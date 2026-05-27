/**
 * Adapter-shaped STT types for shadow / future Edit Agent plumbing.
 * No runtime dependency on Deepgram specifics here.
 */

export type SttMode = "realtime" | "post_call";

/** Future-facing shape for UI/agent settings (unused at runtime except documentation). */
export interface SttAgentUiConfigShape {
  sttProvider?: string;
  sttModel?: string;
  sttLanguage?: string;
  sttMode?: SttMode;
  confidenceThreshold?: number;
  keywordHints?: string[];
  fallbackProvider?: string;
}

/** Resolved STT streaming session from env — shadow path only unless extended later */
export interface SttStreamingRuntimeConfig extends SttAgentUiConfigShape {
  streamingEnabled: boolean;
  endpointingMs: number | null;
  smartFormat: boolean;
  /** Sensitive; never log literal value */
  apiKeyConfigured: boolean;
}

export interface SttTranscriptEvent {
  callId: string;
  provider: string;
  isFinal: boolean;
  text: string;
}

export interface SttStreamingAdapterHandle {
  readonly providerName: string;
  readonly model: string;
  readonly language: string;
  readonly streamingEnabled: boolean;
  start(callId: string): void | Promise<void>;
  /** Twilio forwards mu-law payloads as base64 in `media`; pass through as-is */
  sendAudioFrameBase64(mulawBase64: string): void;
  stop(callId?: string): void;
}
