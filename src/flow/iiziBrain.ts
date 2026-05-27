/**
 * Limited deterministic backend "brain" for IIZI combined SMS inbound calls only.
 * Enforces SMS gate on consensus intent across OpenAI transcript vs Deepgram shadow STT.
 */

import type { BrainIntentSlug, CompiledBrainConfig, PathwayIntentClassification } from "./iiziBrainConfigTypes.js";
import type { IiziBrainConfigV1 } from "./iiziBrainConfigTypes.js";
import { mergePathwayIntents, type MergePathwayOptions, type ResolvedBrainIntent } from "./iiziBrainMerge.js";
import {
  DEFAULT_RUNTIME_BRAIN_UI_SETTINGS,
  type RuntimeBrainUiSettings,
  runtimeBrainUiUsesLegacyPathwayMerge,
} from "../brain/agentBrainUiTypes.js";
export type { ResolvedBrainIntent };
/** Merged coarse outcome for SMS gating — same as `ResolvedBrainIntent` from pathway merge */
export type ResolvedIntent = ResolvedBrainIntent;

import {
  classifyIntentFromSpeechHybrid,
  getDefaultCompiledBrain,
  buildBrainConfigFromLayers,
} from "./iiziBrainSpeechClassify.js";

/** @deprecated Narrow alias — pathways use pathway labels only (+ unknown). */
export type IntentClassification = PathwayIntentClassification;

export type BrainControlMode = "observe" | "suggest" | "control";

export type IiziBrainWorkflowPhase =
  | "pre_sms_intent_gate"
  | "waiting_for_form_and_location"
  | "form_submitted"
  | "location_confirmed"
  | "waiting_for_vehicle_lookup"
  | "vehicle_lookup_match_active"
  | "vehicle_lookup_match_inactive"
  | "vehicle_lookup_no_match";

export interface IiziBrainGuardResults {
  passed: boolean;
  failures: string[];
}

export type BrainTranscriptSource = "deepgram_shadow" | "openai_realtime" | "none";

export interface IiziBrainEvaluateResult {
  observedEvent: string;
  state: string;
  /** Mirrors finalResolvedIntent for planner consumers */
  intentClassification: ResolvedIntent;
  /** DB `agent_brain_configs.version` when a row applied; shipped default compile only → null */
  brainConfigDbVersion: number | null;
  brainConfigSchemaVersion: number;
  /** Pathway classify meta (speech → intent), pre-merge */
  matchedIntentOpenAI: BrainIntentSlug | null;
  matchedIntentDeepgram: BrainIntentSlug | null;
  matchedRuleOpenAI: string;
  matchedRuleDeepgram: string;
  classifySourceOpenAI: string;
  classifySourceDeepgram: string;
  /** Legacy-regex fail-open after config load error */
  brainClassifierForceBuiltinFallback: boolean;
  /** Per-pathway keyword signals (sticky until a new clear keyword hit on that pathway) */
  sourceIntentOpenAI: PathwayIntentClassification;
  sourceIntentDeepgram: PathwayIntentClassification;
  finalResolvedIntent: ResolvedIntent;
  intentResolutionReason: string;
  /** Human-readable SMS policy line for logs (also inside gateSms output) */
  smsGateReason: string;
  expectedNextAction: string;
  transcriptSource: BrainTranscriptSource;
  guardResults: IiziBrainGuardResults;
  controlMode: BrainControlMode;
}

export interface IiziBrainRuntimeState {
  workflowPhase: IiziBrainWorkflowPhase | "idle";
  greetingPlaybackComplete: boolean;
  combinedSmsSuccessfullySent: boolean;
  formSeenAfterSms: boolean;
  locationSeenAfterSms: boolean;
  silenceSignalCount: number;
  lastObservedEvent: string;
  lastTranscriptSource: BrainTranscriptSource;

  /** Compiled policy (defaults + DB layer). */
  brainCompiled: CompiledBrainConfig;
  /** DB row `version`; null if only shipped default compiled (including before async load settles) */
  brainConfigDbVersion: number | null;

  /**
   * When true: Supabase brain load/apply failed mid-call — classify with legacy built-in regex only
   * (`classifyIntentFromSpeechHybrid` receives no compiled rules). SMS gates still use shipped default compile.
   */
  brainClassifierForceBuiltinFallback: boolean;

  openaiLastMatchedRuleIds: string;
  openaiLastClassifySource: string;
  openaiLastMatchedIntentSlug: BrainIntentSlug | null;
  deepgramLastMatchedRuleIds: string;
  deepgramLastClassifySource: string;
  deepgramLastMatchedIntentSlug: BrainIntentSlug | null;

  /** Last clear keyword-derived intent per ASR pathway; "unknown" = no classified hit yet */
  openaiRealtimeIntent: PathwayIntentClassification;
  deepgramShadowIntent: PathwayIntentClassification;

  /** Merged SMS policy intent — never blindly “last transcript wins”. */
  finalResolvedIntent: ResolvedIntent;
  intentResolutionReason: string;

  /** Admin UI policy (`settings.brainUi`); safe defaults if agent row has no JSON. */
  runtimeBrainUi: RuntimeBrainUiSettings;

  /** Monotonic per-call counter bumped on substantive OpenAI user transcript (aligns compare log with caller turn). */
  intentCompareTurnSeq: number;
  /** Last trimmed OpenAI Realtime transcript slice used for intent (not full session history). */
  lastOpenaiIntentTranscriptPreview: string;
  /** Last trimmed Deepgram shadow final transcript slice used for intent. */
  lastDeepgramIntentTranscriptPreview: string;
}

function recomputeFinalIntent(state: IiziBrainRuntimeState): void {
  const ui = state.runtimeBrainUi;
  const useLegacy =
    !ui.enabled || runtimeBrainUiUsesLegacyPathwayMerge(ui);
  const opts: MergePathwayOptions | undefined = useLegacy
    ? undefined
    : { speechTrustMode: ui.speechTrustMode, conflictBehavior: ui.conflictBehavior };
  const { resolved, reason } = mergePathwayIntents(state.openaiRealtimeIntent, state.deepgramShadowIntent, opts);
  state.finalResolvedIntent = resolved;
  state.intentResolutionReason = reason;
}

/** After `runtimeBrainUi` is assigned from agent settings, refresh merged intent from current pathway labels. */
export function refreshIiziBrainMergedIntent(state: IiziBrainRuntimeState): void {
  recomputeFinalIntent(state);
}

export function applyAgentBrainConfigToState(
  state: IiziBrainRuntimeState,
  dbJsonPartial: unknown | null,
  brainConfigDbVersion: number | null,
): void {
  state.brainCompiled = buildBrainConfigFromLayers(dbJsonPartial as Partial<IiziBrainConfigV1> | null);
  state.brainConfigDbVersion = brainConfigDbVersion;
  state.brainClassifierForceBuiltinFallback = false;
}

/**
 * Fail-open: reset gates layer to shipped default compile and force legacy built-in classifier regex
 * (covers Supabase fetch/parse errors during a live call — does not block SMS on config alone).
 */
export function markIiziBrainConfigLoadFailed(state: IiziBrainRuntimeState): void {
  state.brainClassifierForceBuiltinFallback = true;
  state.brainCompiled = getDefaultCompiledBrain();
  state.brainConfigDbVersion = null;
}

function resetPathwayClassifyScratch(state: IiziBrainRuntimeState): void {
  state.openaiLastMatchedRuleIds = "";
  state.openaiLastClassifySource = "config";
  state.openaiLastMatchedIntentSlug = null;
  state.deepgramLastMatchedRuleIds = "";
  state.deepgramLastClassifySource = "config";
  state.deepgramLastMatchedIntentSlug = null;
}

/** Compiled rules for intent labels, or `null` → legacy built-in regex bundle (Supabase fail-open). */
function compiledForClassification(state: IiziBrainRuntimeState): CompiledBrainConfig | null {
  return state.brainClassifierForceBuiltinFallback ? null : state.brainCompiled;
}

/**
 * Conservative classify using compiled brain (`defaults` + optional DB overlay).
 * Internally falls back to legacy regex only if compiled rule list is empty.
 */
export function classifyIntentFromSpeech(
  text: string,
  brain?: CompiledBrainConfig | null,
): PathwayIntentClassification | null {
  return classifyIntentFromSpeechHybrid(text, brain ?? getDefaultCompiledBrain()).intent;
}

export function createInitialIiziBrainState(): IiziBrainRuntimeState {
  const compiled = getDefaultCompiledBrain();
  const s: IiziBrainRuntimeState = {
    workflowPhase: "pre_sms_intent_gate",
    greetingPlaybackComplete: false,
    combinedSmsSuccessfullySent: false,
    formSeenAfterSms: false,
    locationSeenAfterSms: false,
    silenceSignalCount: 0,
    lastObservedEvent: "init",
    lastTranscriptSource: "none",
    brainCompiled: compiled,
    brainConfigDbVersion: null,
    brainClassifierForceBuiltinFallback: false,
    runtimeBrainUi: { ...DEFAULT_RUNTIME_BRAIN_UI_SETTINGS },
    openaiLastMatchedRuleIds: "",
    openaiLastClassifySource: "config",
    openaiLastMatchedIntentSlug: null,
    deepgramLastMatchedRuleIds: "",
    deepgramLastClassifySource: "config",
    deepgramLastMatchedIntentSlug: null,
    openaiRealtimeIntent: "unknown",
    deepgramShadowIntent: "unknown",
    finalResolvedIntent: "unknown",
    intentResolutionReason: "both_unknown_or_unclear",
    intentCompareTurnSeq: 0,
    lastOpenaiIntentTranscriptPreview: "",
    lastDeepgramIntentTranscriptPreview: "",
  };
  recomputeFinalIntent(s);
  return s;
}

/** Log deterministic merge line after source updates */
export function logIiziBrainIntentResolution(callId: string | null, state: IiziBrainRuntimeState): void {
  const cid = callId || "?";
  const gate = smsGatePeek(state);
  const ev = evaluateIiziBrain(state, false);
  if (state.runtimeBrainUi.diagnostics.transcriptCompare) {
    logTranscriptCompare(callId, state);
  }
  console.log(
    `[IIZI-Brain] intent_resolution openai=${state.openaiRealtimeIntent} deepgram=${state.deepgramShadowIntent} ` +
      `resolved=${state.finalResolvedIntent} reason=${state.intentResolutionReason} ` +
      `brainConfigDbVersion=${ev.brainConfigDbVersion ?? "null"} schema=${ev.brainConfigSchemaVersion} ` +
      `matchedIntentOA=${ev.matchedIntentOpenAI ?? "null"} matchedRuleOA=${ev.matchedRuleOpenAI} classifySourceOA=${ev.classifySourceOpenAI} ` +
      `matchedIntentDG=${ev.matchedIntentDeepgram ?? "null"} matchedRuleDG=${ev.matchedRuleDeepgram} classifySourceDG=${ev.classifySourceDeepgram} ` +
      `classifierFailOpen=${ev.brainClassifierForceBuiltinFallback} ` +
      `nextAction=${ev.expectedNextAction} smsGateReason=${gate.smsGateReason} callId=${cid}`,
  );
}

function smsGatePeek(state: IiziBrainRuntimeState): {
  smsGateReason: string;
  wouldAllow: boolean;
  reasonCode: string;
} {
  const gate = gateIiziCombinedSms(state);
  return {
    smsGateReason: gate.smsGateReason,
    wouldAllow: gate.allow,
    reasonCode: gate.reasonCode,
  };
}

const TRANSCRIPT_COMPARE_MAX = 220;

function clipForTranscriptCompare(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, TRANSCRIPT_COMPARE_MAX).replace(/"/g, "'");
}

/** Structured compare line for ops — Deepgram-preferred merge is reflected in resolvedIntent / smsGateReason. */
export function logTranscriptCompare(callId: string | null, state: IiziBrainRuntimeState): void {
  const gate = smsGatePeek(state);
  const oaT = clipForTranscriptCompare(state.lastOpenaiIntentTranscriptPreview || "");
  const dgT = clipForTranscriptCompare(state.lastDeepgramIntentTranscriptPreview || "");
  console.log(
    `[TranscriptCompare] callId=${callId || "?"} turnSeq=${state.intentCompareTurnSeq} ` +
      `openaiTranscript="${oaT}" deepgramTranscript="${dgT}" ` +
      `openaiIntent=${state.openaiRealtimeIntent} deepgramIntent=${state.deepgramShadowIntent} ` +
      `resolvedIntent=${state.finalResolvedIntent} resolutionReason=${state.intentResolutionReason} ` +
      `smsGateReason=${gate.smsGateReason}`,
  );
}

export function ingestIiziBrainNonemptyUserSpeech(state: IiziBrainRuntimeState, text: string): void {
  state.silenceSignalCount = 0;
  state.lastTranscriptSource = "openai_realtime";
  const trimmed = text.trim();
  if (trimmed) {
    state.intentCompareTurnSeq += 1;
    state.lastOpenaiIntentTranscriptPreview = trimmed.slice(0, 400);
  }
  const r = classifyIntentFromSpeechHybrid(text, compiledForClassification(state));
  state.openaiLastMatchedRuleIds = r.meta.matchedRuleIds;
  state.openaiLastClassifySource = r.meta.classifySource;
  state.openaiLastMatchedIntentSlug = r.meta.matchedIntentSlug;
  if (r.intent) state.openaiRealtimeIntent = r.intent;
  recomputeFinalIntent(state);
  state.lastObservedEvent = r.intent ? `user_transcript.${r.intent}` : "user_transcript.unclear_needs_intent_question";
}

/** Deepgram finals: strengthens merge only via deepgramShadowIntent; does not wipe OpenAI pathway */
export function ingestIiziBrainTrustedShadowFinal(
  state: IiziBrainRuntimeState,
  provider: string,
  text: string,
): {
  skippedAggressiveMutation: boolean;
  /** True after a substantive final (>3 chars): log merged intent snapshot */
  shouldLogIntentResolution: boolean;
} {
  state.lastTranscriptSource = "deepgram_shadow";

  const t = text.trim();
  if (!t) {
    state.lastObservedEvent = `trusted_transcript_shadow.${provider}.empty`;
    return { skippedAggressiveMutation: true, shouldLogIntentResolution: false };
  }

  const shortAndAmbiguous = t.length < 4;
  if (shortAndAmbiguous) {
    state.lastObservedEvent = `trusted_transcript_shadow.${provider}.low_signal`;
    return { skippedAggressiveMutation: true, shouldLogIntentResolution: false };
  }

  state.lastObservedEvent = `trusted_transcript_shadow.${provider}.final`;
  state.lastDeepgramIntentTranscriptPreview = t.slice(0, 400);
  const r = classifyIntentFromSpeechHybrid(t, compiledForClassification(state));
  state.deepgramLastMatchedRuleIds = r.meta.matchedRuleIds;
  state.deepgramLastClassifySource = r.meta.classifySource;
  state.deepgramLastMatchedIntentSlug = r.meta.matchedIntentSlug;
  if (r.intent) {
    state.deepgramShadowIntent = r.intent;
    state.silenceSignalCount = 0;
    recomputeFinalIntent(state);
    return { skippedAggressiveMutation: false, shouldLogIntentResolution: true };
  }

  return { skippedAggressiveMutation: true, shouldLogIntentResolution: true };
}

export function ingestIiziBrainGreetingComplete(state: IiziBrainRuntimeState): void {
  state.greetingPlaybackComplete = true;
  state.lastObservedEvent = "greeting_completed";
}

/** Empty Whisper completion — informational silence */
export function ingestIiziBrainEmptyTranscript(state: IiziBrainRuntimeState): void {
  state.lastObservedEvent = "user_transcript_empty";
  const noClearYet =
    state.finalResolvedIntent === "unknown" || state.finalResolvedIntent === "unknown_conflict";
  if (!state.greetingPlaybackComplete || !noClearYet) return;
  state.silenceSignalCount = Math.min(99, state.silenceSignalCount + 1);
}

export type IiziBrainFlowIngestKind =
  | "call_started"
  | "combined_sms_sent"
  | "form_submitted"
  | "location_confirmed"
  | "vehicle_lookup_result"
  | "call_ended";

export function ingestIiziBrainFlow(
  state: IiziBrainRuntimeState,
  kind: IiziBrainFlowIngestKind,
  payload?: Record<string, unknown>,
): void {
  state.lastObservedEvent = kind;
  switch (kind) {
    case "call_started":
      state.workflowPhase = "pre_sms_intent_gate";
      state.lastTranscriptSource = "none";
      state.openaiRealtimeIntent = "unknown";
      state.deepgramShadowIntent = "unknown";
      state.intentCompareTurnSeq = 0;
      state.lastOpenaiIntentTranscriptPreview = "";
      state.lastDeepgramIntentTranscriptPreview = "";
      state.brainClassifierForceBuiltinFallback = false;
      resetPathwayClassifyScratch(state);
      recomputeFinalIntent(state);
      state.intentResolutionReason = "call_started_reset";
      break;
    case "combined_sms_sent":
      state.workflowPhase = "waiting_for_form_and_location";
      state.combinedSmsSuccessfullySent = true;
      state.formSeenAfterSms = false;
      state.locationSeenAfterSms = false;
      break;
    case "form_submitted":
      if (!state.combinedSmsSuccessfullySent) break;
      state.formSeenAfterSms = true;
      state.workflowPhase =
        state.formSeenAfterSms && state.locationSeenAfterSms ? "waiting_for_vehicle_lookup" : "form_submitted";
      break;
    case "location_confirmed":
      if (!state.combinedSmsSuccessfullySent) break;
      state.locationSeenAfterSms = true;
      state.workflowPhase =
        state.formSeenAfterSms && state.locationSeenAfterSms ? "waiting_for_vehicle_lookup" : "location_confirmed";
      break;
    case "vehicle_lookup_result": {
      if (!state.combinedSmsSuccessfullySent) break;
      const match = payload?.match === true;
      const coverageInvalid = payload?.coverage_invalid === true;
      if (!match) {
        state.workflowPhase = "vehicle_lookup_no_match";
      } else if (coverageInvalid) {
        state.workflowPhase = "vehicle_lookup_match_inactive";
      } else {
        state.workflowPhase = "vehicle_lookup_match_active";
      }
      break;
    }
    case "call_ended":
      state.workflowPhase = "idle";
      state.lastObservedEvent = "call_ended";
      state.lastTranscriptSource = "none";
      state.openaiRealtimeIntent = "unknown";
      state.deepgramShadowIntent = "unknown";
      state.intentCompareTurnSeq = 0;
      state.lastOpenaiIntentTranscriptPreview = "";
      state.lastDeepgramIntentTranscriptPreview = "";
      state.brainClassifierForceBuiltinFallback = false;
      resetPathwayClassifyScratch(state);
      recomputeFinalIntent(state);
      state.intentResolutionReason = "call_ended_reset";
      break;
    default:
      break;
  }
}

/** Whether combined SMS may be delivered — uses merged intent + brain gates */
export function gateIiziCombinedSms(state: IiziBrainRuntimeState): {
  allow: boolean;
  reasonCode: string;
  message: string;
  smsGateReason: string;
} {
  if (!state.runtimeBrainUi.gates.combinedSms) {
    return {
      allow: false,
      reasonCode: "combined_sms_disabled",
      smsGateReason: "sms_blocked_config_gate_combined_sms_false",
      message:
        "Combined reg+location SMS is disabled in agent brain settings. Do not send the combined template; follow verbal flow or handoff per policy.",
    };
  }

  const r = state.finalResolvedIntent;

  const deny = (reasonCode: string, smsGateReason: string, message: string) => ({
    allow: false as const,
    reasonCode,
    smsGateReason,
    message,
  });

  if (r === "unknown_conflict") {
    return deny(
      "intent_conflict",
      "sms_blocked_intent_conflict_openai_vs_deepgram",
      "Roadside intent is unclear — OpenAI transcript and Deepgram shadow disagree on roadside vs non-roadside. Do NOT send the combined roadside SMS yet. Verbally reconcile what the caller needs; do not escalate to SMS until consensus.",
    );
  }
  if (r === "non_roadside") {
    return deny(
      "intent_non_roadside",
      "sms_blocked_merged_non_roadside_intent",
      'Merged intent is NON-roadside. Do NOT send roadside SMS templates. Explain briefly that this line is for autoabi and offer transfer to human / callback.',
    );
  }
  if (r === "unknown") {
    return deny(
      "intent_unknown",
      "sms_blocked_merged_unknown_intent",
      "Merged roadside intent is unknown. Ask whether the caller needs roadside/emergency roadside assistance before sending the combined SMS. Do NOT send SMS until clarified.",
    );
  }
  if (r === "emergency_handoff") {
    return deny(
      "intent_emergency_handoff",
      "sms_blocked_emergency_handoff_escalate",
      "Merged intent is EMERGENCY / medical-style escalation — do NOT send combined roadside SMS. Route to emergency services / human handling per playbook.",
    );
  }

  if (r === "roadside") {
    const allow = state.brainCompiled.sendCombinedSmsGate["roadside"] !== false;
    if (!allow) {
      return deny(
        "brain_config_sms_gate",
        "sms_blocked_brain_config_send_combined_sms_roadside_disabled",
        "Brain configuration disallows combined SMS for roadside intent.",
      );
    }
    return {
      allow: true,
      reasonCode: "roadside_detected",
      smsGateReason: "sms_allowed_merged_roadside_intent",
      message: "Allowed: merged intent is roadside — combined roadside SMS permitted by policy.",
    };
  }

  return deny(
    "intent_unhandled",
    `sms_blocked_unhandled_merged_intent_${String(r)}`,
    "Unhandled merged intent for SMS policy — do NOT send combined SMS.",
  );
}

function guardSmsIntent(state: IiziBrainRuntimeState): IiziBrainGuardResults {
  const failures: string[] = [];
  const r = state.finalResolvedIntent;
  if (r === "unknown_conflict") failures.push("intent_conflict");
  if (r === "unknown") failures.push("intent_unknown");
  if (r === "non_roadside") failures.push("intent_non_roadside");
  if (r === "emergency_handoff") failures.push("intent_emergency_handoff");
  return { passed: failures.length === 0, failures };
}

export function deriveExpectedNextActionBrain(state: IiziBrainRuntimeState): string {
  const inSilenceLadder =
    state.finalResolvedIntent === "unknown" || state.finalResolvedIntent === "unknown_conflict";

  if (
    state.greetingPlaybackComplete &&
    inSilenceLadder &&
    state.workflowPhase === "pre_sms_intent_gate"
  ) {
    if (!state.combinedSmsSuccessfullySent && state.silenceSignalCount === 0) {
      return state.runtimeBrainUi.unknownIntentBehavior === "route_human"
        ? "route_human_unknown_intent_clarify_or_handoff"
        : "ask_if_caller_needs_roadside_assistance";
    }
    if (state.silenceSignalCount === 1) return "ask_if_anyone_is_there";
    if (state.silenceSignalCount === 2) return "explain_autoabi_or_human_route";
    if (state.silenceSignalCount >= 3) return "graceful_close_or_handoff";
  }

  switch (state.finalResolvedIntent) {
    case "unknown":
    case "unknown_conflict":
      if (
        state.finalResolvedIntent === "unknown" &&
        state.runtimeBrainUi.unknownIntentBehavior === "route_human"
      ) {
        return "route_human_unknown_intent_clarify_or_handoff";
      }
      if (
        state.finalResolvedIntent === "unknown_conflict" &&
        state.runtimeBrainUi.unknownIntentBehavior === "route_human"
      ) {
        return "route_human_unknown_conflict_escalate_or_clarify";
      }
      return "ask_if_caller_needs_roadside_assistance";
    case "non_roadside":
      return "route_non_roadside_to_human";
    case "emergency_handoff":
      return "route_emergency_human_immediate";
    case "roadside":
      if (!state.combinedSmsSuccessfullySent && state.workflowPhase === "pre_sms_intent_gate") {
        return "send_combined_reg_location_sms";
      }
      if (state.workflowPhase === "waiting_for_form_and_location") return "wait_for_form_and_location";
      if (state.workflowPhase === "form_submitted" || state.workflowPhase === "location_confirmed") {
        return "wait_for_vehicle_lookup";
      }
      break;
    default:
      break;
  }

  switch (state.workflowPhase) {
    case "waiting_for_vehicle_lookup":
      return "wait_for_vehicle_lookup";
    case "vehicle_lookup_match_active":
      return "say_vehicle_and_location_once_then_continue";
    case "vehicle_lookup_match_inactive":
    case "vehicle_lookup_no_match":
      return "route_to_human";
    default:
      return "observe";
  }
}

export function evaluateIiziBrain(state: IiziBrainRuntimeState, controlSmsGateActive: boolean): IiziBrainEvaluateResult {
  const guardResults = guardSmsIntent(state);
  const wf = state.workflowPhase;
  const coarseState =
    state.finalResolvedIntent === "unknown" ||
    state.finalResolvedIntent === "unknown_conflict" ||
    state.finalResolvedIntent === "emergency_handoff"
      ? `intent_triage.${wf}`
      : `${state.finalResolvedIntent}.${wf}`;
  const gateSnapshot = smsGatePeek(state);
  const expectedNextAction = deriveExpectedNextActionBrain(state);
  return {
    observedEvent: state.lastObservedEvent,
    state: coarseState,
    intentClassification: state.finalResolvedIntent,
    brainConfigDbVersion: state.brainConfigDbVersion,
    brainConfigSchemaVersion: state.brainCompiled.schemaVersion,
    matchedIntentOpenAI: state.openaiLastMatchedIntentSlug,
    matchedIntentDeepgram: state.deepgramLastMatchedIntentSlug,
    matchedRuleOpenAI: state.openaiLastMatchedRuleIds,
    matchedRuleDeepgram: state.deepgramLastMatchedRuleIds,
    classifySourceOpenAI: state.openaiLastClassifySource,
    classifySourceDeepgram: state.deepgramLastClassifySource,
    brainClassifierForceBuiltinFallback: state.brainClassifierForceBuiltinFallback,
    sourceIntentOpenAI: state.openaiRealtimeIntent,
    sourceIntentDeepgram: state.deepgramShadowIntent,
    finalResolvedIntent: state.finalResolvedIntent,
    intentResolutionReason: state.intentResolutionReason,
    smsGateReason: gateSnapshot.smsGateReason,
    expectedNextAction,
    transcriptSource: state.lastTranscriptSource,
    guardResults,
    controlMode: controlSmsGateActive ? "control" : "observe",
  };
}

export function logIiziBrainTrustedShadowTranscript(
  callId: string | null,
  sourceProvider: string,
  textSlice: string,
  snap: IiziBrainEvaluateResult,
): void {
  const preview = textSlice.slice(0, 220).replace(/\s+/g, " ").trim();
  console.log(
    `[IIZI-Brain] event=trusted_transcript_shadow source=${sourceProvider} ` +
      `brainConfigDbVersion=${snap.brainConfigDbVersion ?? "null"} schema=${snap.brainConfigSchemaVersion} ` +
      `classifierFailOpen=${snap.brainClassifierForceBuiltinFallback} ` +
      `matchedIntent=${snap.matchedIntentDeepgram ?? "null"} matchedRule=${snap.matchedRuleDeepgram} nextAction=${snap.expectedNextAction} ` +
      `transcriptSource=${snap.transcriptSource} intent=${snap.intentClassification} ` +
      `sourceIntentOpenAI=${snap.sourceIntentOpenAI} sourceIntentDeepgram=${snap.sourceIntentDeepgram} ` +
      `resolvedIntent=${snap.finalResolvedIntent} intentResolutionReason=${snap.intentResolutionReason} ` +
      `smsGateReason=${snap.smsGateReason} text="${preview}" state=${snap.state} controlMode=${snap.controlMode} ` +
      `callId=${callId || "?"} guardsPassed=${snap.guardResults.passed}`,
  );
}

export function logIiziBrainSnapshot(callId: string | null, snap: IiziBrainEvaluateResult): void {
  const id = callId || "?";
  console.log(
    `[IIZI-Brain] event=${snap.observedEvent} state=${snap.state} intent=${snap.intentClassification} ` +
      `brainConfigDbVersion=${snap.brainConfigDbVersion ?? "null"} schema=${snap.brainConfigSchemaVersion} ` +
      `classifierFailOpen=${snap.brainClassifierForceBuiltinFallback} ` +
      `matchedIntentOA=${snap.matchedIntentOpenAI ?? "null"} matchedRuleOA=${snap.matchedRuleOpenAI} classifySourceOA=${snap.classifySourceOpenAI} ` +
      `matchedIntentDG=${snap.matchedIntentDeepgram ?? "null"} matchedRuleDG=${snap.matchedRuleDeepgram} classifySourceDG=${snap.classifySourceDeepgram} ` +
      `sourceIntentOpenAI=${snap.sourceIntentOpenAI} sourceIntentDeepgram=${snap.sourceIntentDeepgram} resolvedIntent=${snap.finalResolvedIntent} ` +
      `intentResolutionReason=${snap.intentResolutionReason} smsGateReason=${snap.smsGateReason} transcriptSource=${snap.transcriptSource} ` +
      `nextAction=${snap.expectedNextAction} controlMode=${snap.controlMode} callId=${id} guardsPassed=${snap.guardResults.passed}`,
  );
}
