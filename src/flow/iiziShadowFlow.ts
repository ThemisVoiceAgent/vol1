import type {
  GuardResult,
  NextAction,
  NextActionType,
  RequiredEventType,
} from "./types.js";

export interface IiziShadowState {
  /** Append-only log of normalized shadow events for this call. */
  eventLog: Array<{ type: RequiredEventType; atIso: string }>;
  memory: Record<string, unknown>;
  stepId: string;
}

const isoNow = () => new Date().toISOString();

function appendLog(state: IiziShadowState, type: RequiredEventType): IiziShadowState {
  return {
    ...state,
    eventLog: [...state.eventLog, { type, atIso: isoNow() }],
  };
}

function deriveExpectedNextAction(state: IiziShadowState, lastEvent: RequiredEventType): NextAction {
  const m = state.memory;

  if (lastEvent === "call_ended" || state.stepId === "ended") {
    return { type: "no_op", reason: "call ended" };
  }

  if (lastEvent === "sms_received") {
    return {
      type: "say",
      messageKey: "iizi.shadow.ack_sms",
      reason: "Inbound SMS should be acknowledged in conversation",
    };
  }

  if (lastEvent === "end_call_requested") {
    return { type: "end_call", reason: "end_call tool was invoked" };
  }

  if (m.coverage_invalid === true || m.vehicle_match === false) {
    return {
      type: "route_human",
      messageKey: "iizi.shadow.invalid_vehicle_or_coverage",
      reason: "Vehicle missing or coverage invalid — human path expected",
    };
  }

  if (m.location_confirmed === true) {
    return {
      type: "say_and_wait",
      messageKey: "iizi.shadow.post_location_intake",
      reason: "Location confirmed — continue incident details / callback flow",
    };
  }

  if (m.vehicle_match === true && m.coverage_invalid !== true) {
    return {
      type: "wait_for_event",
      waitFor: ["location_confirmed"],
      reason: "Valid vehicle — await location confirmation",
    };
  }

  if (m.form_submitted === true) {
    return {
      type: "wait_for_event",
      waitFor: ["vehicle_lookup_result"],
      reason: "Form submitted — await strict vehicle lookup result",
    };
  }

  if (m.sms_sent === true) {
    return {
      type: "wait_for_event",
      waitFor: ["form_submitted"],
      reason: "Combined SMS sent — await form submission",
    };
  }

  if (m.call_started === true) {
    return {
      type: "call_tool",
      toolName: "send_sms",
      reason: "IIZI combined flow: expect combined registration/location SMS",
    };
  }

  return { type: "no_op", reason: "shadow: no IIZI baseline yet" };
}

function runOrderingGuards(
  prevMemory: Record<string, unknown>,
  input: { type: RequiredEventType; payload?: Record<string, unknown> },
): GuardResult[] {
  const guards: GuardResult[] = [];
  if (input.type === "location_confirmed" && !prevMemory.form_submitted) {
    guards.push({
      name: "order_location_after_form",
      pass: false,
      reason: "location_confirmed observed before form_submitted in shadow memory",
      wouldBlock: [] as NextActionType[],
    });
  }
  if (input.type === "vehicle_lookup_result" && !prevMemory.form_submitted) {
    guards.push({
      name: "order_lookup_after_form",
      pass: false,
      reason: "vehicle_lookup_result observed before form_submitted in shadow memory",
      wouldBlock: [] as NextActionType[],
    });
  }
  return guards;
}

/**
 * Pure reducer: previous shadow state + normalized event → next state + guards + expected next action.
 */
export function reduceIiziShadow(
  prev: IiziShadowState | null,
  input: { type: RequiredEventType; payload?: Record<string, unknown> },
): {
  state: IiziShadowState;
  guardResults: GuardResult[];
  expectedNextAction: NextAction;
  reason: string;
} {
  const base: IiziShadowState =
    prev ??
    ({
      eventLog: [],
      memory: {},
      stepId: "init",
    } satisfies IiziShadowState);

  const payload = input.payload ?? {};
  const guardResults = runOrderingGuards(base.memory, input);

  let state = appendLog(base, input.type);
  const mem = { ...state.memory };

  switch (input.type) {
    case "call_started":
      mem.call_started = true;
      state = { ...state, stepId: "call_live", memory: mem };
      break;
    case "sms_sent":
      mem.sms_sent = true;
      if (typeof payload.template_name === "string") mem.last_sms_template = payload.template_name;
      state = { ...state, stepId: "after_combined_sms", memory: mem };
      break;
    case "form_submitted":
      mem.form_submitted = true;
      if (typeof payload.reg === "string") mem.form_reg = payload.reg;
      if (typeof payload.callback_phone === "string") mem.form_callback_phone = payload.callback_phone;
      state = { ...state, stepId: "after_form", memory: mem };
      break;
    case "vehicle_lookup_result":
      if (typeof payload.match === "boolean") mem.vehicle_match = payload.match;
      if (typeof payload.coverage_invalid === "boolean") mem.coverage_invalid = payload.coverage_invalid;
      if (typeof payload.submitted_reg === "string") mem.submitted_reg = payload.submitted_reg;
      state = { ...state, stepId: "after_vehicle_lookup", memory: mem };
      break;
    case "location_confirmed":
      mem.location_confirmed = true;
      state = { ...state, stepId: "after_location", memory: mem };
      break;
    case "sms_received":
      mem.last_inbound_sms_at = isoNow();
      state = { ...state, memory: mem };
      break;
    case "end_call_requested":
      mem.end_call_requested = true;
      state = { ...state, stepId: "end_requested", memory: mem };
      break;
    case "call_ended":
      mem.call_ended = true;
      state = { ...state, stepId: "ended", memory: mem };
      break;
    default:
      state = { ...state, memory: mem };
      break;
  }

  const expectedNextAction = deriveExpectedNextAction(state, input.type);
  const reason = `shadow eval after ${input.type}`;

  return { state, guardResults, expectedNextAction, reason };
}
