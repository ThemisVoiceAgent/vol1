import { createDeepgramSttShadowAdapter } from "./deepgramSttShadowAdapter.js";
import { createNoopSttShadowAdapter } from "./noopSttAdapter.js";
import { readSttShadowEnv } from "./sttShadowEnv.js";
import type { SttStreamingAdapterHandle } from "./types.js";

export interface SttShadowBrainHooks {
  /** Deepgram finalized utterances (shadow); must never throw downstream */
  onDeepgramFinal?: (payload: { callId: string; text: string }) => void;
}

let loggedShadowDisabledGlobally = false;

/**
 * One session per Twilio stream; never throws.
 */
export function createSttShadowSession(callId: string, hooks?: SttShadowBrainHooks): SttStreamingAdapterHandle {
  const cfg = readSttShadowEnv();
  try {
    if (!cfg.shadowEnabled) {
      if (!loggedShadowDisabledGlobally) {
        console.log("[STT] shadow disabled");
        loggedShadowDisabledGlobally = true;
      }
      return createNoopSttShadowAdapter(cfg.rawProvider || "none");
    }

    if ((cfg.rawProvider || "") !== "" && cfg.rawProvider !== "deepgram") {
      console.log(`[STT] provider=${cfg.rawProvider} shadow_session_no_adapter_yet callId=${callId || "?"}`);
      return createNoopSttShadowAdapter(cfg.rawProvider);
    }

    if (!cfg.apiKeyConfigured) {
      console.warn(`[STT] provider=deepgram disabled_missing_config callId=${callId || "?"}`);
      return createNoopSttShadowAdapter("deepgram");
    }

    const apiKey = trimKey();

    const ep = cfg.endpointingMs;
    const smart = cfg.smartFormat;
    const model = cfg.sttModel || "nova-2-phonecall";
    const lang = cfg.sttLanguage || "et";

    return createDeepgramSttShadowAdapter({
      apiKey,
      model,
      language: lang,
      endpointingMs: ep,
      smartFormat: smart,
      onTrustedFinal: hooks?.onDeepgramFinal,
    });
  } catch (err) {
    console.error(`[STT] shadow_session_fatal_fallback_noop callId=${callId || "?"}`, err);
    return createNoopSttShadowAdapter("error");
  }
}

function trimKey(): string {
  return (process.env.DEEPGRAM_API_KEY ?? "").trim();
}
