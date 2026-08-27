import { config } from "../config.js";
import { upsertCall } from "../supabase.js";
import { startOutboundCall } from "../services/outboundCall.js";
import {
  fetchCampaignCallByCallId,
  scheduleCampaignRetry,
  fetchDueCampaignRetries,
  fetchCallsByIds,
  fetchCallsNeedingRetrySchedule,
  claimCampaignRetry,
  insertCampaignCall,
  updateCampaignCallByCallId,
  updateCampaignCallById,
  type CampaignCallRow,
} from "./campaignRepo.js";

/** Max retry attempts. Attempt 1 = initial, attempt 2 = first retry, attempt 3 = second retry. */
const MAX_ATTEMPT = 3;

/** Select caller-ID based on attempt number. */
function callerIdForAttempt(attempt: number): string {
  if (attempt >= 3 && config.twilio.fromNumberFi) {
    return config.twilio.fromNumberFi;
  }
  if (attempt >= 2 && config.twilio.fromNumberLandline) {
    return config.twilio.fromNumberLandline;
  }
  return config.twilio.fromNumber;
}

/** Twilio terminal statuses that mean the debtor never picked up. */
export const THEMIS_NOT_PICKED_UP_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);

/**
 * Retry delay in minutes. Defaults to 4 hours (240 min).
 * For dev/test, set THEMIS_RETRY_DELAY_MINUTES=5 in Railway environment.
 */
const RETRY_DELAY_MINUTES = 240;
function retryDelayMinutes(): number {
  const raw = process.env.THEMIS_RETRY_DELAY_MINUTES;
  if (raw === undefined || raw === null || String(raw).trim() === "") return RETRY_DELAY_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RETRY_DELAY_MINUTES;
  return n;
}

function parseVariables(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v !== undefined && v !== null) out[k] = String(v);
    }
    return out;
  }
  if (typeof raw === "string") {
    try {
      return parseVariables(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Schedule exactly one secondary call +5h after the original attempt time for a
 * not-picked-up Themis outbound call. Idempotent and safe to call repeatedly:
 * the DB guard (attempt_number < 3 AND retry_status IS NULL) prevents
 * double-scheduling and prevents scheduling on attempt-2 rows.
 */
export async function scheduleThemisRetryIfNeeded(params: {
  callId: string;
  reason: string;
  correlationId?: string;
}): Promise<{ scheduled: boolean; reason?: string }> {
  const { callId, reason, correlationId } = params;

  const row = await fetchCampaignCallByCallId(callId);
  if (!row) {
    // Not a Themis campaign call — nothing to do.
    return { scheduled: false, reason: "not_campaign_call" };
  }

  if ((row.attempt_number ?? 1) >= MAX_ATTEMPT) {
    console.log(`[ThemisRetry] skip: already a retry attempt callId=${callId} attempt=${row.attempt_number}`);
    return { scheduled: false, reason: "already_retry_attempt" };
  }

  if (row.retry_status) {
    console.log(`[ThemisRetry] skip: retry already ${row.retry_status} callId=${callId}`);
    return { scheduled: false, reason: "already_scheduled" };
  }

  const variables = parseVariables(row.call_variables);
  const hasRequired = !!(row.phone && row.campaign_id && Object.keys(variables).length > 0);
  if (!hasRequired) {
    console.warn(`[ThemisRetry] skip: missing required fields callId=${callId} phone=${row.phone || "-"} campaign_id=${row.campaign_id || "-"}`);
    return { scheduled: false, reason: "missing_fields" };
  }

  const baseMs = row.created_at ? Date.parse(row.created_at) : Date.now();
  const startMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  const retryAtIso = new Date(startMs + retryDelayMinutes() * 60_000).toISOString();

  const count = await scheduleCampaignRetry(callId, retryAtIso, reason);
  if (count > 0) {
    console.log(
      `[ThemisRetry] scheduled retry callId=${callId} retryAt=${retryAtIso} reason=${reason} attempt=2` +
        (correlationId ? ` correlationId=${correlationId}` : "")
    );
    return { scheduled: true };
  }

  console.log(`[ThemisRetry] skip: guard prevented scheduling callId=${callId} reason=${reason}`);
  return { scheduled: false, reason: "guard" };
}

/** Build the Twilio Stream variable subset for a retry, mirroring the original dial. */
function buildRetryTwilioVariables(campaignId: number, variables: Record<string, string>): Record<string, string> {
  return {
    intra_campaign: "true",
    campaign_id: String(campaignId),
    fk_task_id: variables.fk_task_id || "",
    client_name: variables.client_name || "",
    debt_amount: variables.debt_amount || "",
  };
}

/**
 * Execute all due retries. Called by the protected internal endpoint
 * (POST /internal/themis/process_due_retries) which can be wired to a cron.
 * Each row is claimed atomically before dialing so concurrent/duplicate runs
 * cannot start the same retry twice.
 */
export async function processDueThemisRetries(
  correlationId: string
): Promise<{ due: number; started: number; failed: number; skipped: number }> {
  const summary = { due: 0, started: 0, failed: 0, skipped: 0 };

  const agentId = config.themis.agentId;
  if (!agentId) {
    console.warn(`[ThemisRetry] process: THEMIS_AGENT_ID not configured`);
    return summary;
  }

  const nowIso = new Date().toISOString();
  const due = await fetchDueCampaignRetries(nowIso, 25);
  summary.due = due.length;

  for (const row of due) {
    const rowId = row.id;
    const originalCallId = row.call_id;
    if (!rowId) {
      summary.skipped += 1;
      continue;
    }

    // Atomic claim: scheduled -> attempted. Only the winner proceeds.
    const won = await claimCampaignRetry(rowId);
    if (!won) {
      summary.skipped += 1;
      continue;
    }

    const variables = parseVariables(row.call_variables);
    const phone = row.phone || variables.deptor_phone || variables.debtor_phone || "";
    if (!phone || !row.campaign_id) {
      await updateCampaignCallById(rowId, { retry_status: "skipped", retry_reason: "missing_fields" });
      summary.skipped += 1;
      continue;
    }

    const newCallId = crypto.randomUUID();
    const nextAttempt = (row.attempt_number ?? 1) + 1;

    console.log(
      `[ThemisRetry] starting retry originalCallId=${originalCallId} attempt=${nextAttempt} phone=${phone} correlationId=${correlationId}`
    );

    // Reserve the next-attempt row before dialing (unique index on original_call_id
    // is a hard guard against any duplicate retry row).
    const inserted = await insertCampaignCall({
      campaign_id: row.campaign_id,
      call_id: newCallId,
      fk_task_id: row.fk_task_id ?? null,
      client_name: row.client_name ?? null,
      phone,
      debt_amount: row.debt_amount ?? null,
      twilio_call_sid: null,
      from_number: null,
      voice: row.voice ?? null,
      call_variables: variables,
      attempt_number: nextAttempt,
      original_call_id: originalCallId,
    } as CampaignCallRow);

    if (!inserted) {
      // Likely the unique index rejected a duplicate retry row — do not dial.
      await updateCampaignCallById(rowId, { retry_status: "attempted", retry_reason: "duplicate_retry_row" });
      summary.skipped += 1;
      continue;
    }

    const twilioVariables = buildRetryTwilioVariables(row.campaign_id, variables);
    const fromOverride = callerIdForAttempt(nextAttempt);

    const result = await startOutboundCall(
      {
        to_number: phone,
        agent_id: agentId,
        campaign_id: String(row.campaign_id),
        call_id: newCallId,
        variables: twilioVariables,
        skip_schedule_check: true,
        from_number_override: fromOverride,
      },
      `${correlationId}-retry-${row.fk_task_id || "client"}`
    );

    if (!result.ok) {
      console.warn(
        `[ThemisRetry] retry dial failed originalCallId=${originalCallId} status=${result.status} error=${result.error}`
      );
      await updateCampaignCallById(rowId, { retry_status: "failed", retry_reason: `dial:${result.status}` });
      summary.failed += 1;
      continue;
    }

    await upsertCall(result.call_id, {
      twilio_call_sid: result.twilio_call_sid,
      agent_id: agentId,
      campaign_id: String(row.campaign_id),
      to_number: phone,
      from_number: result.from_number,
      status: "initiated",
      direction: "outbound",
      started_at: new Date().toISOString(),
    });

    await updateCampaignCallByCallId(newCallId, {
      twilio_call_sid: result.twilio_call_sid,
      from_number: result.from_number,
    });

    console.log(
      `[ThemisRetry] retry call started newCallId=${result.call_id} twilioCallSid=${result.twilio_call_sid}`
    );
    summary.started += 1;
  }

  console.log(
    `[ThemisRetry] process complete due=${summary.due} started=${summary.started} failed=${summary.failed} skipped=${summary.skipped} correlationId=${correlationId}`
  );
  return summary;
}

/**
 * Safety net: find calls where retry was never scheduled (auto-poll or webhook
 * both missed), check if the Twilio call ended with a not-picked-up status,
 * and schedule a retry. Called periodically from the setInterval in index.ts.
 */
export async function scheduleMissedRetries(correlationId: string): Promise<number> {
  const rows = await fetchCallsNeedingRetrySchedule(3);
  if (rows.length === 0) return 0;

  const callIds = rows.map((r) => r.call_id).filter(Boolean);
  const callsById = await fetchCallsByIds(callIds);
  if (callsById.size === 0) return 0;

  let scheduled = 0;
  for (const row of rows) {
    const callRecord = callsById.get(row.call_id);
    if (!callRecord?.status) continue;

    if (THEMIS_NOT_PICKED_UP_STATUSES.has(callRecord.status)) {
      const result = await scheduleThemisRetryIfNeeded({
        callId: row.call_id,
        reason: `missed_${callRecord.status}`,
        correlationId,
      });
      if (result.scheduled) {
        scheduled += 1;
        console.log(
          `[ThemisRetry] missed retry recovered callId=${row.call_id} origCallId=${row.original_call_id || "—"} status=${callRecord.status}`
        );
      }
    }
  }

  if (scheduled > 0) {
    console.log(
      `[ThemisRetry] scheduleMissedRetries recovered ${scheduled} of ${rows.length} candidates correlationId=${correlationId}`
    );
  }
  return scheduled;
}
