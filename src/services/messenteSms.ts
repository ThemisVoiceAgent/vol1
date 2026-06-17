/**
 * Minimal Messente Omnichannel SMS provider (native fetch, no SDK).
 *
 * Credentials are read from process.env only and are NEVER logged.
 * Used exclusively by the Themis post-call SMS path (see themisPostCallSms.ts).
 */

const MESSENTE_OMNIMESSAGE_URL = "https://api.messente.com/v1/omnimessage";

export interface MessenteSmsSendParams {
  to: string;
  body: string;
  sender?: string;
}

export interface MessenteSmsSendResult {
  ok: boolean;
  provider: "messente";
  providerMessageId?: string;
  /** HTTP status code from Messente (e.g. 201 on success). */
  status?: number;
  error?: string;
}

/** True when the Themis post-call SMS path should route through Messente. */
export function isMessenteThemisProvider(): boolean {
  return (process.env.THEMIS_SMS_PROVIDER || "").trim().toLowerCase() === "messente";
}

/** Configured Messente sender name (e.g. "themis.ee"). */
export function getMessenteSender(): string {
  return (process.env.MESSENTE_SMS_SENDER || "themis.ee").trim();
}

export async function sendMessenteSms(params: MessenteSmsSendParams): Promise<MessenteSmsSendResult> {
  const username = process.env.MESSENTE_API_USERNAME || "";
  const password = process.env.MESSENTE_API_PASSWORD || "";
  if (!username || !password) {
    return {
      ok: false,
      provider: "messente",
      error: "Messente credentials missing (MESSENTE_API_USERNAME/MESSENTE_API_PASSWORD)",
    };
  }
  if (!params.to || !params.body) {
    return { ok: false, provider: "messente", error: "Missing SMS recipient or body" };
  }

  const sender = (params.sender || getMessenteSender()).trim();

  try {
    // Basic Auth header is built locally and never logged.
    const auth = Buffer.from(`${username}:${password}`).toString("base64");
    const payload = {
      to: params.to,
      messages: [
        {
          channel: "sms",
          sender,
          text: params.body,
        },
      ],
    };

    const res = await fetch(MESSENTE_OMNIMESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => ({}))) as {
      omnimessage_id?: string;
      messages?: Array<{ message_id?: string }>;
      errors?: Array<{ title?: string; detail?: string }>;
      error?: string;
    };

    if (!res.ok) {
      const detail =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.title ||
        data?.error ||
        `HTTP ${res.status}`;
      return { ok: false, provider: "messente", status: res.status, error: detail };
    }

    const providerMessageId = data?.omnimessage_id || data?.messages?.[0]?.message_id || undefined;
    return { ok: true, provider: "messente", providerMessageId, status: res.status };
  } catch (err: any) {
    return { ok: false, provider: "messente", error: err?.message || "Messente SMS send failed" };
  }
}
