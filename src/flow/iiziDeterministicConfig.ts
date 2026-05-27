/** IIZI deterministic flow — agent IDs, trigger index, localized lines. */

import { IIZI_LOCALIZED_LINES } from "./iiziDeterministicLocales.js";
import { normalizeTriggerPhrase } from "./iiziDeterministicNormalize.js";
import {
  IIZI_EN_LANG_HINTS,
  IIZI_ET_LANG_HINTS,
  IIZI_FUZZY_EXTRA,
  IIZI_NON_ROADSIDE_TRIGGER_DATA,
  IIZI_PASSENGER_TRIGGER_DATA,
  IIZI_ROADSIDE_TRIGGER_DATA,
  IIZI_RU_LANG_HINTS,
  IIZI_STRANDED_MOVE_PHRASES,
  IIZI_UNSAFE_TRIGGER_DATA,
} from "./iiziDeterministicTriggers.js";
import type { IiziLanguage, IiziRoadsideCategory } from "./iiziDeterministicTypes.js";

export const IIZI_DETERMINISTIC_AGENT_ID = "00def519-9dd5-402e-bb36-bbb4a865dbc6";
export const IIZI_DETERMINISTIC_AGENT_NAME = "Iizi autoaubi vol 2";

export type {
  IiziCanonicalCategory,
  IiziIncidentType,
  IiziLanguage,
  IiziRoadsideCategory,
} from "./iiziDeterministicTypes.js";

export { normalizeIiziTranscript } from "./iiziDeterministicNormalize.js";

export type IiziTriggerCategory = IiziRoadsideCategory;

function flattenLangPhrases(data: { et: readonly string[]; en: readonly string[]; ru: readonly string[] }): string[] {
  return [...data.et, ...data.en, ...data.ru];
}

export interface IiziTriggerIndexEntry {
  category: IiziRoadsideCategory;
  phrase: string;
  sourceLang: IiziLanguage;
}

function buildRoadsideIndex(): IiziTriggerIndexEntry[] {
  const entries: IiziTriggerIndexEntry[] = [];
  for (const [category, langs] of Object.entries(IIZI_ROADSIDE_TRIGGER_DATA) as [
    IiziRoadsideCategory,
    (typeof IIZI_ROADSIDE_TRIGGER_DATA)[IiziRoadsideCategory],
  ][]) {
    for (const lang of ["et", "en", "ru"] as IiziLanguage[]) {
      for (const raw of langs[lang]) {
        const phrase = normalizeTriggerPhrase(raw);
        if (phrase) entries.push({ category, phrase, sourceLang: lang });
      }
    }
  }
  return entries.sort((a, b) => b.phrase.length - a.phrase.length);
}

export const IIZI_ROADSIDE_TRIGGER_INDEX = buildRoadsideIndex();

export interface IiziPhraseIndexEntry {
  phrase: string;
  sourceLang: IiziLanguage;
}

function buildPhraseLangIndex(data: {
  et: readonly string[];
  en: readonly string[];
  ru: readonly string[];
}): IiziPhraseIndexEntry[] {
  const entries: IiziPhraseIndexEntry[] = [];
  for (const lang of ["et", "en", "ru"] as IiziLanguage[]) {
    for (const raw of data[lang]) {
      const phrase = normalizeTriggerPhrase(raw);
      if (phrase) entries.push({ phrase, sourceLang: lang });
    }
  }
  return entries.sort((a, b) => b.phrase.length - a.phrase.length);
}

export const IIZI_NON_ROADSIDE_INDEX = buildPhraseLangIndex(IIZI_NON_ROADSIDE_TRIGGER_DATA);

export const IIZI_UNSAFE_INDEX = buildPhraseLangIndex(IIZI_UNSAFE_TRIGGER_DATA);

/** @deprecated */
export const IIZI_NON_ROADSIDE_PHRASES_NORM = IIZI_NON_ROADSIDE_INDEX.map((e) => e.phrase);

/** @deprecated */
export const IIZI_UNSAFE_PHRASES_NORM = IIZI_UNSAFE_INDEX.map((e) => e.phrase);

export const IIZI_PASSENGER_PHRASES_NORM = flattenLangPhrases(IIZI_PASSENGER_TRIGGER_DATA).map(normalizeTriggerPhrase);

export const IIZI_STRANDED_MOVE_PHRASES_NORM = IIZI_STRANDED_MOVE_PHRASES.map(normalizeTriggerPhrase);

export const IIZI_FUZZY_CANONICAL_PHRASES = IIZI_FUZZY_EXTRA.map((x) => ({
  phrase: normalizeTriggerPhrase(x.phrase),
  category: x.category,
}));

export const IIZI_EN_LANG_HINTS_NORM = IIZI_EN_LANG_HINTS.map(normalizeTriggerPhrase);
export const IIZI_ET_LANG_HINTS_NORM = IIZI_ET_LANG_HINTS.map(normalizeTriggerPhrase);
export const IIZI_RU_LANG_HINTS_NORM = IIZI_RU_LANG_HINTS.map(normalizeTriggerPhrase);

/** @deprecated Use IIZI_LOCALIZED_LINES via resolveIiziLocalizedLine */
export const IIZI_EXACT_LINES: Record<string, string> = Object.fromEntries(
  Object.entries(IIZI_LOCALIZED_LINES).map(([id, loc]) => [id, loc.et]),
);

export const IIZI_FILLER_LINES: Record<string, string> = {
  "filler.short_ack_1": "Jah.",
  "filler.short_ack_2": "Selge.",
  "filler.short_ack_3": "Okei.",
  "filler.processing_1": "Üks hetk.",
  "filler.processing_2": "Vaatan seda.",
  "filler.processing_3": "Oodake hetk.",
  "filler.soft_pause_1": "Mm.",
  "filler.soft_pause_2": "Hmm.",
  "filler.soft_pause_3": "Eee.",
};

export type IiziFillerReason =
  | "transcript_processing"
  | "tool_pending_short"
  | "classifier_pending"
  | "safe_transition_pause";

export const IIZI_MINIMAL_REALTIME_PROMPT = `You are Maarika, the IIZI roadside assistance voice assistant.

The backend/orchestrator is the source of truth for this call. You do not decide the call flow.

Your job is to:
- speak clearly and calmly,
- read backend-provided exact lines exactly as given in the language provided,
- keep responses short,
- do not translate, paraphrase, or rewrite backend-provided lines.

Do not classify the caller's intent.
Do not decide the next step.
Do not choose SMS templates.
Do not call or describe tools unless the backend instructs it.
Do not continue the business flow from your own reasoning.
Do not say an SMS was sent unless the backend confirms success.
Do not say data was received unless a backend event confirms it.
Do not invent registration number, location, callback number, vehicle details, insurance status, or case completion.
Do not add filler words unless they are backend-provided as exact text.

If the backend provides an exact line to speak, speak only that line and add nothing.
If no backend-approved line is available, stay brief and wait for the next backend instruction.`;

export function incidentLineId(category: IiziRoadsideCategory | null): string {
  if (!category) return "incident.generic_roadside";
  return `incident.${category}`;
}

export function resolveIiziLocalizedLine(
  lineId: string,
  lang: IiziLanguage,
  vars?: Record<string, string>,
  callId?: string | null,
): string | null {
  const loc = IIZI_LOCALIZED_LINES[lineId];
  if (!loc) return null;
  const text = loc[lang] ?? loc.et;
  if (!loc[lang]) {
    console.log(
      `[IIZI-Deterministic] missingLocalizedLine=true line_id=${lineId} lang=${lang} fallback=et callId=${callId ?? "?"}`,
    );
  }
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

/** Backward-compatible: Estonian only */
export function resolveIiziExactLine(lineId: string, vars?: Record<string, string>): string | null {
  return resolveIiziLocalizedLine(lineId, "et", vars);
}

export interface OccupantRequirementResult {
  required: boolean;
  reason: string;
  passengerMentionDetected: boolean;
  passengerPhrase: string | null;
}

export function computeOccupantRequirement(
  category: IiziRoadsideCategory | null,
  normalizedTranscript: string,
): OccupantRequirementResult {
  for (const phrase of IIZI_PASSENGER_PHRASES_NORM) {
    if (normalizedTranscript.includes(phrase)) {
      return {
        required: true,
        reason: "passenger_mentioned",
        passengerMentionDetected: true,
        passengerPhrase: phrase,
      };
    }
  }
  const stranded = IIZI_STRANDED_MOVE_PHRASES_NORM.some((p) => normalizedTranscript.includes(p));
  if (!category) {
    return {
      required: stranded,
      reason: stranded ? "stranded_unknown_category" : "optional_unknown_category",
      passengerMentionDetected: false,
      passengerPhrase: null,
    };
  }
  if (category === "accident" || category === "tow_needed" || category === "no_start" || category === "stuck") {
    return {
      required: true,
      reason: category,
      passengerMentionDetected: false,
      passengerPhrase: null,
    };
  }
  if (category === "mechanical_issue") {
    if (stranded) {
      return {
        required: true,
        reason: "mechanical_cannot_move",
        passengerMentionDetected: false,
        passengerPhrase: null,
      };
    }
    return {
      required: false,
      reason: "mechanical_only",
      passengerMentionDetected: false,
      passengerPhrase: null,
    };
  }
  if (category === "generic_roadside" && stranded) {
    return {
      required: true,
      reason: "generic_stranded",
      passengerMentionDetected: false,
      passengerPhrase: null,
    };
  }
  return {
    required: false,
    reason: `optional_${category}`,
    passengerMentionDetected: false,
    passengerPhrase: null,
  };
}

/** @deprecated Use computeOccupantRequirement */
export function occupantRequiredForCategory(category: IiziRoadsideCategory | null): boolean {
  return computeOccupantRequirement(category, "").required;
}
