import { config } from "../config.js";

export interface CampaignRow {
  campaign_id: number;
  voice: string | null;
  callback_url: string | null;
  created_at?: string;
}

export interface CampaignCallRow {
  id?: string;
  campaign_id: number;
  call_id: string;
  fk_task_id: string | null;
  client_name: string | null;
  phone: string | null;
  debt_amount: string | null;
  twilio_call_sid: string | null;
  from_number: string | null;
  voice: string | null;
  call_variables?: Record<string, string> | null;
  created_at?: string;
}

export async function fetchCampaignCallByCallId(callId: string): Promise<CampaignCallRow | null> {
  const h = authHeaders();
  if (!h || !callId) return null;

  const q = `/themis_campaign_calls?call_id=eq.${encodeURIComponent(callId)}&select=*&limit=1`;
  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) {
      console.warn(`[ThemisIntra] fetchCampaignCallByCallId HTTP ${res.status}`, await res.text());
      return null;
    }
    const rows = (await res.json()) as CampaignCallRow[];
    return rows?.[0] ?? null;
  } catch (err) {
    console.warn(`[ThemisIntra] fetchCampaignCallByCallId error`, err);
    return null;
  }
}

export interface CallRecordRow {
  id: string;
  twilio_call_sid: string | null;
  campaign_id: string | null;
  to_number: string | null;
  from_number: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  answered_at: string | null;
  duration_seconds: number | null;
  transcript: string | null;
  summary: string | null;
  recording_url: string | null;
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

export async function insertCampaign(row: CampaignRow): Promise<boolean> {
  const h = authHeaders();
  if (!h) return false;
  try {
    const res = await fetch(`${restBase()}/themis_campaigns`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.warn(`[ThemisIntra] insertCampaign HTTP ${res.status}`, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[ThemisIntra] insertCampaign error`, err);
    return false;
  }
}

export async function insertCampaignCall(row: CampaignCallRow): Promise<boolean> {
  const h = authHeaders();
  if (!h) return false;
  try {
    const res = await fetch(`${restBase()}/themis_campaign_calls`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.warn(`[ThemisIntra] insertCampaignCall HTTP ${res.status}`, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[ThemisIntra] insertCampaignCall error`, err);
    return false;
  }
}

export async function updateCampaignCallByCallId(
  callId: string,
  patch: Partial<CampaignCallRow>
): Promise<void> {
  const h = authHeaders();
  if (!h) return;
  try {
    await fetch(`${restBase()}/themis_campaign_calls?call_id=eq.${encodeURIComponent(callId)}`, {
      method: "PATCH",
      headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    console.warn(`[ThemisIntra] updateCampaignCallByCallId error`, err);
  }
}

export async function fetchCampaignCalls(campaignId: number | "all", limit = 500): Promise<CampaignCallRow[]> {
  const h = authHeaders();
  if (!h) return [];

  let q = `/themis_campaign_calls?select=*&order=created_at.desc&limit=${limit}`;
  if (campaignId !== "all") {
    q += `&campaign_id=eq.${campaignId}`;
  }

  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) {
      console.warn(`[ThemisIntra] fetchCampaignCalls HTTP ${res.status}`, await res.text());
      return [];
    }
    return (await res.json()) as CampaignCallRow[];
  } catch (err) {
    console.warn(`[ThemisIntra] fetchCampaignCalls error`, err);
    return [];
  }
}

export async function fetchCallsByIds(callIds: string[]): Promise<Map<string, CallRecordRow>> {
  const map = new Map<string, CallRecordRow>();
  if (callIds.length === 0) return map;

  const h = authHeaders();
  if (!h) return map;

  const unique = [...new Set(callIds)];
  const inList = unique.map((id) => encodeURIComponent(id)).join(",");
  const q =
    `/calls?id=in.(${inList})` +
    `&select=id,twilio_call_sid,campaign_id,to_number,from_number,status,started_at,ended_at,answered_at,duration_seconds,transcript,summary,recording_url`;

  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) {
      console.warn(`[ThemisIntra] fetchCallsByIds HTTP ${res.status}`, await res.text());
      return map;
    }
    const rows = (await res.json()) as CallRecordRow[];
    for (const row of rows) {
      map.set(row.id, row);
    }
  } catch (err) {
    console.warn(`[ThemisIntra] fetchCallsByIds error`, err);
  }

  return map;
}

/** Fallback when themis_campaign_calls table is empty/unavailable. */
export async function fetchCallsByCampaignId(campaignId: number | "all", limit = 500): Promise<CallRecordRow[]> {
  const h = authHeaders();
  if (!h) return [];

  let q =
    `/calls?select=id,twilio_call_sid,campaign_id,to_number,from_number,status,started_at,ended_at,answered_at,duration_seconds,transcript,summary,recording_url` +
    `&order=started_at.desc&limit=${limit}`;
  if (campaignId !== "all") {
    q += `&campaign_id=eq.${encodeURIComponent(String(campaignId))}`;
  }

  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) {
      console.warn(`[ThemisIntra] fetchCallsByCampaignId HTTP ${res.status}`, await res.text());
      return [];
    }
    return (await res.json()) as CallRecordRow[];
  } catch (err) {
    console.warn(`[ThemisIntra] fetchCallsByCampaignId error`, err);
    return [];
  }
}
