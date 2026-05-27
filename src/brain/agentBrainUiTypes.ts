/**
 * UI-oriented agent brain model (future editor / canvas).
 * Separate from runtime DB JSON `IiziBrainConfigV1` — can be merged or synced later.
 */

export type BrainProviderMode = "rules" | "llm" | "hybrid";

export interface BrainTranscriptSourcesConfig {
  realtimeOpenAi: boolean;
  externalStt?: boolean;
}

export type BrainActionType =
  | "speak"
  | "send_sms"
  | "vehicle_lookup"
  | "confirm_vehicle_readback"
  | "confirm_location_readback"
  | "ask_occupant_count"
  | "confirm_occupant_count"
  | "callback_sms"
  | "end_call"
  | "handoff";

export interface BrainIntent {
  id: string;
  label: string;
  description?: string;
  examples?: string[];
  keywords?: string[];
  priority?: number;
  confidenceThreshold?: number;
}

export interface BrainState {
  id: string;
  label: string;
  description?: string;
}

export interface BrainTransition {
  from: string;
  to: string;
  onIntent?: string;
  onEvent?: string;
  guardIds?: string[];
}

export interface BrainAction {
  id: string;
  label: string;
  type: BrainActionType;
  allowedInStates?: string[];
  requiredGuards?: string[];
}

export interface BrainGuard {
  id: string;
  label: string;
  description?: string;
}

/**
 * Top-level config for future UI editing. Versioned for migrations.
 */
export type AgentBrainConfig = {
  version: number;
  providerMode: BrainProviderMode;
  transcriptSources: BrainTranscriptSourcesConfig;
  intents: BrainIntent[];
  states: BrainState[];
  transitions: BrainTransition[];
  actions: BrainAction[];
  guards: BrainGuard[];
};

/** Shipped default: documents IIZI roadside FSM for UI; runtime rules still enforced in agent-brain.ts + iiziBrain.ts */
export const DEFAULT_IIZI_AGENT_BRAIN_CONFIG: AgentBrainConfig = {
  version: 1,
  providerMode: "hybrid",
  transcriptSources: { realtimeOpenAi: true, externalStt: true },
  intents: [
    {
      id: "roadside_assistance",
      label: "Roadside assistance",
      description: "Caller needs autoabi / roadside help",
      keywords: ["autoabi", "abi", "teel", "roadside"],
    },
    { id: "non_roadside", label: "Non-roadside", description: "Not a roadside case on this line" },
    { id: "unclear", label: "Unclear intent", description: "Need clarification" },
    { id: "fuel_empty", label: "Out of fuel", keywords: ["kütus", "fuel"] },
    { id: "lockout", label: "Lockout", keywords: ["võtmed", "locked", "kinni"] },
    { id: "battery_issue", label: "Battery", keywords: ["aku", "battery"] },
    { id: "tow_required", label: "Tow required", keywords: ["puksiir", "tow"] },
    { id: "accident", label: "Accident", keywords: ["avarii", "õnnetus", "crash"] },
    { id: "callback_change_requested", label: "Callback number change", description: "Different callback number" },
  ],
  states: [
    { id: "intent_triage.pre_sms_intent_gate", label: "Pre-SMS intent gate" },
    { id: "roadside.confirmed", label: "Roadside confirmed" },
    { id: "roadside.combined_sms_sent", label: "Combined SMS sent" },
    { id: "roadside.form_submitted", label: "Form submitted" },
    { id: "roadside.vehicle_lookup_match_active", label: "Vehicle match + active cover" },
    { id: "roadside.vehicle_lookup_failed", label: "Vehicle no match / invalid cover" },
    { id: "roadside.location_confirmed", label: "Location confirmed" },
    { id: "roadside.vehicle_readback_done", label: "Vehicle readback done" },
    { id: "roadside.location_readback_done", label: "Location readback done" },
    { id: "roadside.occupant_count_required", label: "Occupant count required" },
    { id: "roadside.occupant_count_confirmed", label: "Occupant count confirmed" },
    { id: "roadside.callback_confirmed", label: "Callback preference confirmed" },
    { id: "handoff.required", label: "Human handoff" },
    { id: "call.completed", label: "Call completed" },
  ],
  transitions: [
    { from: "intent_triage.pre_sms_intent_gate", to: "roadside.confirmed", onIntent: "roadside_assistance" },
    { from: "roadside.confirmed", to: "roadside.combined_sms_sent", onEvent: "combined_sms_sent" },
    { from: "roadside.combined_sms_sent", to: "roadside.form_submitted", onEvent: "form_submitted" },
    { from: "roadside.form_submitted", to: "roadside.vehicle_lookup_match_active", onEvent: "vehicle_lookup_match" },
    { from: "roadside.vehicle_lookup_match_active", to: "roadside.location_confirmed", onEvent: "location_confirmed" },
    { from: "roadside.location_confirmed", to: "roadside.vehicle_readback_done", onEvent: "vehicle_readback" },
    { from: "roadside.vehicle_readback_done", to: "roadside.location_readback_done", onEvent: "location_readback" },
    { from: "roadside.location_readback_done", to: "roadside.occupant_count_required", onEvent: "occupant_required" },
    { from: "roadside.occupant_count_required", to: "roadside.occupant_count_confirmed", onEvent: "occupant_confirmed" },
    { from: "roadside.occupant_count_confirmed", to: "roadside.callback_confirmed", onEvent: "callback_confirmed" },
    { from: "intent_triage.pre_sms_intent_gate", to: "handoff.required", onIntent: "non_roadside" },
  ],
  actions: [
    { id: "clarify_roadside_need", label: "Clarify roadside", type: "speak", allowedInStates: ["intent_triage.pre_sms_intent_gate"] },
    { id: "send_combined_sms", label: "Combined reg+location SMS", type: "send_sms", allowedInStates: ["roadside.confirmed"] },
    { id: "vehicle_lookup_strict", label: "Strict vehicle lookup", type: "vehicle_lookup" },
    { id: "confirm_vehicle_readback", label: "Confirm vehicle readback", type: "confirm_vehicle_readback" },
    { id: "confirm_location_readback", label: "Confirm location readback", type: "confirm_location_readback" },
    { id: "ask_occupant_count", label: "Ask occupant count", type: "ask_occupant_count" },
    { id: "confirm_occupant_count", label: "Confirm occupant count", type: "confirm_occupant_count" },
    { id: "callback_sms", label: "Callback SMS (different number)", type: "callback_sms" },
    { id: "end_call", label: "End call", type: "end_call" },
    { id: "handoff", label: "Handoff", type: "handoff" },
  ],
  guards: [
    { id: "intent_roadside_or_unknown", label: "Roadside intent", description: "Merged intent allows roadside SMS path" },
    { id: "form_submitted", label: "Form submitted", description: "Registration form received after combined SMS" },
    { id: "vehicle_match_active_cover", label: "Vehicle + cover OK" },
    { id: "location_confirmed", label: "Location confirmed" },
    { id: "vehicle_readback_done", label: "Vehicle readback done" },
    { id: "location_readback_done", label: "Location readback done" },
    { id: "occupant_prompt_emitted_or_pending", label: "Occupant step engaged" },
    { id: "callback_complete", label: "Callback preference finalized" },
  ],
};

/** Merge agent `settings.brainUi` overlay (optional) with shipped defaults — safe for partial objects. */
export function resolveAgentBrainConfigFromSettings(
  settings: Record<string, unknown> | null | undefined,
): AgentBrainConfig {
  const base = DEFAULT_IIZI_AGENT_BRAIN_CONFIG;
  if (!settings || typeof settings !== "object") return base;
  const raw = settings.brainUi;
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  const providerMode = o.providerMode;
  const version = o.version;
  return {
    ...base,
    providerMode:
      providerMode === "rules" || providerMode === "llm" || providerMode === "hybrid"
        ? (providerMode as BrainProviderMode)
        : base.providerMode,
    version: typeof version === "number" ? version : base.version,
  };
}

// --- Runtime policy from admin UI `settings.brainUi` (voice-loom frontend) ---

export type UiBrainProviderMode = "shadow" | "soft_guard" | "hard_guard";

export type SpeechTrustMode =
  | "prefer_deepgram_when_openai_unclear"
  | "ask_on_conflict"
  | "prefer_openai";

export type UnknownIntentBehaviorUi = "ask_clarification" | "route_human";

export type ConflictBehaviorUi = "ask_clarification" | "prefer_deepgram" | "prefer_openai";

export type RuntimeBrainUiSettings = {
  version: 1;
  enabled: boolean;
  providerMode: UiBrainProviderMode;
  speechTrustMode: SpeechTrustMode;
  unknownIntentBehavior: UnknownIntentBehaviorUi;
  conflictBehavior: ConflictBehaviorUi;
  gates: {
    combinedSms: boolean;
    occupantCount: boolean;
    vehicleReadback: boolean;
    locationReadback: boolean;
    callbackConfirmation: boolean;
    endCall: boolean;
  };
  occupantPrerequisites: {
    formSubmitted: boolean;
    vehicleLookupMatchActive: boolean;
    locationConfirmed: boolean;
    vehicleReadbackComplete: boolean;
    locationReadbackComplete: boolean;
  };
  diagnostics: {
    brainDecision: boolean;
    toolBlocked: boolean;
    transcriptCompare: boolean;
  };
};

/** Back-compat when `settings.brainUi` missing: align with admin UI safest defaults + permissive gates. */
export const DEFAULT_RUNTIME_BRAIN_UI_SETTINGS: RuntimeBrainUiSettings = {
  version: 1,
  enabled: true,
  providerMode: "soft_guard",
  speechTrustMode: "prefer_deepgram_when_openai_unclear",
  conflictBehavior: "ask_clarification",
  unknownIntentBehavior: "ask_clarification",
  gates: {
    combinedSms: true,
    occupantCount: true,
    vehicleReadback: true,
    locationReadback: true,
    callbackConfirmation: true,
    endCall: true,
  },
  occupantPrerequisites: {
    formSubmitted: true,
    vehicleLookupMatchActive: true,
    locationConfirmed: true,
    vehicleReadbackComplete: true,
    locationReadbackComplete: true,
  },
  diagnostics: {
    brainDecision: true,
    toolBlocked: true,
    transcriptCompare: true,
  },
};

function asBool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}

export function resolveRuntimeBrainUiFromSettings(
  settings: Record<string, unknown> | null | undefined,
): RuntimeBrainUiSettings {
  const d = DEFAULT_RUNTIME_BRAIN_UI_SETTINGS;
  if (!settings || typeof settings !== "object") return { ...d };

  const raw = settings.brainUi;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...d };

  const o = raw as Record<string, unknown>;

  const providerMode: UiBrainProviderMode =
    o.providerMode === "shadow" || o.providerMode === "soft_guard" || o.providerMode === "hard_guard"
      ? o.providerMode
      : d.providerMode;

  const speechTrustMode: SpeechTrustMode =
    o.speechTrustMode === "prefer_deepgram_when_openai_unclear" ||
    o.speechTrustMode === "ask_on_conflict" ||
    o.speechTrustMode === "prefer_openai"
      ? o.speechTrustMode
      : d.speechTrustMode;

  const unknownIntentBehavior: UnknownIntentBehaviorUi =
    o.unknownIntentBehavior === "ask_clarification" || o.unknownIntentBehavior === "route_human"
      ? o.unknownIntentBehavior
      : d.unknownIntentBehavior;

  const conflictBehavior: ConflictBehaviorUi =
    o.conflictBehavior === "ask_clarification" ||
    o.conflictBehavior === "prefer_deepgram" ||
    o.conflictBehavior === "prefer_openai"
      ? o.conflictBehavior
      : d.conflictBehavior;

  const gatesIn =
    o.gates && typeof o.gates === "object" && !Array.isArray(o.gates)
      ? (o.gates as Record<string, unknown>)
      : {};
  const occIn =
    o.occupantPrerequisites &&
    typeof o.occupantPrerequisites === "object" &&
    !Array.isArray(o.occupantPrerequisites)
      ? (o.occupantPrerequisites as Record<string, unknown>)
      : {};
  const diagIn =
    o.diagnostics && typeof o.diagnostics === "object" && !Array.isArray(o.diagnostics)
      ? (o.diagnostics as Record<string, unknown>)
      : {};

  return {
    version: 1,
    enabled: asBool(o.enabled, d.enabled),
    providerMode,
    speechTrustMode,
    unknownIntentBehavior,
    conflictBehavior,
    gates: {
      combinedSms: asBool(gatesIn.combinedSms, d.gates.combinedSms),
      occupantCount: asBool(gatesIn.occupantCount, d.gates.occupantCount),
      vehicleReadback: asBool(gatesIn.vehicleReadback, d.gates.vehicleReadback),
      locationReadback: asBool(gatesIn.locationReadback, d.gates.locationReadback),
      callbackConfirmation: asBool(gatesIn.callbackConfirmation, d.gates.callbackConfirmation),
      endCall: asBool(gatesIn.endCall, d.gates.endCall),
    },
    occupantPrerequisites: {
      formSubmitted: asBool(occIn.formSubmitted, d.occupantPrerequisites.formSubmitted),
      vehicleLookupMatchActive: asBool(
        occIn.vehicleLookupMatchActive,
        d.occupantPrerequisites.vehicleLookupMatchActive,
      ),
      locationConfirmed: asBool(occIn.locationConfirmed, d.occupantPrerequisites.locationConfirmed),
      vehicleReadbackComplete: asBool(
        occIn.vehicleReadbackComplete,
        d.occupantPrerequisites.vehicleReadbackComplete,
      ),
      locationReadbackComplete: asBool(
        occIn.locationReadbackComplete,
        d.occupantPrerequisites.locationReadbackComplete,
      ),
    },
    diagnostics: {
      brainDecision: asBool(diagIn.brainDecision, d.diagnostics.brainDecision),
      toolBlocked: asBool(diagIn.toolBlocked, d.diagnostics.toolBlocked),
      transcriptCompare: asBool(diagIn.transcriptCompare, d.diagnostics.transcriptCompare),
    },
  };
}

/** True when pathway merge matches shipped legacy (`npm run intent-classify-smoke`). */
export function runtimeBrainUiUsesLegacyPathwayMerge(ui: RuntimeBrainUiSettings): boolean {
  return (
    ui.speechTrustMode === "prefer_deepgram_when_openai_unclear" && ui.conflictBehavior === "prefer_deepgram"
  );
}
