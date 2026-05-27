import { config } from "./config.js";

/**
 * Fetches agent configuration via the Lovable Cloud edge function.
 * Writes call data via edge function (no service role key needed on Railway).
 */

interface AgentConfig {
  id: string;
  name: string;
  greeting: string | null;
  system_prompt: string | null;
  analysis_prompt: string | null;
  voice: string | null;
  tools: string[] | null;
  /** Agent UI settings. Optional `brainUi` (see `resolveAgentBrainConfigFromSettings` in orchestrator) for future brain editor. */
  settings: Record<string, unknown> | null;
  schedule: Record<string, unknown> | null;
  knowledge_base: unknown[] | null;
  phone_number: string | null;
}

function getBaseUrl(): string {
  return config.supabase.url.replace(/\/+$/, "");
}

function getHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.supabase.anonKey}`,
    apikey: config.supabase.anonKey,
  };
}

async function callEdgeFunction(funcName: string, body: Record<string, unknown>): Promise<any> {
  if (!config.supabase.url || !config.supabase.anonKey) {
    console.warn(`[Supabase] Not configured, cannot call ${funcName}`);
    return null;
  }

  const url = `${getBaseUrl()}/functions/v1/${funcName}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Supabase] ${funcName} error: HTTP ${res.status} ${text}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error(`[Supabase] Error calling ${funcName}:`, err);
    return null;
  }
}

// ─── Agent Config ───

export async function fetchAgentConfig(agentId: string): Promise<AgentConfig | null> {
  const data = await callEdgeFunction("agent-config", { agent_id: agentId });
  return data?.agent || null;
}

export async function fetchAgentByPhoneNumber(
  phoneNumber: string,
  direction?: "inbound" | "outbound"
): Promise<AgentConfig | null> {
  const data = await callEdgeFunction("agent-config", { phone_number: phoneNumber, direction });
  return data?.agent || null;
}

export async function fetchFirstActiveAgent(
  direction?: "inbound" | "outbound"
): Promise<AgentConfig | null> {
  const data = await callEdgeFunction("agent-config", { fallback_first: true, direction });
  return data?.agent || null;
}

// ─── Call Data Writes ───

export async function upsertCall(callId: string, data: Record<string, unknown>): Promise<void> {
  await callEdgeFunction("call-write", { action: "upsert_call", call_id: callId, data });
}

export async function updateCall(callId: string, data: Record<string, unknown>): Promise<void> {
  await callEdgeFunction("call-write", { action: "update_call", call_id: callId, data });
}

export async function updateCallBySid(twilioCallSid: string, data: Record<string, unknown>): Promise<void> {
  await callEdgeFunction("call-write", { action: "update_call_by_sid", twilio_call_sid: twilioCallSid, data });
}

export async function insertCallEvent(callId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await callEdgeFunction("call-write", { action: "insert_event", call_id: callId, type, payload });
}

// ─── SMS Data Writes ───

export async function updateSmsBySid(twilioSid: string, data: Record<string, unknown>): Promise<void> {
  await callEdgeFunction("call-write", { action: "update_sms_by_sid", twilio_sid: twilioSid, data });
}
