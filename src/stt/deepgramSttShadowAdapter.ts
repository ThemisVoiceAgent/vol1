/**
 * Shadow-only Deepgram live STT skeleton.
 * Sends Twilio mu-law base64 payloads as binary frames when websocket is OPEN.
 *
 * NEXT (when promoted out of shadow):
 * - Tune model/language per tenant; backoff/retry; metering; correlate utterance IDs with OpenAI timeline.
 */

import WebSocket from "ws";
import type { SttStreamingAdapterHandle } from "./types.js";

export interface DeepgramSttShadowOpts {
  apiKey: string;
  model: string;
  language: string;
  endpointingMs: number | null;
  smartFormat: boolean;
  /** Fires on Deepgram is_final transcripts with non-empty text; read-only orchestration hooks */
  onTrustedFinal?: (payload: { callId: string; text: string }) => void;
}

/** Deepgram Listen v1 rejects unknown model slugs (HTTP 400 on WS upgrade); map legacy/env typos here. */
function normalizeDeepgramListenModel(requestedRaw: string): {
  requested: string;
  effective: string;
  mappingNote: string | null;
} {
  const requested = requestedRaw.trim();
  if (/^nova-2-phonecall$/i.test(requested)) {
    return {
      requested,
      effective: "nova-2-general",
      mappingNote: "nova_2_phonecall_not_in_listen_v1_enum",
    };
  }
  return { requested, effective: requested, mappingNote: null };
}

/** Serializable query snapshot for logs (never includes API key). */
function listenQuerySanitized(opts: DeepgramSttShadowOpts, effectiveModel: string): Record<string, string> {
  const q: Record<string, string> = {
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    model: effectiveModel,
    language: opts.language.trim(),
  };
  if (opts.endpointingMs !== null) q.endpointing = String(opts.endpointingMs);
  if (opts.smartFormat) q.smart_format = "true";
  return q;
}

function logShadowTranscript(callId: string, text: string, isFinal: boolean): void {
  const preview = text.slice(0, 400).replace(/\s+/g, " ").trim();
  console.log(
    `[STT] transcript callId=${callId} provider=deepgram isFinal=${isFinal} text="${preview}"`,
  );
  console.log(
    `[STT-Brain-Shadow] callId=${callId} provider=deepgram transcript="${preview}" isFinal=${isFinal}`,
  );
}

export function createDeepgramSttShadowAdapter(opts: DeepgramSttShadowOpts): SttStreamingAdapterHandle {
  let ws: WebSocket | null = null;
  let activeCallId = "";

  const { effective: effectiveModel, requested: requestedModel, mappingNote: modelMappingNote } =
    normalizeDeepgramListenModel(opts.model);

  const buildWsUrlAndParams = (): { url: string; listenQuery: Record<string, string> } => {
    const listenQuery = listenQuerySanitized(opts, effectiveModel);
    const qs = new URLSearchParams(listenQuery);
    return {
      listenQuery,
      url: `wss://api.deepgram.com/v1/listen?${qs.toString()}`,
    };
  };

  return {
    providerName: "deepgram",
    model: effectiveModel,
    language: opts.language,
    streamingEnabled: true,

    start(callId: string) {
      activeCallId = callId || "?";
      if (ws) {
        console.warn(`[STT] Deepgram duplicate start skipped callId=${activeCallId}`);
        return;
      }

      const { url, listenQuery } = buildWsUrlAndParams();

      console.log(
        `[STT] deepgram_listen_params=${JSON.stringify({
          host: "wss://api.deepgram.com/v1/listen",
          query: listenQuery,
          requestedModel,
          effectiveModel,
          modelMappingNote,
          endpointingMs: opts.endpointingMs ?? "default",
          smartFormat: opts.smartFormat,
        })}`,
      );

      console.log(
        `[STT] provider=deepgram shadow_enabled=true requestedModel=${requestedModel} effectiveModel=${effectiveModel} language=${opts.language} endpointingMs=${opts.endpointingMs ?? "default"} smartFormat=${opts.smartFormat} modelMappingNote=${modelMappingNote ?? "none"} callId=${activeCallId}`,
      );
      try {
        ws = new WebSocket(url, {
          handshakeTimeout: 15_000,
          headers: {
            Authorization: `Token ${opts.apiKey}`,
          },
        });
      } catch (err) {
        console.error(`[STT] error provider=deepgram callId=${activeCallId} phase=constructor`, err);
        ws = null;
        return;
      }

      ws.once("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").replace(/\s+/g, " ").trim().slice(0, 900);
          console.error(
            `[STT] deepgram_ws_upgrade_http status=${res.statusCode} query=${JSON.stringify(listenQuery)} body_preview="${body}"`,
          );
        });
      });

      ws.on("open", () => {
        console.log(`[STT] connected provider=deepgram callId=${activeCallId}`);
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
          const msg = JSON.parse(raw) as {
            type?: string;
            is_final?: boolean;
            channel?: { alternatives?: Array<{ transcript?: string }> };
          };
          if (msg.type === "SpeechStarted") return;
          const text = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
          if (!text) return;
          const isFinal = Boolean(msg.is_final);
          logShadowTranscript(activeCallId, text, isFinal);
          if (isFinal) {
            try {
              opts.onTrustedFinal?.({ callId: activeCallId, text });
            } catch (cbErr) {
              console.error(`[STT] trusted_final_hook_failed callId=${activeCallId}`, cbErr);
            }
          }
        } catch {
          /* ignore malformed */
        }
      });

      ws.on("error", (err) => {
        console.error(`[STT] error provider=deepgram callId=${activeCallId}`, err);
      });

    },

    sendAudioFrameBase64(mulawBase64: string) {
      if (!mulawBase64 || !ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(Buffer.from(mulawBase64, "base64"));
      } catch (err) {
        console.error(`[STT] error provider=deepgram callId=${activeCallId} phase=send`, err);
      }
    },

    stop(callId?: string) {
      const id = callId || activeCallId;
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }
      } catch {
        /* ignore */
      }
      ws = null;
      console.log(`[STT] closed provider=deepgram callId=${id}`);
    },
  };
}
