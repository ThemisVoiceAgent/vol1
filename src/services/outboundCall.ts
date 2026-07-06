import { config } from "../config.js";
import { fetchAgentConfig } from "../supabase.js";
import { evaluateSchedule, describeScheduleBlock, type AgentSchedule } from "../schedule.js";

export interface StartOutboundCallParams {
  to_number: string;
  agent_id: string;
  campaign_id?: string;
  variables?: Record<string, string>;
  bridge_self_test?: string;
  /** Skip agent schedule check (Intra campaigns pass force via variables instead). */
  skip_schedule_check?: boolean;
  /** Pre-assigned call id (Intra writes DB context before Twilio dials). */
  call_id?: string;
}

export type StartOutboundCallResult =
  | {
      ok: true;
      call_id: string;
      twilio_call_sid: string;
      from_number: string;
    }
  | {
      ok: false;
      status: "not_configured" | "out_of_schedule" | "error";
      error: string;
      schedule_status?: ReturnType<typeof evaluateSchedule>;
    };

/**
 * Starts a Twilio outbound call using the same URL/callback pattern as /api/calls/start.
 * Does not write to Supabase — callers persist metadata separately if needed.
 */
export async function startOutboundCall(
  params: StartOutboundCallParams,
  correlationId: string
): Promise<StartOutboundCallResult> {
  if (!config.twilio.isConfigured) {
    return {
      ok: false,
      status: "not_configured",
      error: "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.",
    };
  }

  if (!config.openai.isConfigured) {
    return {
      ok: false,
      status: "not_configured",
      error: "OpenAI is not configured. Set OPENAI_API_KEY.",
    };
  }

  if (!config.publicBaseUrl) {
    return {
      ok: false,
      status: "not_configured",
      error: "PUBLIC_BASE_URL is not configured.",
    };
  }

  const { to_number, agent_id, campaign_id, variables, bridge_self_test, skip_schedule_check, call_id } = params;

  const callId = call_id || crypto.randomUUID();
  const variablesParam =
    variables && Object.keys(variables).length > 0
      ? `&variables=${encodeURIComponent(JSON.stringify(variables))}`
      : "";
  const bridgeSelfTestParam = bridge_self_test
    ? `&bridgeSelfTest=${encodeURIComponent(bridge_self_test)}`
    : "";
  const voiceUrl = `${config.publicBaseUrl}/twilio/voice?callId=${callId}&agentId=${agent_id}${campaign_id ? `&campaignId=${encodeURIComponent(campaign_id)}` : ""}${variablesParam}${bridgeSelfTestParam}`;
  // Use Flask proxy for Twilio webhooks (Twilio can't reach Railway directly)
  const webhookBase = "https://flask.api.themis.ee";
  const statusUrl = `${webhookBase}/twilio/status`;

  let enableRecording = true;
  let maxRingTime = 60;
  let fromNumber = config.twilio.fromNumber;
  const agentConfig = await fetchAgentConfig(agent_id);

  if (!skip_schedule_check && agentConfig) {
    const schedule = agentConfig.schedule as AgentSchedule;
    const status = evaluateSchedule(schedule);
    const force =
      String((variables as Record<string, string> | undefined)?.force_outside_schedule || "").toLowerCase() ===
      "true";
    console.log(
      `[${correlationId}] Schedule check: allowed=${status.allowed} reason=${status.reason} local=${status.localTime} ${status.dayKey} tz=${status.timezone} force=${force}`
    );
    if (!status.allowed && !force) {
      const msg = describeScheduleBlock(status, schedule);
      return {
        ok: false,
        status: "out_of_schedule",
        error: msg,
        schedule_status: status,
      };
    }
  }

  if (agentConfig?.settings) {
    const s = agentConfig.settings as Record<string, unknown>;
    if (typeof s.enable_recording === "boolean") enableRecording = s.enable_recording;
    if (typeof s.max_ring_time === "number") maxRingTime = s.max_ring_time;
  }

  if (agentConfig?.phone_number) {
    const cleaned = String(agentConfig.phone_number).replace(/[^\d+]/g, "");
    const e164 = cleaned.startsWith("+") ? cleaned : `+${cleaned.replace(/^\+*/, "")}`;
    if (/^\+\d{8,15}$/.test(e164)) {
      fromNumber = e164;
    } else {
      console.warn(
        `[${correlationId}] Agent phone_number "${agentConfig.phone_number}" failed E.164 validation, falling back to env`
      );
    }
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls.json`;
  const authHeader = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");

  const twilioParams: Record<string, string> = {
    To: to_number,
    From: fromNumber,
    Url: voiceUrl,
    StatusCallback: statusUrl,
    StatusCallbackEvent: "initiated ringing answered completed busy no-answer failed canceled",
    StatusCallbackMethod: "POST",
    Timeout: String(maxRingTime),
  };

  if (enableRecording) {
    twilioParams.Record = "true";
    twilioParams.RecordingStatusCallback = `${config.publicBaseUrl}/twilio/recording-status`;
    twilioParams.RecordingStatusCallbackMethod = "POST";
  }

  console.log(`[${correlationId}] Calling Twilio: ${to_number} from ${fromNumber} (agent_id=${agent_id})`);

  const twilioRes = await fetch(twilioUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(twilioParams).toString(),
  });

  const twilioData = (await twilioRes.json()) as { sid?: string; message?: string };

  if (!twilioRes.ok) {
    console.error(`[${correlationId}] Twilio error:`, twilioData);
    return {
      ok: false,
      status: "error",
      error: twilioData.message || "Twilio API error",
    };
  }

  console.log(`[${correlationId}] Call started: SID=${twilioData.sid}, callId=${callId}`);

  return {
    ok: true,
    call_id: callId,
    twilio_call_sid: twilioData.sid || "",
    from_number: fromNumber,
  };
}
