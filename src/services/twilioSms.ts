import { config } from "../config.js";

export interface TwilioSmsSendParams {
  to: string;
  body: string;
  statusCallbackUrl?: string;
}

export interface TwilioSmsSendResult {
  ok: boolean;
  sid?: string;
  status?: string;
  error?: string;
  errorCode?: string | number;
}

export interface SmsMessageInsertRow {
  call_id: string | null;
  agent_id: string | null;
  template_name: string | null;
  direction: "inbound" | "outbound";
  from_number: string;
  to_number: string;
  body: string;
  twilio_sid: string | null;
  status: string;
  /** Optional provider-aware fields (require migration 003). Omitted keys are not sent. */
  provider?: string;
  provider_message_id?: string | null;
  sender_name?: string;
}

function getSupabaseRestHeaders(): Record<string, string> | null {
  const key = config.supabase.serviceRoleKey || config.supabase.anonKey;
  if (!config.supabase.url || !key) return null;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function getSupabaseRestBase(): string {
  return `${config.supabase.url.replace(/\/+$/, "")}/rest/v1`;
}

export async function sendTwilioSms(params: TwilioSmsSendParams): Promise<TwilioSmsSendResult> {
  if (!config.twilio.isConfigured) {
    return { ok: false, error: "Twilio not configured" };
  }
  if (!params.to || !params.body) {
    return { ok: false, error: "Missing SMS recipient or body" };
  }
  if (!config.twilio.fromNumber) {
    return { ok: false, error: "TWILIO_FROM_NUMBER not configured" };
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Messages.json`;
    const authHeader = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
    const form = new URLSearchParams({
      To: params.to,
      From: config.twilio.fromNumber,
      Body: params.body.slice(0, 1600),
      RiskCheck: "disable",
    });
    if (params.statusCallbackUrl) {
      form.set("StatusCallback", params.statusCallbackUrl);
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    const data = (await res.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      message?: string;
      code?: string | number;
      error_code?: string | number;
      error_message?: string;
    };

    if (!res.ok) {
      return {
        ok: false,
        error: data.message || `HTTP ${res.status}`,
        errorCode: data.code,
      };
    }
    if (data.error_code || data.status === "failed" || data.status === "undelivered") {
      return {
        ok: false,
        sid: data.sid,
        status: data.status,
        error: data.error_message || `Twilio status ${data.status || "unknown"}`,
        errorCode: data.error_code,
      };
    }
    return { ok: true, sid: data.sid, status: data.status };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Twilio SMS send failed" };
  }
}

export async function insertSmsMessage(row: SmsMessageInsertRow): Promise<string | null> {
  const headers = getSupabaseRestHeaders();
  if (!headers) return null;
  try {
    const res = await fetch(`${getSupabaseRestBase()}/sms_messages?select=id`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.error(`[twilioSms] insertSmsMessage HTTP ${res.status}`, await res.text());
      return null;
    }
    const rows = (await res.json()) as Array<{ id?: string }>;
    return rows?.[0]?.id || null;
  } catch (err) {
    console.error(`[twilioSms] insertSmsMessage error`, err);
    return null;
  }
}

export async function updateSmsMessageById(id: string, patch: Record<string, unknown>): Promise<void> {
  const headers = getSupabaseRestHeaders();
  if (!headers || !id) return;
  try {
    const url = `${getSupabaseRestBase()}/sms_messages?id=eq.${encodeURIComponent(id)}`;
    await fetch(url, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    console.error(`[twilioSms] updateSmsMessageById error`, err);
  }
}

export async function hasSmsMessageForCallTemplate(callId: string, templateName: string): Promise<boolean | null> {
  const headers = getSupabaseRestHeaders();
  if (!headers || !callId || !templateName) return null;
  try {
    const q =
      `/sms_messages?select=id&call_id=eq.${encodeURIComponent(callId)}` +
      `&template_name=eq.${encodeURIComponent(templateName)}&limit=1`;
    const res = await fetch(`${getSupabaseRestBase()}${q}`, { method: "GET", headers });
    if (!res.ok) {
      console.error(`[twilioSms] hasSmsMessageForCallTemplate HTTP ${res.status}`, await res.text());
      return null;
    }
    const rows = (await res.json()) as Array<{ id?: string }>;
    return rows.length > 0;
  } catch (err) {
    console.error(`[twilioSms] hasSmsMessageForCallTemplate error`, err);
    return null;
  }
}
