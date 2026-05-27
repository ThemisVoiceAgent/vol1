import { config } from "./config.js";

export interface AgentBrainConfigRow {
  id: string;
  agent_id: string;
  version: number;
  enabled: boolean;
  config_json: unknown;
  updated_at?: string;
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
  };
}

/** Latest enabled row for agent — RLS-compatible with anon/service key. */
export async function fetchLatestEnabledBrainConfigRow(agentId: string): Promise<AgentBrainConfigRow | null> {
  const h = authHeaders();
  if (!h) return null;
  const q =
    `/agent_brain_configs?agent_id=eq.${encodeURIComponent(agentId)}` +
    `&enabled=eq.true&select=id,agent_id,version,enabled,config_json,updated_at` +
    `&order=version.desc&limit=1`;
  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) {
      console.warn(`[agentBrainConfigRepo] fetch_latest HTTP ${res.status}`, await res.text());
      return null;
    }
    const rows = (await res.json()) as AgentBrainConfigRow[];
    return rows?.[0] ?? null;
  } catch (e) {
    console.error(`[agentBrainConfigRepo] fetch_latest error`, e);
    return null;
  }
}

export async function fetchMaxBrainConfigVersion(agentId: string): Promise<number> {
  const h = authHeaders();
  if (!h) return 0;
  const q =
    `/agent_brain_configs?agent_id=eq.${encodeURIComponent(agentId)}` +
    `&select=version&order=version.desc&limit=1`;
  try {
    const res = await fetch(`${restBase()}${q}`, { method: "GET", headers: h });
    if (!res.ok) return 0;
    const rows = (await res.json()) as { version: number }[];
    return typeof rows?.[0]?.version === "number" ? rows[0].version : 0;
  } catch {
    return 0;
  }
}

/** Disable older rows after publishing a new version (best-effort). */
export async function disableOlderBrainConfigVersions(agentId: string, keepVersion: number): Promise<void> {
  const h = authHeaders();
  if (!h) return;
  const q =
    `/agent_brain_configs?agent_id=eq.${encodeURIComponent(agentId)}` +
    `&version=lt.${encodeURIComponent(String(keepVersion))}`;
  try {
    const res = await fetch(`${restBase()}${q}`, {
      method: "PATCH",
      headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify({ enabled: false }),
    });
    if (!res.ok) {
      console.warn(`[agentBrainConfigRepo] disable_older HTTP ${res.status}`, await res.text());
    }
  } catch (e) {
    console.error(`[agentBrainConfigRepo] disable_older error`, e);
  }
}

export async function insertBrainConfigVersion(
  agentId: string,
  version: number,
  configJson: unknown,
): Promise<AgentBrainConfigRow | null> {
  const h = authHeaders();
  if (!h) return null;
  try {
    const res = await fetch(`${restBase()}/agent_brain_configs`, {
      method: "POST",
      headers: { ...h, Prefer: "return=representation" },
      body: JSON.stringify({
        agent_id: agentId,
        version,
        enabled: true,
        config_json: configJson && typeof configJson === "object" ? configJson : {},
      }),
    });
    if (!res.ok) {
      console.error(`[agentBrainConfigRepo] insert HTTP ${res.status}`, await res.text());
      return null;
    }
    const rows = (await res.json()) as AgentBrainConfigRow[];
    return rows?.[0] ?? null;
  } catch (e) {
    console.error(`[agentBrainConfigRepo] insert error`, e);
    return null;
  }
}
