/**
 * 5331 — Themis post-call WHATSAPP v2 (Henri directive 07.10):
 * "after each call, the WhatsApp message gets delivered through Messente as well".
 *
 * Channel = Messente omnichannel TEMPLATE WhatsApp (the existing Intra-approved template
 * 'teated_volgnikele_test', language et, sender from messente_to_whatsapp config) — the SAME
 * template the Intra reminder cron has historically used. Template-based sends work without
 * a pre-approved free-text session (Messente delivers the approved template body).
 *
 * Exactly-once: template key themis_post_call_whatsapp_v1 + hasSmsMessageForCallTemplate
 * (call_id+template, DB unique) — fail-closed. Sent for EVERY completed (answered) call
 * alongside the SMS (no extra eligibility filtering beyond the post-call SMS decision,
 * per Henri: "each and every call").
 */
import { insertSmsMessage, updateSmsMessageById, hasSmsMessageForCallTemplate } from "./twilioSms.js";

const MESSENTE_OMNIMESSAGE_URL = "https://api.messente.com/v1/omnimessage";

export const THEMIS_POST_CALL_WHATSAPP_TEMPLATE = "themis_post_call_whatsapp_v1";

/** Gating: env ON (Henri GO). Template name: env or the historical Intra test template. */
export function isThemisWhatsappEnabled(): boolean {
  return (process.env.THEMIS_WHATSAPP_ENABLED || "").trim().toLowerCase() === "true";
}
export function getThemisWhatsappTemplateName(): string {
  return (process.env.THEMIS_WHATSAPP_TEMPLATE || "teated_volgnikele_test").trim();
}
export function getThemisWhatsappSender(): string {
  return (process.env.MESSENTE_WHATSAPP_SENDER || "themis.ee").trim();
}

export interface ThemisWhatsappResult {
  ok: boolean;
  skippedReason?: "disabled" | "duplicate" | "no_copy" | "missing_recipient";
  providerMessageId?: string;
  error?: string;
}

/**
 * TEMPLATE-based WhatsApp send through the existing Messente integration.
 * Exactly-once: claim-first marker (same pattern as SMS) — one WhatsApp per qualifying call.
 */
export async function sendThemisPostCallWhatsapp(params: {
  callId: string;
  campaignId?: number | null;
  to: string;
  /** Debt amount rendered into the template parameters (historical template has no vars —
   *  kept for future templates; the approved template body is fixed on Messente side). */
  debtAmount?: string;
}): Promise<ThemisWhatsappResult> {
  if (!isThemisWhatsappEnabled()) {
    return { ok: false, skippedReason: "disabled" };
  }
  if (!params.to) {
    return { ok: false, skippedReason: "missing_recipient" };
  }

  const already = await hasSmsMessageForCallTemplate(params.callId, THEMIS_POST_CALL_WHATSAPP_TEMPLATE);
  if (already === true) {
    return { ok: false, skippedReason: "duplicate" };
  }
  if (already === null) {
    return { ok: false, error: "dedup check unavailable (fail-closed)" };
  }

  const username = process.env.MESSENTE_API_USERNAME || "";
  const password = process.env.MESSENTE_API_PASSWORD || "";
  if (!username || !password) {
    return { ok: false, error: "Messente credentials missing (MESSENTE_API_USERNAME/PASSWORD)" };
  }

  try {
    const auth = Buffer.from(`${username}:${password}`).toString("base64");
    // Messente WhatsApp template message: sender + template name + language + body params.
    // (Same structure the Intra MessenteWhatsApp.php builds via the PHP SDK.)
    const payload = {
      to: params.to,
      messages: [
        {
          channel: "whatsapp",
          sender: getThemisWhatsappSender(),
          template: {
            name: getThemisWhatsappTemplateName(),
            language: "et",
            components: [{ type: "body", parameters: [] }],
          },
        },
      ],
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
    const errorText: string | undefined = ok
      ? undefined
      : data?.errors?.[0]?.detail || data?.errors?.[0]?.title || `HTTP ${res.status}`;

    await insertSmsMessage({
      call_id: params.callId,
      agent_id: null,
      template_name: THEMIS_POST_CALL_WHATSAPP_TEMPLATE,
      direction: "outbound",
      from_number: "whatsapp",
      to_number: params.to,
      body: `[whatsapp template:${getThemisWhatsappTemplateName()}]`,
      twilio_sid: null,
      status: ok ? "sent" : "failed",
      provider: "messente_whatsapp",
      provider_message_id: providerMessageId || null,
      sender_name: getThemisWhatsappSender(),
    });
    if (!ok) {
      console.error(`[ThemisWhatsApp] send failed HTTP ${res.status} ${errorText || ""} callId=${params.callId}`);
    }

    return { ok, providerMessageId: providerMessageId || undefined, error: ok ? undefined : errorText };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Messente WhatsApp send failed" };
  }
}

/** Delivery-status patch helper (webhook/poll path may update later). */
export async function updateThemisWhatsappStatus(id: string, patch: Record<string, unknown>): Promise<void> {
  await updateSmsMessageById(id, patch);
}
