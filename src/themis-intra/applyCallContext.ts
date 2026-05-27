import type { CampaignCallRow } from "./campaignRepo.js";

/** Merge Intra campaign row + stored JSON into live callVariables (DB wins over empty). */
export function mergeIntraIntoCallVariables(
  callVariables: Record<string, string>,
  row: CampaignCallRow | null,
  storedVars?: Record<string, string> | null
): void {
  const fromStored = storedVars && typeof storedVars === "object" ? storedVars : {};
  const merged: Record<string, string> = { ...fromStored };

  if (row) {
    if (row.campaign_id != null) merged.campaign_id = String(row.campaign_id);
    if (row.fk_task_id) {
      merged.fk_task_id = row.fk_task_id;
      merged.client_id = row.fk_task_id;
    }
    if (row.client_name) merged.client_name = row.client_name;
    if (row.phone) merged.phone = row.phone;
    if (row.debt_amount) merged.debt_amount = row.debt_amount;
    if (row.voice) merged.selected_voice = row.voice;
  }

  applyThemisVariableAliases(merged);

  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || value === "") continue;
    callVariables[key] = String(value);
  }

  callVariables.intra_campaign = "true";
  applyThemisVariableAliases(callVariables);
}

/** Map Intra fields to common {{placeholder}} names used in Themis agent prompts. */
export function applyThemisVariableAliases(vars: Record<string, string>): void {
  if (vars.client_name) {
    vars.full_name = vars.client_name;
    vars.caller_name = vars.client_name;
    vars.debtor_name = vars.client_name;
    vars.first_name = vars.client_name.split(/\s+/)[0] || vars.client_name;
  }
  const amount = vars.debt_amount || vars.claim_remain;
  if (amount) {
    vars.debt_amount = amount;
    vars.claim_remain = amount;
    vars.amount = amount;
    vars.balance = amount;
    vars.outstanding_balance = amount;
    vars.debt_balance = amount;
  }
}

export function logThemisContext(callVariables: Record<string, string>, callId: string): void {
  console.log(
    `[ThemisContext] call_variables amount=${callVariables.debt_amount || callVariables.claim_remain || "-"} ` +
      `name=${callVariables.client_name || callVariables.first_name || "-"} ` +
      `fk_task_id=${callVariables.fk_task_id || "-"} ` +
      `campaign_id=${callVariables.campaign_id || "-"} ` +
      `callId=${callId}`
  );
}

/** Mandatory per-call facts — overrides hardcoded example amounts/days in agent script. */
export function appendThemisIntraContextBlock(
  instructions: string,
  callVariables: Record<string, string>
): string {
  if (callVariables.intra_campaign !== "true") return instructions;

  const lines: string[] = [
    "",
    "--- THIS CALL — MANDATORY FACTS (override any example/test figures elsewhere in these instructions) ---",
  ];

  const name = callVariables.client_name || callVariables.debtor_name || callVariables.first_name;
  if (name) lines.push(`Debtor name (verify identity): ${name}`);

  const amount = callVariables.debt_amount || callVariables.claim_remain;
  if (amount) lines.push(`Outstanding balance for this call ONLY: ${amount} EUR`);

  if (callVariables.last_income_date) {
    lines.push(`Last income / payment date context: ${callVariables.last_income_date}`);
  }
  if (callVariables.dept_source) lines.push(`Debt source: ${callVariables.dept_source}`);
  if (callVariables.creditor_name) lines.push(`Creditor: ${callVariables.creditor_name}`);
  if (callVariables.case_name) lines.push(`Case: ${callVariables.case_name}`);
  if (callVariables.days_overdue) {
    lines.push(`Days overdue for this call ONLY: ${callVariables.days_overdue}`);
  } else {
    lines.push(
      "Do NOT state how many days the debt is overdue unless the caller asks; do not use example overdue periods from the script."
    );
  }

  lines.push(
    "Use ONLY the balance and dates listed in this block. Do NOT mention 1236.69, 120 days, or any other example amount/period from the script."
  );
  lines.push("--- END THIS CALL ---");

  return instructions + lines.join("\n");
}

export function parseStoredCallVariables(raw: unknown): Record<string, string> | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v != null && v !== "") out[k] = String(v);
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  if (typeof raw === "string") {
    try {
      return parseStoredCallVariables(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return null;
}
