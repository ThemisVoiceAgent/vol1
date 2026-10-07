/**
 * 5331 final alignment: Themis post-call WHATSAPP (plumbing only — copy/eligibility BLOCKED
 * pending a product decision; Henri 07.10 "do not invent legal/client-facing copy").
 *
 * Uses the EXISTING Messente omnichannel integration (same omnimessage endpoint + credentials
 * as src/services/messenteSms.ts) with channel:"whatsapp". Same idempotency model as the
 * post-call SMS: template key "themis_post_call_whatsapp_v1" + hasSmsMessageForCallTemplate
 * (call_id+template_name unique) → at most ONE WhatsApp per qualifying call, idempotent
 * across webhook/finalizer/poller/restart.
 *
 * Env gating: THEMIS_WHATSAPP_ENABLED=true turns the flow on. Without it, the flow is a
 * no-op (plumbing deployed, zero production sends until content + eligibility are approved).
 */

import { insertSmsMessage, updateSmsMessageById, hasSmsMessageForCallTemplate } from "./twilioSms.js";

const MESSENTE_OMNIMESSAGE_URL = "https://api.messente.com/v1/omnimessage";

export const THEMIS_POST_CALL_WHATSAPP_TEMPLATE = "themis_post_call_whatsapp_v1";

/** Product decision required before production sends. Logged, not sent. */
export function isThemisWhatsappEnabled(): boolean {
  return (process.env.THEMIS_WHATSAPP_ENABLED || "").trim().toLowerCase() === "true";
}

export interface ThemisWhatsappResult {
  ok: boolean;
  /** skipped_* = no send attempted (idempotency / disabled / missing product decision). */
  skippedReason?: "disabled" | "duplicate" | "no_copy" | "missing_recipient";
  providerMessageId?: string;
  error?: string;
}

/**
 * Sends the post-call WhatsApp via the existing Messente integration and stores the
 * provider result in sms_messages (channel=whatsapp) with the WhatsApp template key.
 * Exactly-once: the marker row is claimed FIRST (same claim-first pattern as SMS).
 */
export async function sendThemisPostCallWhatsapp(params: {
  callId: string;
  campaignId?: number | null;
  to: string;
  /** Text is REQUIRED by the caller — the service never invents copy. */
  body: string;
}): Promise<ThemisWhatsappResult> {
  if (!isThemisWhatsappEnabled()) {
    return { ok: false, skippedReason: "disabled" };
  }
  // Copy guard: empty body = no product copy approved → never send.
  const body = (params.body || "").trim();
  if (!body) {
    console.warn(
      `[ThemisWhatsApp] skipped reason=no_copy callId=${params.callId} — no approved WhatsApp copy (product decision pending)`,
    );
    return { ok: false, skippedReason: "no_copy" };
  }
  if (!params.to) {
    return { ok: false, skippedReason: "missing_recipient" };
  }

  // Exactly-once claim (same guard as SMS).
  const already = await hasSmsMessageForCallTemplate(params.callId, THEMIS_POST_CALL_WHATSAPP_TEMPLATE);
  if (already === true) {
    return { ok: false, skippedReason: "duplicate" };
  }
  if (already === null) {
    // Supabase unreachable — fail CLOSED (do not risk a duplicate send).
    return { ok: false, error: "dedup check unavailable (fail-closed)" };
  }

  const username = process.env.MESSENTE_API_USERNAME || "";
  const password = process.env.MESSENTE_API_PASSWORD || "";
  if (!username || !password) {
    return { ok: false, error: "Messente credentials missing (MESSENTE_API_USERNAME/PASSWORD)" };
  }

  try {
    const auth = Buffer.from(`${username}:${password}`).toString("base64");
    const payload = {
      to: params.to,
      messages: [{ channel: "whatsapp", text: body }],
    };
    const res = await fetch(MESSENTE_OMNIMESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as {
      omnimessage_id?: string;
      messages?: Array<{ message_id?: string }>;
      errors?: Array<{ title?: string; detail?: string }>;
    };
    const providerMessageId = data?.omnimessage_id || data?.messages?.[0]?.message_id || undefined;
    const ok = res.ok;

    // Persist the provider result (same sms_messages table, provider=messente_whatsapp so
    // delivery status is diagnosable; twilio_sid stays null for the WhatsApp channel).
    await insertSmsMessage({
      call_id: params.callId,
      agent_id: null,
      template_name: THEMIS_POST_CALL_WHATSAPP_TEMPLATE,
      direction: "outbound",
      from_number: "whatsapp",
      to_number: params.to,
      body,
      twilio_sid: null,
      status: ok ? "sent" : "failed",
      provider: "messente_whatsapp",
      provider_message_id: providerMessageId || null,
      sender_name: "whatsapp",
    });

    return { ok, providerMessageId, error: ok ? undefined : `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Messente WhatsApp send failed" };
  }
}

/** Delivery-status patch helper (webhook/poll path may update later). */
export async function updateThemisWhatsappStatus(id: string, patch: Record<string, unknown>): Promise<void> {
  await updateSmsMessageById(id, patch);
}
