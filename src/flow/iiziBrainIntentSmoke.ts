/**
 * Minimal intent classification smoke — run: npm run intent-classify-smoke
 *
 * Runs via **tsx** (see package.json): native `node --experimental-strip-types` cannot resolve our
 * “.js specifiers → emit” pattern across the TS module graph without a loader.
 */

import assert from "node:assert/strict";

import type { CompiledBrainConfig } from "./iiziBrainConfigTypes.js";
import { classifyIntentFromSpeechHybrid, getDefaultCompiledBrain } from "./iiziBrainSpeechClassify.js";
import type { PathwayIntentClassification } from "./iiziBrainConfigTypes.js";
import type { ResolvedBrainIntent } from "./iiziBrainMerge.js";
import { mergePathwayIntents } from "./iiziBrainMerge.js";

function expectHybrid(
  text: string,
  compiled: CompiledBrainConfig,
  expected: ResolvedBrainIntent,
  hint: string,
): void {
  const o = classifyIntentFromSpeechHybrid(text, compiled);
  const d = classifyIntentFromSpeechHybrid(text, compiled);
  const oIntent = (o.intent ?? "unknown") as PathwayIntentClassification;
  const dIntent = (d.intent ?? "unknown") as PathwayIntentClassification;
  const { resolved } = mergePathwayIntents(oIntent, dIntent);
  assert.equal(resolved, expected, `${hint}: hybrid merge got ${resolved} (oa=${oIntent} dg=${dIntent})`);
  assert.ok(
    o.meta.matchedRuleIds != null && o.meta.matchedRuleIds.length > 0,
    `${hint}: expected matching rule ids in meta`,
  );
  assert.ok(
    ["config", "fallback_builtin"].includes(o.meta.classifySource),
    `${hint}: unexpected classifySource ${o.meta.classifySource}`,
  );
}

function expectMerge(
  oa: PathwayIntentClassification,
  dg: PathwayIntentClassification,
  expected: ResolvedBrainIntent,
  hint: string,
): void {
  const { resolved, reason } = mergePathwayIntents(oa, dg);
  assert.equal(resolved, expected, `${hint}: merge got ${resolved} reason=${reason} (oa=${oa} dg=${dg})`);
}

/** No intent match — runtime asks / clarifies for unknown workflows. */
function expectNoIntentMatch(text: string, compiled: CompiledBrainConfig, hint: string): void {
  const r = classifyIntentFromSpeechHybrid(text, compiled);
  assert.equal(r.intent, null, `${hint}: expected null intent, got ${r.intent}`);
  assert.equal(r.meta.classifySource, "config", `${hint}: expected config path for compiled default brain`);
}

function run(): void {
  const compiled = getDefaultCompiledBrain();

  expectHybrid(
    "Mul oli liiklusavarii ja puksiir abi vajan teele",
    compiled,
    "roadside",
    "crash + towing wording",
  );
  expectHybrid("Auto ei käivitu ja vajan autoabi teel", compiled, "roadside", "wont-start + autoabi phrase");
  expectHybrid("Mul on rehv katki ja sõidan teel", compiled, "roadside", "flat tire");

  expectHybrid("Ma ei saa autosse sisse võtmed autos", compiled, "roadside", "lockout / keys inside wording");

  expectHybrid("Tule tõesti kiire puksiir", compiled, "roadside", "towing keyword puksiir");

  expectHybrid(
    "Täna hommikul oli avarii suur männ teel",
    compiled,
    "roadside",
    "avarii (default shipped config: accident cues are roadside)",
  );

  expectHybrid("Mul on teiega kindlustuse pakkumine arutada", compiled, "non_roadside", "insurance offer non-roadside");

  expectHybrid("Ma helistan selle pärast arve küsimusega", compiled, "non_roadside", "arve küsimus non-roadside");

  expectHybrid("Pole abi vaja, see oli kontori küsimus", compiled, "non_roadside", "explicit non roadside");

  expectHybrid("Palun kiirabi, mul on tõsine valu rinnus", compiled, "emergency_handoff", "medical escalation");

  expectHybrid("Helistage homme töö ajal tagasi palun", compiled, "non_roadside", "callback wording");

  // Requested phrase coverage (Deepgram-preferred merge uses same hybrid when both pathways see same text)
  expectHybrid("mul on autoabi vaja", compiled, "roadside", "explicit autoabi need");
  expectHybrid("auto ei käivitu", compiled, "roadside", "wont-start phrase");
  expectHybrid("generaator ei tööta", compiled, "roadside", "generator failure roadside cue (ET)");
  expectHybrid("generator ei tööta", compiled, "roadside", "generator failure roadside cue (EN word)");
  expectHybrid("generaator ei lae", compiled, "roadside", "generator not charging / alternator cue");
  expectHybrid("soovin kindlustuse kohta infot", compiled, "non_roadside", "insurance info office line");

  expectNoIntentMatch(
    "Tere tere hommikust kuidas teil läheb mina helistan lihtsalt",
    compiled,
    "random unclear greeting — unknown / clarify at runtime",
  );

  const empty = classifyIntentFromSpeechHybrid("   ", compiled);
  assert.equal(empty.intent, null);

  // Both pathways unclear → merged unknown; SMS must stay blocked until clarified
  const gibberO = classifyIntentFromSpeechHybrid("xyzabc nonsense qwerty", compiled);
  const gibberD = classifyIntentFromSpeechHybrid("xyzabc nonsense qwerty", compiled);
  const gibMerged = mergePathwayIntents(
    (gibberO.intent ?? "unknown") as PathwayIntentClassification,
    (gibberD.intent ?? "unknown") as PathwayIntentClassification,
  );
  assert.equal(gibMerged.resolved, "unknown", "gibberish → both unknown merge");

  // --- Deepgram-preferred pathway merge matrix (OpenAI = first arg, Deepgram = second) ---
  expectMerge("roadside", "roadside", "roadside", "both roadside");
  expectMerge("unknown", "unknown", "unknown", "both unknown");
  expectMerge("roadside", "unknown", "roadside", "OpenAI roadside Deepgram unknown");
  expectMerge("unknown", "roadside", "roadside", "Deepgram roadside OpenAI unknown");
  expectMerge("non_roadside", "unknown", "unknown", "OpenAI non_roadside Deepgram unknown → clarify");
  expectMerge("unknown", "non_roadside", "unknown", "Deepgram non_roadside OpenAI unknown → clarify");
  expectMerge("roadside", "non_roadside", "unknown_conflict", "OpenAI roadside vs Deepgram non_roadside");
  expectMerge("non_roadside", "roadside", "unknown_conflict", "Deepgram roadside vs OpenAI non_roadside");
  expectMerge("roadside", "emergency_handoff", "emergency_handoff", "emergency escalates");
  expectMerge("unknown", "emergency_handoff", "emergency_handoff", "emergency from either pathway");

  console.log("OK intent-classify-smoke:", "roadside/non_roadside/emergency/empty/unclear/merge-matrix passed.");
}

run();
