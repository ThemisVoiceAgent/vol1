export type ThemisOutboundCampaignEvidence = {
  direction: unknown;
  campaignId: unknown;
  variables: Record<string, unknown> | null | undefined;
  campaignCallRow: {
    campaign_id?: unknown;
    fk_task_id?: unknown;
    debt_amount?: unknown;
  } | null | undefined;
};

/** Require an explicit outbound marker and a matching persisted Themis campaign-call row. */
export function isThemisOutboundCampaignCall(evidence: ThemisOutboundCampaignEvidence): boolean {
  if (evidence.direction !== "outbound") return false;

  const campaignId = String(evidence.campaignId ?? "").trim();
  const variables = evidence.variables ?? {};
  const row = evidence.campaignCallRow;
  const taskId = String(variables.fk_task_id ?? "").trim();
  const variableDebt = String(variables.debt_amount ?? variables.claim_remain ?? "").trim();

  if (!campaignId || variables.intra_campaign !== "true" || !taskId || !variableDebt || !row) return false;

  return (
    String(row.campaign_id ?? "").trim() === campaignId &&
    String(row.fk_task_id ?? "").trim() === taskId &&
    String(row.debt_amount ?? "").trim() !== ""
  );
}

export type InitialResponseStartAction = "wait" | "done" | "skip" | "send";

export function resolveInitialResponseStartAction(input: {
  sessionConfigured: boolean;
  openaiReady: boolean;
  pending: boolean;
  useInitialGreeting: boolean;
  greeting: string;
  promptDrivenStart: boolean;
}): InitialResponseStartAction {
  if (!input.sessionConfigured || !input.openaiReady) return "wait";
  if (!input.pending) return "done";
  return input.useInitialGreeting && (input.greeting.trim() || input.promptDrivenStart) ? "send" : "skip";
}

export type ThemisCampaignOpeningInput = {
  callDirection: string;
  isThemisOutboundCampaign: boolean;
  useInitialGreeting: boolean;
  greeting: string;
};

export type ThemisCampaignOpening = {
  useInitialGreeting: boolean;
  greeting: string;
  source: "configured" | "themis_campaign_prompt";
};

/** Preserve campaign-authored text; for verified Themis calls, enable the existing prompt's first turn. */
export function resolveThemisCampaignOpening(input: ThemisCampaignOpeningInput): ThemisCampaignOpening {
  if (input.callDirection !== "outbound" || !input.isThemisOutboundCampaign) {
    return {
      useInitialGreeting: input.useInitialGreeting,
      greeting: input.greeting,
      source: "configured",
    };
  }

  return {
    useInitialGreeting: true,
    greeting: input.greeting,
    source: "themis_campaign_prompt",
  };
}

/** Technical trigger only; spoken wording remains owned by the configured greeting/campaign prompt. */
export function buildThemisCampaignStartInstruction(greeting: string): string {
  const existingGreeting = String(greeting ?? "");
  if (existingGreeting.trim()) {
    return `Use the existing configured campaign opening exactly once: ${JSON.stringify(existingGreeting)}. Then continue the existing campaign prompt unchanged; do not add another greeting.`;
  }
  return "Start the existing campaign prompt's opening now. Speak as soon as the audio session is ready; do not wait for caller audio. Do not create a new greeting or change the campaign prompt.";
}
