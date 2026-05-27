/**
 * IIZI brain configuration — persisted in Supabase `agent_brain_configs.config_json`
 * (`schemaVersion: 1`). Types are tolerant: unknown keys ignored at compile time where safe.
 */

export const IIZI_BRAIN_CONFIG_SCHEMA_VERSION = 1 as const;

/** Config-level intent labels (classification output when matched). `unknown` = no keyword hit */
export type BrainIntentSlug = "roadside" | "non_roadside" | "emergency_handoff" | "unknown";

/** Persisted classifier output per pathway OpenAI/DG excludes unknown_conflict */
export type PathwayIntentClassification = Exclude<BrainIntentSlug, "unknown"> | "unknown";

export interface IiziBrainIntentRule {
  /** Stable logging id — appears in `[IIZI-Brain]` logs */
  id: string;
  /** Case-insensitive substring matches (applied to lowercased text) */
  keywords?: string[];
  /** Regex source with `iu` flags (do not embed flags in string) */
  patterns?: string[];
  /** Documentation / future UI prompts only (not matched unless also listed in keywords/patterns) */
  examples?: string[];
}

export interface IiziBrainIntentBlock {
  /** Logical rule groups scanned in-order within this intent bucket */
  ruleGroups?: IiziBrainIntentRule[];
  /** Semantic labels for callers / prompts (not enforced in minimal runtime) */
  required_fields?: string[];
}

/** When to require occupant count (future gate); minimal structure only */
export interface IiziBrainOccupantWhen {
  intentMatches?: string[];
  keywords?: string[];
}

export interface IiziBrainActionGatesRecord {
  send_combined_sms?: Partial<Record<string, boolean>>;
  route_human?: Partial<Record<string, boolean>>;
  ask_clarification?: Partial<Record<string, boolean>>;
  require_vehicle_lookup?: Partial<Record<string, boolean>>;
  require_location_confirmed?: Partial<Record<string, boolean>>;
  require_occupant_count_when?: IiziBrainOccupantWhen;
}

export interface IiziBrainToolTemplates {
  /** Twilio/OpenAI SMS template friendly name — must match SMS catalog */
  combined_registration_location_sms?: string;
  callback_request_sms?: string;
}

export interface IiziBrainConfigExceptions {
  /** If both non_roadside and roadside hit, treat as denying roadside “needs auto abi” clarification */
  deny_car_roadside_abi_pattern?: string;
}

/** JSON payload shape (`config_json`) */
export interface IiziBrainConfigV1 {
  schemaVersion: typeof IIZI_BRAIN_CONFIG_SCHEMA_VERSION;
  /** Highest slug wins tie when multiple intents match; omissions use runtime default order */
  matchPrecedenceSlugs?: Exclude<BrainIntentSlug, "unknown">[];
  intents: Partial<Record<Exclude<BrainIntentSlug, "unknown">, IiziBrainIntentBlock>>;
  gates?: IiziBrainActionGatesRecord;
  toolTemplates?: IiziBrainToolTemplates;
  supported_languages?: string[];
  exceptions?: IiziBrainConfigExceptions;
}

export interface CompiledBrainRule {
  slug: Exclude<BrainIntentSlug, "unknown">;
  ruleId: string;
  keywords?: string[];
  regexes?: RegExp[];
}

export interface CompiledBrainConfig {
  schemaVersion: number;
  precedence: Exclude<BrainIntentSlug, "unknown">[];
  rules: CompiledBrainRule[];
  deniesCarAbi: RegExp | null;
  sendCombinedSmsGate: Record<string, boolean>;
  gatesLayer: NonNullable<IiziBrainConfigV1["gates"]>;
  toolTemplates?: IiziBrainToolTemplates;
  supportedLanguages: string[];
}

export interface SpeechClassifyMeta {
  matchedIntentSlug: BrainIntentSlug | null;
  /** Config rule ids concatenated (`+`) — empty if fallback */
  matchedRuleIds: string;
  classifySource: "config" | "fallback_none" | "fallback_builtin";
}

export interface SpeechClassifyResult {
  intent: PathwayIntentClassification | null;
  meta: SpeechClassifyMeta;
}
