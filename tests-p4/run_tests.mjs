/**
 * THEMIS 5331 Phase 4 — isolated A/B/C tests (LOCAL, zero side effects).
 * Real source files transpiled with the project's TypeScript; deps stubbed;
 * global fetch routed to an in-process fake Supabase REST + fake Twilio.
 * No network, no DB writes, no outbound calls.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { strict as assert } from "node:assert";
import ts from "typescript";
import path from "node:path";

const ROOT = "/home/hermes/themis-voicebot";
const TMP = "/tmp/t5331p4_modules";
mkdirSync(TMP, { recursive: true });

let PASS = 0, FAIL = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { PASS++; console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { FAIL++; failures.push(name); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// ---------------- global fetch interception (installed FIRST) ----------------
let fetchLog = [];
let routes = []; // {match(url)->body | null, status}
globalThis.fetch = async (url, opts = {}) => {
  fetchLog.push({ url: String(url), method: opts.method || "GET", body: opts.body || null });
  for (const r of routes) {
    const m = r.match(String(url));
    if (m !== null && m !== undefined) {
      const body = typeof m === "function" ? m(String(url), opts) : m;
      const status = r.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: "route not found" }), text: async () => "not found" };
};

// ---------------- stub config (same shape as src/config.ts) ----------------
const configStub = {
  supabase: { url: "https://stub.supabase.co", serviceRoleKey: "stub-service-key", anonKey: "stub-anon" },
  twilio: {
    accountSid: "ACstub", authToken: "stub-token",
    fromNumber: "+37260000985", fromNumberLandline: "+37260002159", fromNumberFi: "+35860003936",
    isConfigured: true,
  },
  openai: { apiKey: "stub", isConfigured: true },
  publicBaseUrl: "https://stub-railway.app",
  themis: { agentId: "agent-stub", apiToken: "t", isApiConfigured: true },
};

const recorded = { updateCallBySid: [], upsertCall: [], dials: [] };

// ---------------- transpile ----------------
function transpileFile(rel, { stripImports = false, rewriteImports = {} } = {}) {
  const full = path.join(ROOT, rel);
  let src = readFileSync(full, "utf8");
  if (stripImports) {
    src = src.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
  } else {
    for (const [from, to] of Object.entries(rewriteImports)) {
      src = src.split(`from "${from}"`).join(`from "${to}"`);
    }
  }
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    fileName: full,
  }).outputText;
}

function writeTmp(name, js) {
  const p = path.join(TMP, name);
  writeFileSync(p, js);
  return p;
}

globalThis.__recorded = recorded;

// ---------------- module chain ----------------
// callResultMapper — pure
const mapperPath = writeTmp("callResultMapper.mjs", transpileFile("src/themis-intra/callResultMapper.ts", { stripImports: true }));

// campaignRepo — config/supabase seams stubbed
const repoPath = writeTmp("campaignRepo.mjs", `
const config = ${JSON.stringify(configStub)};
async function updateCallBySid(sid, patch) { globalThis.__recorded.updateCallBySid.push({ sid, patch }); return true; }
${transpileFile("src/themis-intra/campaignRepo.ts", { stripImports: true })}
`);
const repoUrl = "file://" + repoPath;

// buildStatistics — type-only imports pointed at stubs, value import at mapper
const statsPath = writeTmp("buildStatistics.mjs", transpileFile("src/themis-intra/buildStatistics.ts", {
  rewriteImports: {
    "./campaignRepo.js": "./campaignRepoStubTypes.mjs",
    "./types.js": "./typesStub.mjs",
    "./callResultMapper.js": "./callResultMapper.mjs",
  },
}));
writeTmp("campaignRepoStubTypes.mjs", "export const CampaignCallRow = {}; export const CallRecordRow = {};");
writeTmp("typesStub.mjs", "export const LegacyStatisticsRow = {};");

// retry — repo imported from the SAME loaded module instance; other deps stubbed
const retryPath = writeTmp("retry.mjs", `
import {
  fetchCampaignCallByCallId,
  scheduleCampaignRetry,
  fetchDueCampaignRetries,
  fetchCallsByIds,
  fetchCallsNeedingRetrySchedule,
  claimCampaignRetry,
  insertCampaignCall,
  updateCampaignCallByCallId,
  updateCampaignCallById,
} from "${repoUrl}";
const config = ${JSON.stringify(configStub)};
function upsertCall(callId, patch) { globalThis.__recorded.upsertCall.push({ callId, patch }); return true; }
async function startOutboundCall(params) {
  globalThis.__recorded.dials.push(params);
  return { ok: true, call_id: params.call_id, twilio_call_sid: "CA" + String(params.call_id).slice(0, 10), from_number: "stub-from" };
}
${transpileFile("src/themis-intra/retry.ts", { stripImports: true })}
`);
const retryUrl = "file://" + retryPath;

// ================= TEST A — duration mapping (no answered_at) =================
console.log("\n=== TEST A: duration mapping via fetchCallsByIds → buildStatisticsRows ===");
{
  fetchLog = [];
  // FIX 1 applied: the SELECT must NOT contain answered_at
  const repoSrc = readFileSync(path.join(ROOT, "src/themis-intra/campaignRepo.ts"), "utf8");
  const selects = repoSrc.match(/\/calls\?select=[^`"]+|\/calls\?id=in[^`"]+/g) || [];
  check("A0: no answered_at in any /calls select (FIX 1)", selects.every(s => !s.includes("answered_at")),
        `${selects.length} select strings checked`);

  // Stub Supabase: themis_campaign_calls rows + calls rows WITHOUT answered_at
  const CC_ROWS = [
    { id: "1", campaign_id: 4242, call_id: "call-aaa", fk_task_id: "4339", client_name: "Tanel T", phone: "+37251234567", debt_amount: "100.00", twilio_call_sid: "CAaa1", from_number: "+37260000985", attempt_number: 1, created_at: "2026-09-16T10:00:00Z" },
    { id: "2", campaign_id: 4242, call_id: "call-bbb", fk_task_id: "4340", client_name: "Mari M", phone: "+37251234568", debt_amount: "200.00", twilio_call_sid: "CAbb1", from_number: "+37260000985", attempt_number: 1, created_at: "2026-09-16T10:05:00Z" },
    { id: "3", campaign_id: 4242, call_id: "call-ccc", fk_task_id: "4341", client_name: "Jüri J", phone: "+37251234569", debt_amount: "300.00", twilio_call_sid: null, from_number: null, attempt_number: 1, created_at: "2026-09-16T10:07:00Z" },
  ];
  const CALLS_ROWS = [
    // NOTE: no answered_at key — exactly what prod schema returns
    { id: "call-aaa", twilio_call_sid: "CAaa1", campaign_id: "4242", to_number: "+37251234567", from_number: "+37260000985", status: "completed", started_at: "2026-09-13T18:50:47Z", ended_at: "2026-09-13T18:53:23Z", duration_seconds: 196, transcript: "t1", summary: "s1", recording_url: "r1" },
    { id: "call-bbb", twilio_call_sid: "CAbb1", campaign_id: "4242", to_number: "+37251234568", from_number: "+37260000985", status: "no-answer", started_at: "2026-09-16T10:05:10Z", ended_at: "2026-09-16T10:06:10Z", duration_seconds: null, transcript: null, summary: null, recording_url: null },
  ];
  routes = [{
    match: (url) => {
      if (url.includes("/rest/v1/themis_campaign_calls")) return CC_ROWS;
      if (url.includes("/rest/v1/calls?")) return url.includes("id=in.") ? CALLS_ROWS : CALLS_ROWS.filter(c => c.campaign_id === decodeURIComponent(url.split("campaign_id=eq.")[1]?.split("&")[0] || ""));
      return null;
    },
  }];

  const { fetchCallsByIds, fetchCallsByCampaignId } = await import(repoUrl);
  const byId = await fetchCallsByIds(["call-aaa", "call-bbb", "call-ccc"]);
  check("A1: fetchCallsByIds returns non-empty map (was: empty due to 400)", byId.size === 2, `size=${byId.size}`);
  check("A2: rows carry duration_seconds from stub", byId.get("call-aaa")?.duration_seconds === 196);

  const { buildStatisticsRows, buildStatisticsFromCallsOnly } = await import("file://" + statsPath);
  const rows = buildStatisticsRows(CC_ROWS, byId, "all");
  check("A3: 3 stat rows built", rows.length === 3, `got ${rows.length}`);
  check("A4: completed row call_length='196' (non-empty)", rows[0].call_length === "196", `got '${rows[0].call_length}'`);
  check("A5: no-answer row call_length='' (genuinely no duration)", rows[1].call_length === "", `got '${rows[1].call_length}'`);
  check("A6: call_status rendered from calls.status", rows[0].call_status === "completed" && rows[1].call_status === "no_answer");
  check("A7: row without calls-table row → call_status fallback 'unknown'", rows[2].call_status === "unknown", `got '${rows[2].call_status}'`);

  // Fallback path (fetchCallsByCampaignId) also fixed
  const fallback = await fetchCallsByCampaignId(4242);
  check("A8: fetchCallsByCampaignId (fallback) non-empty after FIX 1", fallback.length === 2, `got ${fallback.length}`);
  const rowsOnly = buildStatisticsFromCallsOnly(fallback, 4242);
  check("A9: calls-only stats carry call_length", rowsOnly[0]?.call_length === "196");

  // Verify the actual HTTP request the fixed code emits contains no answered_at
  const callsQuery = fetchLog.find(f => f.url.includes("/calls?id=in."));
  check("A10: emitted REST query contains no answered_at", callsQuery && !callsQuery.url.includes("answered_at"));
}

// ================= TEST B — timezone DST-safety =================
console.log("\n=== TEST B: formatLegacyCallDate Europe/Tallinn DST-safe ===");
{
  const { formatLegacyCallDate } = await import("file://" + mapperPath);

  // Summer (EEST, UTC+3): 2026-07-15T09:00:00Z = 12:00 Tallinn
  check("B1: July date → +03 summer rendering", formatLegacyCallDate("2026-07-15T09:00:00Z") === "2026-07-15 12:00:00",
        `got '${formatLegacyCallDate("2026-07-15T09:00:00Z")}'`);
  // Winter (EET, UTC+2): 2026-01-15T09:00:00Z = 11:00 Tallinn
  check("B2: January date → +02 winter rendering", formatLegacyCallDate("2026-01-15T09:00:00Z") === "2026-01-15 11:00:00",
        `got '${formatLegacyCallDate("2026-01-15T09:00:00Z")}'`);
  // The audit's live sample: 2026-09-13T18:50:47Z = 21:50:47 Tallinn (EEST +3)
  check("B3: audit live sample renders 2026-09-13 21:50:47", formatLegacyCallDate("2026-09-13T18:50:47Z") === "2026-09-13 21:50:47");
  // DST transition days: 2026-03-29 (EET→EEST 03:00→04:00) and 2026-10-25 (EEST→EET 04:00→03:00)
  check("B4: DST spring-forward day renders +03 after transition", formatLegacyCallDate("2026-03-29T04:00:00Z") === "2026-03-29 07:00:00",
        `got '${formatLegacyCallDate("2026-03-29T04:00:00Z")}'`);
  check("B5: DST fall-back day renders +02 after transition", formatLegacyCallDate("2026-10-25T04:00:00Z") === "2026-10-25 06:00:00",
        `got '${formatLegacyCallDate("2026-10-25T04:00:00Z")}'`);
  check("B6: no fixed-offset (offsets differ across DST) — B1 vs B2 hour delta is 1h not constant",
        formatLegacyCallDate("2026-07-15T09:00:00Z").slice(11) !== formatLegacyCallDate("2026-01-15T09:00:00Z").slice(11));
  check("B7: null/invalid → null", formatLegacyCallDate(null) === null && formatLegacyCallDate("garbage") === null);
  // DST instant boundary: just before spring transition = +02 still
  check("B8: pre-transition instant still +02", formatLegacyCallDate("2026-03-29T00:59:00Z") === "2026-03-29 02:59:00",
        `got '${formatLegacyCallDate("2026-03-29T00:59:00Z")}'`);
}

// ================= TEST C — scheduleMissedRetries flow with FIX 1 =================
console.log("\n=== TEST C: retry scheduling via scheduleMissedRetries (stubbed Supabase+Twilio) ===");
{
  // Fake themis_campaign_calls table (mutable state)
  const NOW = new Date("2026-09-16T12:00:00Z").getTime();
  const realDateNow = Date.now;
  Date.now = () => NOW;
  const realDate = Date;
  const FixedDate = class extends Date {
    constructor(...args) { super(args.length === 0 ? NOW : args[0]); }
    static now() { return NOW; }
  };
  globalThis.Date = FixedDate;

  try {
    // State: one unanswered attempt-1 call (no-answer), retry_status NULL, old enough (>3min)
    let ccTable = [
      {
        id: "r1", campaign_id: 4242, call_id: "call-un", fk_task_id: "4339", client_name: "Tanel T",
        phone: "+37251234567", debt_amount: "100.00", twilio_call_sid: "CAun", from_number: "+37260000985",
        voice: "Ash", attempt_number: 1, original_call_id: null, retry_status: null, retry_scheduled_at: null,
        retry_attempted_at: null, retry_reason: null,
        call_variables: { fk_task_id: "4339", client_name: "Tanel T", debt_amount: "100.00", campaign_id: "4242" },
        created_at: "2026-09-16T09:00:00Z",
      },
      {
        // answered call (completed) — must NOT schedule
        id: "r2", campaign_id: 4242, call_id: "call-ans", fk_task_id: "4340", client_name: "Mari M",
        phone: "+37251234568", debt_amount: "200.00", twilio_call_sid: "CAans", from_number: "+37260000985",
        voice: "Ash", attempt_number: 1, original_call_id: null, retry_status: null, retry_scheduled_at: null,
        retry_attempted_at: null, retry_reason: null,
        call_variables: { fk_task_id: "4340", client_name: "Mari M", debt_amount: "200.00", campaign_id: "4242" },
        created_at: "2026-09-16T09:00:00Z",
      },
    ];
    const callsTable = [
      { id: "call-un", twilio_call_sid: "CAun", campaign_id: "4242", to_number: "+37251234567", from_number: "+37260000985", status: "no-answer", started_at: "2026-09-16T09:00:30Z", ended_at: "2026-09-16T09:01:30Z", duration_seconds: null, transcript: null, summary: null, recording_url: null },
      { id: "call-ans", twilio_call_sid: "CAans", campaign_id: "4242", to_number: "+37251234568", from_number: "+37260000985", status: "completed", started_at: "2026-09-16T09:00:30Z", ended_at: "2026-09-16T09:04:00Z", duration_seconds: 196, transcript: null, summary: null, recording_url: null },
    ];
    let scheduledCount = 0; // how many rows the guard-based PATCH has flipped to scheduled

    // parse a PostgREST query into filters we simulate
    function simRest(url, opts) {
      const u = new URL(url);
      const table = u.pathname.split("/rest/v1/")[1];
      const method = opts.method || "GET";
      const body = opts.body ? JSON.parse(opts.body) : null;

      if (table === "themis_campaign_calls") {
        if (method === "GET") {
          // fetchCallsNeedingRetrySchedule: retry_status=is.null + or=(attempt=1,null) + sid not null + created < cutoff
          if (u.searchParams.get("retry_status") === "is.null" && u.searchParams.get("twilio_call_sid") === "not.is.null") {
            return ccTable.filter(r => !r.retry_status && (r.attempt_number === 1 || r.attempt_number == null) && r.twilio_call_sid && Date.parse(r.created_at) < NOW - 3 * 60_000);
          }
          // fetchDueCampaignRetries: retry_status=eq.scheduled&retry_attempted_at=is.null&retry_scheduled_at=lte.now
          if (u.searchParams.get("retry_status") === "eq.scheduled" && u.searchParams.get("retry_attempted_at") === "is.null") {
            return ccTable.filter(r => r.retry_status === "scheduled" && !r.retry_attempted_at && Date.parse(r.retry_scheduled_at) <= NOW);
          }
          // fetchCampaignCallByCallId: call_id=eq.X&select=*&limit=1
          const callEq = u.searchParams.get("call_id");
          if (callEq) return ccTable.filter(r => r.call_id === callEq.replace("eq.", ""));
          return ccTable;
        }
        if (method === "PATCH") {
          const prefer = (opts.headers?.Prefer || opts.headers?.prefer || "");
          // simulate SQL-style guarded UPDATE: filters must ALL hold for the row to be patched
          const retryStatusRaw = u.searchParams.get("retry_status");          // e.g. "is.null" / "eq.scheduled"
          const retryStatus = retryStatusRaw ? retryStatusRaw.replace(/^(eq|is)\./, "") : null; // null / "scheduled"
          const attemptFilter = u.searchParams.get("or");                     // (attempt_number.lt.3,attempt_number.is.null)
          const callEqRaw = u.searchParams.get("call_id");
          const idEqRaw = u.searchParams.get("id");
          const callEq = callEqRaw ? callEqRaw.replace(/^eq\./, "") : null;
          const idEq = idEqRaw ? idEqRaw.replace(/^eq\./, "") : null;
          const patched = [];
          for (const r of ccTable) {
            if (callEq !== null && r.call_id !== callEq) continue;
            if (idEq !== null && r.id !== idEq) continue;
            // "is.null" means the column must currently be NULL
            if (retryStatusRaw === "is.null" && r.retry_status !== null) continue;
            if (retryStatus === "scheduled" && r.retry_status !== "scheduled") continue;
            if (attemptFilter && !(r.attempt_number == null || r.attempt_number < 3)) continue;
            Object.assign(r, body);
            patched.push(r);
          }
          // scheduleCampaignRetry counts rows; if a unique-index-style insert conflict would occur we don't simulate here
          scheduledCount += (retryStatusRaw === "is.null" ? patched.length : 0);
          return prefer.includes("representation") ? patched : [];
        }
        if (method === "POST") {
          // insertCampaignCall — unique original_call_id guard: reject duplicates
          if (ccTable.some(r => r.original_call_id === body.original_call_id && body.original_call_id)) {
            return { ok: false, status: 409 };
          }
          ccTable.push({ ...body, id: "r" + (ccTable.length + 1), created_at: new Date(NOW).toISOString() });
          return { ok: true, status: 201, json: async () => [body] };
        }
      }
      if (table === "calls") {
        if (method === "GET") {
          const ids = decodeURIComponent(url).match(/id=in\.\(([^)]+)\)/);
          if (ids) {
            const list = ids[1].split(",").map(s => s.trim());
            return callsTable.filter(c => list.includes(c.id));
          }
          return callsTable;
        }
        if (method === "PATCH" || method === "POST") return { ok: true, status: 200, json: async () => [] };
      }
      return { ok: true, status: 200, json: async () => [] };
    }

    routes = [{
      match: (url, opts) => url.includes("/rest/v1/") ? simRest(url, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body }) : null,
    }];
    // The repo/retry modules call fetch(url, {method, headers, body}) — router passes opts through:
    globalThis.fetch = async (url, opts = {}) => {
      fetchLog.push({ url: String(url), method: opts.method || "GET", body: opts.body || null });
      for (const r of routes) {
        const m = r.match(String(url), opts);
        if (m !== null && m !== undefined) {
          const body = typeof m === "function" ? m(String(url), opts) : m;
          const b = body && body.status ? body : { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
          return b.ok !== undefined && b.status ? b : { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
        }
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    };

    const retry = await import(retryUrl);

    // C1: first scheduler tick — schedules exactly one (the no-answer), zero for answered
    recorded.dials.length = 0;
    const n1 = await retry.scheduleMissedRetries("corr-1");
    check("C1: first tick schedules exactly 1 (unanswered only)", n1 === 1, `scheduled=${n1}`);
    check("C1b: answered call scheduled nothing (retry_status still null)",
          ccTable.find(r => r.call_id === "call-ans").retry_status === null);
    check("C1c: scheduled row has retry_status='scheduled'",
          ccTable.find(r => r.call_id === "call-un").retry_status === "scheduled");

    // C2: repeated tick (simulating another webhook/scheduler pass) — still one scheduled total
    const n2 = await retry.scheduleMissedRetries("corr-2");
    check("C2: repeated tick schedules nothing new (guard)", n2 === 0, `scheduled=${n2}`);
    check("C2b: total scheduled rows still 1", ccTable.filter(r => r.retry_status === "scheduled").length === 1);

    // C3: due-date reached → processDueThemisRetries claims + dials attempt-2
    // move retry_scheduled_at into the past
    ccTable.find(r => r.call_id === "call-un").retry_scheduled_at = new Date(NOW - 1000).toISOString();
    recorded.dials.length = 0;
    recorded.upsertCall.length = 0;
    const proc = await retry.processDueThemisRetries("corr-3");
    check("C3: processDueThemisRetries started exactly 1 dial", proc.started === 1, JSON.stringify(proc));
    check("C3b: attempt-2 row inserted with original_call_id binding",
          ccTable.some(r => r.attempt_number === 2 && r.original_call_id === "call-un"));
    check("C3c: claimed row flipped to attempted",
          ccTable.find(r => r.call_id === "call-un").retry_status === "attempted");
    // C4: attempt-2 dial used the LANDLINE number override (bound to the C3 dial)
    check("C4: attempt-2 dial uses landline caller-ID override", recorded.dials[0]?.from_number_override === "+37260002159",
          `got ${recorded.dials[0]?.from_number_override}`);

    // C5: repeated scheduler tick — no second dial for the same original call
    // (r1 is now attempted; the fresh attempt-2 row is attempt>=2 and not scheduled → nothing due)
    const proc3 = await retry.processDueThemisRetries("corr-5");
    check("C5: repeated scheduler tick dials nothing new (claim guard)", proc3.started === 0, JSON.stringify(proc3));

    // C6: webhook repeat (scheduleThemisRetryIfNeeded on same call) — still one
    const wh = await retry.scheduleThemisRetryIfNeeded({ callId: "call-un", reason: "webhook_no_answer" });
    check("C6: repeated webhook request does not double-schedule", wh.scheduled === false && wh.reason === "already_scheduled", JSON.stringify(wh));

    // C7: idempotency census — exactly ONE attempt-2 row for the original call,
    // exactly one dial issued in total, original claimed exactly once.
    check("C7a: exactly 1 attempt-2 row with original_call_id=call-un (unique guard held)",
          ccTable.filter(r => r.original_call_id === "call-un").length === 1);
    check("C7b: exactly 1 dial recorded across the whole scenario", recorded.dials.length === 1, `dials=${recorded.dials.length}`);
    check("C7c: answered call never scheduled nor dialed",
          ccTable.find(r => r.call_id === "call-ans").retry_status === null);
  } finally {
    globalThis.Date = realDate;
  }
}

console.log(`\n========== RESULTS: PASS=${PASS} FAIL=${FAIL} ==========`)
if (failures.length) { console.log("FAILED:", failures.join(" | ")); process.exit(1); }
process.exit(0);
