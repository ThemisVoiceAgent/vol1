/**
 * IIZI-only deterministic backend controller (strangler adapter).
 * Critical flow, classification, and exact speech are owned here — not OpenAI Realtime.
 */

import {
  IIZI_DETERMINISTIC_AGENT_ID,
  IIZI_DETERMINISTIC_AGENT_NAME,
  IIZI_FILLER_LINES,
  IIZI_EN_LANG_HINTS_NORM,
  IIZI_ET_LANG_HINTS_NORM,
  IIZI_RU_LANG_HINTS_NORM,
  computeOccupantRequirement,
  incidentLineId,
  resolveIiziLocalizedLine,
  type IiziFillerReason,
} from "./iiziDeterministicConfig.js";
export type { IiziFillerReason } from "./iiziDeterministicConfig.js";
export {
  normalizeIiziTranscript,
  resolveIiziLocalizedLine,
  resolveIiziExactLine,
  computeOccupantRequirement,
} from "./iiziDeterministicConfig.js";
import { normalizeIiziTranscript, transcriptHasCyrillic } from "./iiziDeterministicNormalize.js";
import {
  classifyTwoStage,
  occupantForClassification,
  updateClassifierContext,
  type TwoStageClassificationResult,
} from "./iiziDeterministicBroad.js";
import type { IiziIncidentType, IiziLanguage, IiziRoadsideCategory } from "./iiziDeterministicTypes.js";
export type { IiziLanguage, IiziRoadsideCategory, IiziIncidentType } from "./iiziDeterministicTypes.js";

export {
  IIZI_DETERMINISTIC_AGENT_ID,
  IIZI_DETERMINISTIC_AGENT_NAME,
  IIZI_MINIMAL_REALTIME_PROMPT,
} from "./iiziDeterministicConfig.js";

export type IiziDeterministicState =
  | "INIT"
  | "GREETING"
  | "WAITING_FOR_ISSUE"
  | "CLASSIFY_INTENT"
  | "ROADSIDE_CONFIRMED"
  | "NON_ROADSIDE_HUMAN_ROUTE"
  | "UNCLEAR_CLARIFY_ONCE"
  | "UNSAFE_HUMAN_ROUTE"
  | "CRM_LOOKUP"
  | "SEND_COMBINED_REG_LOCATION_SMS"
  | "WAITING_FOR_FORM_SUBMITTED"
  | "WAITING_FOR_VEHICLE_LOOKUP"
  | "VEHICLE_MATCHED_ACTIVE"
  | "VEHICLE_MISMATCH_HUMAN_ROUTE"
  | "INSURANCE_INACTIVE_HUMAN_ROUTE"
  | "WAITING_FOR_LOCATION_CONFIRMED"
  | "LOCATION_CONFIRMED"
  | "OCCUPANT_COUNT_REQUIRED"
  | "OCCUPANT_COUNT_CONFIRMED"
  | "ASK_CALLBACK_SAME_NUMBER"
  | "CALLBACK_SAME_NUMBER_CONFIRMED"
  | "SEND_CALLBACK_SMS"
  | "WAITING_FOR_CALLBACK_FORM"
  | "READY_FOR_HANDOFF"
  | "CLOSING_ASKED"
  | "CLOSED";

export type IiziClassificationMethod =
  | "exact"
  | "fuzzy"
  | "broad_roadside_evidence"
  | "clarification"
  | "human_route"
  | "non_roadside"
  | "unsafe"
  | "context_followup";

export type IiziBroadIntent =
  | "roadside_assistance"
  | "not_roadside_assistance"
  | "unsafe_volunteered"
  | "unclear";

export type IiziDeterministicAction =
  | { type: "speak_exact"; lineId: string; vars?: Record<string, string> }
  | { type: "speak_filler"; lineId: string; reason: IiziFillerReason }
  | { type: "send_combined_sms" }
  | { type: "send_callback_sms" }
  | { type: "mark_occupant_required"; category: IiziRoadsideCategory | null; normalizedTranscript?: string }
  | { type: "none" };

export interface IiziDeterministicRuntimeFlags {
  callerKnown: boolean;
  combinedSmsSent: boolean;
  combinedSmsSuccess: boolean;
  formSubmitted: boolean;
  vehicleMatch: boolean | null;
  coverActive: boolean | null;
  locationConfirmed: boolean;
  locationAddress: string;
  occupantCountConfirmed: boolean;
  occupantCountRequired: boolean;
  callbackSameNumber: boolean | null;
  callbackFormReceived: boolean;
  handoffSpoken: boolean;
  clarifyUsed: boolean;
  incidentCategory: IiziRoadsideCategory | null;
}

export type IiziLanguageDetectionMethod = "script" | "exact" | "keyword" | "default";

export interface IiziDeterministicCallContext {
  agentId: string | null;
  agentName: string;
  direction: "inbound" | "outbound";
  useCombinedRegLocationSms: boolean;
}

export interface IiziDeterministicGuardResult {
  active: boolean;
  guardReason: string;
  agentName: string;
  agentId: string | null;
}

export interface IiziDeterministicStateBag {
  currentState: IiziDeterministicState;
  processedEventKeys: Set<string>;
  lastFillerAt: number;
  lastClassificationLog: Record<string, unknown>;
  flags: IiziDeterministicRuntimeFlags;
  iiziLanguage: IiziLanguage;
  previousIiziLanguage: IiziLanguage | null;
  lastWeakRoadsideEvidenceCategory: IiziRoadsideCategory | null;
  lastBroadIntent: IiziBroadIntent | null;
  lastSubCategoryCandidate: IiziRoadsideCategory | null;
  lastUnclearTranscript: string;
  unclearCount: number;
}

export function createInitialIiziDeterministicState(): IiziDeterministicStateBag {
  return {
    currentState: "INIT",
    processedEventKeys: new Set(),
    lastFillerAt: 0,
    lastClassificationLog: {},
    flags: {
      callerKnown: false,
      combinedSmsSent: false,
      combinedSmsSuccess: false,
      formSubmitted: false,
      vehicleMatch: null,
      coverActive: null,
      locationConfirmed: false,
      locationAddress: "",
      occupantCountConfirmed: false,
      occupantCountRequired: false,
      callbackSameNumber: null,
      callbackFormReceived: false,
      handoffSpoken: false,
      clarifyUsed: false,
      incidentCategory: null,
    },
    iiziLanguage: "et",
    previousIiziLanguage: null,
    lastWeakRoadsideEvidenceCategory: null,
    lastBroadIntent: null,
    lastSubCategoryCandidate: null,
    lastUnclearTranscript: "",
    unclearCount: 0,
  };
}

export function isIiziDeterministicCall(ctx: IiziDeterministicCallContext): IiziDeterministicGuardResult {
  const agentName = (ctx.agentName || "").trim();
  const agentId = ctx.agentId?.trim() || null;
  const idMatch = agentId === IIZI_DETERMINISTIC_AGENT_ID;
  const nameMatch = agentName === IIZI_DETERMINISTIC_AGENT_NAME;
  const modeOk = ctx.useCombinedRegLocationSms && ctx.direction === "inbound";
  const active = modeOk && (idMatch || nameMatch);
  let guardReason = "not_iizi_deterministic_agent";
  if (!modeOk) guardReason = "not_combined_inbound";
  else if (idMatch) guardReason = "agent_id_match";
  else if (nameMatch) guardReason = "agent_name_match";
  else guardReason = "agent_mismatch";
  return { active, guardReason, agentName, agentId };
}

export function logIiziDeterministicGuard(
  callId: string | null,
  guard: IiziDeterministicGuardResult,
): void {
  console.log(
    `[IIZI-Deterministic] agentName="${guard.agentName}" agentId=${guard.agentId ?? "null"} ` +
      `iiziDeterministicMode=${guard.active} guardReason=${guard.guardReason} ` +
      `realtimePromptMode=${guard.active ? "minimal_non_authoritative" : "default"} ` +
      `backendOwnsCriticalFlow=${guard.active} backendOwnsLanguage=${guard.active} ` +
      `modelOwnsLanguage=false modelOwnsTranslation=false modelOwnsNextAction=false ` +
      `modelOwnsCriticalWording=false callId=${callId || "?"}`,
  );
}

export function resolveIiziFillerLine(lineId: string): string | null {
  return IIZI_FILLER_LINES[lineId] ?? null;
}

export interface IiziTranscriptClassification {
  broadIntent: IiziBroadIntent;
  subCategory: IiziRoadsideCategory | null;
  finalBackendIntent: "roadside_assistance" | "not_roadside_assistance" | "unclear" | "unsafe";
  incidentType: IiziIncidentType | null;
  classificationMethod: IiziClassificationMethod;
  matchedPhrase: string | null;
  canonicalPhrase: string | null;
  triggerCategory: IiziRoadsideCategory | null;
  classifierConfidence: number;
  subCategoryConfidence: number;
  broadRoadsideEvidenceDetected: boolean;
  broadRoadsideEvidenceTokens: string[];
  rawTranscript: string;
  normalizedTranscript: string;
  unsafeVolunteered: boolean;
  unsafePhrase: string | null;
  humanHandoffReason: string | null;
  suggestConfirmFlatTire: boolean;
  iiziLanguage: IiziLanguage;
  detectedLanguage: IiziLanguage;
  languageDetectionMethod: IiziLanguageDetectionMethod;
  languageSwitch: boolean;
  languageSwitchReason: string | null;
  occupantCountRequired: boolean;
  occupantCountRequiredReason: string;
  passengerMentionDetected: boolean;
  passengerPhrase: string | null;
}

export function detectIiziLanguage(
  rawTranscript: string,
  normalizedTranscript: string,
  currentLang: IiziLanguage,
): {
  lang: IiziLanguage;
  method: IiziLanguageDetectionMethod;
  switch: boolean;
  switchReason: string | null;
} {
  if (transcriptHasCyrillic(rawTranscript)) {
    return {
      lang: "ru",
      method: "script",
      switch: currentLang !== "ru",
      switchReason: currentLang !== "ru" ? "cyrillic_script" : null,
    };
  }

  let enScore = 0;
  let etScore = 0;
  let ruScore = 0;
  for (const h of IIZI_EN_LANG_HINTS_NORM) if (normalizedTranscript.includes(h)) enScore++;
  for (const h of IIZI_ET_LANG_HINTS_NORM) if (normalizedTranscript.includes(h)) etScore++;
  for (const h of IIZI_RU_LANG_HINTS_NORM) if (normalizedTranscript.includes(h)) ruScore++;

  if (enScore >= 2 && enScore >= etScore) {
    return {
      lang: "en",
      method: enScore > 0 ? "keyword" : "default",
      switch: currentLang !== "en",
      switchReason: currentLang !== "en" ? "english_keywords" : null,
    };
  }
  if (etScore >= 1 && etScore > enScore) {
    return {
      lang: "et",
      method: "keyword",
      switch: currentLang !== "et",
      switchReason: currentLang !== "et" ? "estonian_keywords" : null,
    };
  }
  if (ruScore >= 2) {
    return {
      lang: "ru",
      method: "keyword",
      switch: currentLang !== "ru",
      switchReason: currentLang !== "ru" ? "russian_keywords_latin" : null,
    };
  }

  return { lang: currentLang, method: "default", switch: false, switchReason: null };
}

function applyLanguageFromClassification(
  rawTranscript: string,
  normalizedTranscript: string,
  bag: IiziDeterministicStateBag,
  two: TwoStageClassificationResult,
  callId: string | null,
): Pick<
  IiziTranscriptClassification,
  | "iiziLanguage"
  | "detectedLanguage"
  | "languageDetectionMethod"
  | "languageSwitch"
  | "languageSwitchReason"
> {
  const prev = bag.iiziLanguage;
  let detectedLanguage: IiziLanguage;
  let languageDetectionMethod: IiziLanguageDetectionMethod;
  let languageSwitchReason: string | null = null;
  let matchedAliasLanguage: IiziLanguage | null = two.matchedAliasLanguage;
  let triggerIndexSource = two.triggerIndexSource ?? "default";

  if (transcriptHasCyrillic(rawTranscript)) {
    detectedLanguage = "ru";
    languageDetectionMethod = "script";
    matchedAliasLanguage = "ru";
    triggerIndexSource = "default";
    languageSwitchReason = prev !== "ru" ? "cyrillic_script" : null;
  } else if (two.matchedAliasLanguage) {
    detectedLanguage = two.matchedAliasLanguage;
    languageDetectionMethod = "exact";
    languageSwitchReason = "trigger_phrase_language";
  } else {
    const det = detectIiziLanguage(rawTranscript, normalizedTranscript, prev);
    detectedLanguage = det.lang;
    languageDetectionMethod = det.method;
    languageSwitchReason = det.switchReason;
    matchedAliasLanguage = null;
    triggerIndexSource = "default";
  }

  const languageSwitch = detectedLanguage !== prev;
  if (languageSwitch) {
    bag.previousIiziLanguage = prev;
    bag.iiziLanguage = detectedLanguage;
  }

  console.log(
    `[IIZI-Deterministic] iiziLanguage=${bag.iiziLanguage} previousIiziLanguage=${bag.previousIiziLanguage ?? "null"} ` +
      `detectedLanguage=${detectedLanguage} languageDetectionMethod=${languageDetectionMethod} ` +
      `languageSwitch=${languageSwitch} languageSwitchReason=${languageSwitchReason ?? "null"} ` +
      `matchedAliasLanguage=${matchedAliasLanguage ?? "null"} triggerIndexSource=${triggerIndexSource} ` +
      `callId=${callId || "?"}`,
  );

  return {
    iiziLanguage: bag.iiziLanguage,
    detectedLanguage,
    languageDetectionMethod,
    languageSwitch,
    languageSwitchReason,
  };
}

export function classifyIiziTranscript(
  rawTranscript: string,
  bag?: IiziDeterministicStateBag,
  callId?: string | null,
): IiziTranscriptClassification {
  const normalizedTranscript = normalizeIiziTranscript(rawTranscript);
  const langBag = bag ?? createInitialIiziDeterministicState();

  const two = classifyTwoStage(normalizedTranscript, langBag);
  if (bag) {
    updateClassifierContext(bag, normalizedTranscript, two);
  }

  const langFields = applyLanguageFromClassification(
    rawTranscript,
    normalizedTranscript,
    langBag,
    two,
    callId ?? null,
  );

  const category = two.subCategory ?? two.triggerCategory;
  const occ = occupantForClassification(category, normalizedTranscript);

  return {
    rawTranscript,
    normalizedTranscript,
    ...langFields,
    broadIntent: two.broadIntent,
    subCategory: two.subCategory,
    finalBackendIntent: two.finalBackendIntent,
    incidentType: category,
    classificationMethod: two.classificationMethod,
    matchedPhrase: two.matchedPhrase,
    canonicalPhrase: two.canonicalPhrase,
    triggerCategory: two.triggerCategory ?? category,
    classifierConfidence: two.classifierConfidence,
    subCategoryConfidence: two.subCategoryConfidence,
    broadRoadsideEvidenceDetected: two.broadRoadsideEvidenceDetected,
    broadRoadsideEvidenceTokens: two.broadRoadsideEvidenceTokens,
    unsafeVolunteered: two.unsafeVolunteered,
    unsafePhrase: two.unsafePhrase,
    humanHandoffReason: two.humanHandoffReason,
    suggestConfirmFlatTire: two.suggestConfirmFlatTire,
    occupantCountRequired: occ.required,
    occupantCountRequiredReason: occ.reason,
    passengerMentionDetected: occ.passengerMentionDetected,
    passengerPhrase: occ.passengerPhrase,
  };
}

function logClassification(callId: string | null, c: IiziTranscriptClassification, nextState: string): void {
  console.log(
    `[IIZI-Deterministic] rawTranscript="${c.rawTranscript.slice(0, 120)}" ` +
      `normalizedTranscript="${c.normalizedTranscript.slice(0, 120)}" ` +
      `iiziLanguage=${c.iiziLanguage} detectedLanguage=${c.detectedLanguage} ` +
      `languageDetectionMethod=${c.languageDetectionMethod} languageSwitch=${c.languageSwitch} ` +
      `broadIntent=${c.broadIntent} subCategory=${c.subCategory ?? "null"} ` +
      `classificationMethod=${c.classificationMethod} matchedPhrase=${c.matchedPhrase ?? "null"} ` +
      `canonicalPhrase=${c.canonicalPhrase ?? "null"} triggerCategory=${c.triggerCategory ?? "null"} ` +
      `classifierConfidence=${c.classifierConfidence.toFixed(2)} ` +
      `subCategoryConfidence=${c.subCategoryConfidence.toFixed(2)} ` +
      `broadRoadsideEvidenceDetected=${c.broadRoadsideEvidenceDetected} ` +
      `broadRoadsideEvidenceTokens=${c.broadRoadsideEvidenceTokens.join("|") || "none"} ` +
      `finalBackendIntent=${c.finalBackendIntent} ` +
      `occupantCountRequired=${c.occupantCountRequired} occupantCountRequiredReason=${c.occupantCountRequiredReason} ` +
      `passengerMentionDetected=${c.passengerMentionDetected} passengerPhrase=${c.passengerPhrase ?? "null"} ` +
      `unsafeVolunteered=${c.unsafeVolunteered} unsafePhrase=${c.unsafePhrase ?? "null"} ` +
      `humanHandoffReason=${c.humanHandoffReason ?? "null"} suggestConfirmFlatTire=${c.suggestConfirmFlatTire} ` +
      `unsafeRouteTaken=${c.finalBackendIntent === "unsafe"} nextState=${nextState} callId=${callId || "?"}`,
  );
}

function roadsideClassifiedActions(
  bag: IiziDeterministicStateBag,
  category: IiziRoadsideCategory,
  norm: string,
): IiziDeterministicAction[] {
  return [
    { type: "speak_exact", lineId: incidentLineId(category) },
    { type: "mark_occupant_required", category, normalizedTranscript: norm },
    { type: "speak_exact", lineId: bag.flags.callerKnown ? "crm.known" : "crm.unknown" },
    { type: "send_combined_sms" },
  ];
}

function eventKey(callId: string, type: string, payloadKey: string): string {
  return `${callId}:${type}:${payloadKey}`;
}

function isDuplicateEvent(bag: IiziDeterministicStateBag, key: string): boolean {
  if (bag.processedEventKeys.has(key)) return true;
  bag.processedEventKeys.add(key);
  return false;
}

function transition(
  bag: IiziDeterministicStateBag,
  next: IiziDeterministicState,
  reason: string,
  actions: IiziDeterministicAction[],
  callId: string | null,
): { actions: IiziDeterministicAction[]; transitionReason: string } {
  const prev = bag.currentState;
  bag.currentState = next;
  console.log(
    `[IIZI-Deterministic] currentState=${prev} nextState=${next} transitionReason=${reason} callId=${callId || "?"}`,
  );
  return { actions, transitionReason: reason };
}

function parseYesNo(normalized: string): boolean | null {
  if (/\b(ei|mitte|no)\b/.test(normalized) && !/\b(jah|yes|jaa)\b/.test(normalized)) return false;
  if (/\b(jah|jaa|yes|ok|okei|sama)\b/.test(normalized)) return true;
  return null;
}

function parseOccupantCount(normalized: string): number | null {
  const m = normalized.match(/\b(\d{1,2})\b/);
  if (m) return parseInt(m[1], 10);
  if (/\b(kaks|2)\b/.test(normalized)) return 2;
  if (/\b(uks|1|uks)\b/.test(normalized)) return 1;
  if (/\b(kolm|3)\b/.test(normalized)) return 3;
  return null;
}

function stripPostcode(address: string): string {
  return address.replace(/\b\d{5}\b/g, "").replace(/\s+/g, " ").trim();
}

export interface IiziDeterministicTurnInput {
  callId: string | null;
  event:
    | { type: "greeting_complete" }
    | { type: "user_transcript"; text: string }
    | { type: "combined_sms_result"; success: boolean; alreadySent?: boolean }
    | { type: "form_submitted" }
    | { type: "vehicle_lookup_result"; match: boolean; coverageInvalid?: boolean }
    | { type: "location_confirmed"; address: string }
    | { type: "callback_sms_result"; success: boolean }
    | { type: "callback_form_received" }
    | { type: "crm_prefetch"; callerKnown: boolean };
  bag: IiziDeterministicStateBag;
  now?: number;
}

export function reduceIiziDeterministicTurn(input: IiziDeterministicTurnInput): {
  actions: IiziDeterministicAction[];
  transitionReason: string;
  lineId?: string;
  remainingModelOwnedDecision?: string;
} {
  const { bag, event, callId } = input;
  const actions: IiziDeterministicAction[] = [];
  const cid = callId || "?";

  if (event.type === "crm_prefetch") {
    bag.flags.callerKnown = event.callerKnown;
    return transition(bag, "GREETING", "crm_prefetch", actions, callId);
  }

  if (event.type === "greeting_complete") {
    return transition(
      bag,
      "WAITING_FOR_ISSUE",
      "greeting_complete",
      [{ type: "none" }],
      callId,
    );
  }

  if (event.type === "user_transcript") {
    const norm = normalizeIiziTranscript(event.text);
    const state = bag.currentState;

    if (state === "UNCLEAR_CLARIFY_ONCE") {
      const c = classifyIiziTranscript(event.text, bag, callId);
      logClassification(callId, c, state);
      if (c.finalBackendIntent === "roadside_assistance") {
        const category = c.triggerCategory ?? c.subCategory ?? "generic_roadside";
        bag.flags.incidentCategory = category;
        bag.flags.occupantCountRequired = c.occupantCountRequired;
        return transition(
          bag,
          "ROADSIDE_CONFIRMED",
          "clarify_roadside",
          roadsideClassifiedActions(bag, category, norm),
          callId,
        );
      }
      if (c.finalBackendIntent === "not_roadside_assistance") {
        return transition(
          bag,
          "NON_ROADSIDE_HUMAN_ROUTE",
          "clarify_non_roadside",
          [{ type: "speak_exact", lineId: "handoff.human_followup" }],
          callId,
        );
      }
      if (bag.lastWeakRoadsideEvidenceCategory && bag.unclearCount >= 1) {
        return transition(
          bag,
          "UNCLEAR_CLARIFY_ONCE",
          "confirm_flat_tire_after_clarify",
          [{ type: "speak_exact", lineId: "intent.confirm_flat_tire" }],
          callId,
        );
      }
      return transition(
        bag,
        "NON_ROADSIDE_HUMAN_ROUTE",
        "clarify_still_unclear",
        [{ type: "speak_exact", lineId: "handoff.human_followup" }],
        callId,
      );
    }

    if (state === "WAITING_FOR_ISSUE" || state === "CLASSIFY_INTENT") {
      const c = classifyIiziTranscript(event.text, bag, callId);
      bag.lastClassificationLog = { ...c };
      logClassification(callId, c, bag.currentState);

      if (c.finalBackendIntent === "unsafe") {
        return transition(
          bag,
          "UNSAFE_HUMAN_ROUTE",
          "unsafe_volunteered",
          [{ type: "speak_exact", lineId: "handoff.human_followup" }],
          callId,
        );
      }
      if (c.finalBackendIntent === "not_roadside_assistance") {
        return transition(
          bag,
          "NON_ROADSIDE_HUMAN_ROUTE",
          "non_roadside",
          [{ type: "speak_exact", lineId: "handoff.human_followup" }],
          callId,
        );
      }
      if (c.finalBackendIntent === "roadside_assistance") {
        const category = c.triggerCategory ?? c.subCategory ?? "generic_roadside";
        if (
          c.suggestConfirmFlatTire &&
          c.classificationMethod !== "context_followup" &&
          c.subCategoryConfidence < 0.75 &&
          !bag.flags.clarifyUsed
        ) {
          bag.flags.clarifyUsed = true;
          return transition(
            bag,
            "UNCLEAR_CLARIFY_ONCE",
            "confirm_flat_tire_weak_evidence",
            [{ type: "speak_exact", lineId: "intent.confirm_flat_tire" }],
            callId,
          );
        }
        bag.flags.incidentCategory = category;
        bag.flags.occupantCountRequired = c.occupantCountRequired;
        return transition(
          bag,
          "ROADSIDE_CONFIRMED",
          "roadside_classified",
          roadsideClassifiedActions(bag, category, norm),
          callId,
        );
      }
      if (c.finalBackendIntent === "unclear") {
        if (c.suggestConfirmFlatTire || (bag.unclearCount >= 2 && bag.lastWeakRoadsideEvidenceCategory)) {
          bag.flags.clarifyUsed = true;
          return transition(
            bag,
            "UNCLEAR_CLARIFY_ONCE",
            "confirm_flat_tire_unclear_repeat",
            [{ type: "speak_exact", lineId: "intent.confirm_flat_tire" }],
            callId,
          );
        }
        if (!bag.flags.clarifyUsed) {
          bag.flags.clarifyUsed = true;
          return transition(
            bag,
            "UNCLEAR_CLARIFY_ONCE",
            "unclear_first",
            [{ type: "speak_exact", lineId: "intent.unclear_roadside_or_other" }],
            callId,
          );
        }
        if (bag.lastWeakRoadsideEvidenceCategory) {
          return transition(
            bag,
            "UNCLEAR_CLARIFY_ONCE",
            "confirm_flat_tire_before_handoff",
            [{ type: "speak_exact", lineId: "intent.confirm_flat_tire" }],
            callId,
          );
        }
        return transition(
          bag,
          "NON_ROADSIDE_HUMAN_ROUTE",
          "unclear_after_clarify",
          [{ type: "speak_exact", lineId: "handoff.human_followup" }],
          callId,
        );
      }
    }

    if (state === "ASK_CALLBACK_SAME_NUMBER") {
      const yn = parseYesNo(norm);
      if (yn === true) {
        bag.flags.callbackSameNumber = true;
        const handoffLine =
          bag.flags.incidentCategory === "tow_needed" ? "handoff.tow_partner" : "handoff.normal_partner";
        bag.flags.handoffSpoken = true;
        return transition(
          bag,
          "CLOSING_ASKED",
          "callback_same_number_then_handoff",
          [
            { type: "speak_exact", lineId: "callback.same_number_confirmed" },
            { type: "speak_exact", lineId: handoffLine },
            { type: "speak_exact", lineId: "closing.anything_else" },
          ],
          callId,
        );
      }
      if (yn === false) {
        bag.flags.callbackSameNumber = false;
        return transition(
          bag,
          "SEND_CALLBACK_SMS",
          "callback_different_number",
          [{ type: "send_callback_sms" }],
          callId,
        );
      }
      return { actions: [{ type: "none" }], transitionReason: "callback_awaiting_clear_answer" };
    }

    if (state === "OCCUPANT_COUNT_REQUIRED") {
      const n = parseOccupantCount(norm);
      if (n != null && n > 0) {
        bag.flags.occupantCountConfirmed = true;
        const speakLines: IiziDeterministicAction[] = [{ type: "speak_exact", lineId: "occupants.received" }];
        if (n === 2) {
          speakLines.unshift({ type: "speak_exact", lineId: "occupants.confirm_two" });
        }
        return transition(
          bag,
          "ASK_CALLBACK_SAME_NUMBER",
          "occupant_confirmed",
          [...speakLines, { type: "speak_exact", lineId: "callback.ask_same_number" }],
          callId,
        );
      }
      return {
        actions: [{ type: "speak_exact", lineId: "occupants.ask" }],
        transitionReason: "occupant_reask",
      };
    }

    if (state === "CLOSING_ASKED") {
      const yn = parseYesNo(norm);
      if (yn === false || /\b(aitah|head|kõik|kõik korras)\b/.test(norm)) {
        return transition(
          bag,
          "CLOSED",
          "closing_goodbye",
          [{ type: "speak_exact", lineId: "closing.goodbye" }],
          callId,
        );
      }
      return { actions: [{ type: "none" }], transitionReason: "closing_still_needs_help" };
    }

    return {
      actions: [{ type: "none" }],
      transitionReason: `user_transcript_ignored_state_${state}`,
      remainingModelOwnedDecision: `transcript_in_${state}`,
    };
  }

  if (event.type === "combined_sms_result") {
    const key = eventKey(cid, "combined_sms", event.alreadySent ? "already" : event.success ? "ok" : "fail");
    if (isDuplicateEvent(bag, key)) {
      console.log(`[IIZI-Deterministic] duplicate_event_ignored key=${key} callId=${cid}`);
      return { actions: [{ type: "none" }], transitionReason: "duplicate_combined_sms" };
    }
    bag.flags.combinedSmsSent = true;
    bag.flags.combinedSmsSuccess = event.success;
    const lineId = event.alreadySent
      ? "sms.combined.already_sent"
      : event.success
        ? "sms.combined.sent_success"
        : "sms.combined.send_failed";
    console.log(
      `[IIZI-Deterministic] smsTemplateSelected=Registreerimisnumbri ja asukoha SMS sendSmsSuccess=${event.success} ` +
        `smsConfirmationAllowed=${event.success} line_id=${lineId} callId=${cid}`,
    );
    if (!event.success) {
      return transition(bag, bag.currentState, "combined_sms_failed", [{ type: "speak_exact", lineId }], callId);
    }
    return transition(
      bag,
      "WAITING_FOR_FORM_SUBMITTED",
      "combined_sms_sent",
      [{ type: "speak_exact", lineId }],
      callId,
    );
  }

  if (event.type === "form_submitted") {
    const key = eventKey(cid, "form_submitted", "1");
    if (isDuplicateEvent(bag, key)) {
      console.log(`[IIZI-Deterministic] duplicate_event_ignored key=${key} callId=${cid}`);
      return { actions: [{ type: "none" }], transitionReason: "duplicate_form" };
    }
    bag.flags.formSubmitted = true;
    return transition(
      bag,
      "WAITING_FOR_VEHICLE_LOOKUP",
      "form_submitted",
      [{ type: "speak_exact", lineId: "form.registration.received" }],
      callId,
    );
  }

  if (event.type === "vehicle_lookup_result") {
    const pk = `${event.match}:${event.coverageInvalid ?? false}`;
    const key = eventKey(cid, "vehicle_lookup_result", pk);
    if (isDuplicateEvent(bag, key)) {
      console.log(`[IIZI-Deterministic] duplicate_event_ignored key=${key} callId=${cid}`);
      return { actions: [{ type: "none" }], transitionReason: "duplicate_vehicle" };
    }
    bag.flags.vehicleMatch = event.match;
    bag.flags.coverActive = event.coverageInvalid === true ? false : event.match ? true : null;
    console.log(
      `[IIZI-Deterministic] vehicleLookupMatch=${event.match} coverStatus=${bag.flags.coverActive} ` +
        `vehicleSpeechAllowed=${event.match && bag.flags.coverActive !== false} callId=${cid}`,
    );
    if (!event.match) {
      return transition(
        bag,
        "VEHICLE_MISMATCH_HUMAN_ROUTE",
        "vehicle_no_match",
        [{ type: "speak_exact", lineId: "vehicle.match_false.handoff" }],
        callId,
      );
    }
    if (event.coverageInvalid) {
      return transition(
        bag,
        "INSURANCE_INACTIVE_HUMAN_ROUTE",
        "insurance_inactive",
        [{ type: "speak_exact", lineId: "vehicle.insurance_inactive.handoff" }],
        callId,
      );
    }
    return transition(bag, "VEHICLE_MATCHED_ACTIVE", "vehicle_match_active", [{ type: "none" }], callId);
  }

  if (event.type === "location_confirmed") {
    const addr = stripPostcode(event.address);
    const key = eventKey(cid, "location_confirmed", addr.slice(0, 64));
    if (isDuplicateEvent(bag, key)) {
      console.log(`[IIZI-Deterministic] duplicate_event_ignored key=${key} callId=${cid}`);
      return { actions: [{ type: "none" }], transitionReason: "duplicate_location" };
    }
    if (bag.flags.vehicleMatch !== true || bag.flags.coverActive === false) {
      return { actions: [{ type: "none" }], transitionReason: "location_before_vehicle_gate" };
    }
    bag.flags.locationConfirmed = true;
    bag.flags.locationAddress = addr;
    console.log(`[IIZI-Deterministic] locationConfirmed=true callId=${cid}`);
    const afterLocation: IiziDeterministicAction[] = [
      { type: "speak_exact", lineId: "location.received.readback", vars: { address: addr } },
    ];
    if (bag.flags.occupantCountRequired && !bag.flags.occupantCountConfirmed) {
      return transition(
        bag,
        "OCCUPANT_COUNT_REQUIRED",
        "location_then_occupants",
        [...afterLocation, { type: "speak_exact", lineId: "occupants.ask" }],
        callId,
      );
    }
    return transition(
      bag,
      "ASK_CALLBACK_SAME_NUMBER",
      "location_then_callback",
      [...afterLocation, { type: "speak_exact", lineId: "callback.ask_same_number" }],
      callId,
    );
  }

  if (event.type === "callback_sms_result") {
    const key = eventKey(cid, "callback_sms", event.success ? "ok" : "fail");
    if (isDuplicateEvent(bag, key)) {
      console.log(`[IIZI-Deterministic] duplicate_event_ignored key=${key} callId=${cid}`);
      return { actions: [{ type: "none" }], transitionReason: "duplicate_callback_sms" };
    }
    const lineId = event.success ? "callback.different_number_sms_sent" : "callback.sms_failed";
    return transition(
      bag,
      event.success ? "WAITING_FOR_CALLBACK_FORM" : bag.currentState,
      "callback_sms_result",
      [{ type: "speak_exact", lineId }],
      callId,
    );
  }

  if (event.type === "callback_form_received") {
    const key = eventKey(cid, "callback_form", "1");
    if (isDuplicateEvent(bag, key)) {
      console.log(`[IIZI-Deterministic] duplicate_event_ignored key=${key} callId=${cid}`);
      return { actions: [{ type: "none" }], transitionReason: "duplicate_callback_form" };
    }
    bag.flags.callbackFormReceived = true;
    const handoffLine =
      bag.flags.incidentCategory === "tow_needed" ? "handoff.tow_partner" : "handoff.normal_partner";
    bag.flags.handoffSpoken = true;
    return transition(
      bag,
      "CLOSING_ASKED",
      "callback_form_then_handoff",
      [
        { type: "speak_exact", lineId: "callback.form_received" },
        { type: "speak_exact", lineId: handoffLine },
        { type: "speak_exact", lineId: "closing.anything_else" },
      ],
      callId,
    );
  }

  return { actions: [{ type: "none" }], transitionReason: "unhandled_event" };
}

/** After ROADSIDE_CONFIRMED speech ends — CRM + SMS (called from adapter). */
export function advanceAfterRoadsideConfirmed(
  bag: IiziDeterministicStateBag,
  callId: string | null,
): { actions: IiziDeterministicAction[]; transitionReason: string } {
  if (bag.currentState !== "ROADSIDE_CONFIRMED") {
    return { actions: [{ type: "none" }], transitionReason: "not_roadside_confirmed" };
  }
  return transition(
    bag,
    "SEND_COMBINED_REG_LOCATION_SMS",
    "after_incident_ack",
    [
      { type: "speak_exact", lineId: bag.flags.callerKnown ? "crm.known" : "crm.unknown" },
      { type: "send_combined_sms" },
    ],
    callId,
  );
}

/** Handoff + closing when gates satisfied. */
export function advanceIiziDeterministicHandoff(
  bag: IiziDeterministicStateBag,
  callId: string | null,
): { actions: IiziDeterministicAction[]; transitionReason: string } {
  if (bag.flags.handoffSpoken) {
    return { actions: [{ type: "none" }], transitionReason: "handoff_already_spoken" };
  }
  const lineId =
    bag.flags.incidentCategory === "tow_needed" ? "handoff.tow_partner" : "handoff.normal_partner";
  bag.flags.handoffSpoken = true;
  console.log(`[IIZI-Deterministic] handoffReady=true line_id=${lineId} callId=${callId || "?"}`);
  return transition(
    bag,
    "CLOSING_ASKED",
    "handoff_ready",
    [
      { type: "speak_exact", lineId },
      { type: "speak_exact", lineId: "closing.anything_else" },
    ],
    callId,
  );
}

export function pickIiziFillerLine(reason: IiziFillerReason): string {
  const pool =
    reason === "transcript_processing" || reason === "classifier_pending"
      ? ["filler.processing_1", "filler.processing_2", "filler.soft_pause_2"]
      : reason === "tool_pending_short"
        ? ["filler.processing_1", "filler.processing_3"]
        : ["filler.short_ack_2", "filler.soft_pause_1"];
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export interface MaybeSpeakFillerInput {
  bag: IiziDeterministicStateBag;
  reason: IiziFillerReason;
  now: number;
  assistantSpeaking: boolean;
  criticalLineQueued: boolean;
  cooldownMs?: number;
}

export function maybeSpeakIiziFiller(input: MaybeSpeakFillerInput): {
  lineId: string | null;
  suppressedReason: string | null;
} {
  const cooldownMs = input.cooldownMs ?? 8000;
  if (input.assistantSpeaking) {
    return { lineId: null, suppressedReason: "assistant_speaking" };
  }
  if (input.criticalLineQueued) {
    return { lineId: null, suppressedReason: "critical_line_queued" };
  }
  if (input.now - input.bag.lastFillerAt < cooldownMs) {
    return { lineId: null, suppressedReason: "filler_cooldown" };
  }
  const lineId = pickIiziFillerLine(input.reason);
  input.bag.lastFillerAt = input.now;
  console.log(
    `[IIZI-Deterministic] fillerUsed=true fillerLineId=${lineId} fillerReason=${input.reason} fillerSuppressedReason=null`,
  );
  return { lineId, suppressedReason: null };
}

/** Terminal FSM states where model-initiated end_call is permitted (backend owns closure until then). */
const IIZI_TERMINAL_STATES_ALLOW_MODEL_END_CALL: readonly IiziDeterministicState[] = [
  "CLOSED",
  "NON_ROADSIDE_HUMAN_ROUTE",
  "UNSAFE_HUMAN_ROUTE",
  "VEHICLE_MISMATCH_HUMAN_ROUTE",
  "INSURANCE_INACTIVE_HUMAN_ROUTE",
];

export function iiziDeterministicAllowsModelEndCall(state: IiziDeterministicState): boolean {
  return IIZI_TERMINAL_STATES_ALLOW_MODEL_END_CALL.includes(state);
}
