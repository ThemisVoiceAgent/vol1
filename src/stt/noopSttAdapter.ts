import type { SttStreamingAdapterHandle } from "./types.js";

/** No outbound network; absorbs frames */
export function createNoopSttShadowAdapter(providerName = "noop"): SttStreamingAdapterHandle {
  return {
    providerName,
    model: "(none)",
    language: "(none)",
    streamingEnabled: false,
    start() {},
    sendAudioFrameBase64() {},
    stop() {},
  };
}
