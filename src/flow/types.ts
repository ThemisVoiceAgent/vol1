/**
 * Shadow flow engine types (Phase 1 — types only).
 * No runtime behavior; consumed later by engine + trace layers.
 */

export type FlowRuntimeMode = "off" | "shadow" | "soft_guard" | "hard_guard";

export type FlowTemplate =
  | "iizi_roadside"
  | "debt_collection"
  | "customer_support";

export type NextActionType =
  | "say"
  | "say_and_wait"
  | "ask_question"
  | "wait_for_event"
  | "call_tool"
  | "route_human"
  | "end_call"
  | "no_op"
  | "fallback";

/**
 * Canonical events. Shadow layer maps raw runtime signals (tool names, SYSTEM EVENT strings) here.
 */
export type RequiredEventType =
  | "call_started"
  /** Inbound SMS reply observed on this call (shadow / IIZI trace). */
  | "sms_received"
  /** Model invoked end_call tool (shadow; may still be blocked by runtime guards). */
  | "end_call_requested"
  | "user_utterance"
  | "tool_called"
  | "tool_succeeded"
  | "tool_failed"
  | "system_event"
  | "call_ended"
  | "sms_sent"
  | "form_submitted"
  | "vehicle_lookup_result"
  | "insurance_validated"
  | "location_confirmed"
  | "callback_number_confirmed"
  | "occupant_count_confirmed"
  | "human_handoff_requested"
  | "identity_confirmed"
  | "debt_notice_delivered"
  | "payment_plan_collected"
  | "payment_plan_confirmed"
  | "dispute_detected";

export interface RequiredEvent {
  type: RequiredEventType;
  /** If false, step may proceed without this event (documentation / soft hints). */
  required: boolean;
  /** Optional SLA hint for shadow metrics only. */
  timeoutMs?: number;
  /** Where we expect the event from (shadow / metrics). */
  sourceHint?: "user" | "tool" | "system" | "backend" | "unknown";
  notes?: string;
}

export interface NextAction {
  type: NextActionType;
  /** Stable key for i18n / template lookup later, e.g. "iizi.ask_incident_type". */
  messageKey?: string;
  /** Optional human-readable stub for logs only (not spoken in Phase 1). */
  messageStub?: string;
  /** For call_tool shadow: logical tool name as in runtime today. */
  toolName?: string;
  /** Opaque args shape reference or small JSON for trace (no execution). */
  toolArgsHint?: Record<string, unknown>;
  /** Events the engine is waiting on before advancing. */
  waitFor?: RequiredEventType[];
  /** Why this action was chosen (always set for observability). */
  reason: string;
}

export interface GuardResult {
  name: string;
  pass: boolean;
  reason: string;
  /** If pass === false, these action types would be rejected in future guard modes. */
  wouldBlock: NextActionType[];
}

export interface FlowStep {
  id: string;
  title: string;
  /** Events that must be satisfied to leave this step (semantics defined by engine). */
  requiredEvents: RequiredEvent[];
  allowedActions: NextActionType[];
  blockedActions: NextActionType[];
  /** Default recommendation when no transition fired on last event. */
  defaultNextAction: NextAction;
  /** Short phrase for logs / future TTS fallback (not wired in Phase 1). */
  fallbackPhrase: string;
  /** When true in shadow, expectedNextAction should prefer route_human. */
  handoffCondition?: string;
  /** When event fires, go to step id. */
  transitions?: Partial<Record<RequiredEventType, string>>;
}

export interface FlowDefinition {
  template: FlowTemplate;
  version: string;
  initialStepId: string;
  steps: Record<string, FlowStep>;
}

export interface ConversationState {
  callId: string;
  agentId?: string;
  tenantId?: string;
  template: FlowTemplate;
  mode: FlowRuntimeMode;
  currentStepId: string;
  /** Events observed in canonical form (append-only in engine reducer). */
  seenEvents: RequiredEventType[];
  /** Key-value slots filled by tools/system (e.g. vehicle_ok: true). */
  memory: Record<string, unknown>;
  startedAtIso: string;
  updatedAtIso: string;
}

export interface StateTransition {
  fromStepId: string;
  toStepId: string;
  triggerEvent: RequiredEventType;
  guardResults: GuardResult[];
  expectedNextAction: NextAction;
  reason: string;
  atIso: string;
}

export interface RuntimeTraceEvent {
  schemaVersion: 1;
  kind: "flow_shadow_eval";
  callId: string;
  agentId?: string;
  tenantId?: string;
  template: FlowTemplate;
  mode: FlowRuntimeMode;
  currentStepId: string;
  observedEvent: RequiredEventType | "tick" | "unknown";
  observedPayload?: Record<string, unknown>;
  conversationStateSnapshot: Pick<
    ConversationState,
    "currentStepId" | "seenEvents" | "memory"
  >;
  expectedNextAction: NextAction;
  allowedActions: NextActionType[];
  blockedActions: NextActionType[];
  guardResults: GuardResult[];
  reason: string;
  atIso: string;
  /** If the LLM requested an action in the same tick (when known). */
  modelAction?: {
    type?: string;
    toolName?: string;
    raw?: unknown;
  };
  transition?: StateTransition;
}
