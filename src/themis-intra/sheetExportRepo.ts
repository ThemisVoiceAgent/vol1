import { config } from "../config.js";

export interface SheetExportRow {
  id?: string;
  call_id: string;
  target?: string;
  spreadsheet_id: string;
  sheet_name?: string | null;
  exported_at?: string | null;
  status?: string | null;
  error?: string | null;
  row_range?: string | null;
  created_at?: string;
}

function restBase(): string {
  return `${config.supabase.url.replace(/\/+$/, "")}/rest/v1`;
}

function authHeaders(): Record<string, string> | null {
  const key = config.supabase.serviceRoleKey || config.supabase.anonKey;
  if (!config.supabase.url || !key) return null;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

export async function fetchSheetExport(
  callId: string,
  spreadsheetId: string,
  target = "google_sheet"
): Promise<SheetExportRow | null> {
  const h = authHeaders();
  if (!h || !callId) return null;
  const q =
    `/themis_sheet_exports?call_id=eq.${encodeURIComponent(callId)}` +
    `&target=eq.${encodeURIComponent(target)}` +
    `&spreadsheet_id=eq.${encodeURIComponent(spreadsheetId)}` +
    `&select=*&limit=1`;
  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) return null;
    const rows = (await res.json()) as SheetExportRow[];
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Insert export marker; returns row id on success, null on duplicate/conflict. */
export async function insertSheetExportMarker(row: SheetExportRow): Promise<string | null> {
  const h = authHeaders();
  if (!h) return null;
  try {
    const res = await fetch(`${restBase()}/themis_sheet_exports`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(row),
    });
    if (res.status === 409) return null;
    if (!res.ok) {
      console.warn(`[ThemisSheets] insert marker HTTP ${res.status}`, await res.text());
      return null;
    }
    const rows = (await res.json()) as SheetExportRow[];
    return rows?.[0]?.id ?? null;
  } catch (err) {
    console.warn("[ThemisSheets] insert marker error", err);
    return null;
  }
}

export async function updateSheetExportById(
  id: string,
  patch: Partial<SheetExportRow>
): Promise<void> {
  const h = authHeaders();
  if (!h || !id) return;
  try {
    await fetch(`${restBase()}/themis_sheet_exports?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    console.warn("[ThemisSheets] update marker error", err);
  }
}

export type CallExportRow = {
  id: string;
  twilio_call_sid: string | null;
  campaign_id: string | null;
  direction: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  answered_at: string | null;
  duration_seconds: number | null;
  transcript: string | null;
  recording_url: string | null;
};

export async function fetchCallForExport(callId: string): Promise<CallExportRow | null> {
  const h = authHeaders();
  if (!h || !callId) return null;
  const q =
    `/calls?id=eq.${encodeURIComponent(callId)}` +
    `&select=id,twilio_call_sid,campaign_id,direction,status,started_at,ended_at,answered_at,duration_seconds,transcript,recording_url&limit=1`;
  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) return null;
    const rows = (await res.json()) as CallExportRow[];
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function fetchCallIdByTwilioSid(callSid: string): Promise<string | null> {
  const h = authHeaders();
  if (!h || !callSid) return null;
  const q =
    `/calls?twilio_call_sid=eq.${encodeURIComponent(callSid)}` +
    `&select=id&limit=1`;
  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) return null;
    const rows = (await res.json()) as { id: string }[];
    return rows?.[0]?.id ?? null;
  } catch {
    return null;
  }
}
