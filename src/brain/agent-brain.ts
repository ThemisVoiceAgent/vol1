/**
 * Runtime brain adapter: source of truth for IIZI combined inbound tool gating.
 * OpenAI Realtime may propose tools; this module validates before side effects run.
 */

import {
  evaluateIiziBrain,
  gateIiziCombinedSms,
  deriveExpectedNextActionBrain,
  type IiziBrainRuntimeState,
} from "../flow/iiziBrain.js";
import {
  DEFAULT_IIZI_AGENT_BRAIN_CONFIG,
  type AgentBrainConfig,
  type RuntimeBrainUiSettings,
} from "./agentBrainUiTypes.js";

export type BrainDecision = {
  resolvedIntent: string;
  confidence: number;
  currentState: string;
  nextState: string;
  nextAction: string;
  allowedActions: string[];
  blockedActions: string[];
  reason: string;
  speakInstruction?: string;
};

export type BrainRuntimeSnapshot = {
  callId: string | null;
  agentBrainConfig: AgentBrainConfig;
  useCombinedRegLocationSms: boolean;
  callDirection: "inbound" | "outbound";
  iiziBrain: IiziBrainRuntimeState;
  /** Pipeline flags (media-stream) */
  vehicleLookupPassed: boolean;
  vehicleValidationStatus: "unknown" | "valid" | "invalid";
  locationConfirmedFlag: boolean;
  locationStatus: string;
  vehicleReadbackDone: boolean;
  locationReadbackDone: boolean;
  incidentNeedsOccupantCount: boolean;
  occupantCountStatus: "unknown" | "pending" | "confirmed";
  occupantSystemPromptEmitted: boolean;
  callbackConfirmed: boolean;
  callbackPending: boolean;
  combinedSmsTemplateName: string;
  callbackSmsTemplateName: string;
  greetingCompletedAt: number | null;
  userUtteranceCount: number;
};

export type ToolValidationResult = {
  allowed: boolean;
  errorCode?: string;
  message?: string;
  /** Short system line for Realtime correction */
  correctionSystemText?: string;
};

const CLARIFY_ROADSIDE_ET = "Kas Teil on hetkel vaja autoabi?";

function uiPolicy(snap: BrainRuntimeSnapshot): RuntimeBrainUiSettings {
  return snap.iiziBrain.runtimeBrainUi;
}

/** Occupant step required for this call when CRM flagged need AND UI gate allows. */
function effectiveOccupantRequired(snap: BrainRuntimeSnapshot): boolean {
  return snap.incidentNeedsOccupantCount && uiPolicy(snap).gates.occupantCount;
}

/** Per-UI prerequisite toggles — when false, that checkpoint is skipped for occupant confirm. */
function occupantConfirmPrereqsMet(snap: BrainRuntimeSnapshot): boolean {
  const p = uiPolicy(snap).occupantPrerequisites;
  if (p.formSubmitted && !snap.iiziBrain.formSeenAfterSms) return false;
  if (p.vehicleLookupMatchActive && !(snap.vehicleLookupPassed && snap.vehicleValidationStatus === "valid"))
    return false;
  if (p.locationConfirmed && !snap.locationConfirmedFlag) return false;
  if (p.vehicleReadbackComplete && !snap.vehicleReadbackDone) return false;
  if (p.locationReadbackComplete && !snap.locationReadbackDone) return false;
  return true;
}

function confidenceFromIntent(resolved: string): number {
  if (resolved === "unknown" || resolved === "unknown_conflict") return 0.35;
  if (resolved === "roadside") return 0.92;
  if (resolved === "non_roadside") return 0.88;
  return 0.75;
}

function computeAllowedToolNames(snap: BrainRuntimeSnapshot): string[] {
  const allowed = new Set<string>();
  const tryAdd = (name: string, args?: { template_name?: string; count?: string }) => {
    const r = validateIiziInboundToolCall(snap, name, args || {});
    if (r.allowed) allowed.add(name);
  };

  tryAdd("lookup_vehicle");
  tryAdd("confirm_manual_location");
  tryAdd("mark_occupant_count_required");
  tryAdd("confirm_iizi_vehicle_readback_complete");
  tryAdd("confirm_iizi_location_readback_complete");
  tryAdd("confirm_iizi_callback_same_incoming_number");
  tryAdd("confirm_iizi_callback_phone_verbal");
  tryAdd("confirm_occupant_count", { count: "1" });

  tryAdd("send_sms", { template_name: snap.combinedSmsTemplateName });
  tryAdd("send_sms", { template_name: snap.callbackSmsTemplateName });

  if (uiPolicy(snap).gates.endCall) {
    tryAdd("end_call");
  }
  return Array.from(allowed);
}

function computeBlockedToolNames(snap: BrainRuntimeSnapshot, allowed: string[]): string[] {
  const all = [
    "send_sms",
    "lookup_vehicle",
    "confirm_manual_location",
    "mark_occupant_count_required",
    "confirm_occupant_count",
    "confirm_iizi_vehicle_readback_complete",
    "confirm_iizi_location_readback_complete",
    "confirm_iizi_callback_same_incoming_number",
    "confirm_iizi_callback_phone_verbal",
    "end_call",
  ];
  const allow = new Set(allowed);
  return all.filter((t) => !allow.has(t));
}

/**
 * Full brain evaluation for logging / future planner. Does not mutate state.
 */
export function evaluateBrain(snap: BrainRuntimeSnapshot): BrainDecision {
  const evalSnap = evaluateIiziBrain(snap.iiziBrain, true);
  const currentState = evalSnap.state;
  const allowedActions =
    snap.useCombinedRegLocationSms && snap.callDirection === "inbound"
      ? computeAllowedToolNames(snap)
      : ["send_sms", "lookup_vehicle", "confirm_manual_location", "mark_occupant_count_required", "confirm_occupant_count", "end_call"];
  const blockedActions = computeBlockedToolNames(snap, allowedActions);

  let speakInstruction: string | undefined;
  if (
    snap.useCombinedRegLocationSms &&
    snap.callDirection === "inbound" &&
    (evalSnap.finalResolvedIntent === "unknown" || evalSnap.finalResolvedIntent === "unknown_conflict") &&
    snap.iiziBrain.workflowPhase === "pre_sms_intent_gate" &&
    !snap.iiziBrain.combinedSmsSuccessfullySent
  ) {
    speakInstruction = CLARIFY_ROADSIDE_ET;
  }

  const nextAction = deriveExpectedNextActionBrain(snap.iiziBrain);
  const reason = `workflowPhase=${snap.iiziBrain.workflowPhase} expectedNextAction=${nextAction} smsGate=${evalSnap.smsGateReason}`;

  return {
    resolvedIntent: evalSnap.finalResolvedIntent,
    confidence: confidenceFromIntent(evalSnap.finalResolvedIntent),
    currentState,
    nextState: currentState,
    nextAction,
    allowedActions,
    blockedActions,
    reason,
    speakInstruction,
  };
}

function correctionPrefix(): string {
  return (
    `[SYSTEM EVENT: brain_tool_blocked] Internal note — do NOT read this tag aloud. ` +
    `The previous tool call was rejected by policy. Follow the instruction below exactly. `
  );
}

export function validateIiziInboundToolCall(
  snap: BrainRuntimeSnapshot,
  fnName: string,
  toolArgs: { template_name?: string; count?: string },
): ToolValidationResult {
  if (!snap.useCombinedRegLocationSms || snap.callDirection !== "inbound") {
    return { allowed: true };
  }

  const ui = uiPolicy(snap);
  /** Fail-open when brain off or shadow — avoids breaking calls; diagnostics may still log elsewhere. */
  if (!ui.enabled || ui.providerMode === "shadow") {
    return { allowed: true };
  }

  const gate = gateIiziCombinedSms(snap.iiziBrain);

  const deny = (errorCode: string, message: string, correction: string): ToolValidationResult => ({
    allowed: false,
    errorCode,
    message,
    correctionSystemText: correctionPrefix() + correction,
  });

  if (fnName === "send_sms") {
    const name = (toolArgs.template_name || "").trim();
    if (name === snap.combinedSmsTemplateName || name === "Registreerimisnumbri SMS" || name === "Asukoha SMS") {
      if (!gate.allow) {
        const clarify =
          snap.iiziBrain.finalResolvedIntent === "unknown" ||
          snap.iiziBrain.finalResolvedIntent === "unknown_conflict"
            ? ` If intent unclear, ask: "${CLARIFY_ROADSIDE_ET}"`
            : "";
        return deny(gate.reasonCode, gate.message, gate.message + clarify);
      }
    }
    if (name === snap.callbackSmsTemplateName) {
      if (!ui.gates.callbackConfirmation) {
        return deny(
          "callback_confirmation_disabled",
          "Callback confirmation/SMS is disabled in brain settings.",
          "Do not send callback collection SMS or finalize callback until policy allows.",
        );
      }
      if (effectiveOccupantRequired(snap) && snap.occupantCountStatus !== "confirmed") {
        return deny(
          "occupant_count_required",
          "Occupant count must be confirmed before callback SMS.",
          'Confirm occupant count first. Ask exactly: "Mitu inimest on autos koos juhiga?" then call confirm_occupant_count.',
        );
      }
      if (snap.vehicleValidationStatus !== "valid") {
        return deny("vehicle_not_validated", "Vehicle not validated.", "Wait for active vehicle match before callback SMS.");
      }
      if (snap.locationStatus !== "confirmed") {
        return deny("location_not_confirmed", "Location not confirmed.", "Wait for location confirmation before callback SMS.");
      }
      if (snap.useCombinedRegLocationSms && (!snap.vehicleReadbackDone || !snap.locationReadbackDone)) {
        return deny(
          "readback_incomplete",
          "Readbacks incomplete.",
          "Finish vehicle and location readback confirmations before callback SMS.",
        );
      }
    }
    return { allowed: true };
  }

  if (fnName === "confirm_iizi_vehicle_readback_complete") {
    if (!ui.gates.vehicleReadback) {
      return deny("vehicle_readback_gate_disabled", "Vehicle readback confirmation disabled.", "Skip vehicle readback tool per agent settings.");
    }
    if (!snap.vehicleLookupPassed || snap.vehicleValidationStatus !== "valid") {
      return deny("vehicle_not_ready", "Vehicle pipeline not ready.", "Complete vehicle lookup with valid cover first; read details to caller, then confirm.");
    }
    if (!snap.locationConfirmedFlag || snap.locationStatus !== "confirmed") {
      return deny("location_not_ready", "Location not confirmed.", "Wait for location_confirmed before vehicle readback tool.");
    }
    return { allowed: true };
  }

  if (fnName === "confirm_iizi_location_readback_complete") {
    if (!ui.gates.locationReadback) {
      return deny("location_readback_gate_disabled", "Location readback confirmation disabled.", "Skip location readback tool per agent settings.");
    }
    if (!snap.vehicleReadbackDone) {
      return deny("vehicle_readback_first", "Vehicle readback first.", "Call confirm_iizi_vehicle_readback_complete first.");
    }
    if (!snap.locationConfirmedFlag) {
      return deny("location_not_ready", "Location not confirmed.", "Wait for confirmed location before location readback tool.");
    }
    return { allowed: true };
  }

  const iiziCallbackStepReady =
    snap.vehicleLookupPassed &&
    snap.locationConfirmedFlag &&
    snap.vehicleReadbackDone &&
    snap.locationReadbackDone &&
    (!effectiveOccupantRequired(snap) || snap.occupantCountStatus === "confirmed");

  if (fnName === "confirm_iizi_callback_same_incoming_number") {
    if (!ui.gates.callbackConfirmation) {
      return deny(
        "callback_confirmation_disabled",
        "Callback confirmation is disabled in brain settings.",
        "Do not finalize callback preference via tools until policy allows.",
      );
    }
    if (!iiziCallbackStepReady) {
      return deny(
        "callback_gates_not_met",
        "Callback preference gates not met.",
        "Complete readbacks and occupant count (if required) before confirming callback on the same number.",
      );
    }
    if (snap.callbackPending) {
      return deny(
        "callback_pending_form",
        "Different-number SMS flow active.",
        "Wait for form callback phone or use verbal callback confirmation.",
      );
    }
    return { allowed: true };
  }

  if (fnName === "confirm_iizi_callback_phone_verbal") {
    if (!ui.gates.callbackConfirmation) {
      return deny(
        "callback_confirmation_disabled",
        "Callback confirmation is disabled in brain settings.",
        "Do not record verbal callback numbers until policy allows.",
      );
    }
    if (!iiziCallbackStepReady) {
      return deny(
        "callback_gates_not_met",
        "Callback preference gates not met.",
        "Complete prior steps before recording a verbal callback number.",
      );
    }
    return { allowed: true };
  }

  if (fnName === "confirm_occupant_count") {
    if (!ui.gates.occupantCount) {
      return deny(
        "occupant_gate_disabled",
        "Occupant count step disabled in brain settings.",
        "Do not confirm occupant count — gate is off for this agent.",
      );
    }
    const count = typeof toolArgs.count === "string" ? toolArgs.count.trim() : "";
    if (!count) return { allowed: true };

    if (!occupantConfirmPrereqsMet(snap)) {
      return deny(
        "occupant_gates_not_met",
        "Occupant confirm before pipeline ready.",
        "Wait for enabled prerequisite steps before confirm_occupant_count.",
      );
    }
    if (!snap.incidentNeedsOccupantCount) {
      return deny("occupant_not_required", "Occupant count not marked required.", "Only call confirm_occupant_count when mark_occupant_count_required applies.");
    }
    const stepEngaged = snap.occupantSystemPromptEmitted || snap.occupantCountStatus === "pending";
    if (!stepEngaged) {
      return deny(
        "occupant_prompt_not_engaged",
        "Occupant question not allowed/emitted yet.",
        'Do not confirm occupant count until you have asked "Mitu inimest on autos koos juhiga?" after all readbacks, or the system has emitted the occupant prompt.',
      );
    }
    return { allowed: true };
  }

  if (fnName === "mark_occupant_count_required") {
    if (!ui.gates.occupantCount) {
      return deny(
        "occupant_gate_disabled",
        "Occupant count gate disabled.",
        "Do not mark occupant count required — gate is off for this agent.",
      );
    }
    if (snap.iiziBrain.finalResolvedIntent === "non_roadside") {
      return deny(
        "intent_non_roadside",
        "Not a roadside case.",
        "Do not require occupant count for non-roadside; route to human per playbook.",
      );
    }
    return { allowed: true };
  }

  if (fnName === "end_call") {
    if (!ui.gates.endCall) {
      return deny("end_call_disabled", "end_call tool disabled in brain settings.", "Continue the conversation or transfer per playbook without hanging up via tool.");
    }
    const MIN_MS = ui.providerMode === "hard_guard" ? 18_000 : 12_000;
    const msSinceGreeting = snap.greetingCompletedAt ? Date.now() - snap.greetingCompletedAt : 0;
    const tooEarly = !snap.greetingCompletedAt || msSinceGreeting < MIN_MS;
    if (tooEarly || snap.userUtteranceCount === 0) {
      return deny("end_call_not_allowed_yet", "Too early.", "Do not end call until caller has spoken and minimum time after greeting has passed.");
    }
    if (effectiveOccupantRequired(snap) && snap.occupantCountStatus !== "confirmed") {
      return deny(
        "occupant_count_required",
        "Occupant count missing.",
        'Ask occupant count and confirm before end_call.',
      );
    }
    const handoffReady =
      snap.vehicleLookupPassed &&
      snap.locationConfirmedFlag &&
      snap.vehicleReadbackDone &&
      snap.locationReadbackDone &&
      (!effectiveOccupantRequired(snap) || snap.occupantCountStatus === "confirmed");
    if (handoffReady && !snap.callbackConfirmed && ui.gates.callbackConfirmation) {
      return deny(
        "callback_preference_incomplete",
        "Callback not finalized.",
        'Ask: "Kas tagasihelistamiseks kasutame sama numbrit, millelt praegu helistate?" and use the appropriate confirm tool or callback SMS only if they want a different number.',
      );
    }
    return { allowed: true };
  }

  if (fnName === "lookup_vehicle") {
    return { allowed: true };
  }

  return { allowed: true };
}

export function logBrainDecision(snap: BrainRuntimeSnapshot, decision: BrainDecision, toolContext?: string): void {
  if (!snap.iiziBrain.runtimeBrainUi.diagnostics.brainDecision) return;
  const id = snap.callId || "?";
  console.log(
    `[BrainDecision] callId=${id} toolContext=${toolContext || "evaluate"} ` +
      `transcriptSource=${snap.iiziBrain.lastTranscriptSource} providerMode=${snap.agentBrainConfig.providerMode} ` +
      `resolvedIntent=${decision.resolvedIntent} confidence=${decision.confidence.toFixed(2)} ` +
      `currentState=${decision.currentState} nextState=${decision.nextState} nextAction=${decision.nextAction} ` +
      `allowedActions=[${decision.allowedActions.join(",")}] blockedActions=[${decision.blockedActions.join(",")}] ` +
      `reason=${decision.reason}`,
  );
}

export function logBrainToolBlocked(
  snap: BrainRuntimeSnapshot,
  fnName: string,
  result: ToolValidationResult,
): void {
  if (!snap.iiziBrain.runtimeBrainUi.diagnostics.toolBlocked) return;
  const id = snap.callId || "?";
  console.warn(
    `[BrainToolBlocked] callId=${id} tool=${fnName} error=${result.errorCode || "?"} ` +
      `reason=${result.message || ""} transcriptSource=${snap.iiziBrain.lastTranscriptSource} ` +
      `providerMode=${snap.agentBrainConfig.providerMode} resolvedIntent=${snap.iiziBrain.finalResolvedIntent} ` +
      `workflowPhase=${snap.iiziBrain.workflowPhase}`,
  );
}

/** Default shipped UI config (until loaded from agent settings). */
export function getDefaultAgentBrainConfigForCall(): AgentBrainConfig {
  return DEFAULT_IIZI_AGENT_BRAIN_CONFIG;
}
