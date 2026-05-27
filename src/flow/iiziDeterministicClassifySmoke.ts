/**
 * Multilingual IIZI classifier smoke — run: npm run iizi-deterministic-smoke
 */

import assert from "node:assert/strict";
import { classifyIiziTranscript, createInitialIiziDeterministicState } from "./iiziDeterministic.js";
import type { IiziLanguage, IiziRoadsideCategory } from "./iiziDeterministicTypes.js";

type Expect = {
  broadIntent?: string;
  category?: IiziRoadsideCategory | "unsafe" | "not_roadside" | "unclear";
  lang: IiziLanguage;
  occupantRequired?: boolean;
  occupantReason?: string;
  method?: string;
  broadEvidence?: boolean;
};

function expectClassify(text: string, exp: Expect, hint: string): void {
  const bag = createInitialIiziDeterministicState();
  const c = classifyIiziTranscript(text, bag, "smoke");
  if (exp.broadIntent) {
    assert.equal(c.broadIntent, exp.broadIntent, `${hint}: broadIntent`);
  }
  if (exp.category === "unsafe") {
    assert.equal(c.finalBackendIntent, "unsafe", `${hint}: intent`);
    assert.equal(c.broadIntent, "unsafe_volunteered", `${hint}: broad unsafe`);
  } else if (exp.category === "not_roadside") {
    assert.equal(c.finalBackendIntent, "not_roadside_assistance", `${hint}: intent`);
    assert.equal(c.broadIntent, "not_roadside_assistance", `${hint}: broad not_roadside`);
  } else if (exp.category === "unclear") {
    assert.equal(c.finalBackendIntent, "unclear", `${hint}: intent`);
    assert.equal(c.broadIntent, "unclear", `${hint}: broad unclear`);
  } else {
    assert.equal(c.finalBackendIntent, "roadside_assistance", `${hint}: intent`);
    assert.equal(c.broadIntent, "roadside_assistance", `${hint}: broad roadside`);
    assert.equal(c.triggerCategory, exp.category, `${hint}: category`);
    assert.equal(c.subCategory, exp.category, `${hint}: subCategory`);
  }
  if (exp.method) {
    assert.equal(c.classificationMethod, exp.method, `${hint}: method`);
  }
  if (exp.broadEvidence !== undefined) {
    assert.equal(c.broadRoadsideEvidenceDetected, exp.broadEvidence, `${hint}: broadEvidence`);
  }
  if (exp.occupantRequired !== undefined) {
    assert.equal(c.occupantCountRequired, exp.occupantRequired, `${hint}: occupantRequired`);
  }
  if (exp.occupantReason) {
    assert.equal(c.occupantCountRequiredReason, exp.occupantReason, `${hint}: occupantReason`);
  }
  assert.equal(c.iiziLanguage, exp.lang, `${hint}: lang (got ${c.iiziLanguage})`);
}

function run(): void {
  // Two-stage broad + subcategory (ET)
  expectClassify(
    "minu autoreff on tühi ja ma ei saa liikuda",
    {
      broadIntent: "roadside_assistance",
      category: "flat_tire",
      lang: "et",
      occupantRequired: true,
      occupantReason: "car_not_moving",
      broadEvidence: true,
    },
    "et autoreff tuhi cannot move",
  );
  expectClassify(
    "Tere, mul juhtus selline probleem, et minu autoreff on tühi ja ma ei saa liikuda.",
    { broadIntent: "roadside_assistance", category: "flat_tire", lang: "et", occupantRequired: true, broadEvidence: true },
    "et full autoreff sentence",
  );
  expectClassify("autoreff on tühi", { category: "flat_tire", lang: "et", broadEvidence: true }, "et autoreff tuhi short");
  expectClassify("auto probleem", { category: "generic_roadside", lang: "et", broadEvidence: true }, "et auto probleem");
  expectClassify("mul on kindlustuse küsimus", { category: "not_roadside", lang: "et" }, "et insurance only");
  expectClassify("insurance question", { category: "not_roadside", lang: "en" }, "en insurance question short");
  expectClassify(
    "kindlustus on olemas aga rehv on tühi",
    { category: "flat_tire", lang: "et", broadEvidence: true },
    "et insurance plus flat tire",
  );

  // Context follow-up — no human_route
  {
    const bag = createInitialIiziDeterministicState();
    bag.lastWeakRoadsideEvidenceCategory = "flat_tire";
    const c = classifyIiziTranscript("mul on tore fundühi", bag, "smoke");
    assert.equal(c.finalBackendIntent, "roadside_assistance", "garbled follow-up: intent");
    assert.equal(c.triggerCategory, "flat_tire", "garbled follow-up: category");
    assert.notEqual(c.classificationMethod, "human_route", "garbled follow-up: no human_route");
    assert.equal(c.suggestConfirmFlatTire, true, "garbled follow-up: suggest confirm");
  }

  // ET exact triggers
  expectClassify("mul oli avarii", { category: "accident", lang: "et" }, "et avarii");
  expectClassify("auto ei käivitu", { category: "no_start", lang: "et" }, "et no_start");
  expectClassify("reff katki", { category: "flat_tire", lang: "et" }, "et flat fuzzy");
  expectClassify("õli lekib", { category: "mechanical_issue", lang: "et" }, "et oil");
  expectClassify("generaator on katki", { category: "mechanical_issue", lang: "et" }, "et alternator");

  // EN
  expectClassify("I had an accident", { category: "accident", lang: "en" }, "en accident");
  expectClassify("my car wont start", { category: "no_start", lang: "en" }, "en no_start");
  expectClassify("flat tire", { category: "flat_tire", lang: "en" }, "en flat");
  expectClassify("I need a tow truck", { category: "tow_needed", lang: "en" }, "en tow");
  expectClassify("oil is leaking", { category: "mechanical_issue", lang: "en" }, "en oil");
  expectClassify("alternator is broken", { category: "mechanical_issue", lang: "en" }, "en alternator");
  expectClassify("I have an insurance question", { category: "not_roadside", lang: "en" }, "en insurance");

  // RU
  expectClassify("машина не заводится", { category: "no_start", lang: "ru" }, "ru no_start");
  expectClassify("нужен эвакуатор", { category: "tow_needed", lang: "ru" }, "ru tow");
  expectClassify("спустило колесо", { category: "flat_tire", lang: "ru" }, "ru flat");
  expectClassify("течет масло", { category: "mechanical_issue", lang: "ru" }, "ru oil");
  expectClassify("генератор не работает", { category: "mechanical_issue", lang: "ru" }, "ru alternator");
  expectClassify("у меня вопрос по страховке", { category: "not_roadside", lang: "ru" }, "ru insurance");

  // Unsafe
  expectClassify("keegi sai viga", { category: "unsafe", lang: "et" }, "unsafe et");
  expectClassify("someone is injured", { category: "unsafe", lang: "en" }, "unsafe en");
  expectClassify("кто-то пострадал", { category: "unsafe", lang: "ru" }, "unsafe ru");

  console.log("[iizi-deterministic-smoke] OK (two-stage et/en/ru)");
}

run();
