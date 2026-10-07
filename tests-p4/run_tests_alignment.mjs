// 5331 final alignment tests: claimant/last-payment aliases + WhatsApp gating (pure, no network).
import { mergeIntraIntoCallVariables } from "../dist/themis-intra/applyCallContext.js";

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

// F1: TÕB creditor -> claim_owner_type=tob, NO claimant_name
{
  const vars = { creditor_name: "Themis Õigusbüroo OÜ", debt_amount: "100" };
  mergeIntraIntoCallVariables(vars, null, null);
  t("F1 tob type", vars.claim_owner_type === "tob");
  t("F1b no claimant_name", vars.claimant_name === undefined);
}
// F2: external creditor -> claimant_name spoken
{
  const vars = { creditor_name: "Balti Laenu OÜ", debt_amount: "500" };
  mergeIntraIntoCallVariables(vars, null, null);
  t("F2 external type", vars.claim_owner_type === "external");
  t("F2b claimant_name", vars.claimant_name === "Balti Laenu OÜ");
}
// F3: last payment date + days
{
  const daysAgo = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const vars = { last_income_date: daysAgo };
  mergeIntraIntoCallVariables(vars, null, null);
  t("F3 last_payment_date mirrored", vars.last_payment_date === daysAgo);
  const n = Number(vars.days_since_last_payment);
  t("F3b days_since 43..47", n >= 43 && n <= 47);
}
// F4: no fabrication — absent fields stay absent
{
  const vars = { debt_amount: "10" };
  mergeIntraIntoCallVariables(vars, null, null);
  t("F4 no creditor -> no owner type", vars.claim_owner_type === undefined);
  t("F4b no last payment -> absent", vars.last_payment_date === undefined && vars.days_since_last_payment === undefined);
}

// F5: WhatsApp gating (unit — the service file loaded with env off)
process.env.THEMIS_WHATSAPP_ENABLED = "";
const { sendThemisPostCallWhatsapp, THEMIS_POST_CALL_WHATSAPP_TEMPLATE } = await import("../dist/services/themisPostCallWhatsapp.js");
{
  const r = await sendThemisPostCallWhatsapp({ callId: "x", to: "+3720000", body: "x" });
  t("F5 whatsapp disabled by default (no sends)", r.ok === false && r.skippedReason === "disabled");
}
// F6: enabled but no copy -> no_send (never invent)
process.env.THEMIS_WHATSAPP_ENABLED = "true";
{
  const r = await sendThemisPostCallWhatsapp({ callId: "x", to: "+3720000", body: "  " });
  t("F6 no_copy guard", r.ok === false && r.skippedReason === "no_copy");
}
t("F7 template key stable", THEMIS_POST_CALL_WHATSAPP_TEMPLATE === "themis_post_call_whatsapp_v1");

console.log(`========== ALIGNMENT RESULTS: PASS=${pass} FAIL=${fail} ==========`);
process.exit(fail ? 1 : 0);
