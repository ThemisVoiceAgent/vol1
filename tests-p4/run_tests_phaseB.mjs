// 5331 Phase-B: structured outcome resolution + statistics propagation tests (pure functions).
import { resolveCallResult, mapLegacyCallOutcome } from "../dist/themis-intra/callResultMapper.js";
import { buildStatisticsRows, buildStatisticsFromCallsOnly } from "../dist/themis-intra/buildStatistics.js";

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

// B1: legacy statuses unchanged
t("B1 no_answer legacy", resolveCallResult("no-answer", null).call_result === "no_answer");
t("B1b busy legacy", resolveCallResult("busy", null).call_result === "busy");
t("B1c failed legacy", resolveCallResult("failed", null).call_result === "failed");
// B2: completed without outcome → other_completed (NOT unknown)
t("B2 completed no outcome", resolveCallResult("completed", null).call_result === "other_completed");
// B3: completed with structured outcome → outcome value
t("B3 payment_promise", resolveCallResult("completed", { outcome: "payment_promise" }).call_result === "payment_promise");
t("B3b refusal", resolveCallResult("completed", { outcome: "refusal" }).call_result === "refusal");
t("B3c dispute", resolveCallResult("completed", "dispute").call_result === "dispute");
// B4: invalid outcome string → other_completed (never "unknown" for answered)
t("B4 invalid outcome", resolveCallResult("completed", { outcome: "hacky" }).call_result === "other_completed");
// B5: legacy mapper untouched
t("B5 legacy mapper completed", mapLegacyCallOutcome("completed").call_result === "unknown");

// B6: statistics row carries outcome + promise fields + claimant context
const cc = { id: "7", call_id: "call-7", campaign_id: 1234, fk_task_id: "5331", client_name: "Test",
  phone: "+3720000", debt_amount: "100.00", twilio_call_sid: "CAx", from_number: "+3721111",
  voice: "ash", call_variables: { creditor_name: "Test AS", last_income_date: "2023-02-01" },
  attempt_number: 2 };
const call = { id: "call-7", twilio_call_sid: "CAx", campaign_id: "1234", to_number: "+3720000",
  from_number: "+3721111", status: "completed", started_at: "2026-10-06T16:38:37Z", ended_at: null,
  answered_at: null, outcome: { outcome: "payment_promise", payment_promise_date: "2026-10-10",
  payment_promise_amount: "500.00" }, duration_seconds: 60, transcript: "x", summary: "s", recording_url: "r" };
const row = buildStatisticsRows([cc], new Map([["call-7", call]]), 1234)[0];
t("B6 result=payment_promise", row.call_result === "payment_promise");
t("B6b promise_date", row.payment_promise_date === "2026-10-10");
t("B6c promise_amount", row.payment_promise_amount === "500.00");
t("B6d creditor passthrough", row.creditor_name === "Test AS");
t("B6e last_payment passthrough", row.last_payment_date === "2023-02-01");
t("B6f attempt_number", row.attempt_number === "2");

// B7: calls-only fallback keeps legacy shape (no crash on missing outcome)
const solo = buildStatisticsFromCallsOnly([{ ...call, outcome: null }], 99)[0];
t("B7 solo other_completed", solo.call_result === "other_completed");
t("B7b solo outcome empty", (solo.outcome || "") === "");

console.log(`========== PHASE B RESULTS: PASS=${pass} FAIL=${fail} ==========`);
process.exit(fail ? 1 : 0);
