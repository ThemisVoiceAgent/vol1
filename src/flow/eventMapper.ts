import type { RequiredEventType } from "./types.js";

/**
 * Phase 1: canonical events emitted by the IIZI shadow tracer hooks in media-stream.
 * (Mapper reserved for future string normalization; hooks pass RequiredEventType directly.)
 */
export const IIZI_SHADOW_TRACE_EVENT_TYPES: readonly RequiredEventType[] = [
  "call_started",
  "sms_sent",
  "form_submitted",
  "vehicle_lookup_result",
  "location_confirmed",
  "sms_received",
  "end_call_requested",
  "call_ended",
] as const;

export function isIiziShadowTraceEventType(t: string): t is RequiredEventType {
  return (IIZI_SHADOW_TRACE_EVENT_TYPES as readonly string[]).includes(t);
}
