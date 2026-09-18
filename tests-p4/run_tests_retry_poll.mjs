/**
 * THEMIS 5331 — TEST H: retry-dialed call status write-back (LOCAL, zero side effects).
 *
 * Reproduces the 2026-09-17 production gap (call 36e1cc1e / CA5f88558e): an attempt-2 call
 * started by processDueThemisRetries reached Twilio terminal 'no-answer' but the calls row
 * stayed at status='initiated' forever, because the retry path registered no auto-poll and
 * the Twilio StatusCallback never fires (21626).
 *
 * Real modules exercised: themis-intra/retry.ts, themis-intra/campaignRepo.ts,
 * themis-intra/callStatusPoll.ts, services/twilioSms.ts (guard + marker).
 * Stubbed seams: config, supabase.updateCallBySid/upsertCall (write into a fake calls table),
 * outboundCall.startOutboundCall (records dial, returns fake SID), themisPostCallSms (records send),
 * global fetch (fake PostgREST + fake Twilio Call resource), setTimeout (captured, drained manually).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import ts from "typescript";
import path from "node:path";

const ROOT = "/home/hermes/themis-voicebot";
const TMP = "/tmp/t5331h_modules";
mkdirSync(TMP, { recursive: true });

let PASS = 0, FAIL = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { PASS++; console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { FAIL++; failures.push(name); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const configStub = {
  supabase: { url: "https://stub.supabase.co", serviceRoleKey: "stub-service-key", anonKey: "stub-anon" },
  twilio: {
    accountSid: "ACstub", authToken: "stub-token",
    fromNumber: "+372****0985", fromNumberLandline: "+372****2159", fromNumberFi: "+358****3936",
    isConfigured: true,
  },
  publicBaseUrl: "https://stub-railway.app",
  themis: { agentId: "agent-stub", apiToken: "t", isApiConfigured: true },
};

// ---------------- fake state ----------------
const NOW = new Date("2026-09-17T15:58:25Z").getTime();
const realDate = Date;
globalThis.Date = class extends Date {
  constructor(...args) { super(args.length === 0 ? NOW : args[0]); }
  static now() { return NOW; }
};

const ccTable = [
  {
    // attempt-1 row: busy → retry scheduled, now due (mirrors campaign 1789646216061 / f4166c35)
    id: "f6d5ed90", campaign_id: 1789646216061, call_id: "f4166c35", fk_task_id: "4339", client_name: "Tanel T",
    phone: "+372****2318", debt_amount: "100.00", twilio_call_sid: "CA44422a45", from_number: "+372****9858",
    voice: "Sage", attempt_number: 1, original_call_id: null, retry_status: "scheduled",
    retry_scheduled_at: "2026-09-17T15:56:56Z", retry_attempted_at: null, retry_reason: "auto_poll_busy",
    call_variables: { fk_task_id: "4339", client_name: "Tanel T", debt_amount: "100.00", campaign_id: "1789646216061", deptor_phone: "+372****2318" },
    created_at: "2026-09-17T11:56:56Z",
  },
];
const callsTable = [
  { id: "f4166c35", twilio_call_sid: "CA44422a45", campaign_id: "1789646216061", to_number: "+372****2318", from_number: "+372****9858", status: "busy", started_at: "2026-09-17T11:56:57Z", ended_at: "2026-09-17T11:58:13Z", duration_seconds: 0 },
];
const smsTable = [];
const twilioCalls = {}; // sid -> {status, endTime, duration, to}
const recorded = { dials: [], sentSms: [], updateCallBySid: [] };
globalThis.__recorded = recorded;
globalThis.__callsTable = callsTable;

// captured timers
const timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
async function drainTimers(label) {
  // Fire only the timers pending NOW (one poll cycle); timers scheduled by those callbacks stay queued.
  const batch = timers.splice(0, timers.length);
  for (const t of batch) await t.fn();
  return batch.length;
}

// ---------------- fake PostgREST + Twilio ----------------
function simRest(url, opts) {
  const u = new URL(url);
  const table = u.pathname.split("/rest/v1/")[1];
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  const ok = (b, status = 200) => ({ ok: true, status, json: async () => b, text: async () => JSON.stringify(b) });

  if (table === "themis_campaign_calls") {
    if (method === "GET") {
      if (u.searchParams.get("retry_status") === "eq.scheduled" && u.searchParams.get("retry_attempted_at") === "is.null") {
        return ok(ccTable.filter(r => r.retry_status === "scheduled" && !r.retry_attempted_at && realDate.parse(r.retry_scheduled_at) <= NOW));
      }
      if (u.searchParams.get("retry_status") === "is.null" && u.searchParams.get("twilio_call_sid") === "not.is.null") {
        return ok(ccTable.filter(r => !r.retry_status && (r.attempt_number === 1 || r.attempt_number == null) && r.twilio_call_sid && realDate.parse(r.created_at) < NOW - 3 * 60_000));
      }
      const callEq = u.searchParams.get("call_id");
      if (callEq) return ok(ccTable.filter(r => r.call_id === callEq.replace("eq.", "")));
      return ok(ccTable);
    }
    if (method === "PATCH") {
      const prefer = (opts.headers?.Prefer || "");
      const retryStatusRaw = u.searchParams.get("retry_status");
      const attemptFilter = u.searchParams.get("or");
      const callEq = u.searchParams.get("call_id")?.replace(/^eq\./, "") ?? null;
      const idEq = u.searchParams.get("id")?.replace(/^eq\./, "") ?? null;
      const patched = [];
      for (const r of ccTable) {
        if (callEq !== null && r.call_id !== callEq) continue;
        if (idEq !== null && r.id !== idEq) continue;
        if (retryStatusRaw === "is.null" && r.retry_status !== null) continue;
        if (retryStatusRaw === "eq.scheduled" && r.retry_status !== "scheduled") continue;
        if (attemptFilter && !(r.attempt_number == null || r.attempt_number < 3)) continue;
        Object.assign(r, body);
        patched.push(r);
      }
      return ok(prefer.includes("representation") ? patched : []);
    }
    if (method === "POST") {
      if (body.original_call_id && ccTable.some(r => r.original_call_id === body.original_call_id)) {
        return { ok: false, status: 409, json: async () => ({ code: "23505" }), text: async () => "duplicate" };
      }
      ccTable.push({ ...body, id: "row-" + (ccTable.length + 1), retry_status: null, retry_scheduled_at: null, retry_attempted_at: null, retry_reason: null, created_at: new realDate(NOW).toISOString() });
      return ok([body], 201);
    }
  }
  if (table === "calls") {
    if (method === "GET") {
      const ids = decodeURIComponent(url).match(/id=in\.\(([^)]+)\)/);
      if (ids) { const list = ids[1].split(","); return ok(callsTable.filter(c => list.includes(c.id))); }
      return ok(callsTable);
    }
  }
  if (table === "sms_messages") {
    if (method === "GET") {
      const callEq = (u.searchParams.get("call_id") || "").replace("eq.", "");
      const tmplEq = (u.searchParams.get("template_name") || "").replace("eq.", "");
      return ok(smsTable.filter(r => r.call_id === callEq && r.template_name === tmplEq));
    }
    if (method === "POST") {
      if (smsTable.some(r => r.call_id === body.call_id && r.template_name === body.template_name)) {
        return { ok: false, status: 409, json: async () => ({ code: "23505" }), text: async () => "duplicate" };
      }
      const id = "sms-" + (smsTable.length + 1);
      smsTable.push({ id, ...body });
      return ok([{ id }], 201);
    }
    if (method === "PATCH") {
      const idEq = (u.searchParams.get("id") || "").replace("eq.", "");
      const row = smsTable.find(r => r.id === idEq);
      if (row) Object.assign(row, body);
      return ok([]);
    }
  }
  return ok([]);
}

globalThis.fetch = async (url, opts = {}) => {
  const s = String(url);
  if (s.includes("/rest/v1/")) return simRest(s, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
  const m = s.match(/api\.twilio\.com\/2010-04-01\/Accounts\/[^/]+\/Calls\/([^.]+)\.json/);
  if (m) {
    const c = twilioCalls[m[1]];
    if (!c) return { ok: false, status: 404, json: async () => ({}), text: async () => "nf" };
    return { ok: true, status: 200, json: async () => c, text: async () => JSON.stringify(c) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};

// ---------------- transpile real modules ----------------
function transpileFile(rel, { stripImports = false, rewriteImports = {} } = {}) {
  let src = readFileSync(path.join(ROOT, rel), "utf8");
  if (stripImports) src = src.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
  for (const [from, to] of Object.entries(rewriteImports)) src = src.split(`from "${from}"`).join(`from "${to}"`);
  return ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }, fileName: rel }).outputText;
}
function writeTmp(name, js) { const p = path.join(TMP, name); writeFileSync(p, js); return p; }

writeTmp("config.mjs", `export const config = ${JSON.stringify(configStub)};`);
writeTmp("supabase.mjs", `
  export async function upsertCall(callId, patch) {
    const t = globalThis.__callsTable; const ex = t.find(c => c.id === callId);
    if (ex) Object.assign(ex, patch); else t.push({ id: callId, ...patch, ended_at: null, duration_seconds: null });
  }
  export async function updateCallBySid(sid, patch) {
    globalThis.__recorded.updateCallBySid.push({ sid, patch });
    const row = globalThis.__callsTable.find(c => c.twilio_call_sid === sid);
    if (row) Object.assign(row, patch);
  }
`);
writeTmp("outboundCall.mjs", `
  export async function startOutboundCall(params) {
    globalThis.__recorded.dials.push(params);
    return { ok: true, call_id: params.call_id, twilio_call_sid: "CA-" + params.call_id, from_number: params.from_number_override || "+372****0985" };
  }
`);
writeTmp("themisPostCallSms.mjs", `
  export const THEMIS_POST_CALL_SMS_TEMPLATE = "themis_post_call_sms_v1";
  export function renderThemisPostCallSmsBody(d) { return "SMS:" + d; }
  export function resolveThemisSmsProvider() { return "twilio"; }
  export function resolveThemisSmsSender() { return "+372****0985"; }
  export async function sendThemisPostCallSms(p) {
    globalThis.__recorded.sentSms.push(p);
    return { ok: true, provider: "twilio", providerMessageId: "SM" + globalThis.__recorded.sentSms.length, status: "sent" };
  }
`);
writeTmp("campaignRepo.mjs", transpileFile("src/themis-intra/campaignRepo.ts", { rewriteImports: { "../config.js": "./config.mjs", "../supabase.js": "./supabase.mjs" } }));
writeTmp("twilioSms.mjs", transpileFile("src/services/twilioSms.ts", { rewriteImports: { "../config.js": "./config.mjs" } }));
writeTmp("retry.mjs", transpileFile("src/themis-intra/retry.ts", { rewriteImports: {
  "../config.js": "./config.mjs", "../supabase.js": "./supabase.mjs", "../services/outboundCall.js": "./outboundCall.mjs",
  "./callStatusPoll.js": "./callStatusPoll.mjs", "./campaignRepo.js": "./campaignRepo.mjs",
} }));
const pollPath = writeTmp("callStatusPoll.mjs", transpileFile("src/themis-intra/callStatusPoll.ts", { rewriteImports: {
  "../config.js": "./config.mjs", "../supabase.js": "./supabase.mjs", "./retry.js": "./retry.mjs",
  "../services/themisPostCallSms.js": "./themisPostCallSms.mjs", "../services/twilioSms.js": "./twilioSms.mjs",
} }));

const retry = await import("file://" + path.join(TMP, "retry.mjs"));

// ================= H1 — attempt-2 dial registers poll; poll writes terminal no-answer =================
console.log("\n=== TEST H: retry-dialed call → auto-poll → terminal status write-back → SMS once → attempt-3 policy ===");
{
  const proc = await retry.processDueThemisRetries("h-corr-1");
  check("H1: due attempt-1 row → exactly 1 attempt-2 dial", proc.started === 1 && recorded.dials.length === 1, JSON.stringify(proc));
  const a2 = ccTable.find(r => r.attempt_number === 2);
  check("H1b: attempt-2 row bound to original call + landline caller-ID", a2 && a2.original_call_id === "f4166c35" && recorded.dials[0].from_number_override === "+372****2159");
  const a2sid = "CA-" + a2.call_id;
  const a2call = callsTable.find(c => c.id === a2.call_id);
  check("H1c: calls row for attempt-2 upserted as 'initiated' (pre-state of the prod gap)", a2call && a2call.status === "initiated");
  check("H2: retry path registered an auto-poll timer (was: none → root cause)", timers.length === 1 && timers[0].ms === 75_000, `timers=${timers.length} ms=${timers[0]?.ms}`);

  // Twilio: still ringing at first poll
  twilioCalls[a2sid] = { sid: a2sid, status: "ringing", to: "+372****2318", endTime: null, duration: null };
  await drainTimers();
  check("H3: non-terminal poll → calls row untouched, re-poll scheduled (60s)", a2call.status === "initiated" && timers.length === 1 && timers[0].ms === 60_000);

  // Twilio: 60s ring → no-answer (exactly CA5f88558e's outcome)
  twilioCalls[a2sid] = { sid: a2sid, status: "no-answer", to: "+372****2318", endTime: "Thu, 17 Sep 2026 15:59:27 +0000", duration: "0" };
  await drainTimers();
  check("H4: terminal no-answer written back to calls row (was: stuck 'initiated')", a2call.status === "no-answer", `status=${a2call.status}`);
  check("H4b: ended_at persisted from Twilio endTime", a2call.ended_at === "2026-09-17T15:59:27.000Z", `ended_at=${a2call.ended_at}`);
  check("H4c: updateCallBySid called exactly once for attempt-2 SID", recorded.updateCallBySid.filter(u => u.sid === a2sid).length === 1);
  check("H5: post-call SMS sent exactly once for attempt-2 (guard + marker)", recorded.sentSms.length === 1 && smsTable.filter(r => r.call_id === a2.call_id).length === 1, `sends=${recorded.sentSms.length}`);
  check("H5b: SMS marker status=sent with provider id", smsTable[0]?.status === "sent" && smsTable[0]?.twilio_sid === "SM1");
  check("H6: attempt-2 no-answer → attempt-3 retry scheduled on the attempt-2 row (policy: retries up to attempt 3)",
        a2.retry_status === "scheduled" && a2.retry_reason === "auto_poll_no-answer", `retry_status=${a2.retry_status} reason=${a2.retry_reason}`);
  check("H6b: retry_scheduled_at = attempt-2 created_at + 240 min", a2.retry_scheduled_at === new realDate(realDate.parse(a2.created_at) + 240 * 60_000).toISOString(), a2.retry_scheduled_at);
  check("H6c: no further poll timers after terminal", timers.length === 0);

  // Repeat safety-net pass (webhook / poll duplicate) — nothing doubles
  const again = await retry.scheduleThemisRetryIfNeeded({ callId: a2.call_id, reason: "webhook_no-answer" });
  check("H7: repeated schedule request on attempt-2 → already_scheduled (exactly-once)", again.scheduled === false && again.reason === "already_scheduled");

  // ---- attempt-3: due → dial with FI number → poll → no-answer → NO attempt-4 ----
  a2.retry_scheduled_at = new realDate(NOW - 1000).toISOString();
  const proc3 = await retry.processDueThemisRetries("h-corr-3");
  const a3 = ccTable.find(r => r.attempt_number === 3);
  check("H8: attempt-2 due → exactly 1 attempt-3 dial with FI caller-ID", proc3.started === 1 && a3 && recorded.dials[1].from_number_override === "+358****3936", JSON.stringify(proc3));
  check("H8b: attempt-3 row bound to attempt-2 call_id", a3.original_call_id === a2.call_id);
  check("H8c: attempt-3 dial also registered an auto-poll", timers.length === 1 && timers[0].ms === 75_000);
  const a3sid = "CA-" + a3.call_id;
  twilioCalls[a3sid] = { sid: a3sid, status: "no-answer", to: "+372****2318", endTime: "Thu, 17 Sep 2026 20:00:27 +0000", duration: "0" };
  await drainTimers();
  const a3call = callsTable.find(c => c.id === a3.call_id);
  check("H9: attempt-3 terminal no-answer written back", a3call.status === "no-answer");
  check("H9b: attempt-3 SMS sent exactly once (total sends = 2 across 2 terminal calls)", recorded.sentSms.length === 2 && smsTable.filter(r => r.call_id === a3.call_id).length === 1);
  check("H10: attempt-3 no-answer → NO attempt-4 scheduled (MAX_ATTEMPT=3 guard)", a3.retry_status === null, `retry_status=${a3.retry_status}`);
  const proc4 = await retry.processDueThemisRetries("h-corr-4");
  check("H10b: scheduler tick dials nothing more (total dials = 2)", proc4.started === 0 && recorded.dials.length === 2);

  // ---- Answered attempt-2 (completed) → SMS once, no retry ----
  ccTable.push({
    id: "x1", campaign_id: 1789646216061, call_id: "orig-2", fk_task_id: "9001", client_name: "Mari M", phone: "+372****4568",
    debt_amount: "50.00", twilio_call_sid: "CAorig2", from_number: "+372****9858", voice: "Sage", attempt_number: 1, original_call_id: null,
    retry_status: "scheduled", retry_scheduled_at: new realDate(NOW - 5000).toISOString(), retry_attempted_at: null, retry_reason: "auto_poll_no-answer",
    call_variables: { fk_task_id: "9001", client_name: "Mari M", debt_amount: "50.00", campaign_id: "1789646216061" }, created_at: "2026-09-17T11:00:00Z",
  });
  const proc5 = await retry.processDueThemisRetries("h-corr-5");
  const b2 = ccTable.find(r => r.attempt_number === 2 && r.original_call_id === "orig-2");
  const b2sid = "CA-" + b2.call_id;
  twilioCalls[b2sid] = { sid: b2sid, status: "completed", to: "+372****4568", endTime: "Thu, 17 Sep 2026 16:10:00 +0000", duration: "80" };
  await drainTimers();
  const b2call = callsTable.find(c => c.id === b2.call_id);
  check("H11: answered attempt-2 → status completed + duration 80 persisted", proc5.started === 1 && b2call.status === "completed" && b2call.duration_seconds === 80, `status=${b2call?.status} dur=${b2call?.duration_seconds}`);
  check("H11b: answered attempt-2 → SMS once, NO retry scheduled", smsTable.filter(r => r.call_id === b2.call_id).length === 1 && b2.retry_status === null);

  // ---- Static: both dial paths use the same helper; no inline duplicate remains ----
  const routeSrc = readFileSync(path.join(ROOT, "src/routes/themis-intra.ts"), "utf8");
  const retrySrc = readFileSync(path.join(ROOT, "src/themis-intra/retry.ts"), "utf8");
  check("H12: campaign route + retry path both call startThemisCallStatusAutoPoll (single wiring)",
        routeSrc.includes("startThemisCallStatusAutoPoll({") && retrySrc.includes("startThemisCallStatusAutoPoll({"));
  check("H12b: no inline pollCallStatus duplicate left in route", !routeSrc.includes("async function pollCallStatus"));
}

globalThis.Date = realDate;
globalThis.setTimeout = realSetTimeout;
console.log(`\n========== TEST H RESULTS: PASS=${PASS} FAIL=${FAIL} ==========`);
if (failures.length) { console.log("FAILED:", failures.join(" | ")); process.exit(1); }
process.exit(0);
