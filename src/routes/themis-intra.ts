import { Router, Request, Response } from "express";
import { config } from "../config.js";
import { upsertCall, updateCallBySid } from "../supabase.js";
import { startOutboundCall } from "../services/outboundCall.js";
import { requireThemisApiToken } from "../themis-intra/auth.js";
import { firstValidPhone } from "../themis-intra/phone.js";
import {
  insertCampaign,
  insertCampaignCall,
  updateCampaignCallByCallId,
  fetchCampaignCalls,
  fetchCallsByIds,
  fetchCallsByCampaignId,
} from "../themis-intra/campaignRepo.js";
import { buildCallVariables } from "../themis-intra/mapClientVariables.js";
import { applyThemisVariableAliases } from "../themis-intra/applyCallContext.js";
import { buildStatisticsFromCallsOnly, buildStatisticsRows } from "../themis-intra/buildStatistics.js";
import { processDueThemisRetries, scheduleThemisRetryIfNeeded, THEMIS_NOT_PICKED_UP_STATUSES } from "../themis-intra/retry.js";
import { renderThemisPostCallSmsBody, sendThemisPostCallSms, THEMIS_POST_CALL_SMS_TEMPLATE } from "../services/themisPostCallSms.js";
import type { IntraCampaignClient, StartCampaignRequestBody } from "../themis-intra/types.js";

export const themisIntraRouter = Router();

function parseCampaignIdParam(raw: unknown): number | "all" | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const s = String(raw).trim();
  if (s.toLowerCase() === "all") return "all";
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function getClientPhone(client: IntraCampaignClient): string | null {
  const raw = client.deptor_phone || client.debtor_phone;
  return firstValidPhone(raw);
}

themisIntraRouter.post("/start_calls_campaign_api", requireThemisApiToken, async (req: Request, res: Response) => {
  console.log("[ThemisIntra] start_campaign received");

  if (!config.themis.agentId) {
    return res.status(500).json({
      status: "error",
      message: "THEMIS_AGENT_ID is not configured",
      data: {},
    });
  }

  const body = req.body as StartCampaignRequestBody;
  if (!body || typeof body !== "object") {
    return res.status(400).json({
      status: "error",
      message: "Invalid JSON body",
      data: {},
    });
  }

  const clients = body.clients;
  if (!Array.isArray(clients) || clients.length === 0) {
    return res.status(400).json({
      status: "error",
      message: "clients must be a non-empty array",
      data: {},
    });
  }

  const selectedVoice = (body.selectedVoice && String(body.selectedVoice).trim()) || "Sage";
  const callbackUrl = body.callback_url ? String(body.callback_url).trim() : "";
  const campaignId = Date.now();
  const agentId = config.themis.agentId;

  await insertCampaign({
    campaign_id: campaignId,
    voice: selectedVoice,
    callback_url: callbackUrl || null,
  });

  let acceptedCount = 0;
  const correlationId = crypto.randomUUID();

  for (const client of clients) {
    const phone = getClientPhone(client);
    if (!phone) {
      console.log("[ThemisIntra] client skipped (no valid phone)", {
        fk_task_id: client.fk_task_id,
      });
      continue;
    }

    const variables = buildCallVariables(client, campaignId, selectedVoice);
    applyThemisVariableAliases(variables);
    console.log("[ThemisIntra] mapped_variables", {
      fk_task_id: variables.fk_task_id,
      client_name: variables.client_name,
      debt_amount: variables.debt_amount,
      last_income_date: variables.last_income_date,
      campaign_id: variables.campaign_id,
    });

    const callId = crypto.randomUUID();

    // Persist before Twilio dials so media-stream can load context (Stream params are ~256 chars).
    await insertCampaignCall({
      campaign_id: campaignId,
      call_id: callId,
      fk_task_id: client.fk_task_id ? String(client.fk_task_id) : null,
      client_name: client.name ? String(client.name) : null,
      phone,
      debt_amount: client.claim_remain != null ? String(client.claim_remain) : null,
      twilio_call_sid: null,
      from_number: null,
      voice: selectedVoice,
      attempt_number: 1,
      call_variables: variables,
    });

    const twilioVariables = {
      intra_campaign: "true",
      campaign_id: String(campaignId),
      fk_task_id: variables.fk_task_id || "",
      client_name: variables.client_name || "",
      debt_amount: variables.debt_amount || "",
    };

    const result = await startOutboundCall(
      {
        to_number: phone,
        agent_id: agentId,
        campaign_id: String(campaignId),
        call_id: callId,
        variables: twilioVariables,
        skip_schedule_check: true,
      },
      `${correlationId}-${client.fk_task_id || "client"}`
    );

    if (!result.ok) {
      console.warn("[ThemisIntra] outbound call failed", {
        fk_task_id: client.fk_task_id,
        error: result.error,
        status: result.status,
      });
      continue;
    }

    console.log("[ThemisIntra] client accepted", { fk_task_id: client.fk_task_id, phone });
    console.log("[ThemisIntra] outbound call started", {
      call_id: result.call_id,
      twilio_call_sid: result.twilio_call_sid,
      campaign_id: campaignId,
    });

    acceptedCount += 1;

    await upsertCall(result.call_id, {
      twilio_call_sid: result.twilio_call_sid,
      agent_id: agentId,
      campaign_id: String(campaignId),
      to_number: phone,
      from_number: result.from_number,
      status: "initiated",
      direction: "outbound",
      started_at: new Date().toISOString(),
    });

    await updateCampaignCallByCallId(callId, {
      twilio_call_sid: result.twilio_call_sid,
      from_number: result.from_number,
    });

    // Auto-poll: repeatedly check call status until terminal, then send SMS and schedule retry if needed.
    // Fix 2026-07-06: bypasses Twilio webhook not-working issue.
    // Fix 2026-07-08: repeated polling — handles calls that last >75s.
    const twilioCallSid = result.twilio_call_sid;
    const maxPolls = 6;       // 6 × 30s = 3 minutes total
    let pollCount = 0;

    async function pollCallStatus(): Promise<void> {
      pollCount += 1;
      try {
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls/${twilioCallSid}.json`;
        const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
        const resp = await fetch(twilioUrl, { headers: { Authorization: `Basic ${auth}` } });
        if (!resp.ok) {
          if (pollCount < maxPolls) {
            setTimeout(pollCallStatus, 30_000);
          }
          return;
        }
        const data = await resp.json();

        const endedStatuses = new Set(["completed", "busy", "no-answer", "canceled", "failed"]);
        if (!endedStatuses.has(data.status)) {
          // Call still in progress — poll again if we haven't hit the limit
          if (pollCount < maxPolls) {
            setTimeout(pollCallStatus, 30_000);
          }
          return;
        }

        // --- Call has ended (terminal status) ---
        const recipient = data.to || phone;
        const debtAmount = String(client.claim_remain || "").trim() || "0";

        // Update the calls table so the safety net (scheduleMissedRetries)
        // can detect missed retries even if the Twilio webhook doesn't fire.
        await updateCallBySid(twilioCallSid, {
          status: data.status,
          ended_at: data.endTime ? new Date(data.endTime).toISOString() : new Date().toISOString(),
          duration_seconds: data.duration ? parseInt(String(data.duration), 10) : null,
        }).catch((err: unknown) =>
          console.warn(`[ThemisAuto] updateCallBySid error:`, err)
        );

        if (debtAmount) {
          const smsBody = renderThemisPostCallSmsBody(debtAmount);
          const smsResult = await sendThemisPostCallSms({ to: recipient, body: smsBody });

          if (smsResult.ok) {
            console.log(`[ThemisAutoSMS] sent via ${smsResult.provider} to ${recipient} for ${twilioCallSid}`);
          } else {
            console.warn(`[ThemisAutoSMS] FAILED ${twilioCallSid}: ${smsResult.error}`);
          }
        }

        // Schedule retry if call was not picked up
        if (THEMIS_NOT_PICKED_UP_STATUSES.has(data.status)) {
          const retryResult = await scheduleThemisRetryIfNeeded({
            callId,
            reason: `auto_poll_${data.status}`,
          });
          if (retryResult.scheduled) {
            console.log(`[ThemisAuto] retry scheduled for callId=${callId}`);
          }
        }
      } catch (err) {
        console.error(`[ThemisAutoSMS] error:`, err);
        if (pollCount < maxPolls) {
          setTimeout(pollCallStatus, 30_000);
        }
      }
    }

    // Start first poll after initial delay (75s)
    setTimeout(pollCallStatus, 75_000);
  }

  return res.json({
    status: "success",
    message: "Campaign started successfully!",
    data: {
      campaign_id: campaignId,
      voice: selectedVoice,
      callback_url_registered: !!callbackUrl,
      received_clients_count: clients.length,
      accepted_clients_count: acceptedCount,
    },
  });
});

async function handleGetCampaignStatistics(
  req: Request,
  res: Response,
  campaignIdRaw: unknown
): Promise<void> {
  console.log("[ThemisIntra] stats requested", { campaign_id: campaignIdRaw });

  const campaignId = parseCampaignIdParam(campaignIdRaw);
  if (campaignId === null) {
    res.status(400).json({
      status: "error",
      message: "campaign_id is required",
      data: [],
    });
    return;
  }

  const campaignCalls = await fetchCampaignCalls(campaignId);
  let rows;

  if (campaignCalls.length > 0) {
    const callIds = campaignCalls.map((c) => c.call_id).filter(Boolean);
    const callsById = await fetchCallsByIds(callIds);
    rows = buildStatisticsRows(campaignCalls, callsById, campaignId);
  } else {
    const calls =
      campaignId === "all"
        ? await fetchCallsByCampaignId("all")
        : await fetchCallsByCampaignId(campaignId);
    if (campaignId === "all") {
      rows = calls.map((call) => {
        const cid = Number(call.campaign_id) || 0;
        return buildStatisticsFromCallsOnly([call], cid)[0];
      });
    } else {
      rows = buildStatisticsFromCallsOnly(calls, campaignId);
    }
  }

  console.log("[ThemisIntra] stats returned", { count: rows.length, campaign_id: campaignIdRaw });

  if (rows.length === 0) {
    res.json({
      status: "success",
      message: "No calls found for this campaign",
      data: [],
    });
    return;
  }

  res.json({
    status: "success",
    message: "Campaign statistics loaded successfully",
    data: rows,
  });
}

themisIntraRouter.post("/get_campaign_statistics_api", requireThemisApiToken, async (req: Request, res: Response) => {
  const campaignIdRaw = (req.body as { campaign_id?: unknown })?.campaign_id;
  await handleGetCampaignStatistics(req, res, campaignIdRaw);
});

themisIntraRouter.get("/get_campaign_statistics_api", requireThemisApiToken, async (req: Request, res: Response) => {
  const campaignIdRaw = req.query.campaign_id;
  await handleGetCampaignStatistics(req, res, campaignIdRaw);
});

/**
 * POST /internal/themis/process_due_retries — protected retry processor.
 * Finds due +5h retries and starts attempt-2 calls. Intended to be invoked by
 * Railway cron or an external scheduler. Protected by X-API-Token.
 */
themisIntraRouter.post(
  "/internal/themis/process_due_retries",
  requireThemisApiToken,
  async (_req: Request, res: Response) => {
    const correlationId = crypto.randomUUID();
    console.log(`[ThemisRetry] process_due_retries invoked correlationId=${correlationId}`);
    const summary = await processDueThemisRetries(correlationId);
    return res.json({
      status: "success",
      message: "Due retries processed",
      data: { correlation_id: correlationId, ...summary },
    });
  }
);
