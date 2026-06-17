import { config } from "../config.js";

/** Public URL for Google Sheets / browsers — no Twilio basic-auth prompt. */
export function publicRecordingPlaybackUrl(callId: string): string {
  const base = (config.publicBaseUrl || "").replace(/\/+$/, "");
  if (!base || !callId) return "";
  return `${base}/twilio/recording-playback/${encodeURIComponent(callId)}`;
}

export async function fetchTwilioRecordingAudio(
  recordingUrl: string
): Promise<{ ok: true; body: Buffer; contentType: string } | { ok: false; status: number }> {
  const url = (recordingUrl || "").trim();
  if (!url) return { ok: false, status: 404 };
  if (!config.twilio.isConfigured) return { ok: false, status: 503 };

  const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
  try {
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) return { ok: false, status: res.status };
    const body = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "audio/mpeg";
    return { ok: true, body, contentType };
  } catch {
    return { ok: false, status: 502 };
  }
}
