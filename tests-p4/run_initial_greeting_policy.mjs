import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

const root = "/home/hermes/themis-voicebot";
const sourcePath = path.join(root, "src/ws/initialGreetingPolicy.ts");
assert.ok(existsSync(sourcePath), "RED expected: campaign opening policy is not implemented");
const compiledPath = path.join(root, "dist/ws/initialGreetingPolicy.test.cjs");
const source = readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
writeFileSync(compiledPath, compiled);
const require = createRequire(import.meta.url);
const {
  isThemisOutboundCampaignCall,
  resolveThemisCampaignOpening,
  resolveInitialResponseStartAction,
  buildThemisCampaignStartInstruction,
} = require(compiledPath);
assert.equal(typeof resolveThemisCampaignOpening, "function", "RED expected: approved campaign greeting must be preserved");
assert.equal(typeof resolveInitialResponseStartAction, "function", "RED expected: campaign prompt must start once session is ready");
assert.equal(typeof buildThemisCampaignStartInstruction, "function", "RED expected: Live must trigger the existing prompt, not invent a greeting");

const validCampaignEvidence = {
  direction: "outbound",
  campaignId: "campaign-test-1",
  variables: { intra_campaign: "true", fk_task_id: "task-test-1", debt_amount: "42.00" },
  campaignCallRow: { campaign_id: "campaign-test-1", fk_task_id: "task-test-1", debt_amount: "42.00" },
};
assert.equal(isThemisOutboundCampaignCall(validCampaignEvidence), true);
assert.equal(isThemisOutboundCampaignCall({ ...validCampaignEvidence, direction: undefined }), false);
assert.equal(isThemisOutboundCampaignCall({ ...validCampaignEvidence, direction: "inbound" }), false);
assert.equal(isThemisOutboundCampaignCall({ ...validCampaignEvidence, campaignId: "other" }), false);
assert.equal(isThemisOutboundCampaignCall({ ...validCampaignEvidence, campaignCallRow: null }), false);
assert.equal(isThemisOutboundCampaignCall({ ...validCampaignEvidence, campaignCallRow: { ...validCampaignEvidence.campaignCallRow, debt_amount: "" } }), false);
assert.equal(isThemisOutboundCampaignCall({ ...validCampaignEvidence, campaignCallRow: { ...validCampaignEvidence.campaignCallRow, fk_task_id: "other" } }), false);
assert.equal(isThemisOutboundCampaignCall({ ...validCampaignEvidence, variables: { ...validCampaignEvidence.variables, intra_campaign: "false" } }), false);

{
  const configuredGreeting = "Configured Themis campaign opening";
  const policy = resolveThemisCampaignOpening({
    callDirection: "outbound",
    isThemisOutboundCampaign: true,
    useInitialGreeting: false,
    greeting: configuredGreeting,
  });
  assert.equal(policy.useInitialGreeting, true, "verified campaign must auto-start regardless of optional agent toggle");
  assert.equal(policy.greeting, configuredGreeting, "configured campaign greeting must be preserved byte-for-byte");
  assert.equal(policy.source, "themis_campaign_prompt");
}

{
  const policy = resolveThemisCampaignOpening({
    callDirection: "outbound",
    isThemisOutboundCampaign: true,
    useInitialGreeting: false,
    greeting: "",
  });
  assert.equal(policy.useInitialGreeting, true);
  assert.equal(policy.greeting, "", "do not synthesize a new greeting when the campaign greeting field is blank");
  assert.equal(policy.source, "themis_campaign_prompt");
}

{
  const policy = resolveThemisCampaignOpening({
    callDirection: "outbound",
    isThemisOutboundCampaign: false,
    useInitialGreeting: false,
    greeting: "Keep this configured text",
  });
  assert.equal(policy.useInitialGreeting, false, "unrelated outbound calls must retain their existing policy");
  assert.equal(policy.greeting, "Keep this configured text");
  assert.equal(policy.source, "configured");
}

{
  const policy = resolveThemisCampaignOpening({
    callDirection: "outbound",
    isThemisOutboundCampaign: true,
    useInitialGreeting: false,
    greeting: "   ",
  });
  assert.equal(policy.greeting, "   ", "retain the configured value without treating whitespace as a spoken greeting");
  const action = resolveInitialResponseStartAction({
    sessionConfigured: true,
    openaiReady: true,
    pending: true,
    useInitialGreeting: policy.useInitialGreeting,
    greeting: policy.greeting,
    promptDrivenStart: true,
  });
  assert.equal(action, "send", "whitespace-only config falls through to the existing campaign prompt");
  assert(buildThemisCampaignStartInstruction(policy.greeting).includes("existing campaign prompt"));
}

{
  const base = { sessionConfigured: true, openaiReady: true, pending: true, useInitialGreeting: true, greeting: "" };
  assert.equal(resolveInitialResponseStartAction({ ...base, openaiReady: false, promptDrivenStart: true }), "wait");
  assert.equal(resolveInitialResponseStartAction({ ...base, sessionConfigured: false, promptDrivenStart: true }), "wait");
  assert.equal(resolveInitialResponseStartAction({ ...base, greeting: "Configured opening", promptDrivenStart: false }), "send");
  assert.equal(resolveInitialResponseStartAction({ ...base, promptDrivenStart: true }), "send", "blank greeting uses the existing prompt after session readiness");
  assert.equal(resolveInitialResponseStartAction({ ...base, pending: false, promptDrivenStart: true }), "done", "duplicate readiness must not start again");
  assert.equal(resolveInitialResponseStartAction({ ...base, useInitialGreeting: false, promptDrivenStart: false }), "skip");
}

{
  const configured = "  Configured campaign greeting  ";
  const instruction = buildThemisCampaignStartInstruction(configured);
  assert(instruction.includes(JSON.stringify(configured)), "existing configured greeting must be preserved without trimming");
  assert(instruction.includes("exactly once"));
  assert(instruction.includes("existing campaign prompt"));
  assert.equal(/identity|verification|isikutuvast|nime kinnit/i.test(instruction), false, "no added identity process");
}

{
  const instruction = buildThemisCampaignStartInstruction("");
  assert(instruction.includes("existing campaign prompt"));
  assert(instruction.includes("do not wait for caller audio"));
  assert(instruction.toLowerCase().includes("do not create a new greeting"));
  assert.equal(/identity|verification|isikutuvast|nime kinnit/i.test(instruction), false, "no additional identity flow");
}

const mediaStreamSource = readFileSync(path.join(root, "src/ws/media-stream.ts"), "utf8");
assert(mediaStreamSource.includes("resolveThemisCampaignOpening("), "media-stream must use the campaign-preserving opening policy");
assert(mediaStreamSource.includes("promptDrivenStart: isThemisOutboundCampaignContext"), "verified campaign must trigger from its prompt even with no greeting field");
assert(mediaStreamSource.includes("buildThemisCampaignStartInstruction(greeting)"), "Live must trigger the existing campaign prompt/opening");
assert(mediaStreamSource.includes("instructions: LIVE_FRONTEND_PROMPT"), "the approved Live frontend prompt must remain unchanged");
assert(mediaStreamSource.includes("greetingAppendContent: themisCampaignStartInstruction || undefined"), "scoped Live trigger must reach the adapter");
assert(mediaStreamSource.includes("backendInstructions: fullInstructions"), "the existing campaign prompt must remain in the Live backend instructions");
assert(mediaStreamSource.includes("turnDetection: null"), "Realtime VAD must not gate the initial turn");
const sessionUpdatedStart = mediaStreamSource.indexOf('case "session.updated":');
const sessionUpdatedEnd = mediaStreamSource.indexOf('case "response.created":', sessionUpdatedStart);
assert(sessionUpdatedStart >= 0 && sessionUpdatedEnd > sessionUpdatedStart, "session.updated handler must be locatable");
const sessionUpdatedBlock = mediaStreamSource.slice(sessionUpdatedStart, sessionUpdatedEnd);
assert(sessionUpdatedBlock.includes("sessionConfigured = true;") && sessionUpdatedBlock.includes("maybeStartInitialResponse();"), "initial response must trigger on configured session readiness");
assert.equal(mediaStreamSource.includes("buildThemisOutboundIdentityGuard"), false, "no additional identity guard may be injected");
const promptStart = mediaStreamSource.indexOf("const LIVE_FRONTEND_PROMPT = [");
const promptEndMarker = '].join("\\n");';
const promptEnd = mediaStreamSource.indexOf(promptEndMarker, promptStart);
assert(promptStart >= 0 && promptEnd >= promptStart, "Live frontend prompt block must be locatable");
const livePromptBlock = mediaStreamSource.slice(promptStart, promptEnd + promptEndMarker.length);
assert.equal(createHash("sha256").update(livePromptBlock).digest("hex"), "5ef866148985ee6fdd3500c6417d90411748f13f7f61303c98a8a542aa856619", "approved Live frontend prompt must be byte-for-byte unchanged");
const responseBlockStart = mediaStreamSource.indexOf("const greetingResponse: Record<string, unknown> = {};");
const responseBlockEnd = mediaStreamSource.indexOf("sendResponseCreate(\"initial-greeting\"", responseBlockStart);
assert(responseBlockStart >= 0 && responseBlockEnd > responseBlockStart, "initial greeting response block must be locatable");
assert(mediaStreamSource.slice(responseBlockStart, responseBlockEnd).includes("if (hasGreetingText)"), "whitespace-only greeting must not become a spoken override");

console.log("CAMPAIGN OPENING TESTS: 8 scope assertions + 4 policy cases + 6 dispatch cases + 2 start-instruction cases + 6 wiring/prompt-integrity cases");
