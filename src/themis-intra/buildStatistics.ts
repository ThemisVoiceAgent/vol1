import type { CampaignCallRow, CallRecordRow } from "./campaignRepo.js";
import type { LegacyStatisticsRow } from "./types.js";
import { formatLegacyCallDate, mapLegacyCallOutcome } from "./callResultMapper.js";

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
    const { call_status, call_result } = mapLegacyCallOutcome(call?.status);
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
    const { call_status, call_result } = mapLegacyCallOutcome(call.status);
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
