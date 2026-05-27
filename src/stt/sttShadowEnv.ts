import type { SttStreamingRuntimeConfig } from "./types.js";

function trimEnv(key: string): string {
  return (process.env[key] ?? "").trim();
}

function isTruthyEnv(raw: string): boolean {
  const v = raw.toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Reads process env — safe defaults; missing keys yield disabled shadow */
export function readSttShadowEnv(): SttStreamingRuntimeConfig & {
  shadowEnabled: boolean;
  rawProvider: string;
} {
  const rawProvider = trimEnv("STT_PROVIDER").toLowerCase();
  const shadowRaw = trimEnv("STT_SHADOW_ENABLED");
  const shadowEnabled = shadowRaw.length > 0 ? isTruthyEnv(shadowRaw) : false;

  const apiKey = trimEnv("DEEPGRAM_API_KEY");
  const model = trimEnv("DEEPGRAM_MODEL") || "nova-2-general";
  const language = trimEnv("DEEPGRAM_LANGUAGE") || "et";
  const endRaw = trimEnv("DEEPGRAM_ENDPOINTING_MS");
  const sfRaw = trimEnv("DEEPGRAM_SMART_FORMAT");

  let endpointingMs: number | null = null;
  if (endRaw.length > 0) {
    const n = Number(endRaw);
    if (Number.isFinite(n) && n >= 0) endpointingMs = Math.round(n);
  }

  const smartFormat = sfRaw.length > 0 ? isTruthyEnv(sfRaw) : false;

  const sttProvider = rawProvider || undefined;
  return {
    rawProvider,
    shadowEnabled,
    streamingEnabled: true,
    sttProvider,
    sttModel: model,
    sttLanguage: language,
    endpointingMs,
    smartFormat,
    apiKeyConfigured: Boolean(apiKey),
    sttMode: "realtime",
  };
}
