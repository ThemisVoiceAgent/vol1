import { Router, Request, Response } from "express";
import { config } from "../config.js";
import { updateCallBySid, updateSmsBySid, fetchAgentByPhoneNumber, fetchAgentConfig } from "../supabase.js";
import { evaluateSchedule, describeScheduleBlock, type AgentSchedule } from "../schedule.js";
import {
  hasSmsMessageForCallTemplate,
  insertSmsMessage,
  updateSmsMessageById,
} from "../services/twilioSms.js";
import {
  THEMIS_POST_CALL_SMS_TEMPLATE,
  renderThemisPostCallSmsBody,
  resolveThemisSmsProvider,
  resolveThemisSmsSender,
  sendThemisPostCallSms,
} from "../services/themisPostCallSms.js";
import {
  THEMIS_NOT_PICKED_UP_STATUSES,
  scheduleThemisRetryIfNeeded,
} from "../themis-intra/retry.js";
import {
  maybeExportThemisSheetForNotPickedUp,
  maybeUpdateThemisSheetRecording,
} from "../services/themisSheetExport.js";
import { fetchTwilioRecordingAudio } from "../services/recordingPlayback.js";
import { fetchCallForExport } from "../themis-intra/sheetExportRepo.js";

export const twilioWebhookRouter = Router();

type CallBySidRow = {
  id: string;
  campaign_id: string | null;
  direction: string | null;
  to_number: string | null;
  from_number: string | null;
  /** Optional: not present in every calls schema. Treated as undefined when absent. */
  answered_at?: string | null;
};

type CampaignCallDebtRow = {
  debt_amount: string | null;
  call_variables?: Record<string, unknown> | string | null;
};

function restBase(): string {
  return `${config.supabase.url.replace(/\/+$/, "")}/rest/v1`;
}

function restHeaders(): Record<string, string> | null {
  const key = config.supabase.serviceRoleKey || config.supabase.anonKey;
  if (!config.supabase.url || !key) return null;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function fetchCallBySid(callSid: string): Promise<CallBySidRow | null> {
  const headers = restHeaders();
  if (!headers || !callSid) return null;
  // NOTE: answered_at is intentionally NOT selected — some calls schemas (prod)
  // do not have that column, and selecting a missing column fails the whole query.
  const q =
    `/calls?twilio_call_sid=eq.${encodeURIComponent(callSid)}` +
    `&select=id,campaign_id,direction,to_number,from_number&limit=1`;
  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers });
    if (!res.ok) {
      console.error(`[TwilioStatusSMS] fetchCallBySid HTTP ${res.status}`, await res.text());
      return null;
    }
    const rows = (await res.json()) as CallBySidRow[];
    return rows?.[0] ?? null;
  } catch (err) {
    console.error(`[TwilioStatusSMS] fetchCallBySid error`, err);
    return null;
  }
}

function parseCallVariables(raw: unknown): Record<string, string> | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v !== undefined && v !== null && v !== "") out[k] = String(v);
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  if (typeof raw === "string") {
    try {
      return parseCallVariables(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchCampaignCallDebtByCallId(callId: string): Promise<CampaignCallDebtRow | null> {
  const headers = restHeaders();
  if (!headers || !callId) return null;
  const q =
    `/themis_campaign_calls?call_id=eq.${encodeURIComponent(callId)}` +
    `&select=debt_amount,call_variables&limit=1`;
  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers });
    if (!res.ok) {
      console.error(`[TwilioStatusSMS] fetchCampaignCallDebtByCallId HTTP ${res.status}`, await res.text());
      return null;
    }
    const rows = (await res.json()) as CampaignCallDebtRow[];
    return rows?.[0] ?? null;
  } catch (err) {
    console.error(`[TwilioStatusSMS] fetchCampaignCallDebtByCallId error`, err);
    return null;
  }
}

function resolveDebtAmountText(row: CampaignCallDebtRow | null): string | null {
  if (!row) return null;
  const direct = (row.debt_amount || "").trim();
  if (direct) return direct;
  const vars = parseCallVariables(row.call_variables);
  const fromVars = (vars?.debt_amount || vars?.claim_remain || "").trim();
  return fromVars || null;
}

async function maybeSendThemisPostCallSms(params: {
  correlationId: string;
  callSid: string;
  normalizedStatus: string;
  callDurationRaw: unknown;
}): Promise<void> {
  const { correlationId, callSid, normalizedStatus, callDurationRaw } = params;
  // Send SMS for all terminal statuses (answered, not-answered, busy, failed, canceled)
  const terminalStatuses = new Set(["completed", "no-answer", "busy", "canceled", "failed"]);
  if (!terminalStatuses.has(normalizedStatus)) return;

  const callRow = await fetchCallBySid(callSid);
  if (!callRow) {
    console.warn(`[TwilioStatusSMS] skip: call not found callSid=${callSid}`);
    return;
  }

  const isOutbound = (callRow.direction || "").toLowerCase() === "outbound";
  const hasCampaign = !!(callRow.campaign_id && String(callRow.campaign_id).trim());
  if (!isOutbound || !hasCampaign) {
    console.log(
      `[TwilioStatusSMS] skip: non-Themis-or-non-outbound callId=${callRow.id} direction=${callRow.direction || "-"} campaign_id=${callRow.campaign_id || "-"}`
    );
    return;
  }

  const durationSeconds = parseInt(String(callDurationRaw || "0"), 10);

  const recipient = (callRow.to_number || "").trim();
  if (!recipient) {
    console.warn(`[TwilioStatusSMS] skip: missing debtor phone callId=${callRow.id} callSid=${callSid}`);
    return;
  }

  const debtRow = await fetchCampaignCallDebtByCallId(callRow.id);
  const debtAmount = resolveDebtAmountText(debtRow);
  if (!debtAmount) {
    console.warn(`[TwilioStatusSMS] skip: missing debt amount callId=${callRow.id} callSid=${callSid}`);
    return;
  }
  const smsBody = renderThemisPostCallSmsBody(debtAmount);

  const alreadySent = await hasSmsMessageForCallTemplate(callRow.id, THEMIS_POST_CALL_SMS_TEMPLATE);
  if (alreadySent === null) {
    console.warn(`[TwilioStatusSMS] skip: idempotency check unavailable callId=${callRow.id} callSid=${callSid}`);
    return;
  }
  if (alreadySent) {
    console.log(`[TwilioStatusSMS] skip: already sent callId=${callRow.id} callSid=${callSid}`);
    return;
  }

  const provider = resolveThemisSmsProvider();
  const sender = resolveThemisSmsSender(provider);
  console.log(`[ThemisSMS] provider=${provider} sender=${sender}`);

  const smsRowId = await insertSmsMessage({
    call_id: callRow.id,
    agent_id: null,
    template_name: THEMIS_POST_CALL_SMS_TEMPLATE,
    direction: "outbound",
    from_number: sender,
    to_number: recipient,
    body: smsBody,
    twilio_sid: null,
    status: "queued",
    ...(provider === "messente" ? { provider, sender_name: sender } : {}),
  });
  if (!smsRowId) {
    console.error(`[TwilioStatusSMS] skip: failed to persist SMS marker callId=${callRow.id} callSid=${callSid}`);
    return;
  }

  const sendResult = await sendThemisPostCallSms({ to: recipient, body: smsBody });

  if (sendResult.ok) {
    const patch: Record<string, unknown> = { status: sendResult.status || "sent" };
    if (sendResult.provider === "messente") {
      patch.provider = "messente";
      patch.provider_message_id = sendResult.providerMessageId || null;
    } else {
      patch.twilio_sid = sendResult.providerMessageId || null;
    }
    await updateSmsMessageById(smsRowId, patch);
    console.log(
      `[ThemisSMS] sent via ${sendResult.provider} callId=${callRow.id} callSid=${callSid} providerMessageId=${sendResult.providerMessageId || "-"} correlationId=${correlationId}`
    );
    return;
  }

  await updateSmsMessageById(smsRowId, {
    status: `failed:${sendResult.errorCode || "send"}`,
  });
  console.error(
    `[ThemisSMS] ${sendResult.provider} failed callId=${callRow.id} callSid=${callSid} status=${sendResult.errorCode || "-"} error=${sendResult.error || "-"} correlationId=${correlationId}`
  );
}

/**
 * Schedule a single +5h retry when a Themis outbound call was not picked up.
 * Only acts on terminal not-picked-up statuses and never on answered calls.
 */
async function maybeScheduleThemisRetry(params: {
  correlationId: string;
  callSid: string;
  normalizedStatus: string;
}): Promise<void> {
  const { correlationId, callSid, normalizedStatus } = params;
  if (!THEMIS_NOT_PICKED_UP_STATUSES.has(normalizedStatus)) return;

  const callRow = await fetchCallBySid(callSid);
  if (!callRow) {
    console.warn(`[ThemisRetry] skip: call not found callSid=${callSid}`);
    return;
  }

  const isOutbound = (callRow.direction || "").toLowerCase() === "outbound";
  const hasCampaign = !!(callRow.campaign_id && String(callRow.campaign_id).trim());
  if (!isOutbound || !hasCampaign) {
    console.log(
      `[ThemisRetry] skip: non-Themis-or-non-outbound callId=${callRow.id} direction=${callRow.direction || "-"} campaign_id=${callRow.campaign_id || "-"}`
    );
    return;
  }

  if (callRow.answered_at) {
    console.log(`[ThemisRetry] skip: call has answered proof callId=${callRow.id} callSid=${callSid}`);
    return;
  }

  await scheduleThemisRetryIfNeeded({
    callId: callRow.id,
    reason: normalizedStatus,
    correlationId,
  });
}

/**
 * POST /twilio/voice — Twilio voice webhook
 * Returns TwiML that opens a bidirectional Media Stream to /twilio/stream
 */
twilioWebhookRouter.post("/voice", async (req: Request, res: Response) => {
  const correlationId = crypto.randomUUID();
  // Detect inbound vs outbound: outbound calls include callId in query (set by /api/calls/start)
  const isInbound = !req.query.callId;
  const callId = (req.query.callId as string) || crypto.randomUUID();
  const agentId = (req.query.agentId as string) || "";
  const campaignId = (req.query.campaignId as string) || "";
  const variables = (req.query.variables as string) || "";
  const bridgeSelfTest = (req.query.bridgeSelfTest as string) || process.env.TWILIO_BRIDGE_SELF_TEST || "";
  const direction = isInbound ? "inbound" : "outbound";

  console.log(`[${correlationId}] POST /twilio/voice direction=${direction} callId=${callId} agentId=${agentId || "(resolve-by-number)"} campaignId=${campaignId} variables=${variables ? 'yes' : 'no'}`);
  console.log(`[${correlationId}] CallSid=${req.body?.CallSid} From=${req.body?.From} To=${req.body?.To}`);

  if (!config.openai.isConfigured) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">This voice service is not yet configured. Please try again later.</Say>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  // Inbound schedule enforcement — politely decline calls outside the agent's
  // calling window. Outbound calls were already filtered by /api/calls/start.
  if (isInbound) {
    try {
      const calledNumber = req.body?.To || "";
      const agent = agentId
        ? await fetchAgentConfig(agentId)
        : (calledNumber ? await fetchAgentByPhoneNumber(calledNumber, "inbound") : null);
      if (agent) {
        const status = evaluateSchedule(agent.schedule as AgentSchedule);
        console.log(`[${correlationId}] Inbound schedule check: agent=${agent.name} allowed=${status.allowed} reason=${status.reason} local=${status.localTime} tz=${status.timezone}`);
        if (!status.allowed) {
          const reason = describeScheduleBlock(status, agent.schedule as AgentSchedule);
          // Voice-friendly message — agents can override later via settings.
          const closedMsg = "We are currently outside business hours. Please call back during our regular hours. Thank you.";
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${closedMsg}</Say>
  <Hangup/>
</Response>`;
          console.log(`[${correlationId}] Declining inbound: ${reason}`);
          return res.type("text/xml").send(twiml);
        }
      } else {
        console.log(`[${correlationId}] No agent matched for inbound — skipping schedule check`);
      }
    } catch (err) {
      // Never block calls because of a schedule lookup error — log and continue.
      console.error(`[${correlationId}] Inbound schedule check failed:`, err);
    }
  }

  const wsBase = config.publicWsBaseUrl
    || config.publicBaseUrl
      .replace(/^https:\/\//i, "wss://")
      .replace(/^http:\/\//i, "ws://");
  const streamUrl = `${wsBase}/twilio/stream`;
  const calledNumber = req.body?.To || "";
  const fromNumber = req.body?.From || "";

  const recordingCallback = `${config.publicBaseUrl}/twilio/recording-status`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Recording recordingStatusCallback="${recordingCallback}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed" recordingChannels="dual" recordingTrack="both"/>
  </Start>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="callId" value="${callId}"/>
      <Parameter name="agentId" value="${agentId}"/>
      <Parameter name="campaignId" value="${campaignId}"/>
      <Parameter name="callSid" value="${req.body?.CallSid || ""}"/>
      <Parameter name="calledNumber" value="${calledNumber}"/>
      <Parameter name="fromNumber" value="${fromNumber}"/>
      <Parameter name="direction" value="${direction}"/>
      <Parameter name="variables" value="${variables.replace(/"/g, '&quot;')}"/>
      <Parameter name="bridgeSelfTest" value="${bridgeSelfTest.replace(/"/g, '&quot;')}"/>
    </Stream>
  </Connect>
</Response>`;

  if (!streamUrl.startsWith("wss://")) {
    console.warn(`[${correlationId}] Twilio stream URL is not secure wss:// (${streamUrl}). Public WS URL should be wss-reachable from Twilio.`);
  }
  console.log(`[${correlationId}] Returning TwiML with stream → ${streamUrl}`);
  console.log(`[${correlationId}] TwiML payload:\n${twiml}`);
  return res.type("text/xml").send(twiml);
});

/**
 * POST /twilio/status — Twilio status callback
 */
twilioWebhookRouter.post("/status", async (req: Request, res: Response) => {
  const correlationId = crypto.randomUUID();
  const { CallSid, CallStatus, CallDuration } = req.body || {};

  console.log(`[${correlationId}] POST /twilio/status`, { CallSid, CallStatus, CallDuration });

  if (CallSid && CallStatus) {
    const statusMap: Record<string, string> = {
      initiated: "initiated",
      ringing: "ringing",
      "in-progress": "in-progress",
      completed: "completed",
      busy: "busy",
      "no-answer": "no-answer",
      canceled: "canceled",
      failed: "failed",
    };

    const data: Record<string, unknown> = {
      status: statusMap[CallStatus] || CallStatus,
    };

    if (CallStatus === "answered" || CallStatus === "in-progress") {
      data.answered_at = new Date().toISOString();

      // Start a recording via REST API. Required because Record=true on /Calls
      // does NOT capture audio when using <Connect><Stream> (Media Streams).
      if (config.twilio.isConfigured) {
        try {
          const recCallback = `${config.publicBaseUrl}/twilio/recording-status`;
          const recUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls/${CallSid}/Recordings.json`;
          const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
          const body = new URLSearchParams({
            RecordingStatusCallback: recCallback,
            RecordingStatusCallbackMethod: "POST",
            RecordingStatusCallbackEvent: "completed",
            RecordingChannels: "dual",
            RecordingTrack: "both",
          });
          const recRes = await fetch(recUrl, {
            method: "POST",
            headers: {
              Authorization: `Basic ${auth}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
          });
          if (recRes.ok) {
            console.log(`[${correlationId}] Started recording for CallSid=${CallSid}`);
          } else {
            const txt = await recRes.text();
            console.error(`[${correlationId}] Failed to start recording: ${recRes.status} ${txt.slice(0, 300)}`);
          }
        } catch (err) {
          console.error(`[${correlationId}] Recording start error:`, err);
        }
      }
    }

    if (CallStatus === "completed") {
      data.ended_at = new Date().toISOString();
      if (CallDuration) {
        data.duration_seconds = parseInt(CallDuration, 10);
      }
    }

    await updateCallBySid(CallSid, data);
    await maybeSendThemisPostCallSms({
      correlationId,
      callSid: CallSid,
      normalizedStatus: String(data.status || ""),
      callDurationRaw: CallDuration,
    });
    await maybeScheduleThemisRetry({
      correlationId,
      callSid: CallSid,
      normalizedStatus: String(data.status || ""),
    });
    await maybeExportThemisSheetForNotPickedUp({
      callSid: CallSid,
      normalizedStatus: String(data.status || ""),
    });
  }

  return res.json({ ok: true, correlation_id: correlationId });
});

/**
 * POST /twilio/sms-status — Twilio SMS status callback
 * Receives delivery status updates for outbound SMS messages.
 * Logs the full payload so Railway deploy logs can be used to diagnose
 * SMS delivery failures (e.g. Twilio error 30453 carrier/fraud blocks).
 */
twilioWebhookRouter.post("/sms-status", async (req: Request, res: Response) => {
  const correlationId = crypto.randomUUID();
  const receivedAt = new Date().toISOString();

  // Pull every field Twilio may send on an SMS status callback
  const {
    MessageSid,
    SmsSid,
    MessageStatus,
    SmsStatus,
    ErrorCode,
    ErrorMessage,
    To,
    From,
    Body,
    NumSegments,
    NumMedia,
    AccountSid,
    ApiVersion,
    ChannelPrefix,
    ChannelInstallSid,
    RawDlrDoneDate,
  } = req.body || {};

  const sid = MessageSid || SmsSid || "(no-sid)";
  const status = MessageStatus || SmsStatus || "(no-status)";

  console.log(`[TwilioSmsCallback] ──────────────────────────────────────────`);
  console.log(`[TwilioSmsCallback] POST /twilio/sms-status received at ${receivedAt}`);
  console.log(`[TwilioSmsCallback] correlationId=${correlationId}`);
  console.log(`[TwilioSmsCallback] MessageSid=${sid}  Status=${status}`);
  console.log(`[TwilioSmsCallback] To=${To || "(none)"}  From=${From || "(none)"}`);

  if (ErrorCode || ErrorMessage) {
    console.error(`[TwilioSmsCallback] ⚠ ERROR  ErrorCode=${ErrorCode || "(none)"}  ErrorMessage=${ErrorMessage || "(none)"}`);
  } else {
    console.log(`[TwilioSmsCallback] ErrorCode=(none)  ErrorMessage=(none)`);
  }

  console.log(`[TwilioSmsCallback] Full body:`, JSON.stringify({
    MessageSid,
    SmsSid,
    MessageStatus,
    SmsStatus,
    ErrorCode,
    ErrorMessage,
    To,
    From,
    Body: Body ? `${String(Body).slice(0, 80)}${String(Body).length > 80 ? "…" : ""}` : undefined,
    NumSegments,
    NumMedia,
    AccountSid,
    ApiVersion,
    ChannelPrefix,
    ChannelInstallSid,
    RawDlrDoneDate,
  }));

  // Persist delivery status to sms_messages so Call Logs UI reflects real state
  if (sid && sid !== "(no-sid)" && status && status !== "(no-status)") {
    try {
      const updateData: Record<string, unknown> = { status };
      if (ErrorCode) updateData.status = `failed:${ErrorCode}`;
      await updateSmsBySid(sid, updateData);
      console.log(`[TwilioSmsCallback] Updated sms_messages: sid=${sid} status=${updateData.status}`);
    } catch (err) {
      console.error(`[TwilioSmsCallback] Failed to update sms_messages:`, err);
    }
  }

  const responsePayload = { ok: true, correlation_id: correlationId };
  console.log(`[TwilioSmsCallback] Responding 200 OK  correlation_id=${correlationId}`);
  console.log(`[TwilioSmsCallback] ──────────────────────────────────────────`);

  return res.status(200).json(responsePayload);
});

/**
 * POST /twilio/sms-fallback — Twilio SMS fallback handler
 * Called by Twilio when the primary SMS webhook URL fails or returns an error.
 * Logs the full payload for debugging; always returns 200 so Twilio stops retrying.
 */
twilioWebhookRouter.post("/sms-fallback", async (req: Request, res: Response) => {
  const correlationId = crypto.randomUUID();
  const receivedAt = new Date().toISOString();

  const {
    MessageSid,
    SmsSid,
    MessageStatus,
    SmsStatus,
    ErrorCode,
    ErrorMessage,
    To,
    From,
    Body,
    NumSegments,
    NumMedia,
    AccountSid,
    ApiVersion,
  } = req.body || {};

  const sid = MessageSid || SmsSid || "(no-sid)";
  const status = MessageStatus || SmsStatus || "(no-status)";

  console.log(`[TwilioSmsFallback] ──────────────────────────────────────────`);
  console.log(`[TwilioSmsFallback] POST /twilio/sms-fallback received at ${receivedAt}`);
  console.log(`[TwilioSmsFallback] correlationId=${correlationId}`);
  console.log(`[TwilioSmsFallback] MessageSid=${sid}  Status=${status}`);
  console.log(`[TwilioSmsFallback] To=${To || "(none)"}  From=${From || "(none)"}`);

  if (ErrorCode || ErrorMessage) {
    console.error(`[TwilioSmsFallback] ⚠ ERROR  ErrorCode=${ErrorCode || "(none)"}  ErrorMessage=${ErrorMessage || "(none)"}`);
  } else {
    console.log(`[TwilioSmsFallback] ErrorCode=(none)  ErrorMessage=(none)`);
  }

  console.log(`[TwilioSmsFallback] Full body:`, JSON.stringify({
    MessageSid,
    SmsSid,
    MessageStatus,
    SmsStatus,
    ErrorCode,
    ErrorMessage,
    To,
    From,
    Body: Body ? `${String(Body).slice(0, 80)}${String(Body).length > 80 ? "…" : ""}` : undefined,
    NumSegments,
    NumMedia,
    AccountSid,
    ApiVersion,
  }));

  // Persist failure to sms_messages
  if (sid && sid !== "(no-sid)") {
    try {
      const failStatus = ErrorCode ? `fallback:${ErrorCode}` : `fallback:${status}`;
      await updateSmsBySid(sid, { status: failStatus });
      console.log(`[TwilioSmsFallback] Updated sms_messages: sid=${sid} status=${failStatus}`);
    } catch (err) {
      console.error(`[TwilioSmsFallback] Failed to update sms_messages:`, err);
    }
  }

  const responsePayload = { ok: true, correlation_id: correlationId };
  console.log(`[TwilioSmsFallback] Responding 200 OK  correlation_id=${correlationId}`);
  console.log(`[TwilioSmsFallback] ──────────────────────────────────────────`);

  return res.status(200).json(responsePayload);
});

/**
 * GET /twilio/recording-playback/:callId — stream call recording without Twilio basic-auth prompt.
 * Used by Google Sheets links and other browser playback.
 */
twilioWebhookRouter.get("/recording-playback/:callId", async (req: Request, res: Response) => {
  const callId = String(req.params.callId || "").trim();
  if (!callId) return res.status(400).send("Missing callId");

  const call = await fetchCallForExport(callId);
  const recordingUrl = (call?.recording_url || "").trim();
  if (!recordingUrl) return res.status(404).send("Recording not found");

  const audio = await fetchTwilioRecordingAudio(recordingUrl);
  if (!audio.ok) return res.status(audio.status).send("Failed to fetch recording");

  res.setHeader("Content-Type", audio.contentType);
  res.setHeader("Content-Disposition", `inline; filename="themis-recording-${callId}.mp3"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  return res.send(audio.body);
});

/**
 * POST /twilio/recording-status — Twilio recording status callback
 * Saves recording URL to the call record
 */
twilioWebhookRouter.post("/recording-status", async (req: Request, res: Response) => {
  const correlationId = crypto.randomUUID();
  const { CallSid, RecordingUrl, RecordingStatus, RecordingDuration } = req.body || {};

  console.log(`[${correlationId}] POST /twilio/recording-status`, {
    CallSid,
    RecordingStatus,
    RecordingDuration,
    RecordingUrl,
  });

  if (CallSid && RecordingUrl && RecordingStatus === "completed") {
    // Twilio recording URL needs .mp3 or .wav extension for playback
    const recordingUrlMp3 = `${RecordingUrl}.mp3`;
    await updateCallBySid(CallSid, {
      recording_url: recordingUrlMp3,
    });
    console.log(`[${correlationId}] Recording saved for CallSid=${CallSid}: ${recordingUrlMp3}`);
    await maybeUpdateThemisSheetRecording(CallSid, recordingUrlMp3);
  }

  return res.json({ ok: true, correlation_id: correlationId });
});
