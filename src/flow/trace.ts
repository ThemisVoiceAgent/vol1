import { insertCallEvent } from "../supabase.js";
import { reduceIiziShadow, type IiziShadowState } from "./iiziShadowFlow.js";
import type { NextActionType, RequiredEventType, RuntimeTraceEvent } from "./types.js";

export function isFlowShadowTraceEnabled(): boolean {
  const v = (process.env.FLOW_SHADOW_TRACE_ENABLED || "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export interface IiziShadowTraceParams {
  callId: string;
  agentId?: string | null;
  /** Only trace when IIZI combined SMS mode is active for this call. */
  iiziCombinedMode: boolean;
  eventType: RequiredEventType;
  payload?: Record<string, unknown>;
  modelAction?: RuntimeTraceEvent["modelAction"];
  stateRef: { current: IiziShadowState | null };
}

/**
 * Read-only: updates shadow reducer state ref and persists one call_events row when enabled.
 * Wrapped in try/catch so shadow tracing never breaks the live call path.
 */
export function recordIiziShadowTrace(params: IiziShadowTraceParams): void {
  try {
    if (!isFlowShadowTraceEnabled()) return;
    if (!params.iiziCombinedMode) return;
    if (!params.callId) return;

    const { state, guardResults, expectedNextAction, reason } = reduceIiziShadow(params.stateRef.current, {
      type: params.eventType,
      payload: params.payload,
    });
    params.stateRef.current = state;

    const allowed: NextActionType[] = [expectedNextAction.type];
    const trace: RuntimeTraceEvent = {
      schemaVersion: 1,
      kind: "flow_shadow_eval",
      callId: params.callId,
      agentId: params.agentId ?? undefined,
      template: "iizi_roadside",
      mode: "shadow",
      currentStepId: state.stepId,
      observedEvent: params.eventType,
      observedPayload: params.payload,
      conversationStateSnapshot: {
        currentStepId: state.stepId,
        seenEvents: state.eventLog.map((e) => e.type),
        memory: state.memory,
      },
      expectedNextAction,
      allowedActions: allowed,
      blockedActions: [],
      guardResults,
      reason,
      atIso: new Date().toISOString(),
      modelAction: params.modelAction,
    };

    const payload = trace as unknown as Record<string, unknown>;
    insertCallEvent(params.callId, "flow_shadow_trace", payload).catch((err) => {
      console.error(`[FlowShadow] insertCallEvent failed callId=${params.callId}`, err);
    });
  } catch (err) {
    console.error(`[FlowShadow] recordIiziShadowTrace failed callId=${params.callId ?? "?"}`, err);
  }
}
