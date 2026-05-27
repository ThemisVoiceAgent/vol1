import type { CampaignCallRow, CallRecordRow } from "./campaignRepo.js";
import type { LegacyStatisticsRow } from "./types.js";
import { formatLegacyCallDate, mapLegacyCallOutcome } from "./callResultMapper.js";

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
