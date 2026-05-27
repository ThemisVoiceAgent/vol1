/**
 * Compile JSON brain config → regex matchers, classify transcripts, fallback to legacy regex bundle.
 */

import type {
  BrainIntentSlug,
  CompiledBrainConfig,
  CompiledBrainRule,
  IiziBrainConfigExceptions,
  IiziBrainConfigV1,
  IiziBrainIntentRule,
  PathwayIntentClassification,
  SpeechClassifyMeta,
  SpeechClassifyResult,
} from "./iiziBrainConfigTypes.js";
export type { ResolvedBrainIntent } from "./iiziBrainMerge.js";
export { mergePathwayIntents } from "./iiziBrainMerge.js";
import { DEFAULT_IIZI_BRAIN_CONFIG } from "./defaultIiziBrainConfig.js";
import { IIZI_BRAIN_CONFIG_SCHEMA_VERSION } from "./iiziBrainConfigTypes.js";

/** Default slug order — office/emergency escalate before generic roadside cues */
export const DEFAULT_MATCH_PRECEDENCE: Exclude<BrainIntentSlug, "unknown">[] = [
  "non_roadside",
  "emergency_handoff",
  "roadside",
];

const BUILTIN_FALLBACK_DENIES =
  /\bei\s+ole\b[^\n]{0,120}(?:\bautos*\s+abi\b|\bautos*abi\b)/i;

const BUILTIN_FALLBACK_NON =
  /\b(?:ei\s+vaja\s+(?:auto\s*)?abi|pole\s+(?:auto\s*)?abi(?:\s*küsimus)?|pole\s+tegemist\s+(?:õnnetus\b|avar(?:ii)?\b)|ainult\s+kontor(?:i|)|(?:tagasi)?helistage(?:\s*hilisemalt)?|\barve(?:tega)?\b|mitte\s+(?:auto\s*)?abi|väär\s+numer|pole\s+nöör(?:i|)|arutame\s+hind|müügi?\b|tellimus(?:tega)?|lihtsalt\s+infot|soovin\b[^\n]{0,56}?\bkindlustus(?:e|ega|est|ele)?\b|sooviks(?:in|)?\s+teada(?:\s+kui)?)/iu;

/** Legacy roadside bundle if config missing / unloaded */
const BUILTIN_FALLBACK_ROAD =
  /\b(?:(?:kütus|bensiin|bentsiin)(?:\s+on)?\s+otsas\b|(?:mul\s+sai\b|(?:sai|sain|saime)\s+)?(?:mul\s+|ma\s+|meil\s+|teie\s+|ta\s+|sa\s+|me\s+)?(?:kütus|bensiin|bentsiin)\s+otsa\b|(?:auto\s+)?ei\s+käivitu\b|(?:auto\s+)?ei\s+liigu\b|ei\s+käivitu\b|ei\s+liigu\b|(?:generaator|generator)(?:\s+ei)?\s+tööta\b|rehv\s+katki\b|tühi\s+rehv\b|aku\s+tühi\b|ei\s+saa\b[\s\S]{0,44}?\bautos{2,}e\b|(?:\bvõtmed\s+autos\b|\bvõtmed\b[\s\S]{0,32}?\bautos{2,}e\b)|uks\s+lukkus?\b|uks\s+lukus\b|\bvaja\b[^\n]{0,32}(?:auto\s+abi\b|autos*abi\b)|\bmul\s+on\s+autoabi\s+vaja\b|\bautos*abi\b|\bautos*\s+abi\b|puksiirr?\b|pukseerim(?:ine|ist|ise)?\b|kraav\b|avarii\b|õnnetus\b|krahh\b|jäin\s+teele\b|teele\s+jäänud\b|ei\s+käivi\b|käimatuse\b|mootor\b|vedelik\b|rehv\b|kumm\b|ratas(?:tega)?\b|(?:varu)?ratta(?:d|)\b|teel\s+abi\b|abi\s*vaja\s+tee\b|kahjustus\b)/iu;

/** Narrow emergency/medical escalation cues — used only when compiled rules unavailable (fail-open path). */
const BUILTIN_FALLBACK_EMERGENCY = /\b(?:112|kiirabi|politsei|pääste|tulekahju|süttis|veri|hingamine)\b/iu;

type IntentBucketKey = keyof NonNullable<IiziBrainConfigV1["intents"]>;
type IntentBlocks = NonNullable<IiziBrainConfigV1["intents"]>;

function mergeIntentBlocks(base: IntentBlocks, over: Partial<IntentBlocks>): IntentBlocks {
  const out = { ...base };
  for (const k of Object.keys(over) as IntentBucketKey[]) {
    const o = over[k];
    if (!o) continue;
    const prevBlock = out[k];
    let nextRuleGroups: IiziBrainIntentRule[] | undefined;
    if (Array.isArray(o.ruleGroups) && o.ruleGroups.length > 0) {
      nextRuleGroups = [...o.ruleGroups];
    } else if (prevBlock?.ruleGroups) {
      nextRuleGroups = [...prevBlock.ruleGroups];
    } else {
      nextRuleGroups = undefined;
    }
    out[k] = {
      ...(prevBlock ?? {}),
      ...o,
      ruleGroups: nextRuleGroups,
      required_fields: o.required_fields ?? prevBlock?.required_fields,
    };
  }
  return out;
}

function mergeGates(base: NonNullable<IiziBrainConfigV1["gates"]>, over: Partial<typeof base>): NonNullable<
  IiziBrainConfigV1["gates"]
> {
  return {
    ...base,
    ...over,
    send_combined_sms: {
      ...(base.send_combined_sms || {}),
      ...(over.send_combined_sms || {}),
    },
    route_human: { ...(base.route_human || {}), ...(over.route_human || {}) },
    ask_clarification: { ...(base.ask_clarification || {}), ...(over.ask_clarification || {}) },
    require_vehicle_lookup: {
      ...(base.require_vehicle_lookup || {}),
      ...(over.require_vehicle_lookup || {}),
    },
    require_location_confirmed: {
      ...(base.require_location_confirmed || {}),
      ...(over.require_location_confirmed || {}),
    },
    require_occupant_count_when:
      over.require_occupant_count_when ?? base.require_occupant_count_when,
  };
}

/** Deep-merge persisted JSON atop shipped defaults */
export function layerIiziBrainConfig(dbPartial: Partial<IiziBrainConfigV1> | null | undefined): IiziBrainConfigV1 {
  if (!dbPartial || typeof dbPartial !== "object") {
    return { ...DEFAULT_IIZI_BRAIN_CONFIG, intents: { ...DEFAULT_IIZI_BRAIN_CONFIG.intents } };
  }
  const sv = Number(dbPartial.schemaVersion);
  const schemaOk = sv === IIZI_BRAIN_CONFIG_SCHEMA_VERSION || Number.isNaN(sv);

  const mergedBase = schemaOk
    ? { ...DEFAULT_IIZI_BRAIN_CONFIG, ...dbPartial }
    : { ...DEFAULT_IIZI_BRAIN_CONFIG };

  mergedBase.intents = mergeIntentBlocks(
    { ...DEFAULT_IIZI_BRAIN_CONFIG.intents },
    mergedBase.intents || {},
  );
  mergedBase.gates = mergeGates(DEFAULT_IIZI_BRAIN_CONFIG.gates || {}, mergedBase.gates || {});

  if (mergedBase.toolTemplates === undefined || Object.keys(mergedBase.toolTemplates).length === 0) {
    mergedBase.toolTemplates = { ...(DEFAULT_IIZI_BRAIN_CONFIG.toolTemplates || {}) };
  } else {
    mergedBase.toolTemplates = {
      ...(DEFAULT_IIZI_BRAIN_CONFIG.toolTemplates || {}),
      ...mergedBase.toolTemplates,
    };
  }
  mergedBase.exceptions = { ...(DEFAULT_IIZI_BRAIN_CONFIG.exceptions || {}), ...(dbPartial.exceptions || {}) };
  mergedBase.supported_languages = dbPartial.supported_languages?.length
    ? [...dbPartial.supported_languages]
    : [...(DEFAULT_IIZI_BRAIN_CONFIG.supported_languages || [])];

  mergedBase.schemaVersion = IIZI_BRAIN_CONFIG_SCHEMA_VERSION;
  mergedBase.matchPrecedenceSlugs = Array.isArray(mergedBase.matchPrecedenceSlugs)
    ? (mergedBase.matchPrecedenceSlugs as Exclude<BrainIntentSlug, "unknown">[])
    : DEFAULT_MATCH_PRECEDENCE;

  return mergedBase;
}

function compileExceptions(ex?: IiziBrainConfigExceptions): RegExp | null {
  const src = ex?.deny_car_roadside_abi_pattern?.trim();
  if (!src) return null;
  try {
    return new RegExp(src, "iu");
  } catch {
    console.warn(`[IIZI-Brain] invalid deny_car_roadside_abi_pattern — ignored`);
    return null;
  }
}

/** Only three concrete intent buckets compile to rules — drop unknown/defensive junk from DB JSON */
function coerceMatchPrecedence(
  raw: Exclude<BrainIntentSlug, "unknown">[] | undefined,
): Exclude<BrainIntentSlug, "unknown">[] {
  const list = raw?.length ? raw : DEFAULT_MATCH_PRECEDENCE;
  const precedence: Exclude<BrainIntentSlug, "unknown">[] = [];
  for (const s of list) {
    if (s === "non_roadside" || s === "emergency_handoff" || s === "roadside") {
      precedence.push(s);
    }
  }
  return precedence.length > 0 ? precedence : [...DEFAULT_MATCH_PRECEDENCE];
}

export function compileBrainConfig(layered: IiziBrainConfigV1): CompiledBrainConfig {
  const precedence = coerceMatchPrecedence(layered.matchPrecedenceSlugs);

  const rules: CompiledBrainRule[] = [];

  const slugs: Exclude<BrainIntentSlug, "unknown">[] = ["non_roadside", "emergency_handoff", "roadside"];

  const pushSlugRules = (slug: Exclude<BrainIntentSlug, "unknown">) => {
    const groups = layered.intents?.[slug]?.ruleGroups;
    if (!groups) return;
    for (const g of groups) {
      const kws =
        Array.isArray(g.keywords) &&
        g.keywords.map((x) => x.normalize("NFC").trim().toLowerCase()).filter(Boolean);
      const rx: RegExp[] = [];
      if (Array.isArray(g.patterns)) {
        for (const pSrc of g.patterns) {
          const p = typeof pSrc === "string" ? pSrc.trim() : "";
          if (!p) continue;
          try {
            rx.push(new RegExp(p, "iu"));
          } catch {
            console.warn(`[IIZI-Brain] skipped invalid regex in rule=${g.id} slug=${slug}`);
          }
        }
      }
      if ((!kws || kws.length === 0) && rx.length === 0) continue;
      rules.push({
        slug,
        ruleId: g.id,
        keywords: kws && kws.length > 0 ? kws : undefined,
        regexes: rx.length > 0 ? rx : undefined,
      });
    }
  };

  for (const slug of precedence) {
    pushSlugRules(slug);
  }
  for (const slug of slugs) {
    if (!precedence.includes(slug)) pushSlugRules(slug);
  }

  const gateLayerFull = mergeGates(
    mergeGates(DEFAULT_IIZI_BRAIN_CONFIG.gates || {}, {}),
    layered.gates || {},
  );
  const sendsRaw = { ...(DEFAULT_IIZI_BRAIN_CONFIG.gates?.send_combined_sms || {}), ...(gateLayerFull.send_combined_sms || {}) };
  const sendCombinedSmsGate: Record<string, boolean> = {
    roadside: sendsRaw.roadside !== false,
    non_roadside: sendsRaw.non_roadside === true,
    emergency_handoff: sendsRaw.emergency_handoff === true,
    unknown: sendsRaw.unknown === true,
    unknown_conflict: sendsRaw.unknown_conflict === true,
  };

  return {
    schemaVersion: layered.schemaVersion,
    precedence,
    rules,
    deniesCarAbi: compileExceptions(layered.exceptions),
    sendCombinedSmsGate,
    gatesLayer: gateLayerFull,
    toolTemplates: layered.toolTemplates,
    supportedLanguages: layered.supported_languages || ["et"],
  };
}

let cachedDefaultBrainCompile: CompiledBrainConfig | null = null;

/** Shipped default — always compile-once lazily */
export function getDefaultCompiledBrain(): CompiledBrainConfig {
  if (!cachedDefaultBrainCompile) {
    cachedDefaultBrainCompile = compileBrainConfig(DEFAULT_IIZI_BRAIN_CONFIG);
  }
  return cachedDefaultBrainCompile;
}

function ruleMatches(t: string, rule: CompiledBrainRule): boolean {
  if (rule.keywords) {
    for (const kw of rule.keywords) {
      if (t.includes(kw)) return true;
    }
  }
  if (rule.regexes) {
    for (const r of rule.regexes) {
      if (r.test(t)) return true;
    }
  }
  return false;
}

function classifyFromCompiled(tRaw: string, compiled: CompiledBrainConfig): SpeechClassifyResult {
  const t = tRaw.trim().normalize("NFC").toLowerCase();
  if (!t) {
    return {
      intent: null,
      meta: {
        matchedIntentSlug: null,
        matchedRuleIds: "",
        classifySource: "config",
      },
    };
  }

  const hitMap = new Map<Exclude<BrainIntentSlug, "unknown">, Set<string>>();
  for (const rule of compiled.rules) {
    if (ruleMatches(t, rule)) {
      if (!hitMap.has(rule.slug)) hitMap.set(rule.slug, new Set());
      hitMap.get(rule.slug)!.add(rule.ruleId);
    }
  }

  if (hitMap.size === 0) {
    return {
      intent: null,
      meta: {
        matchedIntentSlug: null,
        matchedRuleIds: "",
        classifySource: "config",
      },
    };
  }

  const denies = compiled.deniesCarAbi ?? BUILTIN_FALLBACK_DENIES;
  const hasNon = hitMap.has("non_roadside");
  const hasRoad = hitMap.has("roadside");
  const hasEm = hitMap.has("emergency_handoff");

  const joinIds = (slug: Exclude<BrainIntentSlug, "unknown">) =>
    Array.from(hitMap.get(slug) || []).sort().join("+");

  for (const slug of compiled.precedence) {
    if (!hitMap.has(slug)) continue;
    if (slug === "roadside" && hasNon && denies.test(tRaw)) {
      continue;
    }
    const ids = joinIds(slug);
    return {
      intent: slug,
      meta: {
        matchedIntentSlug: slug,
        matchedRuleIds: ids,
        classifySource: "config",
      },
    };
  }

  /** Fallback if precedence missing a slug that hit */
  if (hasNon) {
    return {
      intent: "non_roadside",
      meta: { matchedIntentSlug: "non_roadside", matchedRuleIds: joinIds("non_roadside"), classifySource: "config" },
    };
  }
  if (hasEm) {
    return {
      intent: "emergency_handoff",
      meta: {
        matchedIntentSlug: "emergency_handoff",
        matchedRuleIds: joinIds("emergency_handoff"),
        classifySource: "config",
      },
    };
  }
  if (hasRoad) {
    return {
      intent: "roadside",
      meta: { matchedIntentSlug: "roadside", matchedRuleIds: joinIds("roadside"), classifySource: "config" },
    };
  }

  const firstSlug = (Array.from(hitMap.keys()) as Exclude<BrainIntentSlug, "unknown">[])[0];
  const idsFirst = joinIds(firstSlug);
  return {
    intent: firstSlug,
    meta: { matchedIntentSlug: firstSlug, matchedRuleIds: idsFirst, classifySource: "config" },
  };
}

export function classifyIntentFromSpeechHybrid(
  text: string,
  compiled: CompiledBrainConfig | null | undefined,
): SpeechClassifyResult {
  const eff = compiled && compiled.rules.length > 0 ? compiled : null;
  if (eff) {
    return classifyFromCompiled(text, eff);
  }

  /** Legacy regex bundle — only when compiled missing or stripped */
  const t = text.trim();
  if (!t) {
    return {
      intent: null,
      meta: {
        matchedIntentSlug: null,
        matchedRuleIds: "builtin_fallback",
        classifySource: "fallback_builtin",
      },
    };
  }
  if (BUILTIN_FALLBACK_EMERGENCY.test(t)) {
    return {
      intent: "emergency_handoff",
      meta: {
        matchedIntentSlug: "emergency_handoff",
        matchedRuleIds: "builtin_fallback_emergency",
        classifySource: "fallback_builtin",
      },
    };
  }
  const deniesCarRoadsideAbi = BUILTIN_FALLBACK_DENIES.test(t);
  const hitNon = BUILTIN_FALLBACK_NON.test(t);
  const hitRoad = BUILTIN_FALLBACK_ROAD.test(t);
  let intent: PathwayIntentClassification | null = null;

  const metaFallback: SpeechClassifyMeta = {
    matchedIntentSlug: null,
    matchedRuleIds: "builtin_fallback_regex_bundle",
    classifySource: "fallback_builtin",
  };

  if (hitNon && hitRoad) {
    if (deniesCarRoadsideAbi) intent = "non_roadside";
    else intent = "roadside";
  } else if (hitRoad) intent = "roadside";
  else if (hitNon) intent = "non_roadside";

  metaFallback.matchedIntentSlug = intent ?? "unknown";
  return { intent, meta: metaFallback };
}

export function buildBrainConfigFromLayers(dbJson?: Partial<IiziBrainConfigV1> | null): CompiledBrainConfig {
  return compileBrainConfig(layerIiziBrainConfig(dbJson ?? null));
}
