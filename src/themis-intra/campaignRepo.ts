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
  // Retry bookkeeping (migration 004). Optional so existing inserts stay valid.
  attempt_number?: number;
  original_call_id?: string | null;
  retry_scheduled_at?: string | null;
  retry_attempted_at?: string | null;
  retry_status?: string | null;
  retry_reason?: string | null;
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

/**
 * Guarded scheduling of a single +5h retry. PostgREST only patches rows that
 * still match (attempt_number < 2 AND retry_status IS NULL), so a second
 * not-picked-up callback for the same call updates nothing and never
 * double-schedules. Returns the number of rows actually scheduled (0 or 1).
 */
export async function scheduleCampaignRetry(
  callId: string,
  retryAtIso: string,
  reason: string
): Promise<number> {
  const h = authHeaders();
  if (!h || !callId) return 0;
  const q =
    `/themis_campaign_calls?call_id=eq.${encodeURIComponent(callId)}` +
    `&or=(attempt_number.lt.2,attempt_number.is.null)&retry_status=is.null`;
  try {
    const res = await fetch(`${restBase()}${q}`, {
      method: "PATCH",
      headers: { ...h, Prefer: "return=representation" },
      body: JSON.stringify({
        retry_scheduled_at: retryAtIso,
        retry_status: "scheduled",
        retry_reason: reason,
      }),
    });
    if (!res.ok) {
      console.warn(`[ThemisRetry] scheduleCampaignRetry HTTP ${res.status}`, await res.text());
      return 0;
    }
    const rows = (await res.json()) as unknown[];
    return Array.isArray(rows) ? rows.length : 0;
  } catch (err) {
    console.warn(`[ThemisRetry] scheduleCampaignRetry error`, err);
    return 0;
  }
}

/** Rows whose retry is due (scheduled, not yet attempted, retry_scheduled_at <= now). */
export async function fetchDueCampaignRetries(nowIso: string, limit = 25): Promise<CampaignCallRow[]> {
  const h = authHeaders();
  if (!h) return [];
  const q =
    `/themis_campaign_calls?retry_status=eq.scheduled&retry_attempted_at=is.null` +
    `&retry_scheduled_at=lte.${encodeURIComponent(nowIso)}` +
    `&select=*&order=retry_scheduled_at.asc&limit=${limit}`;
  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) {
      console.warn(`[ThemisRetry] fetchDueCampaignRetries HTTP ${res.status}`, await res.text());
      return [];
    }
    return (await res.json()) as CampaignCallRow[];
  } catch (err) {
    console.warn(`[ThemisRetry] fetchDueCampaignRetries error`, err);
    return [];
  }
}

/**
 * Find first-attempt campaign calls that were started (have twilio_call_sid)
 * and are old enough to have ended, but have no retry_status set yet.
 * These are "orphaned" calls where the auto-poll (75s) or Twilio webhook
 * failed to schedule a retry. Used by scheduleMissedRetries() as a safety net.
 */
export async function fetchCallsNeedingRetrySchedule(
  olderThanMinutes = 3
): Promise<CampaignCallRow[]> {
  const h = authHeaders();
  if (!h) return [];
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const q =
    `/themis_campaign_calls?retry_status=is.null` +
    `&or=(attempt_number.eq.1,attempt_number.is.null)` +
    `&twilio_call_sid=not.is.null` +
    `&created_at=lt.${encodeURIComponent(cutoff)}` +
    `&select=*&limit=50`;
  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) {
      console.warn(`[ThemisRetry] fetchCallsNeedingRetrySchedule HTTP ${res.status}`, await res.text());
      return [];
    }
    return (await res.json()) as CampaignCallRow[];
  } catch (err) {
    console.warn(`[ThemisRetry] fetchCallsNeedingRetrySchedule error`, err);
    return [];
  }
}

/**
 * Atomically claim a due retry row by flipping retry_status scheduled -> attempted.
 * Only one caller can win because the filter requires retry_status=scheduled.
 * Returns true if this caller won the row.
 */
export async function claimCampaignRetry(rowId: string): Promise<boolean> {
  const h = authHeaders();
  if (!h || !rowId) return false;
  const q = `/themis_campaign_calls?id=eq.${encodeURIComponent(rowId)}&retry_status=eq.scheduled`;
  try {
    const res = await fetch(`${restBase()}${q}`, {
      method: "PATCH",
      headers: { ...h, Prefer: "return=representation" },
      body: JSON.stringify({
        retry_status: "attempted",
        retry_attempted_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.warn(`[ThemisRetry] claimCampaignRetry HTTP ${res.status}`, await res.text());
      return false;
    }
    const rows = (await res.json()) as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.warn(`[ThemisRetry] claimCampaignRetry error`, err);
    return false;
  }
}

/** Update retry bookkeeping on a row by its primary id. */
export async function updateCampaignCallById(
  rowId: string,
  patch: Partial<CampaignCallRow>
): Promise<void> {
  const h = authHeaders();
  if (!h || !rowId) return;
  try {
    await fetch(`${restBase()}/themis_campaign_calls?id=eq.${encodeURIComponent(rowId)}`, {
      method: "PATCH",
      headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    console.warn(`[ThemisRetry] updateCampaignCallById error`, err);
  }
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
