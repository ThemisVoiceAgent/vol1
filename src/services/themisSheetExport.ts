import { config } from "../config.js";
import {
  appendSheetRow,
  isGoogleSheetsConfigured,
  recordingCellRange,
  updateSheetRange,
} from "./googleSheets.js";
import { fetchCampaignCallByCallId } from "../themis-intra/campaignRepo.js";
import {
  fetchCallForExport,
  fetchCallIdByTwilioSid,
  fetchSheetExport,
  insertSheetExportMarker,
  updateSheetExportById,
} from "../themis-intra/sheetExportRepo.js";

const TARGET = "google_sheet";
const TALLINN_TZ = "Europe/Tallinn";

const NOT_PICKED_UP = new Set(["no-answer", "busy", "failed", "canceled"]);

export type ThemisSheetExportParams = {
  callId: string;
  /** Live transcript from media-stream finalize (may be fresher than DB). */
  transcriptOverride?: string | null;
  /** Force not-reached row (no-answer/busy/failed/canceled). */
  forceNotReached?: boolean;
  /** Media stream connected — answered even if DB flags not flushed yet. */
  forceReached?: boolean;
};

function formatDateTallinn(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TALLINN_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")?.value || "";
  const month = parts.find((p) => p.type === "month")?.value || "";
  const year = parts.find((p) => p.type === "year")?.value || "";
  return `${day}.${month}.${year}`;
}

function formatTimeTallinn(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TALLINN_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function resolveFullName(campaignCall: Awaited<ReturnType<typeof fetchCampaignCallByCallId>>): string {
  if (!campaignCall) return "";
  const direct = (campaignCall.client_name || "").trim();
  if (direct) return direct;
  const vars = parseVars(campaignCall.call_variables);
  const fromVars = (vars.client_name || vars.full_name || vars.caller_name || "").trim();
  if (fromVars) return fromVars;
  const first = (vars.first_name || "").trim();
  const last = (vars.last_name || "").trim();
  return [first, last].filter(Boolean).join(" ").trim();
}

function parseVars(raw: unknown): Record<string, string> {
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
      return parseVars(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return {};
}

function wasCallReached(
  call: { answered_at: string | null; duration_seconds: number | null; status: string | null },
  opts?: { forceNotReached?: boolean; forceReached?: boolean }
): boolean {
  if (opts?.forceNotReached) return false;
  if (opts?.forceReached) return true;
  if (call.answered_at) return true;
  const dur = call.duration_seconds ?? 0;
  if (dur > 0) return true;
  const st = (call.status || "").toLowerCase();
  if (NOT_PICKED_UP.has(st)) return false;
  return false;
}

const WANTED_HUMAN_RE =
  /inimene|võlahaldur|võla\s*haldur|helistage\s*tagasi|helistaks\s*tagasi|päris\s*inimene|manager|robotiga\s*ei\s*taha|robot(i|iga)|inimesega|tahan\s*rääkida|tahaks\s*rääkida|callback|tagasihelistus/i;

const SCHEDULE_PROMISE_RE =
  /maksegraafik|graafik|osamakse|järelmaks|osade\s*kaupa|kompromiss.*(graafik|ajakava|kuupäev)|ajakava/i;

const PAYMENT_PROMISE_RE =
  /maksan|makstan|tasun|maksma\s*hakkan|teen\s*makse|ülekanne|üle\s*kanda|makse\s*teen|hakkan\s*maksma|saan\s*maks(a|ta)/i;

const DISPUTE_RE =
  /ei\s*ole\s*minu\s*võlg|pole\s*minu|vale\s*summa|ei\s*nõustu|vaidlen|vaidlust|see\s*pole\s*minu|mitte\s*minu\s*võlg|ei\s*maksa(?!\s*kunagi)/i;

const HOSTILE_RE =
  /kurat|perses|vittu|fuck|idiot|jobu|rumal|loll|ära\s*helista|ähvard|sitt\s*see|võmm|deb(i|i)l/i;

const WILLING_RE =
  /maksegraafik|graafik|maksan|makstan|tasun|ettepanek|soovin\s*maksta|saan\s*maksta|kompromiss|realistlik\s*ettepanek/i;

function classifyTranscript(text: string): {
  wantedHuman: boolean;
  schedulePromise: boolean;
  paymentPromise: boolean;
  clientType: string;
} {
  const t = text.toLowerCase();
  const wantedHuman = WANTED_HUMAN_RE.test(t);
  const schedulePromise = SCHEDULE_PROMISE_RE.test(t);
  const paymentPromise = PAYMENT_PROMISE_RE.test(t);

  let clientType = "polite";
  if (wantedHuman) clientType = "wanted talk to person";
  else if (DISPUTE_RE.test(t)) clientType = "dispute";
  else if (HOSTILE_RE.test(t)) clientType = "asshole";
  else if (WILLING_RE.test(t) || schedulePromise || paymentPromise) clientType = "willing to pay";

  return { wantedHuman, schedulePromise, paymentPromise, clientType };
}

function buildSummaryCell(
  reached: boolean,
  classification: ReturnType<typeof classifyTranscript>
): string {
  if (!reached) {
    return [
      "Was payment schedule promise made?: N",
      "Was payment promise made?: N",
      "Type of client: not reached",
    ].join("\n");
  }
  return [
    `Was payment schedule promise made?: ${classification.schedulePromise ? "Y" : "N"}`,
    `Was payment promise made?: ${classification.paymentPromise ? "Y" : "N"}`,
    `Type of client: ${classification.clientType}`,
  ].join("\n");
}

/** Normalize [User]/[Agent] transcript lines to Klient:/AI: multiline cell. */
export function formatTranscriptForSheet(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return "No conversation.";

  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const userMatch = trimmed.match(/^\[(?:User|user|Klient|klient|customer|client|caller)\]:\s*(.*)$/i);
    if (userMatch) {
      lines.push(`Klient: ${userMatch[1].trim()}`);
      continue;
    }
    const agentMatch = trimmed.match(/^\[(?:Agent|agent|AI|ai|assistant|bot)\]:\s*(.*)$/i);
    if (agentMatch) {
      lines.push(`AI: ${agentMatch[1].trim()}`);
      continue;
    }
    // Skip system/tool noise for sheet readability
    if (trimmed.startsWith("[System]") || trimmed.startsWith("[SMS") || trimmed.startsWith("[Location") || trimmed.startsWith("[Form")) {
      continue;
    }
  }

  return lines.length > 0 ? lines.join("\n") : "No conversation.";
}

function isThemisOutboundCall(
  call: { direction: string | null; campaign_id: string | null },
  campaignCall: Awaited<ReturnType<typeof fetchCampaignCallByCallId>>
): boolean {
  const isOutbound = (call.direction || "").toLowerCase() === "outbound";
  const hasCampaign = !!(call.campaign_id && String(call.campaign_id).trim());
  if (!isOutbound || !hasCampaign) return false;
  if (campaignCall) return true;
  return false;
}

/**
 * Export one horizontal row to Google Sheets for a Themis outbound call.
 * Idempotent via themis_sheet_exports unique index.
 */
export async function exportThemisCallToSheet(params: ThemisSheetExportParams): Promise<void> {
  const { callId, transcriptOverride, forceNotReached, forceReached } = params;

  if (!config.themis.sheets.exportEnabled) return;
  if (!isGoogleSheetsConfigured()) {
    console.warn("[ThemisSheets] export skipped: sheets env not fully configured");
    return;
  }

  const spreadsheetId = config.themis.sheets.spreadsheetId;
  const sheetName = config.themis.sheets.sheetName;

  const existing = await fetchSheetExport(callId, spreadsheetId, TARGET);
  if (existing?.status === "exported") {
    console.log(`[ThemisSheets] skipped duplicate callId=${callId}`);
    return;
  }

  const call = await fetchCallForExport(callId);
  if (!call) {
    console.warn(`[ThemisSheets] export failed callId=${callId} reason=call_not_found`);
    return;
  }

  const campaignCall = await fetchCampaignCallByCallId(callId);
  if (!isThemisOutboundCall(call, campaignCall)) {
    return;
  }

  console.log(`[ThemisSheets] export queued callId=${callId}`);

  const markerId = await insertSheetExportMarker({
    call_id: callId,
    target: TARGET,
    spreadsheet_id: spreadsheetId,
    sheet_name: sheetName,
    status: "exporting",
  });
  if (!markerId) {
    console.log(`[ThemisSheets] skipped duplicate callId=${callId}`);
    return;
  }

  const timestampIso = call.started_at || call.ended_at || new Date().toISOString();
  const reached = wasCallReached(call, { forceNotReached, forceReached });
  const rawTranscript = transcriptOverride ?? call.transcript;
  const formattedTranscript = reached ? formatTranscriptForSheet(rawTranscript) : "No conversation.";
  const classification = reached ? classifyTranscript(rawTranscript || "") : {
    wantedHuman: false,
    schedulePromise: false,
    paymentPromise: false,
    clientType: "not reached",
  };

  const row = [
    formatDateTallinn(timestampIso),
    formatTimeTallinn(timestampIso),
    resolveFullName(campaignCall),
    reached ? "Y" : "N",
    classification.wantedHuman ? "Y" : "N",
    buildSummaryCell(reached, classification),
    formattedTranscript,
    (call.recording_url || "").trim(),
  ];

  const result = await appendSheetRow([row]);
  if (!result.ok) {
    await updateSheetExportById(markerId, {
      status: "failed",
      error: result.error,
    });
    console.warn(`[ThemisSheets] export failed callId=${callId} reason=${result.error}`);
    return;
  }

  await updateSheetExportById(markerId, {
    status: "exported",
    exported_at: new Date().toISOString(),
    row_range: result.updatedRange,
    error: null,
  });
  console.log(`[ThemisSheets] exported callId=${callId} range=${result.updatedRange}`);
}

/** Patch recording URL in column H when Twilio callback arrives after sheet export. */
export async function maybeUpdateThemisSheetRecording(callSid: string, recordingUrl: string): Promise<void> {
  if (!config.themis.sheets.exportEnabled || !isGoogleSheetsConfigured()) return;
  if (!callSid || !recordingUrl) return;

  const callId = await fetchCallIdByTwilioSid(callSid);
  if (!callId) return;

  const spreadsheetId = config.themis.sheets.spreadsheetId;
  const existing = await fetchSheetExport(callId, spreadsheetId, TARGET);
  if (!existing || existing.status !== "exported" || !existing.row_range) return;

  const cellRange = recordingCellRange(existing.row_range);
  if (!cellRange) return;

  const upd = await updateSheetRange(cellRange, recordingUrl);
  if (upd.ok) {
    console.log(`[ThemisSheets] recording updated callId=${callId} range=${cellRange}`);
  } else {
    console.warn(`[ThemisSheets] recording update failed callId=${callId} reason=${upd.error}`);
  }
}

/** Queue export for answered Themis outbound call (media-stream finalize). */
export function queueThemisSheetExportForAnsweredCall(params: {
  callId: string;
  transcript: string | null;
  campaignId: string | null;
  callDirection: string;
}): void {
  const { callId, transcript, campaignId, callDirection } = params;
  if (callDirection !== "outbound" || !campaignId) return;

  exportThemisCallToSheet({ callId, transcriptOverride: transcript, forceReached: true }).catch((err) => {
    console.warn(`[ThemisSheets] export failed callId=${callId} reason=exception`, err);
  });
}

/** Export not-picked-up Themis outbound call from Twilio status callback. */
export async function maybeExportThemisSheetForNotPickedUp(params: {
  callSid: string;
  normalizedStatus: string;
}): Promise<void> {
  const { callSid, normalizedStatus } = params;
  if (!NOT_PICKED_UP.has(normalizedStatus)) return;

  const callId = await fetchCallIdByTwilioSid(callSid);
  if (!callId) {
    console.warn(`[ThemisSheets] not-picked-up skip: call not found callSid=${callSid}`);
    return;
  }

  const call = await fetchCallForExport(callId);
  if (!call) return;
  if (call.answered_at || (call.duration_seconds ?? 0) > 0) return;

  await exportThemisCallToSheet({ callId, forceNotReached: true });
}
