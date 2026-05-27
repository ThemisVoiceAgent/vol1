import type { IntraCampaignClient } from "./types.js";

/** Build call variables for Twilio voice URL / agent prompt substitution. */
export function buildCallVariables(
  client: IntraCampaignClient,
  campaignId: number,
  selectedVoice: string
): Record<string, string> {
  const vars: Record<string, string> = {
    campaign_id: String(campaignId),
    selected_voice: selectedVoice,
    force_outside_schedule: "true",
  };

  if (client.fk_task_id) {
    vars.fk_task_id = String(client.fk_task_id);
    vars.client_id = String(client.fk_task_id);
  }
  if (client.name) {
    vars.client_name = client.name;
    vars.full_name = client.name;
    vars.caller_name = client.name;
    vars.first_name = client.name.split(/\s+/)[0] || client.name;
  }
  if (client.claim_remain) {
    vars.debt_amount = String(client.claim_remain);
    vars.claim_remain = String(client.claim_remain);
  }
  if (client.last_income_date) {
    vars.last_income_date = String(client.last_income_date);
  }
  if (client.dept_source) {
    vars.dept_source = String(client.dept_source);
  }
  if (client.creditor_name) {
    vars.creditor_name = String(client.creditor_name);
  }
  if (client.case_name) {
    vars.case_name = String(client.case_name);
  }

  return vars;
}
