/**
 * Themis post-call SMS: single source of truth for the template and the
 * provider decision shared by BOTH trigger paths:
 *   - src/ws/media-stream.ts (finalizeCall)
 *   - src/routes/twilio-webhooks.ts (maybeSendThemisPostCallSms via /twilio/status)
 *
 * Keeping the provider decision in one place guarantees both paths agree, so the
 * existing duplicate protection (hasSmsMessageForCallTemplate + DB unique index)
 * stays correct regardless of which path fires first.
 */
import { config } from "../config.js";
import { sendTwilioSms } from "./twilioSms.js";
import { getMessenteSender, isMessenteThemisProvider, sendMessenteSms } from "./messenteSms.js";

export const THEMIS_POST_CALL_SMS_TEMPLATE = "themis_post_call_sms_v1";

/**
 * Approved post-call copy. Placeholder is {{debt_amount}}; it is replaced with the
 * resolved amount + "€" before sending (preserving the previous formatting behavior).
 */
export const THEMIS_POST_CALL_SMS_BODY_TEMPLATE =
  "Tere! Tuletame meelde, et teil on tasumata võlg summas {{debt_amount}}. " +
  "Nõuame võlgnevuse viivitamatut tasumist. " +
  "Maksegraafiku sõlmimiseks pöörduge: https://www.themis.ee/graafik\n" +
  "Muudes küsimustes, info@themis.ee";

export function renderThemisPostCallSmsBody(debtAmount: string): string {
  return THEMIS_POST_CALL_SMS_BODY_TEMPLATE.replace("{{debt_amount}}", `${debtAmount}€`);
}

export type ThemisSmsProvider = "messente" | "twilio";

export interface ThemisSmsSendResult {
  ok: boolean;
  provider: ThemisSmsProvider;
  sender: string;
  providerMessageId?: string;
  status?: string;
  error?: string;
  errorCode?: string | number;
}

export function resolveThemisSmsProvider(): ThemisSmsProvider {
  return isMessenteThemisProvider() ? "messente" : "twilio";
}

export function resolveThemisSmsSender(provider: ThemisSmsProvider): string {
  return provider === "messente" ? getMessenteSender() : config.twilio.fromNumber || "";
}

/**
 * Sends the Themis post-call SMS via the configured provider.
 * Twilio path is byte-for-byte the previous behavior; Messente is opt-in via
 * THEMIS_SMS_PROVIDER=messente. Never throws; returns a normalized result.
 */
export async function sendThemisPostCallSms(params: { to: string; body: string }): Promise<ThemisSmsSendResult> {
  const provider = resolveThemisSmsProvider();
  const sender = resolveThemisSmsSender(provider);

  if (provider === "messente") {
    const r = await sendMessenteSms({ to: params.to, body: params.body, sender });
    return {
      ok: r.ok,
      provider,
      sender,
      providerMessageId: r.providerMessageId,
      status: r.ok ? "sent" : undefined,
      error: r.error,
      errorCode: r.status,
    };
  }

  const r = await sendTwilioSms({
    to: params.to,
    body: params.body,
    statusCallbackUrl: `${config.publicBaseUrl}/twilio/sms-status`,
  });
  return {
    ok: r.ok,
    provider,
    sender,
    providerMessageId: r.sid,
    status: r.status,
    error: r.error,
    errorCode: r.errorCode,
  };
}
