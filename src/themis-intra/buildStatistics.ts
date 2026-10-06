import type { CampaignCallRow, CallRecordRow } from "./campaignRepo.js";
import type { LegacyStatisticsRow } from "./types.js";
import { formatLegacyCallDate, mapLegacyCallOutcome, resolveCallResult } from "./callResultMapper.js";

/**
 * Stable non-negative 31-bit int from a call id (FNV-1a), used as call_log_id
 * when the themis_campaign_calls row id is not a plain integer. Intra stores
 * call_log_id as INT PK — historic values are 5 digits (max observed 59720),
 * so collisions between different call_ids are possible but unlikely at this scale.
 */
export function hashCallLogId(callId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < callId.length; i++) {
    hash ^= callId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & 0x7fffffff;
}

/** Return the row id as an integer when it is a plain integer string, else null. */
function numericRowId(rowId: string | undefined | null): number | null {
  if (!rowId || !/^\d+$/.test(rowId)) return null;
  const n = Number(rowId);
  return Number.isSafeInteger(n) ? n : null;
}

export function buildStatisticsRows(
  campaignCalls: CampaignCallRow[],
  callsById: Map<string, CallRecordRow>,
  campaignIdFilter: number | "all"
): LegacyStatisticsRow[] {
  const rows: LegacyStatisticsRow[] = [];

  for (const cc of campaignCalls) {
    if (campaignIdFilter !== "all" && cc.campaign_id !== campaignIdFilter) continue;

    const call = callsById.get(cc.call_id);
    const phone = cc.phone || call?.to_number || "";
    const fromNumber = cc.from_number || call?.from_number || "";
    // 5331 Phase-B: structured outcome (calls.outcome) wins for completed calls; legacy
    // statuses (no_answer/busy/failed) keep their legacy mapping untouched.
    const { call_status, call_result } = resolveCallResult(call?.status, call?.outcome);
    const callDate =
      formatLegacyCallDate(call?.started_at) ||
      formatLegacyCallDate(cc.created_at) ||
      "";
    const pickupDate = formatLegacyCallDate(call?.answered_at);

    rows.push({
      campaign_id: cc.campaign_id,
      // Intra's saveCampaignDataById INSERTs (int)$value['call_log_id'] as the PK of
      // robot_call_campaign_results — a missing key casts to 0 and collides. Use the
      // themis_campaign_calls row id when it is a plain integer, else a stable hash
      // fallback. (robot_calls_log ids only go up to ~236 and do not match this scale;
      // nothing in Intra joins call_log_id to robot_calls_log.id.)
      call_log_id: numericRowId(cc.id) ?? hashCallLogId(cc.call_id),
      fk_task_id: cc.fk_task_id || "",
      client_id: cc.fk_task_id || "",
      client_name: cc.client_name || "",
      phone,
      phone_number: phone,
      debt_amount: cc.debt_amount || "",
      call_sid: call?.twilio_call_sid || cc.twilio_call_sid || "",
      number_call_made_from: fromNumber,
      call_date: callDate,
      call_pickup_date: pickupDate,
      call_length: call?.duration_seconds != null ? String(call.duration_seconds) : "",
      call_count: 1,
      call_status,
      call_result,
      call_summary: call?.summary || "",
      transcript: call?.transcript || "",
      recording_url: call?.recording_url || "",
      // 5331 Phase-B: structured outcome + promise fields passed through when the agent
      // reported them (LegacyStatisticsRow carries them as optional strings).
      outcome: call?.outcome?.outcome || "",
      payment_promise_date: call?.outcome?.payment_promise_date || "",
      payment_promise_amount: call?.outcome?.payment_promise_amount || "",
      // 5331 Phase-B: claimant context from the campaign-call variables when present
      // (creditor = the client on whose behalf the claim is collected; never fabricated).
      creditor_name: (cc.call_variables?.creditor_name as string) || "",
      last_payment_date: (cc.call_variables?.last_income_date as string) || "",
      attempt_number: cc.attempt_number != null ? String(cc.attempt_number) : "1",
    });
  }

  return rows;
}

/** Build stats from calls table only (no themis_campaign_calls rows). */
export function buildStatisticsFromCallsOnly(
  calls: CallRecordRow[],
  campaignId: number
): LegacyStatisticsRow[] {
  return calls.map((call) => {
    const phone = call.to_number || "";
    const { call_status, call_result } = resolveCallResult(call.status, call.outcome);
    return {
      campaign_id: campaignId,
      call_log_id: hashCallLogId(call.id),
      fk_task_id: "",
      client_id: "",
      client_name: "",
      phone,
      phone_number: phone,
      debt_amount: "",
      call_sid: call.twilio_call_sid || "",
      number_call_made_from: call.from_number || "",
      call_date: formatLegacyCallDate(call.started_at) || "",
      call_pickup_date: formatLegacyCallDate(call.answered_at),
      call_length: call.duration_seconds != null ? String(call.duration_seconds) : "",
      call_count: 1,
      call_status,
      call_result,
      call_summary: call.summary || "",
      transcript: call.transcript || "",
      recording_url: call.recording_url || "",
    };
  });
}
