/**
 * Two-stage IIZI transcript classifier: broad intent first, then subcategory.
 */

import { normalizeTriggerPhrase } from "./iiziDeterministicNormalize.js";
import {
  IIZI_FUZZY_CANONICAL_PHRASES,
  IIZI_NON_ROADSIDE_INDEX,
  IIZI_ROADSIDE_TRIGGER_INDEX,
  IIZI_UNSAFE_INDEX,
  computeOccupantRequirement,
} from "./iiziDeterministicConfig.js";
import type { IiziLanguage, IiziRoadsideCategory } from "./iiziDeterministicTypes.js";

export type IiziTriggerIndexSource = "roadside" | "non_roadside" | "unsafe" | "broad_evidence";

interface PhraseLangMatch {
  phrase: string;
  sourceLang: IiziLanguage;
}

/** Classifier memory on deterministic state bag (avoids circular import). */
export interface IiziClassifierMemory {
  lastWeakRoadsideEvidenceCategory: IiziRoadsideCategory | null;
  lastBroadIntent: string | null;
  lastSubCategoryCandidate: IiziRoadsideCategory | null;
  lastUnclearTranscript: string;
  unclearCount: number;
}

export type IiziBroadIntent =
  | "roadside_assistance"
  | "not_roadside_assistance"
  | "unsafe_volunteered"
  | "unclear";

export type IiziClassificationMethod =
  | "exact"
  | "fuzzy"
  | "broad_roadside_evidence"
  | "non_roadside"
  | "unsafe"
  | "clarification"
  | "context_followup";

const BROAD_ROADSIDE_TOKENS_ET = [
  "auto", "soiduk", "sõiduk", "masin", "rehv", "reff", "autoreff", "autorehv", "kumm", "ratas",
  "tuhi", "tyhi", "tühi", "katki", "purunenud", "purunes", "puru", "ei liigu", "ei saa liikuda",
  "ei saa edasi soita", "ei saa edasi sõita", "ei kaivitu", "ei käivitu", "kaima ei lahe",
  "käima ei lähe", "aku", "mootor", "generaator", "genekas", "lekib", "oli", "õli", "puksiir",
  "pukseerimine", "kinni", "kraavis", "uksed lukus", "votmed autos", "võtmed autos", "autoabi",
  "autoga probleem", "auto probleem",
];

const BROAD_ROADSIDE_TOKENS_EN = [
  "car", "vehicle", "tire", "tyre", "wheel", "flat", "broken", "does not move", "cannot move",
  "cannot drive", "won't start", "wont start", "battery", "engine", "alternator", "leaking", "oil",
  "tow", "towing", "stuck", "locked out", "keys in car", "roadside", "breakdown",
];

const BROAD_ROADSIDE_TOKENS_RU = [
  "машина", "автомобиль", "авто", "колесо", "шина", "спущено", "сломалась", "не едет",
  "не могу ехать", "не заводится", "аккумулятор", "двигатель", "мотор", "генератор", "течет",
  "масло", "эвакуатор", "буксировка", "застряла", "застрял", "ключи в машине",
];

const BROAD_ROADSIDE_TOKENS_ET_NORM = BROAD_ROADSIDE_TOKENS_ET.map(normalizeTriggerPhrase);
const BROAD_ROADSIDE_TOKENS_EN_NORM = BROAD_ROADSIDE_TOKENS_EN.map(normalizeTriggerPhrase);
const BROAD_ROADSIDE_TOKENS_RU_NORM = BROAD_ROADSIDE_TOKENS_RU.map(normalizeTriggerPhrase);

const BROAD_ROADSIDE_TOKENS_NORM = [
  ...BROAD_ROADSIDE_TOKENS_ET_NORM,
  ...BROAD_ROADSIDE_TOKENS_EN_NORM,
  ...BROAD_ROADSIDE_TOKENS_RU_NORM,
];

const TIRE_ISH_TOKENS = [
  "rehv", "reff", "autoreff", "autorehv", "kumm", "ratas", "tire", "tyre", "wheel", "колесо", "шина",
  "flat",
];

const EMPTY_BROKEN_TOKENS = [
  "tuhi", "tyhi", "tuhjaks", "tyhjaks", "katki", "purunenud", "purunes", "puru", "puncture",
  "спущено", "пробило", "лопнуло", "лопнула",
];

const CANNOT_MOVE_TOKENS = [
  "ei liigu", "ei saa liikuda", "ei saa edasi soita", "does not move", "cannot move", "cannot drive",
  "car wont move", "car won't move", "машина не едет", "не могу ехать",
];

const TOW_TOKENS = ["puksiir", "pukseerimine", "tow", "towing", "эвакуатор", "буксировка", "evakuator"];

const NO_START_TOKENS = [
  "ei kaivitu", "ei käivitu", "kaima ei lahe", "wont start", "won't start", "battery dead",
  "не заводится", "аккумулятор",
];

const STUCK_TOKENS = ["kinni", "kraavis", "stuck", "застрял", "застряла"];

const FUEL_TOKENS = ["kutus otsas", "kutus otsas", "out of fuel", "out of gas", "нет топлива", "бак пустой"];

const LOCKED_TOKENS = ["votmed autos", "võtmed autos", "locked out", "keys in car", "ключи в машине"];

const MECHANICAL_TOKENS = [
  "lekib", "oli lekib", "õli", "generaator", "genekas", "mootor kuumeneb", "overheating", "leaking",
  "течет", "масло", "генератор", "перегревается",
];

function collectMatchingTokens(normalized: string, tokens: readonly string[]): string[] {
  const found: string[] = [];
  for (const t of tokens) {
    const n = normalizeTriggerPhrase(t);
    if (n && normalized.includes(n)) found.push(n);
  }
  return [...new Set(found)];
}

function findLongestPhraseInIndex(
  normalized: string,
  index: readonly { phrase: string; sourceLang: IiziLanguage }[],
): PhraseLangMatch | null {
  for (const { phrase, sourceLang } of index) {
    if (phrase && normalized.includes(phrase)) {
      return { phrase, sourceLang };
    }
  }
  return null;
}

/** Language from longest matching broad-evidence token in a single locale list. */
function detectBroadEvidenceLanguage(normalized: string): IiziLanguage | null {
  const scoreFor = (tokens: readonly string[]): { count: number; longest: number } => {
    const matched = collectMatchingTokens(normalized, tokens);
    return {
      count: matched.length,
      longest: matched.reduce((m, t) => Math.max(m, t.length), 0),
    };
  };
  const scores: { lang: IiziLanguage; count: number; longest: number }[] = [
    { lang: "et", ...scoreFor(BROAD_ROADSIDE_TOKENS_ET_NORM) },
    { lang: "en", ...scoreFor(BROAD_ROADSIDE_TOKENS_EN_NORM) },
    { lang: "ru", ...scoreFor(BROAD_ROADSIDE_TOKENS_RU_NORM) },
  ];
  const ranked = scores.filter((s) => s.count > 0).sort((a, b) => b.count - a.count || b.longest - a.longest);
  return ranked[0]?.lang ?? null;
}

export function detectBroadRoadsideEvidence(normalized: string): {
  detected: boolean;
  tokens: string[];
  evidenceLang: IiziLanguage | null;
} {
  const tokens = collectMatchingTokens(normalized, BROAD_ROADSIDE_TOKENS_NORM);
  return {
    detected: tokens.length > 0,
    tokens,
    evidenceLang: detectBroadEvidenceLanguage(normalized),
  };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

function fuzzySimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length, 1);
  return 1 - levenshtein(a, b) / maxLen;
}

function findExactOrFuzzyCategory(
  normalized: string,
): {
  category: IiziRoadsideCategory;
  phrase: string;
  method: "exact" | "fuzzy";
  confidence: number;
  sourceLang: IiziLanguage;
} | null {
  for (const { category, phrase, sourceLang } of IIZI_ROADSIDE_TRIGGER_INDEX) {
    if (normalized.includes(phrase)) {
      return { category, phrase, method: "exact", confidence: 1, sourceLang };
    }
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (const { phrase, category } of IIZI_FUZZY_CANONICAL_PHRASES) {
    if (normalized.includes(phrase)) {
      return { category, phrase, method: "exact", confidence: 1, sourceLang: "et" };
    }
    const sim = fuzzySimilarity(normalized.replace(/\s/g, ""), phrase.replace(/\s/g, ""));
    const tokenHit = tokens.some((tok) => fuzzySimilarity(tok, phrase.split(/\s+/)[0] || phrase) >= 0.82);
    if (sim >= 0.88 || tokenHit) {
      return {
        category,
        phrase,
        method: "fuzzy",
        confidence: sim >= 0.88 ? sim : 0.82,
        sourceLang: "et",
      };
    }
  }
  return null;
}

function hasAnyToken(normalized: string, tokens: readonly string[]): boolean {
  return collectMatchingTokens(normalized, tokens).length > 0;
}

/** Stage 2: infer subcategory from evidence when no strong phrase match. */
export function inferSubCategoryFromEvidence(
  normalized: string,
  strongMatch: IiziRoadsideCategory | null,
): { subCategory: IiziRoadsideCategory; confidence: number; weakTireHint: boolean } {
  if (strongMatch) {
    return { subCategory: strongMatch, confidence: 1, weakTireHint: false };
  }

  const tireHit = hasAnyToken(normalized, TIRE_ISH_TOKENS);
  const emptyHit = hasAnyToken(normalized, EMPTY_BROKEN_TOKENS);
  if (tireHit && emptyHit) {
    return { subCategory: "flat_tire", confidence: 0.88, weakTireHint: false };
  }
  if (tireHit) {
    return { subCategory: "flat_tire", confidence: 0.65, weakTireHint: true };
  }

  if (hasAnyToken(normalized, TOW_TOKENS) || hasAnyToken(normalized, CANNOT_MOVE_TOKENS)) {
    return { subCategory: "tow_needed", confidence: 0.8, weakTireHint: false };
  }
  if (hasAnyToken(normalized, NO_START_TOKENS)) {
    return { subCategory: "no_start", confidence: 0.8, weakTireHint: false };
  }
  if (hasAnyToken(normalized, STUCK_TOKENS)) {
    return { subCategory: "stuck", confidence: 0.8, weakTireHint: false };
  }
  if (hasAnyToken(normalized, FUEL_TOKENS)) {
    return { subCategory: "out_of_fuel", confidence: 0.8, weakTireHint: false };
  }
  if (hasAnyToken(normalized, LOCKED_TOKENS)) {
    return { subCategory: "locked_out", confidence: 0.8, weakTireHint: false };
  }
  if (hasAnyToken(normalized, MECHANICAL_TOKENS)) {
    return { subCategory: "mechanical_issue", confidence: 0.75, weakTireHint: false };
  }

  return { subCategory: "generic_roadside", confidence: 0.55, weakTireHint: false };
}

function findUnsafe(normalized: string): PhraseLangMatch | null {
  return findLongestPhraseInIndex(normalized, IIZI_UNSAFE_INDEX);
}

function findNonRoadside(normalized: string): PhraseLangMatch | null {
  return findLongestPhraseInIndex(normalized, IIZI_NON_ROADSIDE_INDEX);
}

function isGarbledFollowUp(normalized: string): boolean {
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length <= 8 && !findNonRoadside(normalized);
}

export interface TwoStageClassificationResult {
  broadIntent: IiziBroadIntent;
  subCategory: IiziRoadsideCategory | null;
  finalBackendIntent: "roadside_assistance" | "not_roadside_assistance" | "unclear" | "unsafe";
  classificationMethod: IiziClassificationMethod;
  triggerCategory: IiziRoadsideCategory | null;
  matchedPhrase: string | null;
  canonicalPhrase: string | null;
  classifierConfidence: number;
  subCategoryConfidence: number;
  broadRoadsideEvidenceDetected: boolean;
  broadRoadsideEvidenceTokens: string[];
  unsafeVolunteered: boolean;
  unsafePhrase: string | null;
  humanHandoffReason: string | null;
  suggestConfirmFlatTire: boolean;
  matchedAliasLanguage: IiziLanguage | null;
  triggerIndexSource: IiziTriggerIndexSource | "default" | null;
}

function withAliasLang(
  result: Omit<TwoStageClassificationResult, "matchedAliasLanguage" | "triggerIndexSource">,
  lang: IiziLanguage | null,
  source: IiziTriggerIndexSource | "default" | null,
): TwoStageClassificationResult {
  return {
    ...result,
    matchedAliasLanguage: lang,
    triggerIndexSource: source,
  };
}

export function classifyTwoStage(
  normalized: string,
  bag: IiziClassifierMemory,
): TwoStageClassificationResult {
  const broadEvidence = detectBroadRoadsideEvidence(normalized);

  // Context follow-up: prior weak tire + garbled utterance
  if (
    bag.lastWeakRoadsideEvidenceCategory === "flat_tire" &&
    isGarbledFollowUp(normalized) &&
    !findNonRoadside(normalized)
  ) {
    return withAliasLang(
      {
        broadIntent: "roadside_assistance",
        subCategory: "flat_tire",
        finalBackendIntent: "roadside_assistance",
        classificationMethod: "context_followup",
        triggerCategory: "flat_tire",
        matchedPhrase: normalized.slice(0, 80),
        canonicalPhrase: "flat_tire_context",
        classifierConfidence: 0.75,
        subCategoryConfidence: 0.75,
        broadRoadsideEvidenceDetected: broadEvidence.detected,
        broadRoadsideEvidenceTokens: broadEvidence.tokens,
        unsafeVolunteered: false,
        unsafePhrase: null,
        humanHandoffReason: null,
        suggestConfirmFlatTire: true,
      },
      broadEvidence.evidenceLang ?? "et",
      "roadside",
    );
  }

  const unsafeMatch = findUnsafe(normalized);
  if (unsafeMatch) {
    return withAliasLang(
      {
        broadIntent: "unsafe_volunteered",
        subCategory: null,
        finalBackendIntent: "unsafe",
        classificationMethod: "unsafe",
        triggerCategory: null,
        matchedPhrase: unsafeMatch.phrase,
        canonicalPhrase: unsafeMatch.phrase,
        classifierConfidence: 1,
        subCategoryConfidence: 0,
        broadRoadsideEvidenceDetected: broadEvidence.detected,
        broadRoadsideEvidenceTokens: broadEvidence.tokens,
        unsafeVolunteered: true,
        unsafePhrase: unsafeMatch.phrase,
        humanHandoffReason: "unsafe_volunteered",
        suggestConfirmFlatTire: false,
      },
      unsafeMatch.sourceLang,
      "unsafe",
    );
  }

  const strong = findExactOrFuzzyCategory(normalized);
  if (strong) {
    return withAliasLang(
      {
        broadIntent: "roadside_assistance",
        subCategory: strong.category,
        finalBackendIntent: "roadside_assistance",
        classificationMethod: strong.method,
        triggerCategory: strong.category,
        matchedPhrase: strong.phrase,
        canonicalPhrase: strong.phrase,
        classifierConfidence: strong.confidence,
        subCategoryConfidence: strong.confidence,
        broadRoadsideEvidenceDetected: broadEvidence.detected,
        broadRoadsideEvidenceTokens: broadEvidence.tokens,
        unsafeVolunteered: false,
        unsafePhrase: null,
        humanHandoffReason: null,
        suggestConfirmFlatTire: false,
      },
      strong.sourceLang,
      "roadside",
    );
  }

  const nonRoadsideMatch = findNonRoadside(normalized);
  if (nonRoadsideMatch && !broadEvidence.detected) {
    return withAliasLang(
      {
        broadIntent: "not_roadside_assistance",
        subCategory: null,
        finalBackendIntent: "not_roadside_assistance",
        classificationMethod: "non_roadside",
        triggerCategory: null,
        matchedPhrase: nonRoadsideMatch.phrase,
        canonicalPhrase: nonRoadsideMatch.phrase,
        classifierConfidence: 0.9,
        subCategoryConfidence: 0,
        broadRoadsideEvidenceDetected: false,
        broadRoadsideEvidenceTokens: [],
        unsafeVolunteered: false,
        unsafePhrase: null,
        humanHandoffReason: null,
        suggestConfirmFlatTire: false,
      },
      nonRoadsideMatch.sourceLang,
      "non_roadside",
    );
  }

  if (broadEvidence.detected) {
    const inferred = inferSubCategoryFromEvidence(normalized, null);
    if (nonRoadsideMatch) {
      // Mixed: roadside wins when immediate vehicle help evidence exists (e.g. rehv tühi + kindlustus)
    }
    return withAliasLang(
      {
        broadIntent: "roadside_assistance",
        subCategory: inferred.subCategory,
        finalBackendIntent: "roadside_assistance",
        classificationMethod: "broad_roadside_evidence",
        triggerCategory: inferred.subCategory,
        matchedPhrase: broadEvidence.tokens.slice(0, 3).join(",") || null,
        canonicalPhrase: inferred.subCategory,
        classifierConfidence: inferred.confidence,
        subCategoryConfidence: inferred.confidence,
        broadRoadsideEvidenceDetected: true,
        broadRoadsideEvidenceTokens: broadEvidence.tokens,
        unsafeVolunteered: false,
        unsafePhrase: null,
        humanHandoffReason: null,
        suggestConfirmFlatTire: inferred.weakTireHint,
      },
      broadEvidence.evidenceLang,
      "broad_evidence",
    );
  }

  if (nonRoadsideMatch) {
    return withAliasLang(
      {
        broadIntent: "not_roadside_assistance",
        subCategory: null,
        finalBackendIntent: "not_roadside_assistance",
        classificationMethod: "non_roadside",
        triggerCategory: null,
        matchedPhrase: nonRoadsideMatch.phrase,
        canonicalPhrase: nonRoadsideMatch.phrase,
        classifierConfidence: 0.85,
        subCategoryConfidence: 0,
        broadRoadsideEvidenceDetected: false,
        broadRoadsideEvidenceTokens: [],
        unsafeVolunteered: false,
        unsafePhrase: null,
        humanHandoffReason: null,
        suggestConfirmFlatTire: false,
      },
      nonRoadsideMatch.sourceLang,
      "non_roadside",
    );
  }

  // Unclear — but track weak tire for next turn
  const tireOnly = hasAnyToken(normalized, TIRE_ISH_TOKENS);
  if (bag.unclearCount >= 1 && bag.lastWeakRoadsideEvidenceCategory === "flat_tire") {
    return withAliasLang(
      {
        broadIntent: "unclear",
        subCategory: null,
        finalBackendIntent: "unclear",
        classificationMethod: "clarification",
        triggerCategory: null,
        matchedPhrase: null,
        canonicalPhrase: null,
        classifierConfidence: 0.4,
        subCategoryConfidence: 0,
        broadRoadsideEvidenceDetected: broadEvidence.detected,
        broadRoadsideEvidenceTokens: broadEvidence.tokens,
        unsafeVolunteered: false,
        unsafePhrase: null,
        humanHandoffReason: null,
        suggestConfirmFlatTire: true,
      },
      broadEvidence.evidenceLang ?? "et",
      broadEvidence.evidenceLang ? "broad_evidence" : "default",
    );
  }

  return withAliasLang(
    {
      broadIntent: "unclear",
      subCategory: null,
      finalBackendIntent: "unclear",
      classificationMethod: "clarification",
      triggerCategory: null,
      matchedPhrase: null,
      canonicalPhrase: null,
      classifierConfidence: 0.35,
      subCategoryConfidence: 0,
      broadRoadsideEvidenceDetected: broadEvidence.detected,
      broadRoadsideEvidenceTokens: broadEvidence.tokens,
      unsafeVolunteered: false,
      unsafePhrase: null,
      humanHandoffReason: tireOnly ? "weak_tire_evidence_only" : "no_clear_intent",
      suggestConfirmFlatTire: false,
    },
    broadEvidence.evidenceLang,
    broadEvidence.evidenceLang ? "broad_evidence" : "default",
  );
}

export function updateClassifierContext(
  bag: IiziClassifierMemory,
  normalized: string,
  result: TwoStageClassificationResult,
): void {
  bag.lastBroadIntent = result.broadIntent;
  bag.lastSubCategoryCandidate = result.subCategory;

  if (result.broadIntent === "unclear") {
    bag.unclearCount += 1;
    bag.lastUnclearTranscript = normalized;
    if (result.humanHandoffReason === "weak_tire_evidence_only" || hasAnyToken(normalized, TIRE_ISH_TOKENS)) {
      bag.lastWeakRoadsideEvidenceCategory = "flat_tire";
    }
  } else {
    bag.unclearCount = 0;
    bag.lastUnclearTranscript = "";
  }

  if (result.broadIntent === "roadside_assistance" && result.subCategory) {
    bag.lastWeakRoadsideEvidenceCategory =
      result.subCategoryConfidence < 0.75 ? result.subCategory : null;
    if (result.suggestConfirmFlatTire) {
      bag.lastWeakRoadsideEvidenceCategory = "flat_tire";
    }
  }
}

export function occupantForClassification(
  subCategory: IiziRoadsideCategory | null,
  normalized: string,
): ReturnType<typeof computeOccupantRequirement> {
  let occ = computeOccupantRequirement(subCategory, normalized);
  if (subCategory === "flat_tire" && hasAnyToken(normalized, CANNOT_MOVE_TOKENS) && !occ.required) {
    occ = {
      required: true,
      reason: "car_not_moving",
      passengerMentionDetected: occ.passengerMentionDetected,
      passengerPhrase: occ.passengerPhrase,
    };
  }
  if (subCategory === "tow_needed" || hasAnyToken(normalized, CANNOT_MOVE_TOKENS)) {
    if (!occ.required && (subCategory === "tow_needed" || subCategory === "generic_roadside")) {
      occ = {
        required: true,
        reason: "car_not_moving",
        passengerMentionDetected: occ.passengerMentionDetected,
        passengerPhrase: occ.passengerPhrase,
      };
    }
  }
  return occ;
}
