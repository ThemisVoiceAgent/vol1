/**
 * Consensus merge — OpenAI Realtime vs Deepgram shadow pathways into SMS gate coarse intent.
 * Deepgram is the preferred transcript signal for roadside vs non-roadside when pathways disagree;
 * OpenAI non_roadside vs Deepgram roadside is treated as a hard conflict (SMS blocked).
 */

import type { BrainIntentSlug, PathwayIntentClassification } from "./iiziBrainConfigTypes.js";
import type { ConflictBehaviorUi, SpeechTrustMode } from "../brain/agentBrainUiTypes.js";

export type ResolvedBrainIntent = BrainIntentSlug | "unknown_conflict";

export type MergePathwayOptions = {
  speechTrustMode: SpeechTrustMode;
  conflictBehavior: ConflictBehaviorUi;
};

/**
 * Merge per-pathway classifications (OpenAI = oa, Deepgram = dg).
 * Emergency handoff wins over commercial intents when either pathway reports it.
 *
 * Optional third argument applies admin UI policy; omitting it preserves legacy merge (tests / backward compat).
 */
export function mergePathwayIntents(
  oa: PathwayIntentClassification,
  dg: PathwayIntentClassification,
  opts?: MergePathwayOptions,
): { resolved: ResolvedBrainIntent; reason: string } {
  if (
    !opts ||
    (opts.speechTrustMode === "prefer_deepgram_when_openai_unclear" && opts.conflictBehavior === "prefer_deepgram")
  ) {
    return mergePathwayIntentsLegacy(oa, dg);
  }
  return mergePathwayIntentsPolicy(oa, dg, opts);
}

/** Original shipped merge — kept byte-stable for `npm run intent-classify-smoke` (2-arg calls). */
export function mergePathwayIntentsLegacy(
  oa: PathwayIntentClassification,
  dg: PathwayIntentClassification,
): { resolved: ResolvedBrainIntent; reason: string } {
  if (oa === dg) {
    return { resolved: oa as ResolvedBrainIntent, reason: reasonBoth(oa) };
  }

  const hasEmergency = oa === "emergency_handoff" || dg === "emergency_handoff";
  if (hasEmergency) {
    return { resolved: "emergency_handoff", reason: "emergency_handoff_escalates" };
  }

  // Hard conflict: opposite commercial intents (SMS must stay blocked)
  if (dg === "roadside" && oa === "non_roadside") {
    return {
      resolved: "unknown_conflict",
      reason: "source_conflict_openai_non_roadside_vs_deepgram_roadside",
    };
  }
  if (oa === "roadside" && dg === "non_roadside") {
    return {
      resolved: "unknown_conflict",
      reason: "source_conflict_openai_roadside_vs_deepgram_non_roadside",
    };
  }

  // Deepgram clear roadside — OpenAI is not non_roadside (conflicts handled above)
  if (dg === "roadside") {
    return { resolved: "roadside", reason: "deepgram_roadside_preferred" };
  }

  // OpenAI roadside, Deepgram unclear/missing
  if (oa === "roadside" && dg === "unknown") {
    return { resolved: "roadside", reason: "openai_roadside_deepgram_unknown" };
  }

  // OpenAI non-roadside but Deepgram unclear — do not trust OpenAI alone; clarify
  if (oa === "non_roadside" && dg === "unknown") {
    return { resolved: "unknown", reason: "openai_non_roadside_deepgram_unknown_ask_clarification" };
  }

  // Deepgram non-roadside, OpenAI unclear — clarify
  if (oa === "unknown" && dg === "non_roadside") {
    return { resolved: "unknown", reason: "deepgram_non_roadside_openai_unknown_ask_clarification" };
  }

  return { resolved: "unknown_conflict", reason: "source_conflict_unhandled_pair" };
}

function mergePathwayIntentsPolicy(
  oa: PathwayIntentClassification,
  dg: PathwayIntentClassification,
  opts: MergePathwayOptions,
): { resolved: ResolvedBrainIntent; reason: string } {
  const speech = opts.speechTrustMode;
  const conf = opts.conflictBehavior;

  if (speech === "prefer_openai") {
    return mergePreferOpenaiPathway(oa, dg);
  }
  if (speech === "ask_on_conflict") {
    const r = mergePathwayIntentsLegacy(oa, dg);
    return upgradeAmbiguousToConflict(r, oa, dg);
  }

  // speech === prefer_deepgram_when_openai_unclear
  if (conf === "ask_clarification") {
    const r = mergePathwayIntentsLegacy(oa, dg);
    return upgradeAmbiguousToConflict(r, oa, dg);
  }
  if (conf === "prefer_openai") {
    return mergePreferOpenaiPathway(oa, dg);
  }

  // conf === prefer_deepgram — should match legacy (caller normally shortcuts); defensive:
  return mergePathwayIntentsLegacy(oa, dg);
}

function mergePreferOpenaiPathway(
  oa: PathwayIntentClassification,
  dg: PathwayIntentClassification,
): { resolved: ResolvedBrainIntent; reason: string } {
  if (oa === dg) {
    return { resolved: oa as ResolvedBrainIntent, reason: reasonBoth(oa) };
  }
  const hasEmergency = oa === "emergency_handoff" || dg === "emergency_handoff";
  if (hasEmergency) {
    return { resolved: "emergency_handoff", reason: "emergency_handoff_escalates" };
  }
  // Never bypass explicit opposite-intent conflict — SMS gate still requires consensus for roadside
  if (dg === "roadside" && oa === "non_roadside") {
    return {
      resolved: "unknown_conflict",
      reason: "source_conflict_openai_non_roadside_vs_deepgram_roadside",
    };
  }
  if (oa === "roadside" && dg === "non_roadside") {
    return {
      resolved: "unknown_conflict",
      reason: "source_conflict_openai_roadside_vs_deepgram_non_roadside",
    };
  }

  if (oa === "roadside") {
    return { resolved: "roadside", reason: "prefer_openai_roadside" };
  }
  if (oa === "non_roadside") {
    return { resolved: "non_roadside", reason: "prefer_openai_non_roadside" };
  }
  if (dg === "roadside") {
    return { resolved: "roadside", reason: "prefer_openai_fallback_deepgram_roadside" };
  }
  if (dg === "non_roadside") {
    return { resolved: "non_roadside", reason: "prefer_openai_fallback_deepgram_non_roadside" };
  }
  return { resolved: "unknown", reason: "prefer_openai_both_unclear" };
}

function upgradeAmbiguousToConflict(
  r: { resolved: ResolvedBrainIntent; reason: string },
  oa: PathwayIntentClassification,
  dg: PathwayIntentClassification,
): { resolved: ResolvedBrainIntent; reason: string } {
  if (
    (oa === "non_roadside" && dg === "unknown") ||
    (oa === "unknown" && dg === "non_roadside")
  ) {
    if (r.resolved === "unknown") {
      return {
        resolved: "unknown_conflict",
        reason: `${r.reason}_upgraded_ask_clarification`,
      };
    }
  }
  return r;
}

function reasonBoth(x: PathwayIntentClassification): string {
  switch (x) {
    case "unknown":
      return "both_unknown_or_unclear";
    case "roadside":
      return "both_agree_roadside";
    case "non_roadside":
      return "both_agree_non_roadside";
    case "emergency_handoff":
      return "both_agree_emergency_handoff";
    default:
      return "both_agree";
  }
}
