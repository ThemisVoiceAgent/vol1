import WebSocket from "ws";
import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { config, getDeploymentIdentity } from "../config.js";
import {
  fetchAgentConfig,
  fetchAgentByPhoneNumber,
  fetchFirstActiveAgent,
  upsertCall,
  updateCall,
} from "../supabase.js";
import type { IiziShadowState } from "../flow/iiziShadowFlow.js";
import {
  createInitialIiziBrainState,
  refreshIiziBrainMergedIntent,
  gateIiziCombinedSms,
  evaluateIiziBrain,
  ingestIiziBrainNonemptyUserSpeech,
  ingestIiziBrainEmptyTranscript,
  ingestIiziBrainFlow,
  ingestIiziBrainGreetingComplete,
  ingestIiziBrainTrustedShadowFinal,
  logIiziBrainTrustedShadowTranscript,
  logIiziBrainSnapshot,
  logIiziBrainIntentResolution,
  applyAgentBrainConfigToState,
  markIiziBrainConfigLoadFailed,
  type IiziBrainRuntimeState,
} from "../flow/iiziBrain.js";
import { fetchLatestEnabledBrainConfigRow } from "../agentBrainConfigRepo.js";
import { recordIiziShadowTrace } from "../flow/trace.js";
import type { AgentBrainConfig } from "../brain/agentBrainUiTypes.js";
import { resolveAgentBrainConfigFromSettings, resolveRuntimeBrainUiFromSettings } from "../brain/agentBrainUiTypes.js";
import {
  evaluateBrain,
  validateIiziInboundToolCall,
  logBrainDecision,
  logBrainToolBlocked,
  getDefaultAgentBrainConfigForCall,
  type BrainRuntimeSnapshot,
  type ToolValidationResult,
} from "../brain/agent-brain.js";
import {
  createInitialIiziDeterministicState,
  isIiziDeterministicCall,
  logIiziDeterministicGuard,
  reduceIiziDeterministicTurn,
  resolveIiziExactLine,
  resolveIiziLocalizedLine,
  computeOccupantRequirement,
  resolveIiziFillerLine,
  maybeSpeakIiziFiller,
  iiziDeterministicAllowsModelEndCall,
  IIZI_MINIMAL_REALTIME_PROMPT,
  type IiziDeterministicAction,
  type IiziDeterministicStateBag,
  type IiziFillerReason,
} from "../flow/iiziDeterministic.js";
import type { SttStreamingAdapterHandle } from "../stt/types.js";
import { createSttShadowSession, type SttShadowBrainHooks } from "../stt/sttShadowSession.js";

// Singleton supabase client for realtime subscriptions (uses anon key — RLS allows authenticated SELECT,
// but for realtime on sms_messages we'll publish to anon role via the table's REPLICA IDENTITY FULL setup).
let supabaseRealtime: SupabaseClient | null = null;
function getSupabaseRealtime(): SupabaseClient | null {
  if (supabaseRealtime) return supabaseRealtime;
  if (!config.supabase.url || !config.supabase.anonKey) return null;
  supabaseRealtime = createClient(config.supabase.url.replace(/\/+$/, ""), config.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseRealtime;
}

// Persist an SMS row to the database via the call-write edge function pattern.
// Uses a direct REST insert with anon key (RLS allows anon INSERT on sms_messages).
async function persistSmsMessage(row: {
  call_id: string | null;
  agent_id: string | null;
  template_name: string | null;
  direction: "inbound" | "outbound";
  from_number: string;
  to_number: string;
  body: string;
  twilio_sid: string | null;
  status: string;
}): Promise<void> {
  if (!config.supabase.url || !config.supabase.anonKey) return;
  try {
    const url = `${config.supabase.url.replace(/\/+$/, "")}/rest/v1/sms_messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: config.supabase.anonKey,
        Authorization: `Bearer ${config.supabase.anonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.error(`[persistSmsMessage] HTTP ${res.status}`, await res.text());
    }
  } catch (err) {
    console.error(`[persistSmsMessage] error:`, err);
  }
}

// Post-call analysis via edge function
async function runPostCallAnalysis(callId: string, transcript: string, analysisPrompt: string) {
  if (!config.supabase.url || !config.supabase.anonKey) return;
  try {
    const url = `${config.supabase.url.replace(/\/+$/, "")}/functions/v1/ai-completion`;
    const systemMsg = analysisPrompt || "Analyze this call transcript. Provide a brief summary of the conversation, the outcome, and any action items. IMPORTANT: Detect the language used in the transcript (Estonian, Russian, or English) and write your entire analysis in that same language. Do not mix languages.";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.supabase.anonKey}`,
        apikey: config.supabase.anonKey,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: transcript },
        ],
        model: "google/gemini-2.5-flash",
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const summary = data?.choices?.[0]?.message?.content || data?.content || null;
      if (summary && typeof summary === "string") {
        await updateCall(callId, { summary });
        console.log(`[MediaStream] Post-call analysis saved (callId=${callId})`);
      }
    } else {
      console.error(`[MediaStream] Analysis failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error(`[MediaStream] Analysis error:`, err);
  }
}

// CRM lookup via edge function — used by inbound bot to identify caller / look up vehicle by reg_no
async function crmLookup(params: { phone_number?: string; reg_no?: string; description?: string }): Promise<any | null> {
  if (!config.supabase.url || !config.supabase.anonKey) return null;
  try {
    const url = `${config.supabase.url.replace(/\/+$/, "")}/functions/v1/crm-lookup`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.supabase.anonKey}`,
        apikey: config.supabase.anonKey,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      console.error(`[crmLookup] HTTP ${res.status} ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    return data?.vehicle || null;
  } catch (err) {
    console.error(`[crmLookup] error:`, err);
    return null;
  }
}

type StrictRegLookupResult =
  | {
      match: true;
      submitted_reg: string;
      normalized_reg: string;
      result_count: number;
      vehicle: Record<string, unknown>;
      cover_status: string;
      coverage_invalid: boolean;
    }
  | {
      match: false;
      submitted_reg: string;
      normalized_reg: string;
      result_count: number;
    };

type LiveTurnSettings = {
  vad_threshold: number;
  silence_duration_ms: number;
  prefix_padding_ms: number;
  interrupt_response: boolean;
  post_playback_cooldown_ms: number;
  post_greeting_cooldown_ms: number;
  watchdog_commit_ms: number;
  inbound_transcript_fallback_ms: number;
  no_audio_grace_ms: number;
  echo_recovery_cooldown_ms: number;
  loudspeaker_mode: boolean;
};

const DEFAULT_LIVE_TURN_SETTINGS: LiveTurnSettings = {
  vad_threshold: 0.6,
  silence_duration_ms: 700,
  prefix_padding_ms: 400,
  interrupt_response: true,
  post_playback_cooldown_ms: 1200,
  post_greeting_cooldown_ms: 150,
  watchdog_commit_ms: 2600,
  inbound_transcript_fallback_ms: 900,
  no_audio_grace_ms: 450,
  echo_recovery_cooldown_ms: 2500,
  loudspeaker_mode: false,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const sanitizeLiveTurnSettings = (raw: unknown): LiveTurnSettings => {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    vad_threshold: clamp(typeof s.vad_threshold === "number" ? s.vad_threshold : DEFAULT_LIVE_TURN_SETTINGS.vad_threshold, 0.1, 0.95),
    silence_duration_ms: clamp(typeof s.silence_duration_ms === "number" ? s.silence_duration_ms : DEFAULT_LIVE_TURN_SETTINGS.silence_duration_ms, 300, 2500),
    prefix_padding_ms: clamp(typeof s.prefix_padding_ms === "number" ? s.prefix_padding_ms : DEFAULT_LIVE_TURN_SETTINGS.prefix_padding_ms, 100, 1000),
    interrupt_response: typeof s.interrupt_response === "boolean" ? s.interrupt_response : DEFAULT_LIVE_TURN_SETTINGS.interrupt_response,
    post_playback_cooldown_ms: clamp(typeof s.post_playback_cooldown_ms === "number" ? s.post_playback_cooldown_ms : DEFAULT_LIVE_TURN_SETTINGS.post_playback_cooldown_ms, 0, 3000),
    post_greeting_cooldown_ms: clamp(typeof s.post_greeting_cooldown_ms === "number" ? s.post_greeting_cooldown_ms : DEFAULT_LIVE_TURN_SETTINGS.post_greeting_cooldown_ms, 0, 1500),
    watchdog_commit_ms: clamp(typeof s.watchdog_commit_ms === "number" ? s.watchdog_commit_ms : DEFAULT_LIVE_TURN_SETTINGS.watchdog_commit_ms, 1000, 6000),
    inbound_transcript_fallback_ms: clamp(typeof s.inbound_transcript_fallback_ms === "number" ? s.inbound_transcript_fallback_ms : DEFAULT_LIVE_TURN_SETTINGS.inbound_transcript_fallback_ms, 300, 3000),
    no_audio_grace_ms: clamp(typeof s.no_audio_grace_ms === "number" ? s.no_audio_grace_ms : DEFAULT_LIVE_TURN_SETTINGS.no_audio_grace_ms, 200, 2000),
    echo_recovery_cooldown_ms: clamp(typeof s.echo_recovery_cooldown_ms === "number" ? s.echo_recovery_cooldown_ms : DEFAULT_LIVE_TURN_SETTINGS.echo_recovery_cooldown_ms, 500, 5000),
    loudspeaker_mode: typeof s.loudspeaker_mode === "boolean" ? s.loudspeaker_mode : DEFAULT_LIVE_TURN_SETTINGS.loudspeaker_mode,
  };
};

function normalizeRegistrationStrict(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

function isCoverageInvalid(coverStatusRaw: unknown): boolean {
  const value = String(coverStatusRaw || "").trim().toLowerCase();
  if (!value) return true;
  if (["active", "valid", "in_force", "in force", "kehtiv", "aktiivne"].includes(value)) return false;
  if (["inactive", "expired", "missing", "unknown", "none", "puudub", "aegunud", "mitteaktiivne"].includes(value)) return true;
  return true;
}

async function strictLookupVehicleBySubmittedReg(submittedReg: string): Promise<StrictRegLookupResult> {
  const submitted = String(submittedReg || "").trim();
  const normalizedReg = normalizeRegistrationStrict(submitted);
  if (!config.supabase.url || !config.supabase.anonKey || !normalizedReg) {
    return {
      match: false,
      submitted_reg: submitted,
      normalized_reg: normalizedReg,
      result_count: 0,
    };
  }

  const fields = [
    "reg_no",
    "make",
    "model",
    "year_of_built",
    "color",
    "insurer",
    "cover_type",
    "cover_status",
  ].join(",");

  try {
    const baseUrl = config.supabase.url.replace(/\/+$/, "");
    const exactUrl =
      `${baseUrl}/rest/v1/crm_vehicles?` +
      `select=${encodeURIComponent(fields)}&reg_no=eq.${encodeURIComponent(normalizedReg)}`;
    const exactRes = await fetch(exactUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.supabase.anonKey}`,
        apikey: config.supabase.anonKey,
      },
    });
    if (!exactRes.ok) {
      console.error(`[IIZI-StrictLookup] HTTP ${exactRes.status} while fetching crm_vehicles exact query`);
      return {
        match: false,
        submitted_reg: submitted,
        normalized_reg: normalizedReg,
        result_count: 0,
      };
    }

    const exactRows = (await exactRes.json().catch(() => [])) as Record<string, unknown>[];
    console.log(
      `[IIZI-StrictLookup] stage=exact_query submitted_reg="${submitted}" normalized_reg="${normalizedReg}" http_status=${exactRes.status} returned_row_count=${exactRows.length}`
    );

    // Fallback for historical data where reg_no may include spaces/hyphens/casing variants.
    // Avoid this full-table fetch unless exact server-side lookup returned no rows.
    let candidateRows = exactRows;
    if (candidateRows.length === 0) {
      const fallbackUrl = `${baseUrl}/rest/v1/crm_vehicles?select=${encodeURIComponent(fields)}`;
      const fallbackRes = await fetch(fallbackUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.supabase.anonKey}`,
          apikey: config.supabase.anonKey,
        },
      });
      if (!fallbackRes.ok) {
        console.error(`[IIZI-StrictLookup] HTTP ${fallbackRes.status} while fetching crm_vehicles fallback query`);
        console.log(
          `[IIZI-StrictLookup] submitted_reg="${submitted}" normalized_reg="${normalizedReg}" match=false`
        );
        return {
          match: false,
          submitted_reg: submitted,
          normalized_reg: normalizedReg,
          result_count: 0,
        };
      }
      const fallbackRows = (await fallbackRes.json().catch(() => [])) as Record<string, unknown>[];
      candidateRows = fallbackRows.filter(
        (row) => normalizeRegistrationStrict(String(row.reg_no || "")) === normalizedReg
      );
      console.log(
        `[IIZI-StrictLookup] stage=fallback_query submitted_reg="${submitted}" normalized_reg="${normalizedReg}" http_status=${fallbackRes.status} returned_row_count=${candidateRows.length}`
      );
    }

    if (candidateRows.length === 0) {
      console.log(
        `[IIZI-StrictLookup] submitted_reg="${submitted}" normalized_reg="${normalizedReg}" match=false`
      );
      return {
        match: false,
        submitted_reg: submitted,
        normalized_reg: normalizedReg,
        result_count: 0,
      };
    }

    const vehicle = candidateRows[0];
    const coverStatus = String(vehicle.cover_status || "");
    const coverageInvalid = isCoverageInvalid(coverStatus);
    console.log(
      `[IIZI-StrictLookup] submitted_reg="${submitted}" normalized_reg="${normalizedReg}" match=true`
    );
    return {
      match: true,
      submitted_reg: submitted,
      normalized_reg: normalizedReg,
      result_count: candidateRows.length,
      vehicle,
      cover_status: coverStatus,
      coverage_invalid: coverageInvalid,
    };
  } catch (err) {
    console.error(`[IIZI-StrictLookup] exception:`, err);
    return {
      match: false,
      submitted_reg: submitted,
      normalized_reg: normalizedReg,
      result_count: 0,
    };
  }
}

// Send SMS via Twilio REST API. Returns true on success.
async function sendSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; error?: string; status?: string; errorCode?: number | string }> {
  console.log(`[sendSms] >>> attempt to=${to} from=${config.twilio.fromNumber || "(missing)"} bodyLen=${body?.length || 0} bodyPreview="${(body || "").slice(0, 60)}"`);
  if (!config.twilio.isConfigured) {
    console.error(`[sendSms] FAIL: Twilio not configured (accountSid set? ${!!config.twilio.accountSid}, authToken set? ${!!config.twilio.authToken})`);
    return { ok: false, error: "Twilio not configured" };
  }
  if (!to || !body) {
    console.error(`[sendSms] FAIL: missing fields to="${to}" bodyLen=${body?.length || 0}`);
    return { ok: false, error: "Missing 'to' or 'body'" };
  }
  if (!config.twilio.fromNumber) {
    console.error(`[sendSms] FAIL: TWILIO_FROM_NUMBER not configured`);
    return { ok: false, error: "TWILIO_FROM_NUMBER not configured" };
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Messages.json`;
    const authHeader = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
    // Twilio sometimes false-flags repeated test traffic with error 30453.
    // riskCheck: "disable" is used here to prevent false-positive blocking for this SMS flow.
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: to,
        From: config.twilio.fromNumber,
        Body: body.slice(0, 1600),
        StatusCallback: `${config.publicBaseUrl}/twilio/sms-status`,
        RiskCheck: "disable",
      }).toString(),
    });
    const data: any = await res.json().catch(() => ({}));
    console.log(`[sendSms] Twilio HTTP ${res.status} response:`, JSON.stringify({
      sid: data?.sid,
      status: data?.status,
      error_code: data?.error_code,
      error_message: data?.error_message,
      to: data?.to,
      from: data?.from,
      num_segments: data?.num_segments,
      price: data?.price,
      message: data?.message,
      code: data?.code,
      more_info: data?.more_info,
    }));
    if (!res.ok) {
      console.error(`[sendSms] FAIL HTTP ${res.status} code=${data?.code} msg=${data?.message} more_info=${data?.more_info}`);
      return { ok: false, error: `${data?.message || `HTTP ${res.status}`}${data?.code ? ` (code ${data.code})` : ""}${data?.more_info ? ` ${data.more_info}` : ""}` };
    }
    // Twilio returns 201 even if the message will fail later (e.g. status="failed" or has error_code).
    // Treat any of those as a real failure so the AI doesn't claim success.
    if (data?.error_code || data?.status === "failed" || data?.status === "undelivered") {
      console.error(`[sendSms] FAIL Twilio accepted but flagged status="${data?.status}" error_code=${data?.error_code} error_message=${data?.error_message}`);
      return { ok: false, sid: data?.sid, status: data?.status, errorCode: data?.error_code, error: data?.error_message || `Twilio status ${data?.status}` };
    }
    console.log(`[sendSms] OK sid=${data?.sid} status=${data?.status}`);
    return { ok: true, sid: data?.sid, status: data?.status };
  } catch (err: any) {
    console.error(`[sendSms] EXCEPTION:`, err);
    return { ok: false, error: err?.message || "send failed" };
  }
}

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
/** GA Realtime: G.711 μ-law (Twilio-compatible). */
const REALTIME_GA_ULAW_FORMAT = { type: "audio/pcmu" } as const;
const REALTIME_GA_RESPONSE_MODALITIES = ["audio"] as const;
/** ~100 ms of Twilio 20 ms μ-law frames before input_audio_buffer.commit. */
const MIN_INPUT_FRAMES_BEFORE_COMMIT = 5;

const VOICE_SPEED_MIN = 1.0;
const VOICE_SPEED_MAX = 1.5;

function clampVoiceSpeed(raw: unknown): number {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) return VOICE_SPEED_MIN;
  const stepped = Math.round(n / 0.05) * 0.05;
  return Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, stepped));
}

function buildGaAudioOutput(voice: string, speed: number) {
  return {
    format: REALTIME_GA_ULAW_FORMAT,
    voice,
    speed,
  };
}

const THEMIS_DEBT_GREETING_TERMS = ["võlg", "võlgnevus", "jääk", "nõue", "euro"] as const;

const WRONG_PERSON_END_CALL_MARKERS = [
  "vale isik",
  "vale inimene",
  "wrong person",
  "ei ole õige inimene",
  "not the person",
  "kolmas isik",
] as const;

function isWrongPersonEndCallContext(text: string): boolean {
  const lower = text.toLowerCase();
  return WRONG_PERSON_END_CALL_MARKERS.some((marker) => lower.includes(marker));
}

function resolveEndCallCloseText(context: string): string {
  const lower = context.toLowerCase();
  if (lower.includes("juba maksnud") || lower.includes("already paid")) {
    return "Selge. Panen selle info kirja. Head päeva!";
  }
  if (
    isWrongPersonEndCallContext(context) ||
    lower.includes("vale number") ||
    lower.includes("wrong number") ||
    lower.includes("ei räägi") ||
    lower.includes("not the person")
  ) {
    return "Selge, vabandan tülitamast. Head päeva!";
  }
  return "Selge. Head päeva!";
}

function greetingMayDiscloseDebt(greetingText: string): boolean {
  const lower = greetingText.toLowerCase();
  return THEMIS_DEBT_GREETING_TERMS.some((term) => lower.includes(term));
}

function buildGaAudioInput(opts: {
  turnDetection?: Record<string, unknown> | null;
  transcription?: { model: string; language: string; prompt: string };
}) {
  const input: Record<string, unknown> = { format: REALTIME_GA_ULAW_FORMAT };
  if (opts.transcription) input.transcription = opts.transcription;
  if (opts.turnDetection !== undefined) input.turn_detection = opts.turnDetection;
  return input;
}

/** Every GA session.update must include session.type. */
function buildGaSessionPatch(fields: Record<string, unknown>): Record<string, unknown> {
  return { type: "realtime", ...fields };
}

function describeGaSessionPatchForLog(session: Record<string, unknown>): Record<string, unknown> {
  const audio = session.audio as { input?: { turn_detection?: { type?: string } } } | undefined;
  const turnDetection = audio?.input?.turn_detection;
  return {
    type: session.type,
    max_output_tokens: session.max_output_tokens,
    vad_nested: !!(audio?.input && turnDetection !== undefined),
    turn_detection_type: turnDetection?.type,
    tools_count: Array.isArray(session.tools) ? session.tools.length : 0,
  };
}

const DEFAULT_INSTRUCTIONS = `You are a professional AI phone agent. Follow these rules strictly:
1. NEVER go off-topic. Only discuss what your instructions cover.
2. Keep every response to 1-3 short sentences maximum.
3. Do NOT elaborate unless explicitly asked.
4. Do NOT make up information not in your instructions or knowledge base.
5. If unsure, say you will follow up — do not guess.
6. Stay in character at all times. Follow the script exactly.`;

/**
 * Handles a single Twilio Media Stream WebSocket connection.
 * Bridges audio between Twilio (mulaw/8kHz) and OpenAI Realtime API.
 */
export function handleTwilioMediaStream(twilioWs: WebSocket) {
  let openaiWs: WebSocket | null = null;
  let streamSid: string = "";
  let callId: string = "";
  let agentId: string = "";
  let calledNumber: string = "";
  let fromNumber: string = "";
  let callDirection: "inbound" | "outbound" = "outbound";
  let callSid: string = "";
  let campaignId: string = "";
  let callVariables: Record<string, string> = {};

  // Collect transcript turns
  const transcriptLines: string[] = [];
  let callStartTime: Date | null = null;
  let agentAnalysisPrompt: string = "";
  let agentKnowledgeBase: any[] = [];
  type SmsMessage = { id?: string; name: string; description?: string; content: string; trigger: "during" | "after"; order?: number };
  type SmsToolStateValue = "not_requested" | "pending" | "sent" | "failed" | "already_sent";
  let smsMessages: SmsMessage[] = [];
  const smsSentNames = new Set<string>();
  const smsToolState = new Map<string, SmsToolStateValue>();
  let smsPendingTemplate: string | null = null;
  let lastSmsToolResultAt = 0;
  let lastSmsToolResultTemplate: string | null = null;
  let lastLoggedSmsAudioAfterResultAt = 0;
  let locationStatus: "unknown" | "pending" | "confirmed" | "failed" = "unknown";
  let locationConfirmedValue: { address?: string; lat?: number | null; lon?: number | null } | null = null;
  let useCombinedRegLocationSms = false;
  /** IIZI shadow state machine (read-only trace; no effect on live path). */
  const iiziShadowStateRef: { current: IiziShadowState | null } = { current: null };
  /** IIZI combined-mode brain (intent + SMS gate); inbound only effective path. */
  const iiziBrainRef: { current: IiziBrainRuntimeState } = { current: createInitialIiziBrainState() };
  /** IIZI deterministic strangler — owns critical flow for target agent only. */
  let iiziDeterministicMode = false;
  const iiziDetRef: { current: IiziDeterministicStateBag } = { current: createInitialIiziDeterministicState() };
  const iiziDetPendingActions: IiziDeterministicAction[] = [];
  let iiziDetCriticalLineQueued = false;
  let iiziDetDraining = false;

  const touchIiziBrainLog = (reason: string) => {
    if (!useCombinedRegLocationSms || callDirection !== "inbound") return;
    try {
      const snap = evaluateIiziBrain(iiziBrainRef.current, true);
      logIiziBrainSnapshot(callId, snap);
    } catch (err) {
      console.error(`[IIZI-Brain] log_failed reason=${reason} callId=${callId || "?"}`, err);
    }
  };
  /** Parallel STT shadow stream (e.g. Deepgram); default off; does not replace OpenAI Realtime transcription */
  let sttShadowSession: SttStreamingAdapterHandle | null = null;
  let combinedLocationReadbackQueued = false;
  let vehicleValidationStatus: "unknown" | "valid" | "invalid" = "unknown";
  const COMBINED_SMS_TEMPLATE_NAME = "Registreerimisnumbri ja asukoha SMS";
  let callbackSmsRequestedWhileBlocked = false;
  const CALLBACK_SMS_TEMPLATE_NAME = "Retrieval of callback number through SMS";
  let incidentNeedsOccupantCount = false;
  let occupantCountStatus: "unknown" | "pending" | "confirmed" = "unknown";
  let occupantCountValue: string | null = null;
  /** Combined IIZI pipeline — deterministic ordering for occupant count + callback SMS */
  let vehicleLookupPassed = false;
  let locationConfirmedFlag = false;
  let vehicleReadbackDone = false;
  let locationReadbackDone = false;
  let iiziOccupantPromptDeferred = false;
  type IiziCallbackMode =
    | "unset"
    | "same_incoming_number"
    | "different_number_sms"
    | "form_callback_phone"
    | "verbal";
  /** Caller callback preference finalized (same line, form phone, or verbal number) — NOT set on callback SMS send alone */
  let callbackConfirmed = false;
  let callbackMode: IiziCallbackMode = "unset";
  let callbackSmsSent = false;
  /** Waiting for callback number via form after different-number SMS */
  let callbackPending = false;
  let inboundSmsChannel: RealtimeChannel | null = null;
  let locationConfirmChannel: RealtimeChannel | null = null;
  let resolvedAgentIdRef: string | null = null;
  let substituteVarsRef: (text: string) => string = (t) => t;
  let maxCallDurationMinutes: number = 0;
  let useInitialGreeting = true;
  let callDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let greetingInProgress = true; // Protect initial greeting from interruption
  let activeResponseId: string | null = null; // Track current response to discard stale audio
  let ignoreAudioUntilNextResponse = false;
  let sessionConfigured = false;
  let pendingInitialResponse = false;
  let realtimeSessionUpdateFailed = false;
  let lastGaSessionPatchReason = "";
  let lastGaSessionPatchForDiag: Record<string, unknown> | null = null;
  let inboundAudioCooldownUntil = 0;
  let turnDetectionEnableTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAssistantTranscript = "";
  let repeatedAssistantTranscriptCount = 0;
  let pendingRecoveryCooldownMs = 0;
  const DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS = 220;
  // Realtime spoken output can consume tokens much faster than plain text, so give
  // the first greeting a very large budget and then restore the normal cap.
  const INITIAL_GREETING_MAX_RESPONSE_OUTPUT_TOKENS = 4096;
  let greetingTokenLimitRaised = false;
  let configuredMaxResponseOutputTokens = DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS;
  let lastResponseFinishReason: string | null = null;
  let lastResponseOutputTokens: number | null = null;
  // Tools are deferred: we do NOT expose them during the greeting so the model
  // cannot auto-fire end_call / lookup_vehicle before saying hello. The full
  // toolset is attached via session.update right after greeting playback ends.
  let pendingToolsForActivation: any[] = [];
  let toolsActivated = false;

  // Anti-barge-in: when true, don't forward user audio to OpenAI while AI is speaking
  let antiBargeinEnabled = false;
  let aiIsSpeaking = false; // Track whether AI is currently outputting audio or Twilio is still playing it
  // Guardrails against premature end_call right after greeting:
  // 1. We require at least one real user utterance before honoring end_call.
  // 2. We require a minimum elapsed time since greeting completion.
  let greetingCompletedAt: number | null = null;
  let userUtteranceCount = 0;
  let hasPostGreetingSpeechStarted = false;
  let hasCommittedUserAudio = false;
  let userAudioTurnCount = 0;
  let pendingEndCall: {
    reason: string;
    closeText: string;
    closeSpeechRequired: boolean;
    closeResponseSent: boolean;
  } | null = null;
  let endCallHangupTimer: ReturnType<typeof setTimeout> | null = null;
  const MIN_MS_AFTER_GREETING_BEFORE_END_CALL = 12_000;
  let responsePlaybackMarkName: string | null = null;
  let responseHasAudio = false;
  let responseAudioDone = false;
  let responseDoneReceived = false;
  let responseAudioDeltaLogged = false;
  let markFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- Diagnostic counters (A–E from runbook) ----
  // A. Twilio inbound caller audio
  let twilioInboundFrames = 0;
  let twilioInboundFramesDropGreeting = 0;
  let twilioInboundFramesDropCooldown = 0;
  let twilioInboundFramesDropAntiBargein = 0;
  let twilioInboundFramesForwarded = 0;
  let twilioInboundFramesAfterGreeting = 0;
  let firstInboundAudioAfterGreetingLogged = false;
  // B. OpenAI session
  let openaiSessionCreatedAt: number | null = null;
  let openaiSessionUpdatedAt: number | null = null;
  // C. User turn detection
  let speechStartedCount = 0;
  let speechStoppedCount = 0;
  let bufferCommittedCount = 0;
  let userTranscriptCount = 0;
  // D. Assistant response creation
  let responseCreateSentCount = 0;
  let userResponseCreateSentCount = 0;
  let responseCreatedCount = 0;
  let userResponseCreatedCount = 0;
  let responseDoneCount = 0;
  let responseErrorCount = 0;
  let pendingUserResponseTimer: ReturnType<typeof setTimeout> | null = null;
  let callerSpeechWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingUserResponseReason: string | null = null;
  let pendingUserResponseAttempts = 0;
  let pendingUserResponseTranscript: string | null = null;
  let inboundTranscriptFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let inboundTranscriptFallbackSeq = 0;
  let latestCompletedInboundTranscript: { seq: number; text: string; at: number } | null = null;
  let inboundNoAudioTimer: ReturnType<typeof setTimeout> | null = null;
  let responseDoneFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let inboundRecoveryAttemptSeq = 0;
  let inboundRecoveryAttemptsForSeq = 0;
  let pendingInboundRecoveryAfterCancel: {
    reason: string;
    failedResponseId: string | null;
    transcriptSeq: number;
    transcriptText: string;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  // E. Assistant audio back to Twilio
  let assistantAudioDeltaCount = 0;
  let assistantOutputAudioDeltaCount = 0;
  let firstAssistantAudioDeltaAt: string | null = null;
  let totalAssistantAudioBytes = 0;
  let userAssistantAudioDeltaCount = 0;
  let userAssistantAudioBytes = 0;
  let twilioOutboundFrames = 0;
  let userTwilioOutboundFrames = 0;
  let firstTwilioOutboundAt: string | null = null;
  let twilioOutboundSendErrors = 0;
  let diagnosticSnapshotTimer: ReturnType<typeof setInterval> | null = null;
  let twilioStartReceived = false;
  let twilioStopReceived = false;
  let twilioGreetingMarkReceived = false;
  let firstCallerMediaAfterGreetingAt: string | null = null;
  let firstInboundAudioForwardedToOpenAiAt: string | null = null;
  let conversationItemCreatedCount = 0;
  let lastSessionConfigSent: Record<string, unknown> | null = null;
  let loadedAgentName = "(none)";
  let bridgeSelfTest = "";
  let callFinalized = false;
  let lastResponseCreateReason = "(none)";
  let activeResponseReason = "(none)";
  let activeResponseInboundTranscriptSeq = 0;
  let activeResponseTwilioChunks = 0;
  let activeResponseTwilioBytes = 0;
  let liveTurnSettings: LiveTurnSettings = { ...DEFAULT_LIVE_TURN_SETTINGS };
  let turnGateAcceptedFrames = 0;
  const turnGateDropCounts: Record<string, number> = {};
  let callerSpeechActive = false;
  let lastAcceptedCallerAudioAt = 0;
  let vadEnabledAcknowledged = false;
  let vadServerCreateResponseEnabled = false;
  let initialGreetingResponseFinished = false;
  let inputFramesSinceLastCommit = 0;
  let lastCommittedUserItemId: string | null = null;
  let framesForPendingCommit = 0;
  const responseCreateSentForItemIds = new Set<string>();
  type PendingCommittedUserTurn = {
    itemId: string;
    committedAt: number;
    framesAtCommit: number;
    transcriptReceived: boolean;
    responseScheduled: boolean;
    fallbackTimer: ReturnType<typeof setTimeout> | null;
  };
  const pendingCommittedUserTurns = new Map<string, PendingCommittedUserTurn>();
  let roadsideContextActive = false;
  const emittedOccupantNudges = new Set<string>();
  const emittedCallbackPreferenceNudges = new Set<string>();
  let agentBrainUiConfig: AgentBrainConfig = getDefaultAgentBrainConfigForCall();

  const diagState = () =>
    `state{greetingPlaying=${greetingInProgress},greetingCompletedAt=${greetingCompletedAt ? new Date(greetingCompletedAt).toISOString() : "null"},vadEnabled=${vadEnabledAcknowledged},assistantSpeaking=${aiIsSpeaking},activeResponse=${activeResponseId || "none"},pendingUserTurn=${pendingUserResponseReason || "none"},userUtteranceCount=${userUtteranceCount},openaiWs.readyState=${openaiWs?.readyState ?? "null"},twilioWs.readyState=${twilioWs.readyState}}`;

  const logCallDeploymentIdentity = () => {
    const d = getDeploymentIdentity();
    console.log(`[Diag-Deploy] callId=${callId} gitSha=${d.gitSha} railwayDeploymentId=${d.railwayDeploymentId} NODE_ENV=${d.nodeEnv} realtimeModel=${d.realtimeModel}`);
    console.log(`[Diag-Deploy] callId=${callId} twilioVoiceWebhook=${d.expectedTwilioVoiceWebhook} expectedPublicBaseUrl=${d.publicBaseUrl} expectedStreamUrl=${d.expectedTwilioStreamUrl}`);
  };

  const setSmsToolState = (templateName: string, next: SmsToolStateValue, reason: string) => {
    const prev = smsToolState.get(templateName) || "not_requested";
    smsToolState.set(templateName, next);
    console.log(`[MediaStream] smsToolState transition template="${templateName}" from=${prev} to=${next} reason=${reason} (callId=${callId})`);
  };

  const setLocationStatus = (
    next: "unknown" | "pending" | "confirmed" | "failed",
    reason: string,
    value?: { address?: string; lat?: number | null; lon?: number | null } | null
  ) => {
    const prev = locationStatus;
    locationStatus = next;
    locationConfirmedFlag = next === "confirmed";
    if (value !== undefined) {
      locationConfirmedValue = value;
    }
    console.log(
      `[MediaStream] locationStatus transition from=${prev} to=${next} reason=${reason} address="${locationConfirmedValue?.address || ""}" lat=${locationConfirmedValue?.lat ?? "null"} lon=${locationConfirmedValue?.lon ?? "null"} (callId=${callId})`
    );
  };

  const iiziCombinedInbound = () => useCombinedRegLocationSms && callDirection === "inbound";
  /** IIZI deterministic inbound + Themis outbound: backend owns post-greeting responses (not VAD auto). */
  const runtimeOwnsPostGreetingResponses = () =>
    initialGreetingResponseFinished &&
    ((iiziDeterministicMode && iiziCombinedInbound()) ||
      (callDirection === "outbound" && !iiziCombinedInbound()));
  /** Strict lookup success + location_confirmed=true */
  const iiziBackendReadyForReadbacks = () => vehicleLookupPassed && locationConfirmedFlag;
  const iiziCanAskOccupantQuestion = () =>
    !iiziCombinedInbound() ||
    (iiziBackendReadyForReadbacks() && vehicleReadbackDone && locationReadbackDone && incidentNeedsOccupantCount);

  const iiziCanConfirmOccupantCount = () =>
    !iiziCombinedInbound() ||
    (vehicleLookupPassed &&
      vehicleValidationStatus === "valid" &&
      locationConfirmedFlag &&
      vehicleReadbackDone &&
      locationReadbackDone);

  /** Ready to collect or finalize callback preference (after readbacks; occupant done if required) */
  const iiziHandoffReadyForCallbackStep = () =>
    iiziCombinedInbound() &&
    vehicleLookupPassed &&
    locationConfirmedFlag &&
    vehicleReadbackDone &&
    locationReadbackDone &&
    (!incidentNeedsOccupantCount || occupantCountStatus === "confirmed");

  const iiziBlockedEndCallPendingCallback = () => iiziHandoffReadyForCallbackStep() && !callbackConfirmed;

  const emitLocationConfirmedSystemEvent = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return false;
    const addr = (locationConfirmedValue?.address || "").toString().slice(0, 300);
    const lat = locationConfirmedValue?.lat ?? null;
    const lon = locationConfirmedValue?.lon ?? null;
    const sysMsg = `[SYSTEM EVENT: location_confirmed] location_confirmed=true address="${addr}" lat=${lat} lon=${lon}. Internal note only — do NOT read this tag, the brackets, or the field names aloud. The customer just confirmed their location via the SMS link. Read the address back to them naturally in the same language the call is being conducted in. Do not ask for confirmation again. Continue to the next required step.`;
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: sysMsg }],
      },
    }));
    scheduleUserResponseCreate("system-event", 50);
    return true;
  };

  const maybeNudgeDeferredCallbackSms = (source: string) => {
    if (!callbackSmsRequestedWhileBlocked) return;
    if (vehicleValidationStatus !== "valid") return;
    if (locationStatus !== "confirmed") return;
    if (iiziCombinedInbound() && (!vehicleReadbackDone || !locationReadbackDone)) {
      console.log(
        `[IIZI-CallbackSMS] deferred reason=readback_incomplete vehicleRb=${vehicleReadbackDone} locRb=${locationReadbackDone} source=${source} callId=${callId}`
      );
      return;
    }
    if (incidentNeedsOccupantCount && occupantCountStatus !== "confirmed") return;
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

    callbackSmsRequestedWhileBlocked = false;
    console.log(`[IIZI-CallbackSMS] gates_open source=${source} callId=${callId}`);
    const sysMsg =
      `[SYSTEM EVENT: callback_sms_ready] callback_sms_ready=true. ` +
      `Internal note only — do NOT read this tag or field names aloud. ` +
      `The caller previously asked to use a different callback number; gates are now satisfied. ` +
      `Send the callback collection SMS now: call send_sms with template_name="${CALLBACK_SMS_TEMPLATE_NAME}". ` +
      `Do NOT treat SMS success as final callback confirmation — wait for SYSTEM form_submitted with callback_phone or use confirm_iizi_callback_phone_verbal if they dictate a number.`;
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: sysMsg }],
      },
    }));
    scheduleUserResponseCreate("system-event", 50);
  };

  const maybeEmitCallbackPreferenceRequired = (source: string) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (!iiziHandoffReadyForCallbackStep()) return;
    if (callbackConfirmed || callbackPending) return;
    if (callbackSmsRequestedWhileBlocked) return;
    if (source !== "end_call_blocked" && emittedCallbackPreferenceNudges.has("callback_preference_prompt")) return;
    if (source !== "end_call_blocked") emittedCallbackPreferenceNudges.add("callback_preference_prompt");
    const sysMsg =
      `[SYSTEM EVENT: callback_preference_required] ` +
      `Ask exactly once: "Kas tagasihelistamiseks kasutame sama numbrit, millelt praegu helistate?" ` +
      `Internal note only — do NOT read this tag aloud. ` +
      `If the caller wants the same number, call confirm_iizi_callback_same_incoming_number — do NOT send template "${CALLBACK_SMS_TEMPLATE_NAME}". ` +
      `Only if they clearly want a different number, call send_sms with template_name="${CALLBACK_SMS_TEMPLATE_NAME}". ` +
      `After that SMS succeeds, wait for SYSTEM form_submitted callback_phone or use confirm_iizi_callback_phone_verbal if they give and confirm a number by voice.`;
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: sysMsg }],
      },
    }));
    console.log(`[IIZI-Callback] preference_prompt source=${source} callId=${callId}`);
    scheduleUserResponseCreate("system-event", 50);
  };

  const OCCUPANT_REQUIRED_ROADSIDE_TRIGGERS = [
    "avarii",
    "õnnetus",
    "kokkupõrge",
    "accident",
    "crash",
    "puksiir",
    "pukseerimine",
    "tow",
    "towing",
    "auto ei käivitu",
    "ei käivitu",
    "auto ei liigu",
    "sõiduk ei liigu",
    "auto on kinni",
    "kinni",
    "stuck",
    "stranded",
    "cannot move",
    "does not move",
    "won't start",
  ] as const;

  const OCCUPANT_REQUIRED_PASSENGER_TRIGGERS = [
    "girlfriend",
    "boyfriend",
    "wife",
    "husband",
    "friend",
    "child",
    "passenger",
    "kaasreisija",
    "reisija",
    "tüdruk",
    "naine",
    "mees",
    "sõber",
    "laps",
  ] as const;

  const isOccupantCountGateBlocked = () =>
    incidentNeedsOccupantCount && occupantCountStatus !== "confirmed";

  const emitOccupantCountRequiredSystemEvent = (source: string) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (
      useCombinedRegLocationSms &&
      callDirection === "inbound" &&
      !iiziBrainRef.current.runtimeBrainUi.gates.occupantCount
    ) {
      console.log(`[IIZI-Occupants] skip occupant ask — occupant gate disabled in brainUi source=${source} callId=${callId}`);
      return;
    }
    if (useCombinedRegLocationSms && callDirection === "inbound") {
      if (vehicleValidationStatus === "invalid" || !vehicleLookupPassed) {
        iiziOccupantPromptDeferred = false;
        console.log(`[IIZI-Occupants] skip occupant ask — vehicle pipeline not eligible source=${source} callId=${callId}`);
        return;
      }
      if (!locationConfirmedFlag) {
        iiziOccupantPromptDeferred = true;
        console.log(`[IIZI-Occupants] defer occupant — location not confirmed source=${source} callId=${callId}`);
        return;
      }
      if (!vehicleReadbackDone || !locationReadbackDone) {
        iiziOccupantPromptDeferred = true;
        console.log(
          `[IIZI-Occupants] defer occupant — readbacks incomplete source=${source} vehicleRb=${vehicleReadbackDone} locRb=${locationReadbackDone} callId=${callId}`,
        );
        return;
      }
    }
    if (emittedOccupantNudges.has("occupant_prompt_sent")) return;
    emittedOccupantNudges.add("occupant_prompt_sent");
    const sysMsg =
      `[SYSTEM EVENT: occupant_count_required] Ask exactly: "Mitu inimest on autos koos juhiga?" ` +
      `Do not continue until answered. Internal note only — do NOT read this tag aloud.`;
    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: sysMsg }],
        },
      }),
    );
    console.log(`[IIZI-Occupants] occupant_prompt emitted source=${source} callId=${callId}`);
    iiziOccupantPromptDeferred = false;
    scheduleUserResponseCreate("system-event", 50);
  };

  const maybeEmitDeferredOccupantPrompt = () => {
    if (!iiziCombinedInbound()) return;
    if (!iiziOccupantPromptDeferred) return;
    if (!incidentNeedsOccupantCount || occupantCountStatus === "confirmed") {
      iiziOccupantPromptDeferred = false;
      return;
    }
    if (vehicleValidationStatus === "invalid" || !vehicleLookupPassed) {
      iiziOccupantPromptDeferred = false;
      return;
    }
    if (!iiziCanAskOccupantQuestion()) return;
    emitOccupantCountRequiredSystemEvent("deferred_gates_open");
  };

  const buildBrainRuntimeSnapshot = (): BrainRuntimeSnapshot => ({
    callId,
    agentBrainConfig: agentBrainUiConfig,
    useCombinedRegLocationSms,
    callDirection,
    iiziBrain: iiziBrainRef.current,
    vehicleLookupPassed,
    vehicleValidationStatus,
    locationConfirmedFlag,
    locationStatus,
    vehicleReadbackDone,
    locationReadbackDone,
    incidentNeedsOccupantCount,
    occupantCountStatus,
    occupantSystemPromptEmitted: emittedOccupantNudges.has("occupant_prompt_sent"),
    callbackConfirmed,
    callbackPending,
    combinedSmsTemplateName: COMBINED_SMS_TEMPLATE_NAME,
    callbackSmsTemplateName: CALLBACK_SMS_TEMPLATE_NAME,
    greetingCompletedAt,
    userUtteranceCount,
  });

  const injectBrainToolCorrection = (text: string) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !text.trim()) return;
    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: text.trim() }],
        },
      }),
    );
  };

  const iiziDeterministicInbound = () => iiziDeterministicMode && iiziCombinedInbound();

  const speakExactIizi = (lineId: string, vars?: Record<string, string>): boolean => {
    const lang = iiziDetRef.current.iiziLanguage;
    const text = resolveIiziLocalizedLine(lineId, lang, vars, callId);
    if (!text) {
      console.warn(`[IIZI-Deterministic] unknown line_id=${lineId} callId=${callId}`);
      return false;
    }
    console.log(
      `[IIZI-Deterministic] line_id=${lineId} transcript_source=backend_exact remainingModelOwnedDecision=none callId=${callId}`,
    );
    iiziDetCriticalLineQueued = true;
    return sendResponseCreate("iizi-exact", {
      instructions:
        `Speak ONLY the following sentence verbatim in Estonian. Do not add, remove, or change any words. ` +
        `Do not call tools. Do not add filler.\n"""\n${text}\n"""`,
      output_modalities: [...REALTIME_GA_RESPONSE_MODALITIES],
    });
  };

  const speakFillerIizi = (lineId: string, reason: IiziFillerReason): boolean => {
    const text = resolveIiziFillerLine(lineId);
    if (!text) return false;
    return sendResponseCreate("iizi-filler", {
      instructions:
        `Speak ONLY this brief filler verbatim, then stop:\n"""\n${text}\n"""`,
      output_modalities: [...REALTIME_GA_RESPONSE_MODALITIES],
    });
  };

  const enqueueIiziDeterministicActions = (actions: IiziDeterministicAction[]) => {
    for (const a of actions) {
      if (a.type !== "none") iiziDetPendingActions.push(a);
    }
    void drainIiziDeterministicQueue();
  };

  const runIiziBackendSms = async (
    templateName: string,
  ): Promise<{ ok: boolean; alreadySent: boolean }> => {
    const recipient = callDirection === "inbound" ? fromNumber : calledNumber;
    const tpl = smsMessages.find((m) => m.trigger === "during" && m.name === templateName);
    if (!recipient || !tpl) {
      if (templateName) setSmsToolState(templateName, "failed", "backend_deterministic_missing");
      return { ok: false, alreadySent: false };
    }
    if (smsSentNames.has(tpl.name)) {
      return { ok: true, alreadySent: true };
    }
    setSmsToolState(tpl.name, "pending", "backend_deterministic_send");
    if (tpl.name === COMBINED_SMS_TEMPLATE_NAME) {
      setLocationStatus("pending", "combined_sms_sent", null);
      vehicleValidationStatus = "unknown";
      vehicleLookupPassed = false;
      vehicleReadbackDone = false;
      locationReadbackDone = false;
    }
    const body = substituteVarsRef(tpl.content);
    const result = await sendSms(recipient, body);
    lastSmsToolResultAt = Date.now();
    lastSmsToolResultTemplate = tpl.name;
    if (result.ok) {
      smsSentNames.add(tpl.name);
      setSmsToolState(tpl.name, "sent", "backend_deterministic_ok");
      if (tpl.name === COMBINED_SMS_TEMPLATE_NAME) {
        try {
          ingestIiziBrainFlow(iiziBrainRef.current, "combined_sms_sent");
        } catch {
          /* observability only */
        }
      }
      if (tpl.name === CALLBACK_SMS_TEMPLATE_NAME) {
        callbackSmsSent = true;
        callbackPending = true;
        callbackMode = "different_number_sms";
      }
      return { ok: true, alreadySent: false };
    }
    setSmsToolState(tpl.name, "failed", `backend_det:${result.error || "fail"}`);
    return { ok: false, alreadySent: false };
  };

  const processOneIiziDeterministicAction = async (action: IiziDeterministicAction): Promise<boolean> => {
    switch (action.type) {
      case "speak_exact":
        return speakExactIizi(action.lineId, action.vars);
      case "speak_filler":
        return speakFillerIizi(action.lineId, action.reason);
      case "mark_occupant_required": {
        const norm = action.normalizedTranscript ?? "";
        const occ = action.category
          ? computeOccupantRequirement(action.category, norm)
          : computeOccupantRequirement(null, norm);
        if (occ.required) {
          incidentNeedsOccupantCount = true;
          occupantCountStatus = "pending";
          iiziDetRef.current.flags.occupantCountRequired = true;
          console.log(
            `[IIZI-Deterministic] occupantCountRequired=true occupantCountRequiredReason=${occ.reason} ` +
              `passengerMentionDetected=${occ.passengerMentionDetected} passengerPhrase=${occ.passengerPhrase ?? "null"} ` +
              `triggerCategory=${action.category ?? "null"} callId=${callId}`,
          );
        }
        return true;
      }
      case "send_combined_sms": {
        const r = await runIiziBackendSms(COMBINED_SMS_TEMPLATE_NAME);
        const turn = reduceIiziDeterministicTurn({
          callId,
          bag: iiziDetRef.current,
          event: {
            type: "combined_sms_result",
            success: r.ok,
            alreadySent: r.alreadySent,
          },
        });
        enqueueIiziDeterministicActions(turn.actions);
        return false;
      }
      case "send_callback_sms": {
        const r = await runIiziBackendSms(CALLBACK_SMS_TEMPLATE_NAME);
        const turn = reduceIiziDeterministicTurn({
          callId,
          bag: iiziDetRef.current,
          event: { type: "callback_sms_result", success: r.ok },
        });
        enqueueIiziDeterministicActions(turn.actions);
        return false;
      }
      default:
        return true;
    }
  };

  const drainIiziDeterministicQueue = async () => {
    if (iiziDetDraining || !iiziDeterministicInbound()) return;
    iiziDetDraining = true;
    try {
      while (iiziDetPendingActions.length > 0 && !activeResponseId && openaiWs?.readyState === WebSocket.OPEN) {
        const action = iiziDetPendingActions.shift()!;
        const spoke = await processOneIiziDeterministicAction(action);
        if (spoke) break;
      }
    } finally {
      iiziDetDraining = false;
      iiziDetCriticalLineQueued = false;
    }
  };

  const runIiziDeterministicUserTranscript = (text: string) => {
    const filler = maybeSpeakIiziFiller({
      bag: iiziDetRef.current,
      reason: "transcript_processing",
      now: Date.now(),
      assistantSpeaking: aiIsSpeaking || Boolean(activeResponseId),
      criticalLineQueued: iiziDetCriticalLineQueued,
    });
    if (filler.lineId && !activeResponseId) {
      speakFillerIizi(filler.lineId, "transcript_processing");
    } else if (filler.suppressedReason) {
      console.log(
        `[IIZI-Deterministic] fillerUsed=false fillerSuppressedReason=${filler.suppressedReason} callId=${callId}`,
      );
    }
    const turn = reduceIiziDeterministicTurn({
      callId,
      bag: iiziDetRef.current,
      event: { type: "user_transcript", text },
    });
    if (turn.remainingModelOwnedDecision) {
      console.log(
        `[IIZI-Deterministic] remainingModelOwnedDecision=${turn.remainingModelOwnedDecision} callId=${callId}`,
      );
    }
    enqueueIiziDeterministicActions(turn.actions);
  };

  const runIiziDeterministicSystemEvent = (
    event:
      | { type: "form_submitted" }
      | { type: "vehicle_lookup_result"; match: boolean; coverageInvalid?: boolean }
      | { type: "location_confirmed"; address: string }
      | { type: "callback_form_received" },
  ) => {
    const turn = reduceIiziDeterministicTurn({ callId, bag: iiziDetRef.current, event });
    enqueueIiziDeterministicActions(turn.actions);
  };

  const resetInboundRecoveryPlaybackState = () => {
    clearInboundTranscriptFallbackTimer();
    clearInboundNoAudioTimer();
    clearResponseDoneFallbackTimer();
    clearMarkFallback();
    activeResponseId = null;
    responsePlaybackMarkName = null;
    responseHasAudio = false;
    responseAudioDone = false;
    responseDoneReceived = false;
    responseAudioDeltaLogged = false;
    activeResponseTwilioChunks = 0;
    activeResponseTwilioBytes = 0;
    aiIsSpeaking = false;
  };

  const completeInboundTranscriptRecovery = (reason: string, transcriptText: string, transcriptSeq: number) => {
    if (iiziDeterministicInbound()) {
      console.log(
        `[IIZI-Deterministic] iiziTranscriptRecoveryMode=backend_fsm reason=${reason} ` +
          `recoveredTranscript="${transcriptText.slice(0, 160)}" recoveryFedToBackend=true ` +
          `recoveryTriggeredModelResponse=false callId=${callId}`,
      );
      runIiziDeterministicUserTranscript(transcriptText);
      return;
    }
    injectInboundTranscriptAsUserText(transcriptText, reason, transcriptSeq);
    lastResponseCreateReason = reason;
    console.warn(
      `[Diag-InboundTurn] fallback sent seq=${transcriptSeq} reason=${reason} text="${transcriptText.slice(0, 160)}" (callId=${callId})`,
    );
    sendResponseCreate(reason, { output_modalities: [...REALTIME_GA_RESPONSE_MODALITIES] });
  };

  /** Returns block result if IIZI brain denies tool; otherwise null. */
  const rejectToolIfBrainBlocks = (
    fnName: string,
    toolArgs: { template_name?: string; count?: string },
  ): ToolValidationResult | null => {
    if (iiziDeterministicInbound()) {
      if (fnName === "end_call" && !iiziDeterministicAllowsModelEndCall(iiziDetRef.current.currentState)) {
        return {
          allowed: false,
          errorCode: "iizi_deterministic_backend_not_closed",
          message: "end_call blocked — backend has not reached a terminal closure state.",
          correctionSystemText:
            `[SYSTEM EVENT: brain_tool_blocked] Internal note — do NOT read aloud. ` +
            `end_call is owned by the backend until the call reaches a terminal state.`,
        };
      }
      const backendOwned = [
        "send_sms",
        "confirm_iizi_vehicle_readback_complete",
        "confirm_iizi_location_readback_complete",
        "confirm_iizi_callback_same_incoming_number",
        "confirm_iizi_callback_phone_verbal",
        "confirm_occupant_count",
        "mark_occupant_count_required",
      ];
      if (backendOwned.includes(fnName)) {
        return {
          allowed: false,
          errorCode: "iizi_deterministic_backend_owned",
          message: `${fnName} is owned by the backend in IIZI deterministic mode.`,
          correctionSystemText:
            `[SYSTEM EVENT: brain_tool_blocked] Internal note — do NOT read aloud. ` +
            `The orchestrator owns this step. Wait for backend exact speech; do not improvise or call this tool.`,
        };
      }
    }
    if (!iiziCombinedInbound()) return null;
    const snap = buildBrainRuntimeSnapshot();
    const decision = evaluateBrain(snap);
    logBrainDecision(snap, decision, fnName);
    const v = validateIiziInboundToolCall(snap, fnName, toolArgs);
    if (v.allowed) return null;
    logBrainToolBlocked(snap, fnName, v);
    return v;
  };

  const diagnoseBreakPoint = () => {
    if (twilioInboundFramesAfterGreeting === 0) return "Twilio inbound media after greeting is 0: Twilio stream/greeting mark/gating is broken.";
    if (speechStartedCount === 0 && userTranscriptCount === 0 && bufferCommittedCount === 0) return "Twilio inbound media exists but no OpenAI speech_started/transcript/commit: audio forwarding or Realtime input format is broken.";
    if ((userTranscriptCount > 0 || bufferCommittedCount > 0) && responseCreateSentCount === 0) return "OpenAI transcript/commit exists but no response.create: response triggering logic is broken.";
    if (responseCreateSentCount > 0 && responseCreatedCount === 0) return "response.create was sent but no response.created: OpenAI session/model/config/error is broken.";
    if (responseCreatedCount > 0 && assistantAudioDeltaCount + assistantOutputAudioDeltaCount === 0) return "response.created exists but no audio delta: session output modality/audio config is broken.";
    if (assistantAudioDeltaCount + assistantOutputAudioDeltaCount > 0 && twilioOutboundFrames === 0) return "audio delta exists but no Twilio outbound media: outbound forwarding/conversion is broken.";
    if (twilioOutboundFrames > 0) return "Twilio outbound media exists; if caller hears nothing, codec/payload format or Twilio playback path is broken.";
    return "No single break point identified; inspect preceding counters/events.";
  };

  const sendTwilioBridgeSelfTestTone = (reason: string) => {
    if (bridgeSelfTest !== "twilio-outbound") return;
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) {
      console.warn(`[Diag-TestB] skipped reason=${reason} streamSid=${streamSid || "empty"} twilioState=${twilioWs.readyState} (callId=${callId})`);
      return;
    }
    const linearToMuLaw = (sample: number) => {
      const BIAS = 0x84;
      const CLIP = 32635;
      let sign = (sample >> 8) & 0x80;
      if (sign !== 0) sample = -sample;
      if (sample > CLIP) sample = CLIP;
      sample += BIAS;
      let exponent = 7;
      for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) exponent -= 1;
      const mantissa = (sample >> (exponent + 3)) & 0x0f;
      return (~(sign | (exponent << 4) | mantissa)) & 0xff;
    };
    const sampleRate = 8000;
    const toneHz = 880;
    const frames = 60;
    const framePayloads = Array.from({ length: frames }, (_, frameIndex) => {
      const frame = Buffer.alloc(160);
      for (let i = 0; i < 160; i += 1) {
        const t = (frameIndex * 160 + i) / sampleRate;
        frame[i] = linearToMuLaw(Math.round(Math.sin(2 * Math.PI * toneHz * t) * 12000));
      }
      return frame.toString("base64");
    });
    console.warn(`[Diag-TestB] sending hardcoded outbound Twilio media tone frames=${frames} reason=${reason} (callId=${callId})`);
    for (const payload of framePayloads) {
      try {
        twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
        twilioOutboundFrames += 1;
        if (!firstTwilioOutboundAt) firstTwilioOutboundAt = new Date().toISOString();
      } catch (sendErr) {
        twilioOutboundSendErrors += 1;
        console.error(`[Diag-TestB] Twilio outbound self-test send error (callId=${callId}, twilioState=${twilioWs.readyState}):`, sendErr);
      }
    }
  };

  const clearMarkFallback = () => {
    if (markFallbackTimer) {
      clearTimeout(markFallbackTimer);
      markFallbackTimer = null;
    }
  };

  const clearTurnDetectionEnableTimer = () => {
    if (turnDetectionEnableTimer) {
      clearTimeout(turnDetectionEnableTimer);
      turnDetectionEnableTimer = null;
    }
  };

  const clearPendingUserResponseTimer = () => {
    if (pendingUserResponseTimer) {
      clearTimeout(pendingUserResponseTimer);
      pendingUserResponseTimer = null;
    }
  };

  const clearInboundTranscriptFallbackTimer = () => {
    if (inboundTranscriptFallbackTimer) {
      clearTimeout(inboundTranscriptFallbackTimer);
      inboundTranscriptFallbackTimer = null;
    }
  };

  const clearInboundNoAudioTimer = () => {
    if (inboundNoAudioTimer) {
      clearTimeout(inboundNoAudioTimer);
      inboundNoAudioTimer = null;
    }
  };

  const clearResponseDoneFallbackTimer = () => {
    if (responseDoneFallbackTimer) {
      clearTimeout(responseDoneFallbackTimer);
      responseDoneFallbackTimer = null;
    }
  };

  const clearPendingInboundRecoveryAfterCancel = () => {
    if (pendingInboundRecoveryAfterCancel?.timer) {
      clearTimeout(pendingInboundRecoveryAfterCancel.timer);
    }
    pendingInboundRecoveryAfterCancel = null;
  };

  const clearCallerSpeechWatchdog = () => {
    if (callerSpeechWatchdogTimer) {
      clearTimeout(callerSpeechWatchdogTimer);
      callerSpeechWatchdogTimer = null;
    }
  };

  const clearEndCallHangupTimer = () => {
    if (endCallHangupTimer) {
      clearTimeout(endCallHangupTimer);
      endCallHangupTimer = null;
    }
  };

  const currentResponseHasAssistantAudio = () =>
    responseHasAudio || activeResponseTwilioChunks > 0 || activeResponseTwilioBytes > 0;

  const completePendingEndCallHangup = (source: string) => {
    if (!pendingEndCall) return;
    console.log(`[EndCall] close_playback_done_hanging_up source=${source} callId=${callId}`);
    pendingEndCall = null;
    clearEndCallHangupTimer();
    hangUpCall();
  };

  const speakEndCallClose = (): boolean => {
    if (!pendingEndCall?.closeSpeechRequired || pendingEndCall.closeResponseSent) return false;
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return false;
    const text = pendingEndCall.closeText;
    console.log(`[EndCall] speaking_close_before_hangup text="${text}" callId=${callId}`);
    pendingEndCall.closeResponseSent = true;
    const sent = sendResponseCreate("end-call-close", {
      instructions:
        `Your ONLY task is to say the following OUT LOUD, WORD-FOR-WORD in Estonian. ` +
        `Do not add, remove, or change any words:\n"""\n${text}\n"""`,
      output_modalities: [...REALTIME_GA_RESPONSE_MODALITIES],
    });
    if (!sent) {
      pendingEndCall.closeResponseSent = false;
      return false;
    }
    clearEndCallHangupTimer();
    endCallHangupTimer = setTimeout(() => {
      console.warn(`[EndCall] close speech fallback timeout — hanging up (callId=${callId})`);
      completePendingEndCallHangup("close-speak-fallback-timeout");
    }, 12_000);
    return true;
  };

  const strictTurnGateEnabled = () =>
    callDirection === "inbound" && (antiBargeinEnabled || liveTurnSettings.interrupt_response === false);

  const effectivePostPlaybackCooldownMs = (baseMs: number) =>
    liveTurnSettings.loudspeaker_mode ? baseMs + 300 : baseMs;

  const assistantPlaybackProtected = () =>
    Boolean(activeResponseId) || aiIsSpeaking || Boolean(responsePlaybackMarkName);

  const hasUserAudioActivity = () =>
    hasPostGreetingSpeechStarted || hasCommittedUserAudio || userAudioTurnCount > 0;

  const logUserAudioActivity = (source: string, transcriptLen = 0) => {
    console.log(
      `[TurnGate] user_audio_activity speechStarted=${hasPostGreetingSpeechStarted} committed=${hasCommittedUserAudio} transcriptLen=${transcriptLen} userAudioTurnCount=${userAudioTurnCount} source=${source} callId=${callId}`
    );
  };

  const clearStalePendingUserTurn = (reason: string, itemId?: string | null) => {
    if (!pendingUserResponseReason && !pendingUserResponseTimer) return;
    console.log(
      `[TurnGate] pending_user_turn_cleared reason=${reason} pendingReason=${pendingUserResponseReason || "none"} itemId=${itemId || lastCommittedUserItemId || "none"} callId=${callId}`
    );
    clearPendingUserResponseTimer();
    pendingUserResponseReason = null;
    pendingUserResponseTranscript = null;
    pendingUserResponseAttempts = 0;
  };

  const clearPendingCommittedTurnFallback = (itemId: string) => {
    const turn = pendingCommittedUserTurns.get(itemId);
    if (turn?.fallbackTimer) {
      clearTimeout(turn.fallbackTimer);
      turn.fallbackTimer = null;
    }
  };

  const isRuntimeCommittedTranscriptReason = (reason: string) =>
    runtimeOwnsPostGreetingResponses() &&
    (reason === "transcript-ready" || reason === "transcript-fallback-committed-audio");

  const scheduleTranscriptReadyResponse = (
    itemId: string,
    reason: "transcript-ready" | "transcript-fallback-committed-audio",
    attempt = 1
  ): boolean => {
    const turn = pendingCommittedUserTurns.get(itemId);
    if (!turn) return false;
    if (responseCreateSentForItemIds.has(itemId)) {
      console.log(
        `[TurnGate] response_create_deduped itemId=${itemId} existingResponseId=${activeResponseId || "none"} callId=${callId}`
      );
      return false;
    }

    const cooldownLeftMs = Math.max(0, inboundAudioCooldownUntil - Date.now());
    const blockReason = getCallerAudioBlockReason(true, { transcriptReadyItemId: itemId });
    if (blockReason || activeResponseId || greetingInProgress || cooldownLeftMs > 0) {
      if (attempt <= 40) {
        const waitMs = Math.max(
          80,
          Math.min(200, cooldownLeftMs || (blockReason === "caller_still_speaking" ? 120 : 150))
        );
        console.log(
          `[TurnGate] response_create_retry_scheduled reason=${reason} attempt=${attempt} waitMs=${waitMs} block=${blockReason || "none"} itemId=${itemId} callId=${callId}`
        );
        setTimeout(() => scheduleTranscriptReadyResponse(itemId, reason, attempt + 1), waitMs);
        return true;
      }
      console.error(
        `[TurnGate] response_create_gave_up reason=${reason} itemId=${itemId} block=${blockReason || "none"} attempts=${attempt} callId=${callId}`
      );
      return false;
    }

    if (
      sendResponseCreate(
        reason,
        { output_modalities: [...REALTIME_GA_RESPONSE_MODALITIES] },
        { committedItemId: itemId }
      )
    ) {
      turn.responseScheduled = true;
      console.log(`[Diag] response.create sent reason=${reason} itemId=${itemId} callId=${callId}`);
      return true;
    }

    if (attempt <= 40) {
      const waitMs = 100;
      console.log(
        `[TurnGate] response_create_retry_scheduled reason=${reason} attempt=${attempt} waitMs=${waitMs} block=send_failed itemId=${itemId} callId=${callId}`
      );
      setTimeout(() => scheduleTranscriptReadyResponse(itemId, reason, attempt + 1), waitMs);
      return true;
    }
    return false;
  };

  const scheduleResponseForCommittedTurn = (
    itemId: string,
    reason: "transcript-ready" | "transcript-fallback-committed-audio",
    _transcript?: string
  ): boolean => {
    if (!runtimeOwnsPostGreetingResponses() || itemId === "none") return false;
    const turn = pendingCommittedUserTurns.get(itemId);
    if (!turn) {
      console.warn(`[TurnGate] schedule skipped reason=no_pending_turn itemId=${itemId} source=${reason} callId=${callId}`);
      return false;
    }
    if (turn.responseScheduled || responseCreateSentForItemIds.has(itemId)) {
      console.log(
        `[TurnGate] response_create_deduped itemId=${itemId} existingResponseId=${activeResponseId || "none"} callId=${callId}`
      );
      return false;
    }
    if (reason === "transcript-ready") turn.transcriptReceived = true;
    clearPendingCommittedTurnFallback(itemId);

    const msSinceCallerAudio =
      lastAcceptedCallerAudioAt > 0 ? Date.now() - lastAcceptedCallerAudioAt : Number.POSITIVE_INFINITY;
    if (msSinceCallerAudio < liveTurnSettings.silence_duration_ms) {
      console.log(
        `[TurnGate] transcript_ready_response_allowed despite_recent_caller_audio=true itemId=${itemId} msSinceAudio=${msSinceCallerAudio} callId=${callId}`
      );
    }

    return scheduleTranscriptReadyResponse(itemId, reason, 1);
  };

  const registerPendingCommittedTurn = (itemId: string, framesAtCommit: number) => {
    clearPendingCommittedTurnFallback(itemId);
    const turn: PendingCommittedUserTurn = {
      itemId,
      committedAt: Date.now(),
      framesAtCommit,
      transcriptReceived: false,
      responseScheduled: false,
      fallbackTimer: null,
    };
    pendingCommittedUserTurns.set(itemId, turn);
    console.log(
      `[TurnGate] pending_user_audio_turn itemId=${itemId} transcript_len=0 frames=${framesAtCommit} callId=${callId}`
    );
    const fallbackMs = liveTurnSettings.inbound_transcript_fallback_ms;
    turn.fallbackTimer = setTimeout(() => {
      turn.fallbackTimer = null;
      if (turn.responseScheduled || responseCreateSentForItemIds.has(itemId)) return;
      if (turn.framesAtCommit < MIN_INPUT_FRAMES_BEFORE_COMMIT) {
        console.log(
          `[TurnGate] transcript-fallback skipped reason=too_few_frames frames=${turn.framesAtCommit} itemId=${itemId} callId=${callId}`
        );
        return;
      }
      console.log(
        `[TurnGate] transcript-fallback firing itemId=${itemId} timeoutMs=${fallbackMs} frames=${turn.framesAtCommit} callId=${callId}`
      );
      scheduleResponseForCommittedTurn(itemId, "transcript-fallback-committed-audio");
    }, fallbackMs);
  };

  const shouldManuallyScheduleResponse = (reason: string) => {
    if (reason.startsWith("system-event") || reason === "tool-result") return true;
    if (reason === "transcript-ready" || reason === "transcript-fallback-committed-audio") return true;
    if (runtimeOwnsPostGreetingResponses()) return false;
    if (!vadServerCreateResponseEnabled) return true;
    if (reason.includes("user-transcript") || reason.includes("inbound-transcript")) return false;
    if (reason.includes("speech") || reason.includes("audio-commit") || reason.includes("watchdog")) {
      return false;
    }
    return true;
  };

  const hasValidPendingUserTurn = () => {
    const transcript = (pendingUserResponseTranscript || "").trim();
    if (transcript.length > 0) return true;
    if (!lastCommittedUserItemId) return false;
    return !responseCreateSentForItemIds.has(lastCommittedUserItemId);
  };

  const getCallerAudioBlockReason = (
    includeCallerSpeech = false,
    opts?: { transcriptReadyItemId?: string | null }
  ): string | null => {
    const transcriptItemId = opts?.transcriptReadyItemId ?? null;
    let trustVadTurnEnd = false;
    if (transcriptItemId) {
      trustVadTurnEnd =
        runtimeOwnsPostGreetingResponses() &&
        pendingCommittedUserTurns.has(transcriptItemId);
    }

    if (includeCallerSpeech) {
      if (callerSpeechActive) return "caller_still_speaking";
      if (!trustVadTurnEnd && lastAcceptedCallerAudioAt > 0) {
        const msSinceLastCallerAudio = Date.now() - lastAcceptedCallerAudioAt;
        if (msSinceLastCallerAudio < liveTurnSettings.silence_duration_ms) {
          return "caller_still_speaking";
        }
      } else if (trustVadTurnEnd && lastAcceptedCallerAudioAt > 0) {
        const msSinceLastCallerAudio = Date.now() - lastAcceptedCallerAudioAt;
        if (msSinceLastCallerAudio < liveTurnSettings.silence_duration_ms) {
          console.log(
            `[TurnGate] transcript_ready_response_allowed despite_recent_caller_audio=true itemId=${transcriptItemId} callId=${callId}`
          );
        }
      }
    }
    if (greetingInProgress) {
      return "greeting_playing";
    }
    if (greetingCompletedAt && !vadEnabledAcknowledged) {
      return "vad_not_enabled_yet";
    }
    if (Date.now() < inboundAudioCooldownUntil) {
      return "post_playback_cooldown";
    }
    if (callDirection === "outbound" && assistantPlaybackProtected()) {
      return "assistant_speaking";
    }
    if (strictTurnGateEnabled() && assistantPlaybackProtected()) {
      return "assistant_speaking";
    }
    return null;
  };

  const isUserTurnReason = (reason: string) =>
    reason.includes("user") ||
    reason.includes("transcript") ||
    reason.includes("inbound") ||
    reason.includes("watchdog") ||
    reason.includes("speech") ||
    reason.includes("audio-commit");

  const tryCommitCallerAudio = (reason: string, delayMs = 80) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
      console.warn(`[Diag] audio commit skipped reason=${reason} skip=openai_ws_not_open openaiState=${openaiWs?.readyState ?? "null"} (callId=${callId})`);
      return false;
    }
    const commitBlockReason = getCallerAudioBlockReason(true);
    if (commitBlockReason) {
      console.log(`[TurnGate] skip_empty_audio_commit reason=blocked_${commitBlockReason} frames=${inputFramesSinceLastCommit} callId=${callId}`);
      return false;
    }
    if (inputFramesSinceLastCommit < MIN_INPUT_FRAMES_BEFORE_COMMIT) {
      console.log(
        `[TurnGate] skip_empty_audio_commit reason=too_few_frames frames=${inputFramesSinceLastCommit} callId=${callId}`
      );
      clearStalePendingUserTurn("too_few_frames");
      return false;
    }
    framesForPendingCommit = inputFramesSinceLastCommit;
    console.warn(`[Diag] input_audio_buffer.commit sent reason=${reason} frames=${framesForPendingCommit} (callId=${callId})`);
    openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    inputFramesSinceLastCommit = 0;
    if (shouldManuallyScheduleResponse(reason)) {
      scheduleUserResponseCreate(reason, delayMs);
    }
    return true;
  };

  const armCallerSpeechWatchdog = (reason: string, timeoutMs = liveTurnSettings.watchdog_commit_ms) => {
    clearCallerSpeechWatchdog();
    callerSpeechWatchdogTimer = setTimeout(() => {
      callerSpeechWatchdogTimer = null;
      const blockReason = getCallerAudioBlockReason(true);
      if (blockReason) {
        console.log(`[TurnGate] watchdog skipped reason=${blockReason} source=${reason} callId=${callId}`);
        if (blockReason === "caller_still_speaking") {
          const elapsed = lastAcceptedCallerAudioAt > 0 ? Date.now() - lastAcceptedCallerAudioAt : 0;
          const waitMs = Math.max(150, liveTurnSettings.silence_duration_ms - elapsed + 50);
          armCallerSpeechWatchdog(`${reason}-reschedule`, waitMs);
        }
        return;
      }
      if (activeResponseId || greetingInProgress || responsePlaybackMarkName) return;
      console.warn(`[Diag] caller speech watchdog fired reason=${reason}; forcing commit (callId=${callId})`);
      tryCommitCallerAudio(`watchdog-${reason}`, 120);
    }, timeoutMs);
  };

  const sendResponseCreate = (
    reason: string,
    response?: Record<string, unknown>,
    opts?: { committedItemId?: string | null }
  ) => {
    const committedItemId = opts?.committedItemId ?? lastCommittedUserItemId;
    const blockReason = isUserTurnReason(reason)
      ? getCallerAudioBlockReason(true, {
          transcriptReadyItemId: isRuntimeCommittedTranscriptReason(reason) ? committedItemId : null,
        })
      : null;
    if (blockReason) {
      console.log(`[TurnGate] blocked response.create reason=${blockReason} source=${reason} callId=${callId}`);
      return false;
    }
    if (
      isUserTurnReason(reason) &&
      !reason.startsWith("system-event") &&
      reason !== "tool-result" &&
      committedItemId &&
      responseCreateSentForItemIds.has(committedItemId)
    ) {
      console.log(
        `[TurnGate] response_create_deduped itemId=${committedItemId} existingResponseId=${activeResponseId || "none"} callId=${callId}`
      );
      return false;
    }
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
      console.warn(`[Diag] response.create skipped reason=${reason} skip=openai_ws_not_open openaiState=${openaiWs?.readyState ?? "null"} activeResponseBefore=${activeResponseId || "none"} (callId=${callId})`);
      return false;
    }
    if (activeResponseId) {
      console.warn(`[Diag] response.create skipped reason=${reason} skip=active_response activeResponseBefore=${activeResponseId} (callId=${callId})`);
      return false;
    }
    responseCreateSentCount += 1;
    if (reason !== "initial-greeting") userResponseCreateSentCount += 1;
    lastResponseCreateReason = reason;
    if (committedItemId) {
      responseCreateSentForItemIds.add(committedItemId);
      const turn = pendingCommittedUserTurns.get(committedItemId);
      if (turn) turn.responseScheduled = true;
    }
    console.log(
      `[Diag] response.create sent #${responseCreateSentCount} reason=${reason} itemId=${committedItemId || "none"} activeResponseBefore=${activeResponseId || "none"} (callId=${callId})`
    );
    openaiWs.send(JSON.stringify(response ? { type: "response.create", response } : { type: "response.create" }));
    return true;
  };

  const scheduleUserResponseCreate = (reason: string, delayMs: number, transcript?: string) => {
    const cleanTranscript = typeof transcript === "string" ? transcript.trim() : "";
    if (!cleanTranscript && isUserTurnReason(reason) && shouldManuallyScheduleResponse(reason)) {
      console.log(`[TurnGate] ignore_empty_user_turn callId=${callId} itemId=${lastCommittedUserItemId || "none"}`);
      clearStalePendingUserTurn("empty_schedule_request");
      return;
    }
    if (!shouldManuallyScheduleResponse(reason)) {
      console.log(`[TurnGate] skip_manual_response_schedule reason=${reason} vad_create_response=${vadServerCreateResponseEnabled} callId=${callId}`);
      return;
    }
    if (cleanTranscript) pendingUserResponseTranscript = cleanTranscript;
    if (pendingUserResponseTimer) {
      if (cleanTranscript) {
        clearPendingUserResponseTimer();
        pendingUserResponseReason = reason;
        pendingUserResponseAttempts = 0;
      } else if (reason.startsWith("system-event") && (pendingUserResponseReason || "").startsWith("system-event")) {
        clearPendingUserResponseTimer();
        pendingUserResponseAttempts = 0;
        pendingUserResponseReason = "system-event-coalesced";
        console.log(`[Diag] system-event responses coalesced → single pending follow-up (callId=${callId})`);
      } else {
        console.log(`[Diag] response.create schedule skipped reason=${reason} skip=already_pending pendingReason=${pendingUserResponseReason || "none"} activeResponse=${activeResponseId || "none"} (callId=${callId})`);
        return;
      }
    }
    pendingUserResponseReason = pendingUserResponseReason || reason;
    pendingUserResponseTimer = setTimeout(() => {
      pendingUserResponseTimer = null;
      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

      const finalReason = pendingUserResponseReason || reason;
      const cooldownLeftMs = Math.max(0, inboundAudioCooldownUntil - Date.now());
      const blockReason = isUserTurnReason(finalReason)
        ? getCallerAudioBlockReason(true, {
            transcriptReadyItemId: isRuntimeCommittedTranscriptReason(finalReason)
              ? lastCommittedUserItemId
              : null,
          })
        : null;
      if (
        isUserTurnReason(finalReason) &&
        !(pendingUserResponseTranscript || "").trim() &&
        !hasValidPendingUserTurn()
      ) {
        clearStalePendingUserTurn("stale_empty_turn");
        return;
      }
      if (blockReason || activeResponseId || greetingInProgress || cooldownLeftMs > 0) {
        pendingUserResponseAttempts += 1;
        if (pendingUserResponseAttempts <= 120) {
          const waitMs = Math.max(150, Math.min(500, cooldownLeftMs || 250));
          if (pendingUserResponseAttempts === 1 || pendingUserResponseAttempts % 10 === 0) {
            if (blockReason) {
              console.log(`[TurnGate] blocked response.create reason=${blockReason} source=${pendingUserResponseReason || reason} callId=${callId}`);
            }
            console.warn(`[Diag] Deferring response.create after ${pendingUserResponseReason} — activeResponse=${activeResponseId || "none"} greeting=${greetingInProgress} cooldownLeftMs=${cooldownLeftMs} attempt=${pendingUserResponseAttempts} (callId=${callId})`);
          }
          scheduleUserResponseCreate(pendingUserResponseReason || reason, waitMs);
        } else {
          console.error(`[Diag] Gave up forcing assistant response after ${pendingUserResponseReason} because previous response never cleared (callId=${callId})`);
          pendingUserResponseReason = null;
          pendingUserResponseTranscript = null;
          pendingUserResponseAttempts = 0;
        }
        return;
      }

      pendingUserResponseReason = null;
      pendingUserResponseTranscript = null;
      pendingUserResponseAttempts = 0;
      console.warn(`[Diag] No assistant response after ${finalReason}; sending single response.create (callId=${callId})`);
      sendResponseCreate(finalReason, { output_modalities: [...REALTIME_GA_RESPONSE_MODALITIES] });
    }, delayMs);
  };

  const normalizeTranscript = (txt: string) =>
    txt
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  const startInboundAudioCooldown = (ms: number, reason: string) => {
    inboundAudioCooldownUntil = Math.max(inboundAudioCooldownUntil, Date.now() + ms);
    inputFramesSinceLastCommit = 0;
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    }
    console.log(`[MediaStream] Inbound audio cooldown ${ms}ms after ${reason} (callId=${callId})`);
  };

  const injectInboundTranscriptAsUserText = (transcript: string, reason: string, seq = latestCompletedInboundTranscript?.seq || 0) => {
    const clean = transcript.trim();
    if (!clean || callDirection !== "inbound" || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: clean }],
      },
    }));
    console.warn(`[Diag-InboundTurn] transcript.injected seq=${seq} reason=${reason} text="${clean.slice(0, 160)}" (callId=${callId})`);
  };

  const triggerInboundTranscriptRecovery = (reason: string, failedResponseId?: string | null) => {
    const blockReason = getCallerAudioBlockReason(true);
    if (blockReason) {
      console.log(`[TurnGate] blocked response.create reason=${blockReason} source=${reason} callId=${callId}`);
      return;
    }
    if (callDirection !== "inbound" || greetingInProgress) return;
    if (!latestCompletedInboundTranscript?.text) {
      console.warn(`[Diag-InboundTurn] recovery skipped reason=${reason} skip=no_transcript responseId=${failedResponseId || "none"} (callId=${callId})`);
      if (iiziDeterministicInbound()) {
        console.log(
          `[IIZI-Deterministic] iiziTranscriptRecoveryMode=suppressed reason=empty_transcript ` +
            `recoveryFedToBackend=false recoveryTriggeredModelResponse=false callId=${callId}`,
        );
      }
      return;
    }
    if (iiziDeterministicInbound() && !latestCompletedInboundTranscript.text.trim()) {
      console.log(
        `[IIZI-Deterministic] iiziTranscriptRecoveryMode=suppressed reason=would_trigger_model_response ` +
          `recoveryFedToBackend=false recoveryTriggeredModelResponse=false callId=${callId}`,
      );
      return;
    }
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
      console.warn(`[Diag-InboundTurn] recovery skipped reason=${reason} skip=openai_ws_not_open responseId=${failedResponseId || "none"} openaiState=${openaiWs?.readyState ?? "null"} (callId=${callId})`);
      return;
    }
    if (inboundRecoveryAttemptSeq !== latestCompletedInboundTranscript.seq) {
      inboundRecoveryAttemptSeq = latestCompletedInboundTranscript.seq;
      inboundRecoveryAttemptsForSeq = 0;
    }
    inboundRecoveryAttemptsForSeq += 1;
    if (inboundRecoveryAttemptsForSeq > 2) {
      console.error(`[Diag-InboundTurn] recovery abandoned reason=${reason} seq=${latestCompletedInboundTranscript.seq} attempts=${inboundRecoveryAttemptsForSeq} responseId=${failedResponseId || "none"} text="${latestCompletedInboundTranscript.text.slice(0, 160)}" (callId=${callId})`);
      return;
    }
    console.warn(`[Diag-InboundTurn] recovery triggered reason=${reason} seq=${latestCompletedInboundTranscript.seq} failedResponseId=${failedResponseId || "none"} text="${latestCompletedInboundTranscript.text.slice(0, 160)}" attempts=${inboundRecoveryAttemptsForSeq} (callId=${callId})`);
    const shouldCancelActiveResponse = Boolean(failedResponseId && activeResponseId === failedResponseId && !responseDoneReceived);
    const recoveryTranscriptSeq = latestCompletedInboundTranscript.seq;
    const recoveryTranscriptText = latestCompletedInboundTranscript.text;
    if (shouldCancelActiveResponse) {
      try {
        clearPendingInboundRecoveryAfterCancel();
        pendingInboundRecoveryAfterCancel = {
          reason,
          failedResponseId: failedResponseId || null,
          transcriptSeq: recoveryTranscriptSeq,
          transcriptText: recoveryTranscriptText,
          timer: null,
        };
        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
        console.warn(`[Diag-InboundTurn] response.cancel sent for failed no-audio responseId=${failedResponseId} seq=${latestCompletedInboundTranscript.seq} (callId=${callId})`);
      } catch (err) {
        console.error(`[Diag-InboundTurn] response.cancel failed responseId=${failedResponseId} (callId=${callId}):`, err);
      }
    }
    resetInboundRecoveryPlaybackState();
    ignoreAudioUntilNextResponse = shouldCancelActiveResponse;
    const sendRecoveryResponse = () => {
      if (!latestCompletedInboundTranscript?.text || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
      completeInboundTranscriptRecovery(
        reason,
        latestCompletedInboundTranscript.text,
        latestCompletedInboundTranscript.seq,
      );
    };
    if (shouldCancelActiveResponse) {
      if (pendingInboundRecoveryAfterCancel) {
        pendingInboundRecoveryAfterCancel.timer = setTimeout(() => {
          const pending = pendingInboundRecoveryAfterCancel;
          if (!pending || pending.transcriptSeq !== recoveryTranscriptSeq) return;
          console.warn(`[Diag-InboundTurn] cancel recovery fallback timer fired seq=${recoveryTranscriptSeq} failedResponseId=${failedResponseId || "none"}; forcing recovery create (callId=${callId})`);
          clearPendingInboundRecoveryAfterCancel();
          ignoreAudioUntilNextResponse = false;
          sendRecoveryResponse();
        }, 650);
      }
    } else sendRecoveryResponse();
  };

  const armInboundNoAudioTimer = (responseId: string | null, transcriptSeq: number, reason: string, timeoutMs = 1400) => {
    if (callDirection !== "inbound" || greetingInProgress || !responseId) return;
    clearInboundNoAudioTimer();
    inboundNoAudioTimer = setTimeout(() => {
      inboundNoAudioTimer = null;
      const blockReason = getCallerAudioBlockReason(true);
      if (blockReason) {
        console.log(`[TurnGate] blocked response.create reason=${blockReason} source=inbound-no-audio-${reason} callId=${callId}`);
        return;
      }
      if (callDirection !== "inbound" || greetingInProgress) return;
      if (activeResponseId !== responseId) return;
      if (activeResponseTwilioChunks > 0) return;
      console.error(`[Diag-InboundTurn] no-usable-audio timeout reason=${reason} responseId=${responseId} seq=${transcriptSeq} openaiAudio=${responseHasAudio} twilioChunks=${activeResponseTwilioChunks} text="${latestCompletedInboundTranscript?.text?.slice(0, 160) || ""}" (callId=${callId})`);
      triggerInboundTranscriptRecovery(`inbound-no-audio-${reason}`, responseId);
    }, timeoutMs);
    console.log(`[Diag-InboundTurn] no-audio timer armed reason=${reason} responseId=${responseId} seq=${transcriptSeq} timeoutMs=${timeoutMs} (callId=${callId})`);
  };

  const armResponseDoneNoAudioGrace = (responseId: string | null, transcriptSeq: number, reason: string, timeoutMs = liveTurnSettings.no_audio_grace_ms) => {
    if (callDirection !== "inbound" || greetingInProgress || !responseId) return;
    clearResponseDoneFallbackTimer();
    responseDoneFallbackTimer = setTimeout(() => {
      responseDoneFallbackTimer = null;
      const blockReason = getCallerAudioBlockReason(true);
      if (blockReason) {
        console.log(`[TurnGate] blocked response.create reason=${blockReason} source=${reason} callId=${callId}`);
        return;
      }
      if (callDirection !== "inbound" || greetingInProgress) return;
      if (activeResponseId !== responseId) return;
      if (activeResponseTwilioChunks > 0) {
        maybeCompleteAiTurn(`${reason}-audio-arrived`);
        return;
      }
      console.error(`[Diag-InboundTurn] response.done no-usable-audio grace expired responseId=${responseId} seq=${transcriptSeq} openaiAudio=${responseHasAudio} twilioChunks=${activeResponseTwilioChunks} text="${latestCompletedInboundTranscript?.text?.slice(0, 160) || ""}" (callId=${callId})`);
      triggerInboundTranscriptRecovery("inbound-response-done-no-audio", responseId);
    }, timeoutMs);
    console.warn(`[Diag-InboundTurn] response.done no-audio grace armed responseId=${responseId} seq=${transcriptSeq} timeoutMs=${timeoutMs} (callId=${callId})`);
  };

  const resetResponseState = () => {
    activeResponseId = null;
    responsePlaybackMarkName = null;
    responseHasAudio = false;
    responseAudioDone = false;
    responseDoneReceived = false;
    responseAudioDeltaLogged = false;
    activeResponseInboundTranscriptSeq = 0;
    activeResponseTwilioChunks = 0;
    activeResponseTwilioBytes = 0;
    clearMarkFallback();
    clearInboundTranscriptFallbackTimer();
    clearInboundNoAudioTimer();
    clearResponseDoneFallbackTimer();
  };

  const sendGaSessionUpdate = (reason: string, fields: Record<string, unknown>) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    const session = buildGaSessionPatch(fields);
    const diag = describeGaSessionPatchForLog(session);
    lastGaSessionPatchReason = reason;
    lastGaSessionPatchForDiag = diag;
    console.log(
      `[RealtimeGA] session_update_patch reason=${reason} has_session_type=${diag.type === "realtime"} vad_nested=${diag.vad_nested} tools_count=${diag.tools_count} callId=${callId}`
    );
    openaiWs.send(JSON.stringify({ type: "session.update", session }));
  };

  const enableTurnDetection = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    // Flush any audio that accumulated during greeting playback (echo, line noise)
    // BEFORE enabling VAD, so it doesn't immediately fire a false speech_started.
    openaiWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    inputFramesSinceLastCommit = 0;
    const vadAutoCreateResponse =
      iiziDeterministicMode && iiziCombinedInbound() ? false : iiziCombinedInbound();
    const turnDetection = {
      type: "server_vad",
      threshold: liveTurnSettings.vad_threshold,
      prefix_padding_ms: liveTurnSettings.prefix_padding_ms,
      silence_duration_ms: liveTurnSettings.silence_duration_ms,
      create_response: vadAutoCreateResponse,
      interrupt_response: liveTurnSettings.interrupt_response,
    };
    const patchFields: Record<string, unknown> = {
      audio: {
        input: buildGaAudioInput({ turnDetection }),
      },
    };
    // Activate tools NOW (post-greeting). They were withheld during the greeting
    // so the model couldn't immediately call end_call or lookup_vehicle.
    if (!toolsActivated && pendingToolsForActivation.length > 0) {
      patchFields.tools = pendingToolsForActivation;
      toolsActivated = true;
      console.log(`[MediaStream] Activating ${pendingToolsForActivation.length} tools post-greeting (callId=${callId})`);
    }
    console.log(
      `[GreetingGate] requesting VAD session.update after cooldown=${Math.max(0, Date.now() - (greetingCompletedAt || Date.now()))}ms callId=${callId}`
    );
    console.log(
      `[Diag-OpenAI-Config] callId=${callId} direction=${callDirection} session.update patch=${JSON.stringify({ turn_detection: turnDetection, tools_count: Array.isArray(patchFields.tools) ? patchFields.tools.length : 0 })}`
    );
    vadServerCreateResponseEnabled = vadAutoCreateResponse;
    console.log(
      `[TurnGate] VAD create_response=${vadAutoCreateResponse} runtimeOwned=${runtimeOwnsPostGreetingResponses()} callId=${callId}`
    );
    sendGaSessionUpdate("post-greeting-vad-tools", patchFields);
  };

  const maybeCompleteAiTurn = (source: string) => {
    if (!responseDoneReceived) return;
    if (responseHasAudio && !responseAudioDone) return;
    if (responsePlaybackMarkName) return;

    if (greetingTokenLimitRaised) {
      // Greeting playback finished. Safely lower the per-response cap to the configured value
      // for the rest of the call — UNLESS the greeting itself hit the cap (truncated),
      // because lowering it further would just clip subsequent answers too.
      if (lastResponseFinishReason === "max_output_tokens") {
        console.log(`[MediaStream] Greeting hit max_output_tokens — keeping budget at ${INITIAL_GREETING_MAX_RESPONSE_OUTPUT_TOKENS} for safety (callId=${callId})`);
      } else if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        try {
          sendGaSessionUpdate("post-greeting-max-output-tokens", {
            max_output_tokens: configuredMaxResponseOutputTokens,
          });
          console.log(`[MediaStream] Greeting done — requested max_output_tokens=${configuredMaxResponseOutputTokens} (callId=${callId})`);
        } catch (err) {
          console.warn(`[MediaStream] Failed to lower max_output_tokens:`, err);
        }
      }
      greetingTokenLimitRaised = false;
    }

    const completedResponseId = activeResponseId;
    // After the GREETING specifically, use a tiny cooldown so we don't drop the
    // caller's immediate reply ("tere" / "mul oli avarii"). Echo risk is minimal
    // because the greeting just finished playing and Twilio's mark confirmed it.
    // After normal AI turns we keep the longer cooldown to avoid echo loops.
    const defaultCooldownMs = greetingInProgress
      ? liveTurnSettings.post_greeting_cooldown_ms
      : liveTurnSettings.post_playback_cooldown_ms;
    const recoveryCooldownMs = effectivePostPlaybackCooldownMs(pendingRecoveryCooldownMs || defaultCooldownMs);
    pendingRecoveryCooldownMs = 0;

    resetResponseState();
    ignoreAudioUntilNextResponse = false;
    aiIsSpeaking = false;

    if (pendingEndCall) {
      if (pendingEndCall.closeSpeechRequired && !pendingEndCall.closeResponseSent) {
        if (!speakEndCallClose()) {
          endCallHangupTimer = setTimeout(
            () => completePendingEndCallHangup("close-speak-send-failed"),
            1500
          );
        }
        startInboundAudioCooldown(recoveryCooldownMs, source);
        return;
      }
      if (!pendingEndCall.closeSpeechRequired) {
        console.log(`[EndCall] hanging_up_after_existing_audio callId=${callId}`);
        startInboundAudioCooldown(recoveryCooldownMs, source);
        completePendingEndCallHangup(source);
        return;
      }
      if (pendingEndCall.closeSpeechRequired && pendingEndCall.closeResponseSent) {
        startInboundAudioCooldown(recoveryCooldownMs, source);
        completePendingEndCallHangup(source);
        return;
      }
    }

    startInboundAudioCooldown(recoveryCooldownMs, source);
    if (!greetingInProgress && pendingUserResponseReason) {
      if (hasValidPendingUserTurn() && !activeResponseId) {
        console.log(`[Diag] AI turn completed while user response pending (${pendingUserResponseReason}); scheduling response after cooldown (callId=${callId})`);
        scheduleUserResponseCreate(pendingUserResponseReason, recoveryCooldownMs + 150);
      } else {
        clearStalePendingUserTurn("stale_empty_turn");
      }
    }

    if (greetingInProgress) {
      greetingInProgress = false;
      initialGreetingResponseFinished = true;
      if (lastResponseCreateReason === "initial-greeting") {
        lastResponseCreateReason = "(none)";
      }
      greetingCompletedAt = Date.now();
      if (useCombinedRegLocationSms && callDirection === "inbound") {
        try {
          ingestIiziBrainGreetingComplete(iiziBrainRef.current);
          touchIiziBrainLog("greeting_complete");
        } catch (err) {
          console.error(`[IIZI-Brain] greeting_ingest_failed callId=${callId || "?"}`, err);
        }
      }
      if (iiziDeterministicInbound()) {
        const turn = reduceIiziDeterministicTurn({
          callId,
          bag: iiziDetRef.current,
          event: { type: "greeting_complete" },
        });
        enqueueIiziDeterministicActions(turn.actions);
      }
      console.log(`[GreetingGate] complete source=${source} callId=${callId}`);
      console.log(`[MediaStream] Greeting playback complete via ${source}, enabling VAD after ${recoveryCooldownMs}ms cooldown (callId=${callId}, responseId=${completedResponseId})`);
      clearTurnDetectionEnableTimer();
      turnDetectionEnableTimer = setTimeout(() => {
        turnDetectionEnableTimer = null;
        enableTurnDetection();
      }, recoveryCooldownMs);
      return;
    }

    console.log(`[MediaStream] AI playback complete via ${source} (callId=${callId}, responseId=${completedResponseId})`);
    if (iiziDeterministicInbound()) {
      void drainIiziDeterministicQueue();
    }
  };

  // Connect to OpenAI Realtime API with agent-specific config
  const connectToOpenAI = async () => {
    if (!config.openai.isConfigured) {
      console.error("[MediaStream] OpenAI not configured, cannot bridge");
      twilioWs.close();
      return;
    }

    // Fetch agent configuration
    let instructions = DEFAULT_INSTRUCTIONS;
    let greeting = "";
    let voice = "alloy";
    let voiceSpeed = 1.0;
    let agentConfig = null;
    let agentTools: string[] = [];

    if (agentId && agentId !== "default") {
      agentConfig = await fetchAgentConfig(agentId);
    }
    if (!agentConfig && calledNumber) {
      console.log(`[MediaStream] No agent by ID, trying phone lookup: ${calledNumber} dir=${callDirection} (callId=${callId})`);
      agentConfig = await fetchAgentByPhoneNumber(calledNumber, callDirection);
    }
    if (!agentConfig) {
      console.log(`[MediaStream] No agent found, falling back to first active agent dir=${callDirection} (callId=${callId})`);
      agentConfig = await fetchFirstActiveAgent(callDirection);
    }

    if (agentConfig) {
      loadedAgentName = agentConfig.name || "(unnamed)";
      console.log(`[MediaStream] Loaded agent config: "${agentConfig.name}" (callId=${callId})`);
      console.log(`[Diag-Agent] callId=${callId} loadedAgentId=${(agentConfig as any).id || agentId || "(none)"} loadedAgentName="${loadedAgentName}" requestedAgentId=${agentId || "(none)"}`);
      if (agentConfig.system_prompt) instructions = agentConfig.system_prompt;
      if (agentConfig.greeting) greeting = agentConfig.greeting;
      if (agentConfig.voice) voice = agentConfig.voice;
      if (agentConfig.tools) agentTools = agentConfig.tools;
      if (agentConfig.analysis_prompt) agentAnalysisPrompt = agentConfig.analysis_prompt;
      if (agentConfig.knowledge_base) agentKnowledgeBase = agentConfig.knowledge_base as any[];
      if (agentConfig.settings) {
        const settings = agentConfig.settings as Record<string, unknown>;
        agentBrainUiConfig = resolveAgentBrainConfigFromSettings(settings);
        iiziBrainRef.current.runtimeBrainUi = resolveRuntimeBrainUiFromSettings(settings);
        refreshIiziBrainMergedIntent(iiziBrainRef.current);
        maxCallDurationMinutes = (settings.max_call_duration as number) || 0;
        voiceSpeed = clampVoiceSpeed((settings as { voice_speed?: unknown }).voice_speed);
        // Per-response token cap for normal turns (greeting still uses INITIAL_GREETING_MAX_RESPONSE_OUTPUT_TOKENS)
        const rawCap = (settings as any).response_token_cap;
        if (typeof rawCap === "number" && Number.isFinite(rawCap) && rawCap >= 50 && rawCap <= 4096) {
          configuredMaxResponseOutputTokens = Math.round(rawCap);
        }
        if ((settings as any).use_combined_reg_location_sms === true) {
          useCombinedRegLocationSms = true;
          console.log(`[IIZI-CombinedSMS] enabled=true callId=${callId}`);
        }
        if (settings.use_initial_greeting === false) {
          useInitialGreeting = false;
        }
        liveTurnSettings = sanitizeLiveTurnSettings((settings as any).live_turn_settings);
        // Read uninterruptible greeting setting (default true)
        if (settings.uninterruptible_greeting === false) {
          greetingInProgress = false; // Allow interruption from the start
        }
        console.log(
          `[GreetingGate] uninterruptible_greeting=${settings.uninterruptible_greeting === false ? "false" : "true"} effectiveGreetingInProgress=${greetingInProgress} callId=${callId}`
        );
        // Read anti-barge-in setting (default false)
        if (settings.anti_barge_in === true) {
          antiBargeinEnabled = true;
          console.log(`[MediaStream] Anti-barge-in enabled (callId=${callId})`);
        }
        // SMS settings — new schema: array of named templates with explicit triggers.
        // Backward-compat: if `sms_messages` is missing but `sms_template` exists, migrate inline.
        if (Array.isArray((settings as any).sms_messages)) {
          smsMessages = ((settings as any).sms_messages as any[])
            .filter((m) => m && typeof m.content === "string" && m.content.trim())
            .map((m, idx): SmsMessage => ({
              id: m.id,
              name: (m.name || `sms_${idx + 1}`).toString().trim(),
              description: typeof m.description === "string" ? m.description.trim() : "",
              content: m.content,
              trigger: m.trigger === "after" ? "after" : "during",
              order: typeof m.order === "number" ? m.order : idx,
            }))
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        } else if (typeof (settings as any).sms_template === "string" && (settings as any).sms_template.trim()) {
          const legacyDuring = (settings as any).sms_during_call === true;
          const legacyAfter = (settings as any).sms_after_call === true;
          if (legacyDuring) {
            smsMessages.push({ name: "default", description: "", content: (settings as any).sms_template, trigger: "during", order: 0 });
          }
          if (legacyAfter) {
            smsMessages.push({ name: "default", description: "", content: (settings as any).sms_template, trigger: "after", order: 1 });
          }
        }
      }
    } else {
      console.warn(`[MediaStream] No agents found at all, using defaults (callId=${callId})`);
    }

    console.log(`[LiveTurnSettings] callId=${callId} settings=${JSON.stringify(liveTurnSettings)}`);
    console.log(
      `[LiveCallBehavior] loaded anti_barge_in=${antiBargeinEnabled} uninterruptible_greeting=${greetingInProgress} use_initial_greeting=${useInitialGreeting} loudspeaker_mode=${liveTurnSettings.loudspeaker_mode} callId=${callId}`
    );
    console.log(`[GreetingGate] init greetingInProgress=${greetingInProgress} callId=${callId}`);
    console.log(
      `[TurnGate] loaded mode callId=${callId} strict=${strictTurnGateEnabled()} anti_barge_in=${antiBargeinEnabled} interrupt_response=${liveTurnSettings.interrupt_response} silence_duration_ms=${liveTurnSettings.silence_duration_ms} watchdog_commit_ms=${liveTurnSettings.watchdog_commit_ms}`
    );

    // Inbound CRM prefetch: identify caller by phone number so the agent knows who's calling.
    // Exposed via callVariables so the system prompt can reference {{caller_name}}, {{caller_reg_no}}, etc.
    if (callDirection === "inbound" && fromNumber) {
      const normalizedFrom = String(fromNumber).replace(/[^\d+]/g, "");
      console.log(
        `[CallerContext] from=${fromNumber} normalized=${normalizedFrom} calledNumber=${calledNumber} direction=${callDirection} callId=${callId}`
      );
      const vehicle = await crmLookup({ phone_number: fromNumber });
      if (vehicle) {
        console.log(
          `[CallerContext] lookup result known=true name=${vehicle.owner_name || ""} reg=${vehicle.reg_no || ""} callId=${callId}`
        );
        console.log(`[MediaStream] CRM hit for ${fromNumber}: ${vehicle.owner_name} / ${vehicle.reg_no} (callId=${callId})`);
        callVariables.caller_known = "true";
        callVariables.caller_name = vehicle.owner_name || "";
        callVariables.caller_reg_no = vehicle.reg_no || "";
        callVariables.caller_make = vehicle.make || "";
        callVariables.caller_model = vehicle.model || "";
        callVariables.caller_year = vehicle.year_of_built ? String(vehicle.year_of_built) : "";
        callVariables.caller_color = vehicle.color || "";
        callVariables.caller_insurer = vehicle.insurer || "";
        callVariables.caller_cover_type = vehicle.cover_type || "";
        callVariables.caller_cover_status = vehicle.cover_status || "";
      } else {
        console.log(`[CallerContext] lookup result known=false name= reg= callId=${callId}`);
        console.log(`[MediaStream] CRM miss for ${fromNumber} (callId=${callId})`);
        callVariables.caller_known = "false";
      }
      console.log(`[CallerContext] substituted caller_known=${callVariables.caller_known || "false"} callId=${callId}`);
    }

    // Substitute template variables (e.g. {{first_name}}, {{caller_name}})
    const substituteVars = (text: string): string => {
      if (!text) return text;
      return text.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
        const trimmed = varName.trim();
        if (callVariables[trimmed] !== undefined) return callVariables[trimmed];
        return match;
      });
    };

    // Strip orphan {{...}} placeholders that didn't match any variable.
    // Without this, things like "{{eesti keeles suhtle!}}" get read aloud verbatim
    // by TTS, which sounds broken to the caller.
    const stripUnresolvedPlaceholders = (text: string): string => {
      if (!text) return text;
      return text.replace(/\{\{[^}]+\}\}/g, "").replace(/\s{2,}/g, " ").trim();
    };

    // Inject location confirmation link variable so SMS templates can use {{location_link}}.
    // Token = HMAC-SHA256(callId, LOCATION_TOKEN_SECRET) — verified server-side
    // either by Railway /api/location/confirm OR by Lovable edge function `location-confirm`.
    // The MVP uses the Lovable-hosted page (LOCATION_PAGE_BASE_URL); switch to Azure
    // by changing that env var only — the page contract is identical.
    // Resolve the location confirmation page base URL with sane fallbacks.
    // The Railway env was historically set to a placeholder Azure host
    // (`yoursite.z6.web.core.windows.net`) which does not resolve in DNS and
    // breaks the SMS link in production. Detect obvious placeholder values and
    // fall back to the Lovable-hosted page so the link is always usable.
    const PLACEHOLDER_HOST_PATTERNS = [
      /yoursite/i,
      /example\.com/i,
      /your-?domain/i,
      /placeholder/i,
    ];
    const LOVABLE_FALLBACK = "https://app.beyondcode.ai";
    let locationPageBase = (
      process.env.LOCATION_PAGE_BASE_URL ||
      process.env.AZURE_STATIC_BASE_URL ||
      ""
    ).replace(/\/+$/, "");
    if (locationPageBase && PLACEHOLDER_HOST_PATTERNS.some((re) => re.test(locationPageBase))) {
      console.warn(
        `[MediaStream] LOCATION_PAGE_BASE_URL looks like a placeholder (${locationPageBase}), falling back to ${LOVABLE_FALLBACK}`,
      );
      locationPageBase = LOVABLE_FALLBACK;
    }
    if (!locationPageBase) {
      locationPageBase = LOVABLE_FALLBACK;
    }
    // Defensive: strip route segments that some operators accidentally append
    // to LOCATION_PAGE_BASE_URL (e.g. `https://app.example.com/location`),
    // which previously produced double-path URLs like `/location/location?...`
    // and 404 in production. The base URL must be only scheme + host (+ optional
    // sub-path that is NOT one of our route names).
    const ROUTE_SUFFIXES = [
      /\/location\/?$/i,
      /\/form\/?$/i,
      /\/index\.html?$/i,
    ];
    for (const re of ROUTE_SUFFIXES) {
      if (re.test(locationPageBase)) {
        const before = locationPageBase;
        locationPageBase = locationPageBase.replace(re, "");
        console.warn(
          `[MediaStream] LOCATION_PAGE_BASE_URL contained a route suffix (${before}), normalized to ${locationPageBase}`,
        );
      }
    }
    const tokenSecret = process.env.LOCATION_TOKEN_SECRET || "";
    const maskToken = (token: string) =>
      token.length > 10 ? `${token.slice(0, 6)}...${token.slice(-4)}` : "***";
    if (callId && tokenSecret) {
      try {
        const crypto = await import("crypto");
        const locToken = crypto.createHmac("sha256", tokenSecret).update(callId).digest("hex");
        // Lovable page lives at /location?caseId=...&token=...
        // Azure static page lives at /index.html?caseId=...&token=...
        // Detect by extension/path: if base ends with a host (no path), use /location.
        const isLovableLike = !locationPageBase.endsWith(".html") && !/\/index$/.test(locationPageBase);
        const path = isLovableLike ? "/location" : "/index.html";
        const baseLocationUrl = `${locationPageBase}${path}?caseId=${encodeURIComponent(callId)}`;
        callVariables.location_link = `${baseLocationUrl}&token=${locToken}`;
        console.log(`[MediaStream] link generated type=location caseId=${callId} token=${maskToken(locToken)} url=${baseLocationUrl}&token=<masked>`);
      } catch (err) {
        console.error(`[MediaStream] Failed to build location_link:`, err);
      }
    } else if (callId && !tokenSecret) {
      console.warn(`[MediaStream] LOCATION_TOKEN_SECRET not set — cannot build location_link`);
    }

    // Inject form submission link variable so SMS templates can use {{form_link}}.
    // The form page lets the customer enter their car registration number and a
    // callback phone number. Submitted values land in the same `calls` row
    // (form_registration_number, form_callback_phone_number, form_submitted_at)
    // and are read back to the caller by the AI via the realtime UPDATE
    // subscription further down. Same HMAC token + base URL as the location link.
    if (callId && tokenSecret) {
      try {
        const crypto = await import("crypto");
        const formToken = crypto.createHmac("sha256", tokenSecret).update(callId).digest("hex");
        const isLovableLike = !locationPageBase.endsWith(".html") && !/\/index$/.test(locationPageBase);
        const formPath = isLovableLike ? "/form" : "/form.html";
        const combinedPath = isLovableLike ? "/combined" : "/combined.html";
        const formBase = `${locationPageBase}${formPath}?caseId=${encodeURIComponent(callId)}`;
        const combinedBase = `${locationPageBase}${combinedPath}?caseId=${encodeURIComponent(callId)}`;
        callVariables.form_link = `${formBase}&token=${formToken}&mode=registration`;
        callVariables.combined_reg_location_link = `${combinedBase}&token=${formToken}`;
        // Backward-compatible alias only; NOT a separate 4th link.
        callVariables.form1_link = callVariables.form_link;
        callVariables.form2_link = `${formBase}&token=${formToken}&mode=callback`;
        console.log(`[MediaStream] link generated type=registration caseId=${callId} token=${maskToken(formToken)} url=${formBase}&token=<masked>&mode=registration`);
        console.log(`[MediaStream] link generated type=callback caseId=${callId} token=${maskToken(formToken)} url=${formBase}&token=<masked>&mode=callback`);
        console.log(`[MediaStream] link generated type=combined_reg_location caseId=${callId} token=${maskToken(formToken)} url=${combinedBase}&token=<masked>`);
      } catch (err) {
        console.error(`[MediaStream] Failed to build form_link:`, err);
      }
    }

    // Legacy Google Form fallback — only used if GOOGLE_FORM_BASE_URL is configured
    // AND we couldn't build a Lovable form link above. Kept for backwards compat.
    const formBaseUrl = (process.env.GOOGLE_FORM_BASE_URL || "").replace(/\/+$/, "");
    const formCaseEntryId = process.env.GOOGLE_FORM_CASE_ENTRY_ID || "";
    if (callId && formBaseUrl && formCaseEntryId && !callVariables.form_link) {
      try {
        const params = new URLSearchParams({
          usp: "pp_url",
          [formCaseEntryId]: callId,
        });
        callVariables.form_link = `${formBaseUrl}?${params.toString()}`;
      } catch (err) {
        console.error(`[MediaStream] Failed to build google form_link:`, err);
      }
    }

    if (Object.keys(callVariables).length > 0) {
      instructions = substituteVars(instructions);
      greeting = substituteVars(greeting);
      console.log(`[MediaStream] Substituted ${Object.keys(callVariables).length} variables into prompt (callId=${callId})`);
    }
    // Always strip ANY remaining {{...}} placeholders so they're never spoken aloud
    // or fed to the model verbatim. This catches things like {{eesti keeles suhtle!}}
    // that were used as language hints but aren't real variables.
    greeting = stripUnresolvedPlaceholders(greeting);
    instructions = stripUnresolvedPlaceholders(instructions);
    // Make substitute available outside this scope for SMS sending
    substituteVarsRef = substituteVars;

    // Write initial call record to DB
    // Resolve agent_id from URL param OR from the agent we just looked up by phone number (inbound)
    const resolvedAgentId =
      (agentId && agentId !== "default" && agentId) ||
      (agentConfig && (agentConfig as any).id) ||
      null;
    resolvedAgentIdRef = resolvedAgentId;

    const detGuard = isIiziDeterministicCall({
      agentId: resolvedAgentId,
      agentName: loadedAgentName,
      direction: callDirection,
      useCombinedRegLocationSms,
    });
    iiziDeterministicMode = detGuard.active;
    logIiziDeterministicGuard(callId, detGuard);
    if (iiziDeterministicInbound()) {
      const exactGreeting = resolveIiziLocalizedLine("greeting.initial", iiziDetRef.current.iiziLanguage, undefined, callId);
      if (exactGreeting) greeting = exactGreeting;
      instructions = IIZI_MINIMAL_REALTIME_PROMPT;
      reduceIiziDeterministicTurn({
        callId,
        bag: iiziDetRef.current,
        event: {
          type: "crm_prefetch",
          callerKnown: callVariables.caller_known === "true",
        },
      });
      console.log(
        `[IIZI-Deterministic] applied minimal_non_authoritative prompt and greeting.initial callId=${callId}`,
      );
    }
    callStartTime = new Date();

    if (useCombinedRegLocationSms && callDirection === "inbound" && resolvedAgentId) {
      fetchLatestEnabledBrainConfigRow(resolvedAgentId)
        .then((row) => {
          try {
            applyAgentBrainConfigToState(iiziBrainRef.current, row?.config_json ?? null, row?.version ?? null);
            console.log(
              `[IIZI-Brain] brain_config_loaded brainConfigDbVersion=${row?.version ?? "default_shipped_overlay"} schema=${iiziBrainRef.current.brainCompiled.schemaVersion} agentId=${resolvedAgentId} callId=${callId || "?"}`,
            );
          } catch (err) {
            markIiziBrainConfigLoadFailed(iiziBrainRef.current);
            console.error(`[IIZI-Brain] brain_config_apply_failed_builtin_classifier_fail_open agentId=${resolvedAgentId}`, err);
          }
        })
        .catch((err) => {
          markIiziBrainConfigLoadFailed(iiziBrainRef.current);
          console.error(`[IIZI-Brain] brain_config_fetch_failed_builtin_classifier_fail_open agentId=${resolvedAgentId}`, err);
        });
    }

    upsertCall(callId, {
      twilio_call_sid: callSid || null,
      agent_id: resolvedAgentId,
      campaign_id: campaignId || null,
      // For inbound: caller is From, our number is To. For outbound: callee is To.
      to_number: callDirection === "inbound" ? (calledNumber || "unknown") : (calledNumber || "unknown"),
      from_number: callDirection === "inbound" ? (fromNumber || null) : (config.twilio.fromNumber || null),
      status: "in-progress",
      direction: callDirection,
      started_at: callStartTime.toISOString(),
    })
      .then(() => {
        if (!callId) return;
        recordIiziShadowTrace({
          callId,
          agentId: resolvedAgentId,
          iiziCombinedMode: useCombinedRegLocationSms,
          eventType: "call_started",
          payload: { direction: callDirection },
          stateRef: iiziShadowStateRef,
        });
        if (useCombinedRegLocationSms && callDirection === "inbound") {
          try {
            ingestIiziBrainFlow(iiziBrainRef.current, "call_started");
            touchIiziBrainLog("call_started");
          } catch (err) {
            console.error(`[IIZI-Brain] call_started_ingest_failed callId=${callId}`, err);
          }
        }
      })
      .catch((err) => {
        console.error(`[MediaStream] upsertCall failed (callId=${callId || "?"})`, err);
      });

    // Subscribe to inbound SMS replies for THIS call.
    // When the customer texts back during the call, inject the reply as a system message
    // into the OpenAI Realtime session so the AI can read it back / acknowledge it.
    if (callId) {
      const sb = getSupabaseRealtime();
      if (sb) {
        try {
          inboundSmsChannel = sb
            .channel(`inbound-sms-${callId}`)
            .on(
              "postgres_changes",
              {
                event: "INSERT",
                schema: "public",
                table: "sms_messages",
                filter: `call_id=eq.${callId}`,
              },
              async (payload: any) => {
                const row = payload?.new;
                if (!row || row.direction !== "inbound") return;
                const replyBody = (row.body || "").toString().slice(0, 800);
                const fromNum = row.from_number || "the customer";
                console.log(`[MediaStream] Inbound SMS received (callId=${callId}, from=${fromNum}): "${replyBody.slice(0, 80)}"`);
                transcriptLines.push(`[SMS from ${fromNum}]: ${replyBody}`);

                recordIiziShadowTrace({
                  callId,
                  agentId: resolvedAgentIdRef,
                  iiziCombinedMode: useCombinedRegLocationSms,
                  eventType: "sms_received",
                  payload: { from: String(fromNum), preview: replyBody.slice(0, 120) },
                  stateRef: iiziShadowStateRef,
                });

                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  if (iiziDeterministicInbound()) {
                    console.log(
                      `[IIZI-Deterministic] iizi_sms_received_model_response_blocked=true from="${fromNum}" ` +
                        `bodyPreview="${replyBody.slice(0, 80)}" currentState=${iiziDetRef.current.currentState} ` +
                        `callId=${callId}`,
                    );
                  } else {
                    const sysMsg = `[SYSTEM EVENT: sms_received] from="${fromNum}" body="${replyBody}". Internal note only — do NOT read this tag aloud. Acknowledge the customer's SMS content naturally in the conversation right now (for example, read any phone number or address back to confirm). Speak in the same language the call is being conducted in.`;
                    openaiWs.send(JSON.stringify({
                      type: "conversation.item.create",
                      item: {
                        type: "message",
                        role: "system",
                        content: [{ type: "input_text", text: sysMsg }],
                      },
                    }));
                    scheduleUserResponseCreate("system-event", 50);
                  }
                }
              },
            )
            .subscribe((status: string) => {
              console.log(`[MediaStream] Inbound SMS channel status (callId=${callId}): ${status}`);
            });
        } catch (err) {
          console.error(`[MediaStream] Failed to subscribe to inbound SMS:`, err);
        }

        // Subscribe to location confirmation: when the customer confirms their pin
        // on the static page, the orchestrator's /api/location/confirm endpoint sets
        // location_confirmed=true on the calls row. Inject a system message so the AI
        // reads the address back to the caller during the live conversation.
        try {
          locationConfirmChannel = sb
            .channel(`call-location-${callId}`)
            .on(
              "postgres_changes",
              {
                event: "UPDATE",
                schema: "public",
                table: "calls",
                filter: `id=eq.${callId}`,
              },
              async (payload: any) => {
                const row = payload?.new;
                const prev = payload?.old;
                if (!row) return;

                // 1. Location confirmation
                const justLocationConfirmed =
                  row.location_confirmed === true && prev?.location_confirmed !== true;
                if (justLocationConfirmed) {
                  const addr = (row.location_address || "").toString().slice(0, 300);
                  console.log(`[MediaStream] Location confirmed (callId=${callId}): "${addr}"`);
                  if (useCombinedRegLocationSms) {
                    console.log(`[IIZI-CombinedSMS] location confirmed callId=${callId}`);
                  }
                  const hasCoordinates =
                    Number.isFinite(Number(row.location_lat)) && Number.isFinite(Number(row.location_lon));
                  const hasAddress = Boolean(addr);
                  if (hasAddress || hasCoordinates) {
                    setLocationStatus("confirmed", "location_confirmed_realtime", {
                      address: addr || undefined,
                      lat: row.location_lat ?? null,
                      lon: row.location_lon ?? null,
                    });
                    console.log(
                      `[MediaStream] location_confirmed received address="${addr}" lat=${row.location_lat} lon=${row.location_lon} (callId=${callId})`
                    );
                  } else {
                    setLocationStatus("failed", "location_confirmed_realtime_missing_payload", null);
                  }
                  transcriptLines.push(`[Location confirmed]: ${addr} (${row.location_lat},${row.location_lon})`);
                  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                    if (useCombinedRegLocationSms && vehicleValidationStatus !== "valid") {
                      combinedLocationReadbackQueued = true;
                    } else if (iiziDeterministicInbound() && hasAddress) {
                      runIiziDeterministicSystemEvent({ type: "location_confirmed", address: addr });
                    } else {
                      emitLocationConfirmedSystemEvent();
                    }
                  }
                  maybeNudgeDeferredCallbackSms("location_confirmed");
                  maybeEmitDeferredOccupantPrompt();
                  recordIiziShadowTrace({
                    callId,
                    agentId: resolvedAgentIdRef,
                    iiziCombinedMode: useCombinedRegLocationSms,
                    eventType: "location_confirmed",
                    payload: {
                      address: addr,
                      lat: row.location_lat ?? null,
                      lon: row.location_lon ?? null,
                      payload_ok: hasAddress || hasCoordinates,
                    },
                    stateRef: iiziShadowStateRef,
                  });
                  if (useCombinedRegLocationSms && callDirection === "inbound") {
                    try {
                      ingestIiziBrainFlow(iiziBrainRef.current, "location_confirmed");
                      touchIiziBrainLog("location_confirmed");
                    } catch (err) {
                      console.error(`[IIZI-Brain] location_flow_failed callId=${callId}`, err);
                    }
                  }
                }

                // 2. Google Form fallback submission (registration number / callback phone)
                const justFormSubmitted =
                  row.form_submitted_at && row.form_submitted_at !== prev?.form_submitted_at;
                if (justFormSubmitted) {
                  const reg = (row.form_registration_number || "").toString().slice(0, 20);
                  const phone = (row.form_callback_phone_number || "").toString().slice(0, 20);
                  console.log(`[MediaStream] Form submitted (callId=${callId}): reg="${reg}" phone="${phone}"`);
                  recordIiziShadowTrace({
                    callId,
                    agentId: resolvedAgentIdRef,
                    iiziCombinedMode: useCombinedRegLocationSms,
                    eventType: "form_submitted",
                    payload: { reg, callback_phone: phone },
                    stateRef: iiziShadowStateRef,
                  });
                  if (useCombinedRegLocationSms && callDirection === "inbound") {
                    try {
                      ingestIiziBrainFlow(iiziBrainRef.current, "form_submitted");
                      touchIiziBrainLog("form_submitted");
                    } catch (err) {
                      console.error(`[IIZI-Brain] form_flow_failed callId=${callId}`, err);
                    }
                  }
                  if (useCombinedRegLocationSms && reg) {
                    console.log(`[IIZI-CombinedSMS] form registration received callId=${callId}`);
                  }
                  if (useCombinedRegLocationSms && callDirection === "inbound" && phone.trim()) {
                    callbackConfirmed = true;
                    callbackPending = false;
                    callbackMode = "form_callback_phone";
                    console.log(`[IIZI-Callback] confirmed via form_callback_phone callId=${callId}`);
                  }
                  transcriptLines.push(`[Form submitted]: reg=${reg} phone=${phone}`);
                  if (iiziDeterministicInbound() && reg) {
                    runIiziDeterministicSystemEvent({ type: "form_submitted" });
                  }
                  if (iiziDeterministicInbound() && phone.trim()) {
                    runIiziDeterministicSystemEvent({ type: "callback_form_received" });
                  }
                  if (openaiWs && openaiWs.readyState === WebSocket.OPEN && !iiziDeterministicInbound()) {
                    const fieldParts: string[] = [];
                    if (reg) fieldParts.push(`reg="${reg}"`);
                    if (phone) fieldParts.push(`callback_phone="${phone}"`);
                    const fields = fieldParts.join(" ");
                    const sysMsg = `[SYSTEM EVENT: form_submitted] ${fields}. Internal note only — do NOT read this tag, the brackets, or the field names aloud. The customer just submitted the form via the SMS link. Read the values back to them naturally in the same language the call is being conducted in and ask for confirmation. Then continue the conversation using these confirmed values.`;
                    openaiWs.send(JSON.stringify({
                      type: "conversation.item.create",
                      item: {
                        type: "message",
                        role: "system",
                        content: [{ type: "input_text", text: sysMsg }],
                      },
                    }));
                    scheduleUserResponseCreate("system-event", 50);

                    if (reg) {
                      const lookup = await strictLookupVehicleBySubmittedReg(reg);
                      if (lookup.match) {
                        const v = lookup.vehicle as Record<string, unknown>;
                        const vehicleEvent =
                          `[SYSTEM EVENT: vehicle_lookup_result] ` +
                          `match=true submitted_reg="${lookup.submitted_reg}" reg_no="${String(v.reg_no || "")}" ` +
                          `make="${String(v.make || "")}" model="${String(v.model || "")}" year="${String(v.year_of_built || "")}" ` +
                          `color="${String(v.color || "")}" insurer="${String(v.insurer || "")}" ` +
                          `cover_type="${String(v.cover_type || "")}" cover_status="${lookup.cover_status}" ` +
                          `coverage_invalid=${lookup.coverage_invalid}. ` +
                          `Internal note only — do NOT read tags/field names aloud. ` +
                          `If coverage_invalid=true, do NOT continue normal location/callback/partner dispatch route; ` +
                          `route to human follow-up path.`;
                        console.log(
                          `[IIZI-StrictLookup] match=true submitted_reg="${lookup.submitted_reg}" normalized_reg="${lookup.normalized_reg}" result_count=${lookup.result_count} cover_status="${lookup.cover_status}" coverage_invalid=${lookup.coverage_invalid} (callId=${callId})`
                        );
                        if (useCombinedRegLocationSms) {
                          if (lookup.coverage_invalid) {
                            vehicleValidationStatus = "invalid";
                            vehicleLookupPassed = false;
                            vehicleReadbackDone = false;
                            locationReadbackDone = false;
                            console.log(`[IIZI-CombinedSMS] vehicle invalid, blocking flow callId=${callId}`);
                          } else {
                            vehicleValidationStatus = "valid";
                            vehicleLookupPassed = true;
                            vehicleReadbackDone = false;
                            locationReadbackDone = false;
                            console.log(`[IIZI-CombinedSMS] vehicle valid, continuing callId=${callId}`);
                          }
                        }
                        if (iiziDeterministicInbound()) {
                          runIiziDeterministicSystemEvent({
                            type: "vehicle_lookup_result",
                            match: true,
                            coverageInvalid: lookup.coverage_invalid,
                          });
                        } else {
                          openaiWs.send(
                            JSON.stringify({
                              type: "conversation.item.create",
                              item: {
                                type: "message",
                                role: "system",
                                content: [{ type: "input_text", text: vehicleEvent }],
                              },
                            })
                          );
                          console.log(`[IIZI-StrictLookup] injected vehicle_lookup_result event match=true (callId=${callId})`);
                          scheduleUserResponseCreate("system-event", 50);
                        }
                        recordIiziShadowTrace({
                          callId,
                          agentId: resolvedAgentIdRef,
                          iiziCombinedMode: useCombinedRegLocationSms,
                          eventType: "vehicle_lookup_result",
                          payload: {
                            match: true,
                            coverage_invalid: lookup.coverage_invalid,
                            submitted_reg: lookup.submitted_reg,
                          },
                          stateRef: iiziShadowStateRef,
                        });
                        if (useCombinedRegLocationSms && callDirection === "inbound") {
                          try {
                            ingestIiziBrainFlow(iiziBrainRef.current, "vehicle_lookup_result", {
                              match: true,
                              coverage_invalid: lookup.coverage_invalid,
                              submitted_reg: lookup.submitted_reg,
                            });
                            touchIiziBrainLog("vehicle_lookup_match");
                          } catch (err) {
                            console.error(`[IIZI-Brain] vehicle_flow_failed callId=${callId}`, err);
                          }
                        }
                        if (
                          useCombinedRegLocationSms &&
                          !lookup.coverage_invalid &&
                          locationStatus === "confirmed" &&
                          combinedLocationReadbackQueued
                        ) {
                          if (iiziDeterministicInbound()) {
                            runIiziDeterministicSystemEvent({
                              type: "location_confirmed",
                              address: locationConfirmedValue?.address || "",
                            });
                            combinedLocationReadbackQueued = false;
                          } else {
                            const emitted = emitLocationConfirmedSystemEvent();
                            if (emitted) combinedLocationReadbackQueued = false;
                          }
                        }
                        maybeEmitDeferredOccupantPrompt();
                        maybeNudgeDeferredCallbackSms("vehicle_valid");
                      } else {
                        const vehicleEvent =
                          `[SYSTEM EVENT: vehicle_lookup_result] match=false submitted_reg="${lookup.submitted_reg}". ` +
                          `Internal note only — do NOT read tags/field names aloud. ` +
                          `Do NOT continue normal location/callback/partner route. ` +
                          `Tell the caller the vehicle was not found, that a human will contact them in 5–10 minutes, ` +
                          `and then call end_call if the tool is available. Do NOT silently hang up.`;
                        console.log(
                          `[IIZI-StrictLookup] match=false submitted_reg="${lookup.submitted_reg}" normalized_reg="${lookup.normalized_reg}" result_count=${lookup.result_count} (callId=${callId})`
                        );
                        if (useCombinedRegLocationSms) {
                          vehicleValidationStatus = "invalid";
                          vehicleLookupPassed = false;
                          vehicleReadbackDone = false;
                          locationReadbackDone = false;
                          console.log(`[IIZI-CombinedSMS] vehicle invalid, blocking flow callId=${callId}`);
                        }
                        if (iiziDeterministicInbound()) {
                          runIiziDeterministicSystemEvent({
                            type: "vehicle_lookup_result",
                            match: false,
                            coverageInvalid: false,
                          });
                        } else {
                          openaiWs.send(
                            JSON.stringify({
                              type: "conversation.item.create",
                              item: {
                                type: "message",
                                role: "system",
                                content: [{ type: "input_text", text: vehicleEvent }],
                              },
                            })
                          );
                          console.log(`[IIZI-StrictLookup] injected vehicle_lookup_result event match=false (callId=${callId})`);
                          scheduleUserResponseCreate("system-event", 50);
                        }
                        recordIiziShadowTrace({
                          callId,
                          agentId: resolvedAgentIdRef,
                          iiziCombinedMode: useCombinedRegLocationSms,
                          eventType: "vehicle_lookup_result",
                          payload: {
                            match: false,
                            submitted_reg: lookup.submitted_reg,
                          },
                          stateRef: iiziShadowStateRef,
                        });
                        if (useCombinedRegLocationSms && callDirection === "inbound") {
                          try {
                            ingestIiziBrainFlow(iiziBrainRef.current, "vehicle_lookup_result", {
                              match: false,
                              submitted_reg: lookup.submitted_reg,
                            });
                            touchIiziBrainLog("vehicle_lookup_nomatch");
                          } catch (err) {
                            console.error(`[IIZI-Brain] vehicle_flow_failed callId=${callId}`, err);
                          }
                        }
                      }
                    }
                  }
                }
              },
            )
            .subscribe((status: string) => {
              console.log(`[MediaStream] Location channel status (callId=${callId}): ${status}`);
            });
        } catch (err) {
          console.error(`[MediaStream] Failed to subscribe to location updates:`, err);
        }
      }
    }

    const url = `${OPENAI_REALTIME_URL}?model=${config.openai.realtimeModel}`;

    sessionConfigured = false;
    pendingInitialResponse = false;
    realtimeSessionUpdateFailed = false;
    vadEnabledAcknowledged = false;
    vadServerCreateResponseEnabled = false;
    initialGreetingResponseFinished = false;
    inputFramesSinceLastCommit = 0;
    lastCommittedUserItemId = null;
    responseCreateSentForItemIds.clear();
    pendingCommittedUserTurns.clear();
    framesForPendingCommit = 0;
    hasPostGreetingSpeechStarted = false;
    hasCommittedUserAudio = false;
    userAudioTurnCount = 0;
    pendingEndCall = null;
    clearEndCallHangupTimer();
    resetResponseState();
    ignoreAudioUntilNextResponse = false;
    aiIsSpeaking = false;
    inboundAudioCooldownUntil = 0;
    lastAssistantTranscript = "";
    repeatedAssistantTranscriptCount = 0;
    pendingRecoveryCooldownMs = 0;
    clearTurnDetectionEnableTimer();

    openaiWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
      },
    });

    const maybeStartInitialResponse = () => {
      if (realtimeSessionUpdateFailed) {
        console.warn(`[RealtimeGA] skipping initial response.create — session.update failed (callId=${callId})`);
        return;
      }
      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !pendingInitialResponse) {
        return;
      }

      pendingInitialResponse = false;

      const hasGreetingText = Boolean((greeting || "").trim());
      if (!useInitialGreeting || !hasGreetingText) {
        pendingInitialResponse = false;
        greetingInProgress = false;
        greetingCompletedAt = Date.now();
        console.log(
          `[GreetingGate] use_initial_greeting=${useInitialGreeting} has_greeting_text=${hasGreetingText} skip initial greeting callId=${callId}`
        );
        if (!useInitialGreeting) {
          console.log(`[GreetingGate] use_initial_greeting=false skip initial greeting callId=${callId}`);
        }
        enableTurnDetection();
        return;
      }

      console.log(`[MediaStream] Triggering initial response (callId=${callId}), greeting="${greeting || "(none)"}"`);
      if (greetingMayDiscloseDebt(greeting || "")) {
        console.warn(`[ThemisSafety] initial_greeting_may_disclose_debt callId=${callId}`);
      }

      const greetingResponse: Record<string, unknown> = {};
      if (greeting) {
        // Strict, unambiguous instructions. Past versions said "in the original language"
        // which the model interpreted loosely and would translate Estonian → English.
        greetingResponse.instructions =
          `Your one and ONLY job for this turn is to read the following greeting OUT LOUD, ` +
          `WORD-FOR-WORD, in the EXACT SAME LANGUAGE it is written in. ` +
          `Do NOT translate it. Do NOT paraphrase it. Do NOT add anything before or after it. ` +
          `Do NOT change a single word. Do NOT pronounce any punctuation, brackets, or template syntax. ` +
          `If the greeting is in Estonian, you MUST speak Estonian. If in Finnish, Finnish. If in English, English. ` +
          `\n\nGREETING TO SAY VERBATIM:\n"""\n${greeting}\n"""`;
      }
      sendResponseCreate("initial-greeting", Object.keys(greetingResponse).length > 0 ? greetingResponse : undefined);

      // Treat the initial response as speaking immediately so anti-barge-in stays active until playback is confirmed done.
      aiIsSpeaking = true;

      if (maxCallDurationMinutes > 0 && !callDurationTimer) {
        const maxMs = maxCallDurationMinutes * 60 * 1000;
        console.log(`[MediaStream] Max call duration: ${maxCallDurationMinutes}m (callId=${callId})`);
        callDurationTimer = setTimeout(() => {
          console.log(`[MediaStream] Max call duration reached, hanging up (callId=${callId})`);
          transcriptLines.push(`[System]: Call ended — max duration (${maxCallDurationMinutes}m) reached`);
          hangUpCall();
        }, maxMs);
      }

      // Don't enable VAD until Twilio confirms the greeting has actually finished playing.
      if (!greetingInProgress) {
        enableTurnDetection();
        console.log(`[MediaStream] VAD enabled immediately (interruptible greeting) (callId=${callId})`);
      }
    };

    openaiWs.on("open", () => {
      console.log(`[MediaStream] Connected to OpenAI Realtime (callId=${callId}, voice=${voice})`);
      console.log(`[Diag-OpenAI] OpenAI WS open (callId=${callId}) model=${config.openai.realtimeModel} readyState=${openaiWs?.readyState ?? "null"}`);

      // Note: do NOT bake "your first message MUST be the greeting" into the long-lived
      // session instructions — that text persists for the whole call and can cause the
      // model to keep re-greeting / repeating the same opener in a loop. The greeting is
      // injected ONCE via the initial response.create instructions instead.
      let fullInstructions = instructions;

      if (agentKnowledgeBase && agentKnowledgeBase.length > 0) {
        const kbText = agentKnowledgeBase
          .filter((item: any) => item.content && item.content.trim())
          .map((item: any) => `## ${item.name}\n${item.content}`)
          .join("\n\n");
        if (kbText) {
          fullInstructions += `\n\nKNOWLEDGE BASE — Use this information to answer questions accurately:\n\n${kbText}`;
        }
      }

      fullInstructions += `\n\nBEHAVIORAL RULES (always follow, never override):
- Maximum 1-3 sentences per response. Never give long answers.
- Stay strictly on topic. Do not improvise or add unrequested information.
- Follow the script above exactly. Do not deviate.
- If asked about something outside your scope, briefly redirect back to the topic.
- ALWAYS finish your sentence completely before stopping. Never cut off mid-word or mid-sentence.
- If the caller says "jah", "jaa", "mina olen", "jah mina olen", or repeats the target name approximately, treat identity as confirmed. Do not ask identity again unless the caller explicitly denies being the person or the answer is truly unclear.`;

      if (iiziDeterministicInbound()) {
        fullInstructions = IIZI_MINIMAL_REALTIME_PROMPT;
        console.log(
          `[IIZI-Deterministic] realtime session uses minimal prompt only (no roadside triggers in prompt) callId=${callId}`,
        );
      } else if (useCombinedRegLocationSms && callDirection === "inbound") {
        fullInstructions += `\n\nIIZI COMBINED INBOUND — HARD ORDER (follow exactly; do not improvise):
- NEVER claim or imply that an SMS was sent (e.g. do not say "saadan" / "saatsin" about the registration+location SMS) until the send_sms tool has returned success=true for that send.
- Combined registration+location SMS: send at most once using the combined template when the script allows.
- Wait in order for: roadside classification → one CRM acknowledgement if instructed → combined SMS send (after success only) → customer submits the form (SYSTEM form_submitted) → SYSTEM vehicle_lookup_result → location_confirmed for the pin/link flow.
- If vehicle_lookup_result has match=true and coverage is active/valid (coverage_invalid=false), read vehicle and insurance/coverage details aloud to the caller once, then call confirm_iizi_vehicle_readback_complete.
- Only after that, read the confirmed location address aloud once, then call confirm_iizi_location_readback_complete.
- Only after BOTH confirm tools have succeeded and occupant count is required for this case, ask exactly once: "Mitu inimest on autos koos juhiga?" — do not ask earlier and do not repeat unless the tool failed.
- Use confirm_occupant_count only after that question was asked and answered.
- Callback: default is the same incoming phone number. Ask once: "Kas tagasihelistamiseks kasutame sama numbrit, millelt praegu helistate?" If yes — call confirm_iizi_callback_same_incoming_number; do NOT send the callback SMS template. Send template "${CALLBACK_SMS_TEMPLATE_NAME}" only if the caller explicitly wants a different number; SMS success does not finalize callback — wait for form callback_phone or confirm_iizi_callback_phone_verbal.
- Do not jump to summary, handoff, or end_call until required gates in your instructions are satisfied (including callback preference finalized).`;
      }

      // Inject SMS catalog so the AI knows which named SMSes are available, when to use them, and what they say.
      const duringSmsList = smsMessages.filter((m) => m.trigger === "during");
      const afterSmsList = smsMessages.filter((m) => m.trigger === "after");
      if (duringSmsList.length > 0 || afterSmsList.length > 0) {
        let smsBlock = `\n\nAVAILABLE SMS TEMPLATES — These are the ONLY SMSes you can send. Each has a fixed name and EXACT text. You may NOT change the text. To send one, call the send_sms tool with template_name set to the exact name below. Pick the template whose "When to use" matches the current moment in the conversation.`;
        if (duringSmsList.length > 0) {
          smsBlock += `\n\nDuring-call SMSes (you choose when/whether to send each):`;
          duringSmsList.forEach((m, i) => {
            const whenToUse = m.description?.trim() ? m.description.trim() : "(no guidance — only send if obviously appropriate)";
            smsBlock += `\n${i + 1}. name="${m.name}"\n   When to use: ${whenToUse}\n   Content (sent verbatim): "${m.content}"`;
          });
        }
        if (afterSmsList.length > 0) {
          smsBlock += `\n\nAfter-call SMSes (sent automatically when the call ends, in this order — do NOT send them yourself):`;
          afterSmsList.forEach((m, i) => {
            const whenToUse = m.description?.trim() ? m.description.trim() : "(automatic post-call)";
            smsBlock += `\n${i + 1}. name="${m.name}"\n   Purpose: ${whenToUse}\n   Content: "${m.content}"`;
          });
        }
        smsBlock += `\n\nRules:\n- Pick the SMS whose "When to use" matches the moment.\n- Never invent a new SMS. Never paraphrase the content.\n- If none fit, do not send anything.\n- After the customer replies via SMS, you will receive a system message starting with "[SYSTEM EVENT: sms_received]". Treat it as an internal note (do NOT read the tag aloud) and acknowledge the SMS content naturally in the conversation (e.g. confirm a number back to them).`;
        fullInstructions += smsBlock;
      }

      const tools: any[] = [];

      if (agentTools.includes("end_call")) {
        tools.push({
          type: "function",
          name: "end_call",
          description: "End the current phone call. STRICT RULES: (1) Never call this during or immediately after the greeting. (2) Never call this before the caller has spoken at least one substantive sentence to you. (3) Only call this AFTER the caller has clearly said goodbye (e.g. 'aitäh, head aega', 'tšau', 'bye'), OR the caller explicitly asked to hang up, OR all required intake information has been collected AND you have confirmed the next step with the caller. If you are unsure, do NOT call this — keep the conversation going.",
          parameters: {
            type: "object",
            properties: {
              reason: {
                type: "string",
                description: "Brief reason for ending the call",
              },
            },
            required: ["reason"],
          },
        });
      }

      if (agentTools.includes("lookup_vehicle")) {
        tools.push({
          type: "function",
          name: "lookup_vehicle",
          description: "Look up a vehicle in the CRM. Call this ONLY when the caller has SPOKEN one of the following out loud during the live conversation: (a) a registration plate (e.g. '484DLC'), or (b) a free-text description of the car (make/model/color/year, e.g. 'must BMW 535D 2006'). DO NOT call this just because you know the caller's phone number — the system already attempted a phone-based match before connecting you. DO NOT call this during or immediately after the greeting. DO NOT call this before the caller has actually spoken to you. Returns owner name, vehicle, insurer, cover type/status. If no match, returns found:false.",
          parameters: {
            type: "object",
            properties: {
              reg_no: {
                type: "string",
                description: "Estonian registration plate the caller spoke aloud, e.g. '495BJS'. Strip spaces, uppercase. Pass even if you are not 100% sure — server does fuzzy matching.",
              },
              description: {
                type: "string",
                description: "Free-text vehicle description the caller spoke aloud, in any language (Estonian preferred), e.g. 'must BMW 535D 2006' or 'punane Saab 9-5'. Use when caller describes the car instead of giving the plate.",
              },
            },
          },
        });
      }

      if (duringSmsList.length > 0) {
        const recipientHint = callDirection === "inbound"
          ? "the caller's number is the From number of this call"
          : "the called number is the To number of this call";
        const allowedNames = duringSmsList.map((m) => `"${m.name}"`).join(", ");
        tools.push({
          type: "function",
          name: "send_sms",
          description: `Send one of the pre-configured SMS templates to the other party RIGHT NOW. The recipient is the other party on this call (${recipientHint}) — you do NOT pass a phone number. You also do NOT write the message yourself: pick one of the configured templates by its EXACT name (see AVAILABLE SMS TEMPLATES in your instructions). The server sends the template text VERBATIM. Allowed template_name values: ${allowedNames}. After it sends, briefly confirm to the caller in their language.`,
          parameters: {
            type: "object",
            properties: {
              template_name: {
                type: "string",
                enum: duringSmsList.map((m) => m.name),
                description: "Exact name of the configured SMS template to send. Must match one of the names listed in AVAILABLE SMS TEMPLATES.",
              },
            },
            required: ["template_name"],
          },
        });
      }

      tools.push({
        type: "function",
        name: "confirm_manual_location",
        description:
          "Use only after manual/verbal location fallback, and only after you have read the address back to the caller and the caller has explicitly confirmed it.",
        parameters: {
          type: "object",
          properties: {
            address: {
              type: "string",
              description: "Caller-confirmed manual address from the live voice conversation.",
            },
          },
          required: ["address"],
        },
      });

      tools.push({
        type: "function",
        name: "mark_occupant_count_required",
        description:
          "Call this immediately after classifying a case as accident, towing, stranded, auto ei käivitu, auto ei liigu, stuck, or vehicle cannot move. This marks occupant count as mandatory before the callback-preference step.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Short reason why occupant count is mandatory for this case.",
            },
          },
          required: ["reason"],
        },
      });

      tools.push({
        type: "function",
        name: "confirm_occupant_count",
        description:
          "Use only after the assistant asked exactly 'Mitu inimest on autos koos juhiga?' and the caller answered.",
        parameters: {
          type: "object",
          properties: {
            count: {
              type: "string",
              description: "Occupant count provided by the caller, including the driver.",
            },
          },
          required: ["count"],
        },
      });

      if (useCombinedRegLocationSms && callDirection === "inbound") {
        tools.push({
          type: "function",
          name: "confirm_iizi_vehicle_readback_complete",
          description:
            "Call ONCE immediately after you have spoken the vehicle and insurance/coverage details from SYSTEM vehicle_lookup_result to the caller. Requires vehicle lookup passed with valid cover and location_confirmed. Do NOT call before those conditions.",
          parameters: { type: "object", properties: {}, required: [] },
        });
        tools.push({
          type: "function",
          name: "confirm_iizi_location_readback_complete",
          description:
            "Call ONCE immediately after you have read the confirmed location address aloud. Must be called after confirm_iizi_vehicle_readback_complete when the vehicle path is valid.",
          parameters: { type: "object", properties: {}, required: [] },
        });
        tools.push({
          type: "function",
          name: "confirm_iizi_callback_same_incoming_number",
          description:
            "Call ONLY after asking the callback question and the caller confirms they want tagasihelistamine on the same number they are calling from. Does NOT send any SMS.",
          parameters: { type: "object", properties: {}, required: [] },
        });
        tools.push({
          type: "function",
          name: "confirm_iizi_callback_phone_verbal",
          description:
            "Call ONLY after the caller explicitly gives a different callback phone number by voice and confirms it (e.g. repeats it back). Use when they are not using the callback SMS form flow.",
          parameters: {
            type: "object",
            properties: {
              phone: {
                type: "string",
                description: "Callback number as confirmed with the caller (digits, may include country code).",
              },
            },
            required: ["phone"],
          },
        });
      }

      greetingTokenLimitRaised = Boolean(greeting);

      const gaTranscription = {
        model: "whisper-1",
        // Lock STT to Estonian — most callers speak ET. Mixed-language whisper
        // mangles plates like 484DLC → 484DLT, which breaks CRM lookups.
        language: "et",
        prompt: "Eesti keelne kõne. Auto registreerimismärgid on kujul kolm numbrit ja kolm tähte, näiteks 484DLC, 495BJS, 606BSB, 130XMS.",
      };
      const sessionUpdate: any = {
        type: "session.update",
        session: {
          type: "realtime",
          instructions: fullInstructions,
          output_modalities: [...REALTIME_GA_RESPONSE_MODALITIES],
          max_output_tokens: greetingTokenLimitRaised
            ? INITIAL_GREETING_MAX_RESPONSE_OUTPUT_TOKENS
            : configuredMaxResponseOutputTokens,
          audio: {
            input: buildGaAudioInput({
              transcription: gaTranscription,
              turnDetection: null,
            }),
            output: buildGaAudioOutput(voice, voiceSpeed),
          },
        },
      };

      // IMPORTANT: do NOT attach tools yet. Tools are activated only after the
      // greeting playback completes (see enableTurnDetection). This prevents the
      // model from auto-calling end_call / lookup_vehicle before the greeting,
      // which was causing inbound calls to drop with "Thank you, have a great day!".
      pendingToolsForActivation = tools;
      toolsActivated = false;

      console.log(`[RealtimeAudio] voice_speed=${voiceSpeed} callId=${callId}`);
      pendingInitialResponse = true;
      lastSessionConfigSent = {
        model: config.openai.realtimeModel,
        session_type: sessionUpdate.session.type,
        output_modalities: sessionUpdate.session.output_modalities,
        audio_input_format: REALTIME_GA_ULAW_FORMAT.type,
        audio_output_format: REALTIME_GA_ULAW_FORMAT.type,
        voice: sessionUpdate.session.audio?.output?.voice,
        voice_speed: sessionUpdate.session.audio?.output?.speed,
        turn_detection: sessionUpdate.session.audio?.input?.turn_detection,
        input_audio_transcription: sessionUpdate.session.audio?.input?.transcription,
        tools_count: tools.length,
      };
      console.log(`[GreetingGate] initial turn_detection=null toolsWithheld=true callId=${callId}`);
      console.log(`[RealtimeGA] temperature_omitted model=${config.openai.realtimeModel} callId=${callId}`);
      console.log(`[Diag-OpenAI-Config] callId=${callId} ${JSON.stringify(lastSessionConfigSent)}`);
      openaiWs!.send(JSON.stringify(sessionUpdate));
    });

    openaiWs.on("message", async (data) => {
      try {
        const event = JSON.parse(data.toString());

        switch (event.type) {
          case "session.created":
            openaiSessionCreatedAt = Date.now();
            console.log(`[Diag] OpenAI session.created (callId=${callId}) model=${config.openai.realtimeModel}`);
            break;

          case "conversation.item.created":
            conversationItemCreatedCount += 1;
            console.log(`[Diag] conversation.item.created #${conversationItemCreatedCount} itemType=${event.item?.type || "?"} role=${event.item?.role || "?"} (callId=${callId})`);
            break;

          case "session.updated":
            openaiSessionUpdatedAt = Date.now();
            if (!sessionConfigured) {
              sessionConfigured = true;
              console.log(`[Diag] OpenAI session.updated — INITIAL configured (callId=${callId}) ga=true output_modalities=audio format=audio/pcmu voice_speed=${voiceSpeed}`);
              maybeStartInitialResponse();
            } else {
              console.log(
                `[Diag] OpenAI session.updated — patch applied reason=${lastGaSessionPatchReason || "unknown"} (callId=${callId})`
              );
              if (lastGaSessionPatchReason === "post-greeting-vad-tools") {
                vadEnabledAcknowledged = true;
                console.log(`[GreetingGate] VAD enabled (session.updated ack) callId=${callId}`);
              }
            }
            break;

          case "response.created":
            if (pendingInboundRecoveryAfterCancel && event.response?.id !== pendingInboundRecoveryAfterCancel.failedResponseId) {
              clearPendingInboundRecoveryAfterCancel();
            }
            clearPendingUserResponseTimer();
            responseCreatedCount += 1;
            activeResponseId = event.response?.id || null;
            if (lastCommittedUserItemId) {
              responseCreateSentForItemIds.add(lastCommittedUserItemId);
            }
            let resolvedResponseReason = lastResponseCreateReason;
            if (
              initialGreetingResponseFinished &&
              (resolvedResponseReason === "initial-greeting" || resolvedResponseReason === "(greeting-done)")
            ) {
              resolvedResponseReason =
                pendingUserResponseReason ||
                (hasCommittedUserAudio
                  ? "committed-user-audio"
                  : hasPostGreetingSpeechStarted
                    ? "vad-auto-response"
                    : "speech-stopped");
            }
            if (callDirection === "inbound" && !greetingInProgress && resolvedResponseReason === "initial-greeting") {
              resolvedResponseReason = "inbound-auto-vad";
            }
            activeResponseReason = resolvedResponseReason;
            const runtimeUnexpectedAuto =
              runtimeOwnsPostGreetingResponses() &&
              (resolvedResponseReason === "(none)" ||
                resolvedResponseReason === "vad-auto-response" ||
                resolvedResponseReason === "speech-stopped" ||
                resolvedResponseReason === "committed-user-audio");
            if (runtimeUnexpectedAuto) {
              console.warn(
                `[TurnGate] unexpected_auto_response_created responseId=${activeResponseId || "none"} itemId=${lastCommittedUserItemId || "none"} reason=${resolvedResponseReason} callId=${callId}`
              );
            }
            if (activeResponseReason !== "initial-greeting") userResponseCreatedCount += 1;
            responsePlaybackMarkName = null;
            responseHasAudio = false;
            responseAudioDone = false;
            responseDoneReceived = false;
            responseAudioDeltaLogged = false;
            activeResponseInboundTranscriptSeq = callDirection === "inbound" && !greetingInProgress
              ? latestCompletedInboundTranscript?.seq || inboundTranscriptFallbackSeq
              : 0;
            activeResponseTwilioChunks = 0;
            activeResponseTwilioBytes = 0;
            ignoreAudioUntilNextResponse = false;
            aiIsSpeaking = true;
            lastResponseFinishReason = null;
            lastResponseOutputTokens = null;
            console.log(`[Diag] response.created #${responseCreatedCount} reason=${activeResponseReason} responseId=${activeResponseId} (callId=${callId})`);
            if (callDirection === "inbound" && activeResponseReason !== "initial-greeting") {
              console.log(`[Diag-InboundTurn] response.created seq=${activeResponseInboundTranscriptSeq} responseId=${activeResponseId} reason=${activeResponseReason} transcript="${latestCompletedInboundTranscript?.text?.slice(0, 160) || ""}" (callId=${callId})`);
              armInboundNoAudioTimer(activeResponseId, activeResponseInboundTranscriptSeq, "response.created");
            }
            break;

          case "response.cancelled":
          case "response.canceled": {
            const responseId = event.response?.id || event.response_id || null;
            if (pendingInboundRecoveryAfterCancel && (!responseId || responseId === pendingInboundRecoveryAfterCancel.failedResponseId)) {
              const pending = pendingInboundRecoveryAfterCancel;
              clearPendingInboundRecoveryAfterCancel();
              ignoreAudioUntilNextResponse = false;
              activeResponseId = null;
              responsePlaybackMarkName = null;
              responseHasAudio = false;
              responseAudioDone = false;
              responseDoneReceived = false;
              responseAudioDeltaLogged = false;
              activeResponseTwilioChunks = 0;
              activeResponseTwilioBytes = 0;
              aiIsSpeaking = false;
              console.warn(`[Diag-InboundTurn] response.cancelled received; sending recovery response seq=${pending.transcriptSeq} failedResponseId=${pending.failedResponseId || "none"} reason=${pending.reason} (callId=${callId})`);
              completeInboundTranscriptRecovery(pending.reason, pending.transcriptText, pending.transcriptSeq);
            }
            break;
          }

          case "response.audio.delta":
          case "response.output_audio.delta": {
            if (event.type === "response.audio.delta") {
              console.warn(`[Diag] OpenAI beta audio event type=${event.type} — GA expects response.output_audio.delta (callId=${callId})`);
            }
            const responseId = event.response_id || activeResponseId || null;
            if (smsPendingTemplate && responseId && responseId === activeResponseId && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
              console.warn(
                `[MediaStream] assistant_cancelled reason=sms_pending templateName="${smsPendingTemplate}" callId=${callId} responseId=${responseId}`
              );
              try {
                openaiWs.send(JSON.stringify({ type: "response.cancel" }));
              } catch (err) {
                console.error(`[MediaStream] response.cancel failed during sms_pending guard (callId=${callId}):`, err);
              }
              break;
            }
            if (ignoreAudioUntilNextResponse) {
              if (callDirection === "inbound" && activeResponseReason !== "initial-greeting") {
                console.warn(`[Diag-InboundTurn] audio.delta discarded reason=ignoreAudioUntilNextResponse responseId=${responseId || "none"} seq=${activeResponseInboundTranscriptSeq} type=${event.type} (callId=${callId})`);
              }
              break;
            }
            if (!activeResponseId || !responseId || responseId !== activeResponseId) {
              if (callDirection === "inbound" && activeResponseReason !== "initial-greeting") {
                console.warn(`[Diag-InboundTurn] audio.delta discarded reason=response_mismatch active=${activeResponseId || "none"} eventResponse=${responseId || "none"} seq=${activeResponseInboundTranscriptSeq} type=${event.type} (callId=${callId})`);
              }
              break;
            }
            const hasUsableAudioDelta = typeof event.delta === "string" && event.delta.length > 0;
            if (event.type === "response.output_audio.delta") assistantOutputAudioDeltaCount += 1;
            else assistantAudioDeltaCount += 1;
            if (hasUsableAudioDelta) responseHasAudio = true;
            if (
              hasUsableAudioDelta &&
              lastSmsToolResultAt > 0 &&
              lastLoggedSmsAudioAfterResultAt < lastSmsToolResultAt &&
              lastSmsToolResultTemplate
            ) {
              lastLoggedSmsAudioAfterResultAt = Date.now();
              console.log(
                `[MediaStream] first assistant audio after tool result template="${lastSmsToolResultTemplate}" responseId=${responseId || "none"} at=${new Date(lastLoggedSmsAudioAfterResultAt).toISOString()} (callId=${callId})`
              );
            }
            if (callDirection === "inbound" && activeResponseReason !== "initial-greeting" && !responseAudioDeltaLogged && hasUsableAudioDelta) {
              responseAudioDeltaLogged = true;
              console.log(`[Diag-InboundTurn] response.audio.delta first type=${event.type} responseId=${responseId} seq=${activeResponseInboundTranscriptSeq} hasDelta=${!!event.delta} (callId=${callId})`);
            }
            if (streamSid && twilioWs.readyState === WebSocket.OPEN && event.delta) {
              try {
                const raw = Buffer.from(event.delta, "base64");
                if (raw.length === 0) {
                  if (callDirection === "inbound" && activeResponseReason !== "initial-greeting") {
                    console.warn(`[Diag-InboundTurn] audio.delta decoded to zero bytes responseId=${responseId} seq=${activeResponseInboundTranscriptSeq} deltaLen=${event.delta.length} (callId=${callId})`);
                  }
                  break;
                }
                totalAssistantAudioBytes += raw.length;
                if (activeResponseReason !== "initial-greeting") {
                  userAssistantAudioDeltaCount += 1;
                  userAssistantAudioBytes += raw.length;
                }
                if (!firstAssistantAudioDeltaAt) {
                  firstAssistantAudioDeltaAt = new Date().toISOString();
                  console.log(`[Diag] first OpenAI audio delta type=${event.type} bytes=${raw.length} at=${firstAssistantAudioDeltaAt} (callId=${callId})`);
                }
                const FRAME = 160; // 20ms @ 8kHz mu-law
                for (let offset = 0; offset < raw.length; offset += FRAME) {
                  const chunk = raw.subarray(offset, Math.min(offset + FRAME, raw.length));
                  try {
                    twilioWs.send(JSON.stringify({
                      event: "media",
                      streamSid,
                      media: { payload: chunk.toString("base64") },
                    }));
                    twilioOutboundFrames += 1;
                    if (activeResponseReason !== "initial-greeting") userTwilioOutboundFrames += 1;
                    activeResponseTwilioChunks += 1;
                    activeResponseTwilioBytes += chunk.length;
                    if (callDirection === "inbound" && activeResponseReason !== "initial-greeting" && activeResponseTwilioChunks === 1) {
                      clearInboundTranscriptFallbackTimer();
                      clearInboundNoAudioTimer();
                      clearResponseDoneFallbackTimer();
                    }
                    if (callDirection === "inbound" && activeResponseReason !== "initial-greeting" && (activeResponseTwilioChunks <= 3 || activeResponseTwilioChunks % 25 === 0)) {
                      console.log(`[Diag-InboundTurn] twilio.media.forwarded responseId=${responseId} seq=${activeResponseInboundTranscriptSeq} chunk=${activeResponseTwilioChunks} chunkBytes=${chunk.length} responseBytes=${activeResponseTwilioBytes} totalTwilioOut=${twilioOutboundFrames} (callId=${callId})`);
                    }
                    if (!firstTwilioOutboundAt) {
                      firstTwilioOutboundAt = new Date().toISOString();
                      console.log(`[Diag] first outbound media to Twilio at=${firstTwilioOutboundAt} twilioState=${twilioWs.readyState} (callId=${callId})`);
                    }
                  } catch (sendErr) {
                    twilioOutboundSendErrors += 1;
                    console.error(`[Diag] Twilio send error (callId=${callId}, twilioState=${twilioWs.readyState}):`, sendErr);
                  }
                }
              } catch (e) {
                try {
                  twilioWs.send(JSON.stringify({
                    event: "media",
                    streamSid,
                    media: { payload: event.delta },
                  }));
                  twilioOutboundFrames += 1;
                  activeResponseTwilioChunks += 1;
                  activeResponseTwilioBytes += Buffer.byteLength(String(event.delta), "base64");
                  if (callDirection === "inbound" && activeResponseReason !== "initial-greeting" && activeResponseTwilioChunks === 1) {
                    clearInboundTranscriptFallbackTimer();
                    clearInboundNoAudioTimer();
                    clearResponseDoneFallbackTimer();
                  }
                  if (callDirection === "inbound" && activeResponseReason !== "initial-greeting") {
                    console.log(`[Diag-InboundTurn] twilio.media.forwarded fallback responseId=${responseId} seq=${activeResponseInboundTranscriptSeq} chunk=${activeResponseTwilioChunks} responseBytes=${activeResponseTwilioBytes} totalTwilioOut=${twilioOutboundFrames} (callId=${callId})`);
                  }
                  if (!firstTwilioOutboundAt) {
                    firstTwilioOutboundAt = new Date().toISOString();
                    console.log(`[Diag] first outbound media to Twilio at=${firstTwilioOutboundAt} twilioState=${twilioWs.readyState} (callId=${callId})`);
                  }
                } catch (sendErr) {
                  twilioOutboundSendErrors += 1;
                  console.error(`[Diag] Twilio send error (fallback path) (callId=${callId}):`, sendErr);
                }
              }
            } else {
              console.warn(`[Diag] Cannot forward assistant audio: streamSid=${streamSid?"set":"empty"} twilioState=${twilioWs.readyState} hasDelta=${!!event.delta} (callId=${callId})`);
            }
            break;
          }

          case "response.audio_transcript.done":
          case "response.output_audio_transcript.done": {
            if (event.type === "response.audio_transcript.done") {
              console.warn(`[Diag] OpenAI beta transcript event type=${event.type} — GA expects response.output_audio_transcript.done (callId=${callId})`);
            }
            const assistantTranscript = (event.transcript || "").toString();
            console.log(`[MediaStream] AI said (callId=${callId}): ${assistantTranscript}`);
            transcriptLines.push(`[Agent]: ${assistantTranscript}`);
            if (callDirection === "inbound" && activeResponseReason !== "initial-greeting") {
              console.log(`[Diag-InboundTurn] response.audio_transcript.done seq=${activeResponseInboundTranscriptSeq} responseId=${activeResponseId || "none"} text="${assistantTranscript.slice(0, 160)}" (callId=${callId})`);
              if (activeResponseTwilioChunks > 0) {
                clearInboundTranscriptFallbackTimer();
                clearInboundNoAudioTimer();
                clearResponseDoneFallbackTimer();
              } else if (activeResponseId) {
                console.warn(`[Diag-InboundTurn] transcript-only assistant response detected; keeping no-audio recovery armed responseId=${activeResponseId} seq=${activeResponseInboundTranscriptSeq} openaiAudio=${responseHasAudio} twilioChunks=${activeResponseTwilioChunks} (callId=${callId})`);
                armResponseDoneNoAudioGrace(
                  activeResponseId,
                  activeResponseInboundTranscriptSeq,
                  "response.audio_transcript.done-no-twilio-audio",
                  liveTurnSettings.no_audio_grace_ms
                );
              }
            }

            // Detect the model repeating itself (echo loop). If it says effectively the
            // same line twice in a row without the user speaking in between, extend the
            // post-speech cooldown so its own audio can't keep re-triggering it.
            const normalizedAssistantTranscript = normalizeTranscript(assistantTranscript);
            if (normalizedAssistantTranscript) {
              if (normalizedAssistantTranscript === lastAssistantTranscript) {
                repeatedAssistantTranscriptCount += 1;
              } else {
                lastAssistantTranscript = normalizedAssistantTranscript;
                repeatedAssistantTranscriptCount = 1;
              }

              if (repeatedAssistantTranscriptCount >= 2) {
                pendingRecoveryCooldownMs = Math.max(
                  pendingRecoveryCooldownMs,
                  liveTurnSettings.echo_recovery_cooldown_ms
                );
                console.warn(`[MediaStream] Detected repeated assistant line x${repeatedAssistantTranscriptCount}, extending echo recovery cooldown (callId=${callId})`);
              }
            }
            break;
          }

          case "conversation.item.input_audio_transcription.completed": {
            clearCallerSpeechWatchdog();
            userTranscriptCount += 1;
            const transcriptItemId = (event as { item_id?: string }).item_id || lastCommittedUserItemId || "none";
            const transcriptTextAll = String(event.transcript || "").trim();
            console.log(`[Diag] user_transcript #${userTranscriptCount} (callId=${callId}): "${event.transcript}"`);
            transcriptLines.push(`[User]: ${event.transcript}`);
            if (!transcriptTextAll) {
              console.log(`[TurnGate] ignore_empty_user_turn callId=${callId} itemId=${transcriptItemId}`);
              clearStalePendingUserTurn("empty_transcript", transcriptItemId);
              break;
            }
            const pendingTurn = pendingCommittedUserTurns.get(transcriptItemId);
            const framesForLog = pendingTurn?.framesAtCommit ?? inputFramesSinceLastCommit;
            console.log(
              `[TurnGate] valid_user_turn itemId=${transcriptItemId} transcript_len=${transcriptTextAll.length} frames=${framesForLog} callId=${callId}`
            );
            if (typeof event.transcript === "string" && event.transcript.trim().length > 0) {
              userUtteranceCount += 1;
              logUserAudioActivity("transcript", transcriptTextAll.length);
              const callerSpeechLower = event.transcript.toLowerCase();
              const matchedRoadsideTrigger = OCCUPANT_REQUIRED_ROADSIDE_TRIGGERS.find((kw) =>
                callerSpeechLower.includes(kw)
              );
              if (matchedRoadsideTrigger && !roadsideContextActive) {
                roadsideContextActive = true;
              }
              if (!incidentNeedsOccupantCount) {
                const matchedPassengerTrigger = OCCUPANT_REQUIRED_PASSENGER_TRIGGERS.find((kw) =>
                  callerSpeechLower.includes(kw)
                );
                const matchedTrigger = matchedRoadsideTrigger || (roadsideContextActive ? matchedPassengerTrigger : null);
                if (matchedTrigger) {
                  incidentNeedsOccupantCount = true;
                  occupantCountStatus = "pending";
                  console.log(
                    `[OccupantGate] required=true source=transcript reason=${matchedTrigger} callId=${callId}`
                  );
                  console.log(`[IIZI-Occupants] required reason=${matchedTrigger} source=transcript callId=${callId}`);
                  emitOccupantCountRequiredSystemEvent("transcript_trigger");
                }
              }
            }
            // Real user speech resets the repeat counter.
            lastAssistantTranscript = "";
            repeatedAssistantTranscriptCount = 0;
            pendingRecoveryCooldownMs = 0;
            if (callDirection === "inbound") {
              const fallbackSeq = ++inboundTranscriptFallbackSeq;
              const transcriptText = transcriptTextAll;
              latestCompletedInboundTranscript = { seq: fallbackSeq, text: transcriptText, at: Date.now() };
              inboundRecoveryAttemptSeq = fallbackSeq;
              inboundRecoveryAttemptsForSeq = 0;
              clearInboundTranscriptFallbackTimer();
              if (useCombinedRegLocationSms) {
                try {
                  ingestIiziBrainNonemptyUserSpeech(iiziBrainRef.current, transcriptText);
                  logIiziBrainIntentResolution(callId, iiziBrainRef.current);
                  touchIiziBrainLog("user_transcript");
                } catch (err) {
                  console.error(`[IIZI-Brain] speech_ingest_failed callId=${callId}`, err);
                }
              }
              if (iiziDeterministicInbound()) {
                runIiziDeterministicUserTranscript(transcriptText);
              }
              if (activeResponseId && !responseHasAudio && activeResponseReason !== "initial-greeting") {
                console.warn(`[Diag-InboundTurn] new user transcript while previous response has no usable audio; resetting stale response state activeResponse=${activeResponseId} seq=${fallbackSeq} previousSeq=${activeResponseInboundTranscriptSeq} (callId=${callId})`);
                clearInboundNoAudioTimer();
                clearResponseDoneFallbackTimer();
                clearMarkFallback();
                activeResponseId = null;
                responsePlaybackMarkName = null;
                responseHasAudio = false;
                responseAudioDone = false;
                responseDoneReceived = false;
                responseAudioDeltaLogged = false;
                activeResponseTwilioChunks = 0;
                activeResponseTwilioBytes = 0;
                aiIsSpeaking = false;
              }
              console.log(`[Diag-InboundTurn] transcript.completed seq=${fallbackSeq} at=${new Date(latestCompletedInboundTranscript.at).toISOString()} text="${transcriptText.slice(0, 160)}" responseCreated=${responseCreatedCount} activeResponse=${activeResponseId || "none"} (callId=${callId})`);
              inboundTranscriptFallbackTimer = setTimeout(() => {
                inboundTranscriptFallbackTimer = null;
                if (fallbackSeq !== inboundTranscriptFallbackSeq || greetingInProgress) return;
                if (activeResponseTwilioChunks > 0) return;
                if (activeResponseId) {
                  console.warn(`[Diag-InboundTurn] fallback active response has no usable Twilio audio yet; escalating seq=${fallbackSeq} activeResponse=${activeResponseId} openaiAudio=${responseHasAudio} twilioChunks=${activeResponseTwilioChunks} (callId=${callId})`);
                  triggerInboundTranscriptRecovery("inbound-transcript-fallback-active-no-audio", activeResponseId);
                  return;
                }
                console.warn(`[Diag-InboundTurn] fallback scheduled fired seq=${fallbackSeq} reason=transcript-no-response activeResponse=${activeResponseId || "none"} text="${transcriptText.slice(0, 160)}" (callId=${callId})`);
                triggerInboundTranscriptRecovery("inbound-transcript-fallback", null);
              }, liveTurnSettings.inbound_transcript_fallback_ms);
              console.log(
                `[Diag-InboundTurn] fallback scheduled seq=${fallbackSeq} timeoutMs=${liveTurnSettings.inbound_transcript_fallback_ms} text="${transcriptText.slice(0, 160)}" (callId=${callId})`
              );
            } else if (iiziDeterministicInbound()) {
              console.log(
                `[IIZI-Deterministic] skip_model_user_transcript_response=true callId=${callId} itemId=${transcriptItemId}`,
              );
            } else if (runtimeOwnsPostGreetingResponses()) {
              scheduleResponseForCommittedTurn(transcriptItemId, "transcript-ready", event.transcript);
            } else if (
              !responseCreateSentForItemIds.has(transcriptItemId) &&
              shouldManuallyScheduleResponse("user-transcript")
            ) {
              scheduleUserResponseCreate("user-transcript", 150, event.transcript);
            } else if (responseCreateSentForItemIds.has(transcriptItemId)) {
              console.log(
                `[TurnGate] response_create_deduped itemId=${transcriptItemId} existingResponseId=${activeResponseId || "none"} callId=${callId}`
              );
            }
            break;
          }

          case "response.function_call_arguments.done": {
            const fnName = event.name;
            console.log(
              `[MediaStream] Tool called: ${fnName} (callId=${callId}) argChars=${typeof event.arguments === "string" ? event.arguments.length : 0}`,
            );

            if (fnName === "end_call") {
              let reason = "Call ended by AI";
              try {
                const args = JSON.parse(event.arguments);
                reason = args.reason || reason;
              } catch {}
              if (iiziDeterministicInbound()) {
                const detState = iiziDetRef.current.currentState;
                if (!iiziDeterministicAllowsModelEndCall(detState)) {
                  console.log(
                    `[IIZI-Deterministic] iizi_model_end_call_blocked=true currentState=${detState} ` +
                      `reason=backend_not_closed callId=${callId}`,
                  );
                  openaiWs!.send(
                    JSON.stringify({
                      type: "conversation.item.create",
                      item: {
                        type: "function_call_output",
                        call_id: event.call_id,
                        output: JSON.stringify({
                          success: false,
                          error: "iizi_deterministic_backend_not_closed",
                          message:
                            "end_call is owned by the backend for this call. Wait for backend closure instructions.",
                        }),
                      },
                    }),
                  );
                  break;
                }
              }
              recordIiziShadowTrace({
                callId,
                agentId: resolvedAgentIdRef,
                iiziCombinedMode: useCombinedRegLocationSms,
                eventType: "end_call_requested",
                payload: { reason },
                stateRef: iiziShadowStateRef,
              });
              const brainBlockEnd = rejectToolIfBrainBlocks("end_call", {});
              if (brainBlockEnd) {
                openaiWs!.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: brainBlockEnd.errorCode || "brain_blocked",
                        message: brainBlockEnd.message || "end_call blocked by policy.",
                      }),
                    },
                  }),
                );
                if (brainBlockEnd.correctionSystemText) injectBrainToolCorrection(brainBlockEnd.correctionSystemText);
                const hadDeferredCallbackSms = callbackSmsRequestedWhileBlocked;
                maybeNudgeDeferredCallbackSms("end_call_brain_blocked");
                if (!hadDeferredCallbackSms) maybeEmitCallbackPreferenceRequired("end_call_blocked");
                scheduleUserResponseCreate("tool-result", 50);
                break;
              }
              if (isOccupantCountGateBlocked()) {
                console.warn(
                  `[IIZI-Occupants] blocked action=end_call reason=required_not_confirmed status=${occupantCountStatus} callId=${callId}`
                );
                openaiWs!.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({
                      success: false,
                      error: "occupant_count_required",
                      message: 'Ask exactly: "Mitu inimest on autos koos juhiga?" Do not continue until answered.',
                    }),
                  },
                }));
                emitOccupantCountRequiredSystemEvent("end_call");
                break;
              }
              if (iiziBlockedEndCallPendingCallback()) {
                console.warn(
                  `[IIZI-Callback] blocked action=end_call reason=callback_not_confirmed mode=${callbackMode} pending=${callbackPending} callId=${callId}`
                );
                openaiWs!.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({
                      success: false,
                      error: "callback_preference_incomplete",
                      message:
                        `Finalize callback preference first. Ask: "Kas tagasihelistamiseks kasutame sama numbrit, millelt praegu helistate?" ` +
                        `If same number — confirm_iizi_callback_same_incoming_number (no callback SMS). ` +
                        `If different number — send_sms "${CALLBACK_SMS_TEMPLATE_NAME}" only after they ask, then wait for form callback_phone or use confirm_iizi_callback_phone_verbal. ` +
                        `Do not end_call until callback is confirmed.`,
                    }),
                  },
                }));
                const hadDeferredCallbackSms = callbackSmsRequestedWhileBlocked;
                maybeNudgeDeferredCallbackSms("end_call_blocked");
                if (!hadDeferredCallbackSms) maybeEmitCallbackPreferenceRequired("end_call_blocked");
                scheduleUserResponseCreate("tool-result", 50);
                break;
              }

              // Guardrail: refuse end_call if it fires too soon after greeting or before
              // any real user activity. Privacy-safe wrong-person hangups may proceed after
              // greeting even when the transcript callback has not arrived yet.
              const endCallContextText = `${reason} ${typeof event.arguments === "string" ? event.arguments : ""}`;
              const wrongPersonEnd = isWrongPersonEndCallContext(endCallContextText);
              const msSinceGreeting = greetingCompletedAt ? Date.now() - greetingCompletedAt : 0;
              const tooEarly =
                !greetingCompletedAt ||
                (msSinceGreeting < MIN_MS_AFTER_GREETING_BEFORE_END_CALL && !wrongPersonEnd);
              const noUserSpeech = userUtteranceCount === 0 && !hasUserAudioActivity();
              const allowWrongPersonDespiteNoTranscript =
                wrongPersonEnd && Boolean(greetingCompletedAt) && !tooEarly;
              if ((tooEarly || noUserSpeech) && !allowWrongPersonDespiteNoTranscript) {
                console.warn(
                  `[EndCallGuard] blocked reason="${reason}" tooEarly=${tooEarly} noUserSpeech=${noUserSpeech} userAudioTurnCount=${userAudioTurnCount} userUtterances=${userUtteranceCount} msSinceGreeting=${msSinceGreeting} (callId=${callId})`
                );
                openaiWs!.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({
                      success: false,
                      error: "end_call_not_allowed_yet",
                      message: "You may NOT end the call yet. The caller has not had a real chance to speak. Stay on the line, ask them again in their language to describe the situation, and wait for their answer. Do NOT call end_call again until the caller has actually spoken and the case is fully handled.",
                    }),
                  },
                }));
                scheduleUserResponseCreate("tool-result", 50);
                break;
              }

              if (allowWrongPersonDespiteNoTranscript && userUtteranceCount === 0) {
                console.log(
                  `[EndCallGuard] allow_wrong_person_end_call despite_no_transcript=true reason="${reason}" callId=${callId}`
                );
              }

              const currentHasAudio = currentResponseHasAssistantAudio();
              const closeText = resolveEndCallCloseText(endCallContextText);
              const willSpeakClose = !currentHasAudio;
              console.log(
                `[EndCall] requested reason="${reason}" hasAudio=${currentHasAudio} willSpeakClose=${willSpeakClose} callId=${callId}`
              );
              transcriptLines.push(`[System]: Call ended — ${reason}`);

              pendingEndCall = {
                reason,
                closeText,
                closeSpeechRequired: willSpeakClose,
                closeResponseSent: false,
              };
              clearEndCallHangupTimer();

              openaiWs!.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({
                      success: true,
                      message: willSpeakClose
                        ? "Call will end after the mandatory goodbye line is spoken."
                        : "Call will end after current assistant audio finishes playing.",
                    }),
                  },
                })
              );
              // Do not schedule tool-result — it often creates a tool-only response with no audio.
            }

            if (fnName === "lookup_vehicle") {
              let args: any = {};
              try { args = JSON.parse(event.arguments || "{}"); } catch {}
              const vehicle = await crmLookup({
                phone_number: args.phone_number,
                reg_no: args.reg_no,
                description: args.description,
              });
              const output = vehicle
                ? { found: true, vehicle }
                : { found: false, message: "No vehicle found in CRM for the given details." };
              openaiWs!.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: event.call_id,
                  output: JSON.stringify(output),
                },
              }));
              scheduleUserResponseCreate("tool-result", 50);
              transcriptLines.push(`[System]: lookup_vehicle(${JSON.stringify(args)}) → ${vehicle ? vehicle.reg_no + " " + vehicle.owner_name : "not found"}`);
            }

            if (fnName === "mark_occupant_count_required") {
              let args: any = {};
              try { args = JSON.parse(event.arguments || "{}"); } catch {}
              const reason = typeof args.reason === "string" ? args.reason.trim() : "";
              const brainMark = rejectToolIfBrainBlocks("mark_occupant_count_required", {});
              if (brainMark) {
                openaiWs!.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: brainMark.errorCode || "brain_blocked",
                        message: brainMark.message || "mark_occupant_count_required blocked.",
                      }),
                    },
                  }),
                );
                if (brainMark.correctionSystemText) injectBrainToolCorrection(brainMark.correctionSystemText);
                scheduleUserResponseCreate("tool-result", 50);
              } else {
                roadsideContextActive = true;
                incidentNeedsOccupantCount = true;
                if (occupantCountStatus !== "confirmed") {
                  occupantCountStatus = "pending";
                }
                console.log(
                  `[OccupantGate] required=true source=tool reason=${reason || "unspecified"} callId=${callId}`
                );
                console.log(
                  `[IIZI-Occupants] required reason=${reason || "unspecified"} source=tool callId=${callId}`
                );
                openaiWs!.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({ success: true }),
                  },
                }));
                emitOccupantCountRequiredSystemEvent("mark_occupant_count_required");
                scheduleUserResponseCreate("tool-result", 50);
              }
            }

            if (fnName === "confirm_occupant_count") {
              let args: any = {};
              try { args = JSON.parse(event.arguments || "{}"); } catch {}
              const count = typeof args.count === "string" ? args.count.trim() : "";
              if (!count) {
                openaiWs!.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({
                      success: false,
                      error: "invalid_occupant_count",
                      message: "Occupant count is required before callback collection.",
                    }),
                  },
                }));
                scheduleUserResponseCreate("tool-result", 50);
              } else {
                const brainOcc = rejectToolIfBrainBlocks("confirm_occupant_count", { count });
                if (brainOcc) {
                  openaiWs!.send(
                    JSON.stringify({
                      type: "conversation.item.create",
                      item: {
                        type: "function_call_output",
                        call_id: event.call_id,
                        output: JSON.stringify({
                          success: false,
                          error: brainOcc.errorCode || "brain_blocked",
                          message: brainOcc.message || "confirm_occupant_count blocked.",
                        }),
                      },
                    }),
                  );
                  if (brainOcc.correctionSystemText) injectBrainToolCorrection(brainOcc.correctionSystemText);
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (
                  iiziCombinedInbound() &&
                  occupantCountStatus !== "confirmed" &&
                  !iiziCanConfirmOccupantCount()
                ) {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "occupant_gates_not_met",
                        message:
                          "Do not record occupant count yet. Wait for vehicle_lookup_result (valid cover), location_confirmed, vehicle readback, and location readback; then ask the question once.",
                      }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else {
                  incidentNeedsOccupantCount = true;
                  occupantCountStatus = "confirmed";
                  occupantCountValue = count;
                  emittedOccupantNudges.clear();
                  console.log(`[OccupantGate] confirmed count=${count} callId=${callId}`);
                  console.log(`[IIZI-Occupants] confirmed count=${count} callId=${callId}`);
                  const hadDeferredCallbackSms = callbackSmsRequestedWhileBlocked;
                  maybeNudgeDeferredCallbackSms("occupant_confirmed");
                  if (!hadDeferredCallbackSms) maybeEmitCallbackPreferenceRequired("occupant_confirmed");
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({ success: true }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                }
              }
            }

            if (fnName === "confirm_iizi_vehicle_readback_complete") {
              if (!useCombinedRegLocationSms || callDirection !== "inbound") {
                openaiWs!.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({ success: false, error: "not_iizi_combined_inbound" }),
                  },
                }));
                scheduleUserResponseCreate("tool-result", 50);
              } else {
                const brainV = rejectToolIfBrainBlocks("confirm_iizi_vehicle_readback_complete", {});
                if (brainV) {
                  openaiWs!.send(
                    JSON.stringify({
                      type: "conversation.item.create",
                      item: {
                        type: "function_call_output",
                        call_id: event.call_id,
                        output: JSON.stringify({
                          success: false,
                          error: brainV.errorCode || "brain_blocked",
                          message: brainV.message || "Vehicle readback confirm blocked.",
                        }),
                      },
                    }),
                  );
                  if (brainV.correctionSystemText) injectBrainToolCorrection(brainV.correctionSystemText);
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (!vehicleLookupPassed || vehicleValidationStatus !== "valid") {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "vehicle_not_ready",
                        message:
                          "Confirm only after SYSTEM vehicle_lookup_result shows match=true with valid cover. Speak those details to the caller first.",
                      }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (!locationConfirmedFlag || locationStatus !== "confirmed") {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "location_not_ready",
                        message: "Wait for location_confirmed=true before calling this tool.",
                      }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (vehicleReadbackDone) {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({ success: true, already_confirmed: true }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else {
                  vehicleReadbackDone = true;
                  console.log(`[IIZI-Pipeline] vehicle_readback_done callId=${callId}`);
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({ success: true }),
                    },
                  }));
                  maybeEmitDeferredOccupantPrompt();
                  maybeNudgeDeferredCallbackSms("vehicle_readback_done");
                  scheduleUserResponseCreate("tool-result", 50);
                }
              }
            }

            if (fnName === "confirm_iizi_location_readback_complete") {
              if (!useCombinedRegLocationSms || callDirection !== "inbound") {
                openaiWs!.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({ success: false, error: "not_iizi_combined_inbound" }),
                  },
                }));
                scheduleUserResponseCreate("tool-result", 50);
              } else {
                const brainLoc = rejectToolIfBrainBlocks("confirm_iizi_location_readback_complete", {});
                if (brainLoc) {
                  openaiWs!.send(
                    JSON.stringify({
                      type: "conversation.item.create",
                      item: {
                        type: "function_call_output",
                        call_id: event.call_id,
                        output: JSON.stringify({
                          success: false,
                          error: brainLoc.errorCode || "brain_blocked",
                          message: brainLoc.message || "Location readback confirm blocked.",
                        }),
                      },
                    }),
                  );
                  if (brainLoc.correctionSystemText) injectBrainToolCorrection(brainLoc.correctionSystemText);
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (!vehicleReadbackDone) {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "vehicle_readback_first",
                        message: "Call confirm_iizi_vehicle_readback_complete first after speaking vehicle/insurance details.",
                      }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (!locationConfirmedFlag || locationStatus !== "confirmed") {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "location_not_ready",
                        message: "Wait for location_confirmed and read the address aloud before this tool.",
                      }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (locationReadbackDone) {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({ success: true, already_confirmed: true }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else {
                  locationReadbackDone = true;
                  console.log(`[IIZI-Pipeline] location_readback_done callId=${callId}`);
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({ success: true }),
                    },
                  }));
                  maybeEmitDeferredOccupantPrompt();
                  const hadDeferredCallbackSmsLoc = callbackSmsRequestedWhileBlocked;
                  maybeNudgeDeferredCallbackSms("location_readback_done");
                  if (
                    (!incidentNeedsOccupantCount || occupantCountStatus === "confirmed") &&
                    !hadDeferredCallbackSmsLoc
                  ) {
                    maybeEmitCallbackPreferenceRequired("location_readback_done");
                  }
                  scheduleUserResponseCreate("tool-result", 50);
                }
              }
            }

            if (fnName === "confirm_iizi_callback_same_incoming_number") {
              if (!useCombinedRegLocationSms || callDirection !== "inbound") {
                openaiWs!.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({ success: false, error: "not_iizi_combined_inbound" }),
                  },
                }));
                scheduleUserResponseCreate("tool-result", 50);
              } else {
                const brainCbSame = rejectToolIfBrainBlocks("confirm_iizi_callback_same_incoming_number", {});
                if (brainCbSame) {
                  openaiWs!.send(
                    JSON.stringify({
                      type: "conversation.item.create",
                      item: {
                        type: "function_call_output",
                        call_id: event.call_id,
                        output: JSON.stringify({
                          success: false,
                          error: brainCbSame.errorCode || "brain_blocked",
                          message: brainCbSame.message || "Callback same-number confirm blocked.",
                        }),
                      },
                    }),
                  );
                  if (brainCbSame.correctionSystemText) injectBrainToolCorrection(brainCbSame.correctionSystemText);
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (!iiziHandoffReadyForCallbackStep()) {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "callback_gates_not_met",
                        message: "Complete vehicle/location readbacks and occupant count (if required) before confirming callback preference.",
                      }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (callbackPending) {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "callback_pending_form",
                        message: "Caller is in different-number SMS flow; wait for form callback_phone or use verbal confirmation tool.",
                      }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else {
                  callbackConfirmed = true;
                  callbackMode = "same_incoming_number";
                  callbackPending = false;
                  console.log(`[IIZI-Callback] same_incoming_number confirmed callId=${callId}`);
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({ success: true }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                }
              }
            }

            if (fnName === "confirm_iizi_callback_phone_verbal") {
              let args: any = {};
              try { args = JSON.parse(event.arguments || "{}"); } catch {}
              const phone = typeof args.phone === "string" ? args.phone.trim() : "";
              if (!useCombinedRegLocationSms || callDirection !== "inbound") {
                openaiWs!.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({ success: false, error: "not_iizi_combined_inbound" }),
                  },
                }));
                scheduleUserResponseCreate("tool-result", 50);
              } else {
                const brainVerb = rejectToolIfBrainBlocks("confirm_iizi_callback_phone_verbal", {});
                if (brainVerb) {
                  openaiWs!.send(
                    JSON.stringify({
                      type: "conversation.item.create",
                      item: {
                        type: "function_call_output",
                        call_id: event.call_id,
                        output: JSON.stringify({
                          success: false,
                          error: brainVerb.errorCode || "brain_blocked",
                          message: brainVerb.message || "Verbal callback confirm blocked.",
                        }),
                      },
                    }),
                  );
                  if (brainVerb.correctionSystemText) injectBrainToolCorrection(brainVerb.correctionSystemText);
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (!iiziHandoffReadyForCallbackStep()) {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "callback_gates_not_met",
                        message: "Complete prior steps before recording a verbal callback number.",
                      }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else if (phone.replace(/\D/g, "").length < 5) {
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "invalid_callback_phone",
                        message: "Ask again for a full phone number the caller confirms.",
                      }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                } else {
                  callbackConfirmed = true;
                  callbackMode = "verbal";
                  callbackPending = false;
                  console.log(`[IIZI-Callback] verbal phone confirmed callId=${callId}`);
                  openaiWs!.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({ success: true }),
                    },
                  }));
                  scheduleUserResponseCreate("tool-result", 50);
                }
              }
            }

            if (fnName === "send_sms") {
              let args: any = {};
              try {
                args = JSON.parse(event.arguments || "{}");
              } catch (e) {
                const errName = e instanceof Error ? e.name : "Error";
                const errMsg = e instanceof Error ? e.message : String(e);
                const argLen = typeof event.arguments === "string" ? event.arguments.length : 0;
                console.error(
                  `[MediaStream] send_sms: JSON parse failed callId=${callId} tool=send_sms error=${errName} msg=${errMsg} argChars=${argLen}`,
                );
              }
              let requestedName = typeof args.template_name === "string" ? args.template_name.trim() : "";
              if (requestedName === CALLBACK_SMS_TEMPLATE_NAME) {
                console.log(`[IIZI-CallbackSMS] requested callId=${callId}`);
              }
              if (
                useCombinedRegLocationSms &&
                (requestedName === "Registreerimisnumbri SMS" || requestedName === "Asukoha SMS")
              ) {
                console.log(`[IIZI-CombinedSMS] sending combined template callId=${callId}`);
                requestedName = COMBINED_SMS_TEMPLATE_NAME;
              }
              const recipient = callDirection === "inbound" ? fromNumber : calledNumber;

              console.log(`[MediaStream] send_sms INVOKED (callId=${callId}) requestedName="${requestedName}" callDirection=${callDirection} fromNumber="${fromNumber}" calledNumber="${calledNumber}" recipient="${recipient}" availableTemplates=[${smsMessages.map((m) => `${m.name}(${m.trigger})`).join(", ")}]`);

              // Look up the configured during-call template by exact name.
              // We NEVER use AI-supplied content — only the verbatim configured template.
              const tpl = smsMessages.find(
                (m) => m.trigger === "during" && m.name === requestedName,
              );
              if (useCombinedRegLocationSms && requestedName === COMBINED_SMS_TEMPLATE_NAME && !tpl) {
                console.error(`[IIZI-CombinedSMS] missing template callId=${callId}`);
                setSmsToolState(requestedName, "failed", "combined_template_missing");
                openaiWs!.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "combined_template_missing",
                        message: `Template "${COMBINED_SMS_TEMPLATE_NAME}" is missing. Ask a human operator to configure it before continuing.`,
                      }),
                    },
                  })
                );
                scheduleUserResponseCreate("tool-result", 50);
                break;
              }
              console.log(
                `[MediaStream] send_sms selected template requested="${requestedName}" found=${Boolean(tpl)} trigger="during" (callId=${callId})`
              );
              const brainBlockSms = rejectToolIfBrainBlocks("send_sms", { template_name: requestedName });
              if (brainBlockSms) {
                lastSmsToolResultAt = Date.now();
                lastSmsToolResultTemplate = requestedName || null;
                if (tpl) setSmsToolState(tpl.name, "failed", brainBlockSms.errorCode || "brain_blocked");
                openaiWs!.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: brainBlockSms.errorCode || "brain_blocked",
                        message: brainBlockSms.message || "SMS blocked by policy.",
                      }),
                    },
                  }),
                );
                if (brainBlockSms.correctionSystemText) injectBrainToolCorrection(brainBlockSms.correctionSystemText);
                scheduleUserResponseCreate("tool-result", 50);
                break;
              }
              if (tpl && smsSentNames.has(tpl.name)) {
                setSmsToolState(tpl.name, "already_sent", "duplicate_blocked");
                lastSmsToolResultAt = Date.now();
                lastSmsToolResultTemplate = tpl.name;
                console.warn(
                  `[MediaStream] send_sms duplicate blocked callId=${callId} template_name="${tpl.name}" sentTemplates=[${Array.from(smsSentNames).join(", ")}] twilio_send_skipped=true`
                );
                openaiWs!.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: true,
                        already_sent: true,
                        message:
                          "SMS template already sent for this call. Do not repeat the sent confirmation. Continue waiting for the caller or the relevant system event.",
                      }),
                    },
                  })
                );
                console.log(
                  `[MediaStream] function_call_output sent tool=send_sms template="${tpl.name}" success=true already_sent=true call_id=${event.call_id} (callId=${callId})`
                );
                scheduleUserResponseCreate("tool-result", 50);
                break;
              }

              if (
                requestedName === CALLBACK_SMS_TEMPLATE_NAME &&
                isOccupantCountGateBlocked()
              ) {
                callbackSmsRequestedWhileBlocked = true;
                console.warn(
                  `[IIZI-CallbackSMS] blocked reason=occupant_count_required status=${occupantCountStatus} callId=${callId}`
                );
                console.warn(
                  `[IIZI-Occupants] blocked action=callback_sms reason=required_not_confirmed status=${occupantCountStatus} callId=${callId}`
                );
                console.warn(
                  `[OccupantGate] callback blocked occupant_count_required status=${occupantCountStatus} callId=${callId}`
                );
                openaiWs!.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "occupant_count_required",
                        message:
                          "Before callback collection, ask exactly: Mitu inimest on autos koos juhiga? Then call confirm_occupant_count after the caller answers.",
                      }),
                    },
                  })
                );
                emitOccupantCountRequiredSystemEvent("callback_sms");
                scheduleUserResponseCreate("tool-result", 50);
                break;
              }

              if (
                useCombinedRegLocationSms &&
                requestedName === CALLBACK_SMS_TEMPLATE_NAME &&
                vehicleValidationStatus !== "valid"
              ) {
                callbackSmsRequestedWhileBlocked = true;
                console.warn(
                  `[IIZI-CallbackSMS] blocked reason=vehicle_not_validated status=${vehicleValidationStatus} callId=${callId}`
                );
                openaiWs!.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "vehicle_not_validated",
                        message:
                          "Vehicle is not yet validated as found and active. Wait for registration submission and strict vehicle validation before callback flow.",
                      }),
                    },
                  })
                );
                scheduleUserResponseCreate("tool-result", 50);
                break;
              }

              if (requestedName === CALLBACK_SMS_TEMPLATE_NAME && locationStatus !== "confirmed") {
                callbackSmsRequestedWhileBlocked = true;
                console.warn(
                  `[IIZI-CallbackSMS] blocked reason=location_not_confirmed status=${locationStatus} callId=${callId}`
                );
                lastSmsToolResultAt = Date.now();
                lastSmsToolResultTemplate = requestedName;
                setSmsToolState(requestedName, "failed", `location_not_confirmed:${locationStatus}`);
                console.warn(
                  `[MediaStream] callback blocked because location_not_confirmed status=${locationStatus} template="${requestedName}" (callId=${callId})`
                );
                openaiWs!.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "location_not_confirmed",
                        message:
                          "Location has not been confirmed. Do not continue to callback. Continue waiting for location confirmation or use manual location fallback.",
                      }),
                    },
                  })
                );
                console.log(
                  `[MediaStream] function_call_output sent tool=send_sms template="${requestedName}" success=false error=location_not_confirmed call_id=${event.call_id} (callId=${callId})`
                );
                scheduleUserResponseCreate("tool-result", 50);
                break;
              }

              if (
                useCombinedRegLocationSms &&
                callDirection === "inbound" &&
                tpl &&
                tpl.name === COMBINED_SMS_TEMPLATE_NAME
              ) {
                try {
                  const gate = gateIiziCombinedSms(iiziBrainRef.current);
                  touchIiziBrainLog("sms_gate_eval");
                  if (!gate.allow) {
                    console.warn(
                      `[IIZI-Brain] control=block_sms reason=${gate.reasonCode} smsGateReason=${gate.smsGateReason} callId=${callId}`
                    );
                    lastSmsToolResultAt = Date.now();
                    lastSmsToolResultTemplate = tpl.name;
                    setSmsToolState(tpl.name, "failed", gate.reasonCode);
                    openaiWs!.send(
                      JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                          type: "function_call_output",
                          call_id: event.call_id,
                          output: JSON.stringify({
                            success: false,
                            error: gate.reasonCode,
                            message: gate.message,
                          }),
                        },
                      })
                    );
                    console.log(
                      `[MediaStream] function_call_output sent tool=send_sms template="${tpl.name}" success=false error=${gate.reasonCode} call_id=${event.call_id} (callId=${callId})`
                    );
                    scheduleUserResponseCreate("tool-result", 50);
                    break;
                  }
                  console.log(`[IIZI-Brain] control=allow_sms reason=${gate.reasonCode} smsGateReason=${gate.smsGateReason} callId=${callId}`);
                } catch (gateErr) {
                  console.error(`[IIZI-Brain] sms_gate_internal_error_denying_send callId=${callId}`, gateErr);
                  lastSmsToolResultAt = Date.now();
                  lastSmsToolResultTemplate = tpl.name;
                  setSmsToolState(tpl.name, "failed", "brain_gate_error");
                  openaiWs!.send(
                    JSON.stringify({
                      type: "conversation.item.create",
                      item: {
                        type: "function_call_output",
                        call_id: event.call_id,
                        output: JSON.stringify({
                          success: false,
                          error: "brain_gate_error",
                          message: "Internal policy check failed — do NOT send roadside SMS yet; clarify caller need verbally.",
                        }),
                      },
                    })
                  );
                  scheduleUserResponseCreate("tool-result", 50);
                  break;
                }
              }

              if (tpl) {
                setSmsToolState(tpl.name, "pending", "twilio_send_started");
                smsPendingTemplate = tpl.name;
                if (useCombinedRegLocationSms && tpl.name === COMBINED_SMS_TEMPLATE_NAME) {
                  setLocationStatus("pending", "combined_sms_sent", null);
                  vehicleValidationStatus = "unknown";
                  vehicleLookupPassed = false;
                  vehicleReadbackDone = false;
                  locationReadbackDone = false;
                  iiziOccupantPromptDeferred = false;
                  emittedOccupantNudges.delete("occupant_prompt_sent");
                  callbackConfirmed = false;
                  callbackMode = "unset";
                  callbackSmsSent = false;
                  callbackPending = false;
                  emittedCallbackPreferenceNudges.clear();
                }
                if (activeResponseId && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  const responseId = activeResponseId;
                  try {
                    openaiWs.send(JSON.stringify({ type: "response.cancel" }));
                    console.warn(
                      `[MediaStream] assistant_cancelled reason=sms_pending templateName="${tpl.name}" callId=${callId} responseId=${responseId}`
                    );
                  } catch (err) {
                    console.error(`[MediaStream] response.cancel failed during send_sms pending (callId=${callId}):`, err);
                  }
                }
              }

              let result: { ok: boolean; sid?: string; error?: string; status?: string; errorCode?: number | string };
              let bodyForLog = "";
              if (!recipient) {
                result = { ok: false, error: "No recipient phone number available for this call" };
                if (requestedName) setSmsToolState(requestedName, "failed", "missing_recipient");
              } else if (!requestedName) {
                result = { ok: false, error: "template_name is required" };
              } else if (!tpl) {
                const allowed = smsMessages.filter((m) => m.trigger === "during").map((m) => m.name).join(", ");
                result = { ok: false, error: `Unknown template_name "${requestedName}". Allowed: ${allowed || "(none)"}` };
                setSmsToolState(requestedName, "failed", "unknown_template_name");
              } else {
                bodyForLog = substituteVarsRef(tpl.content);
                result = await sendSms(recipient, bodyForLog);
                if (result.ok) {
                  smsSentNames.add(tpl.name);
                  setSmsToolState(tpl.name, "sent", "twilio_send_success");
                  if (smsPendingTemplate === tpl.name) smsPendingTemplate = null;
                  if (tpl.name === CALLBACK_SMS_TEMPLATE_NAME) {
                    callbackSmsRequestedWhileBlocked = false;
                    callbackSmsSent = true;
                    callbackPending = true;
                    callbackMode = "different_number_sms";
                    console.log(`[IIZI-CallbackSMS] sent ok pending_form=true callId=${callId}`);
                  }
                  if (useCombinedRegLocationSms && tpl.name === COMBINED_SMS_TEMPLATE_NAME) {
                    console.log(`[IIZI-CombinedSMS] sent ok callId=${callId}`);
                  }
                  if (tpl.name === "Asukoha SMS") {
                    setLocationStatus("pending", "location_sms_sent", null);
                  }
                  // Persist outbound SMS so we can later correlate inbound replies to this call.
                  persistSmsMessage({
                    call_id: callId || null,
                    agent_id: resolvedAgentId,
                    template_name: tpl.name,
                    direction: "outbound",
                    from_number: config.twilio.fromNumber || "",
                    to_number: recipient,
                    body: bodyForLog,
                    twilio_sid: result.sid || null,
                    status: result.status || "sent",
                  }).catch(() => {});
                  recordIiziShadowTrace({
                    callId,
                    agentId: resolvedAgentIdRef,
                    iiziCombinedMode: useCombinedRegLocationSms,
                    eventType: "sms_sent",
                    payload: { template_name: tpl.name, twilio_sid: result.sid ?? null },
                    stateRef: iiziShadowStateRef,
                  });
                  if (useCombinedRegLocationSms && tpl.name === COMBINED_SMS_TEMPLATE_NAME && callDirection === "inbound") {
                    try {
                      ingestIiziBrainFlow(iiziBrainRef.current, "combined_sms_sent");
                      touchIiziBrainLog("combined_sms_sent");
                    } catch (err) {
                      console.error(`[IIZI-Brain] combined_sms_sent_ingest_failed callId=${callId}`, err);
                    }
                  }
                } else {
                  setSmsToolState(tpl.name, "failed", `twilio_send_failed:${result.error || result.status || "unknown"}`);
                  if (smsPendingTemplate === tpl.name) smsPendingTemplate = null;
                }
              }
              if (tpl && smsPendingTemplate === tpl.name) smsPendingTemplate = null;
              if (tpl && !result.ok && smsToolState.get(tpl.name) !== "failed") {
                setSmsToolState(tpl.name, "failed", "send_sms_validation_failed");
              }
              lastSmsToolResultAt = Date.now();
              lastSmsToolResultTemplate = tpl?.name || requestedName || null;
              console.log(`[MediaStream] send_sms RESULT template="${requestedName}" → ${recipient} ok=${result.ok} sid=${result.sid || "-"} status=${result.status || "-"} errorCode=${result.errorCode || "-"} err=${result.error || "-"} (callId=${callId})`);
              transcriptLines.push(`[System]: send_sms(template="${requestedName}", to=${recipient}, body="${(bodyForLog || "").slice(0, 80)}...") → ${result.ok ? "sent " + result.sid : "failed: " + result.error}`);
              openaiWs!.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: event.call_id,
                  output: JSON.stringify(result.ok
                    ? {
                      success: true,
                      message:
                        useCombinedRegLocationSms && requestedName === COMBINED_SMS_TEMPLATE_NAME
                          ? "Saatsin Teile tekstisõnumi. Palun avage link, sisestage auto registreerimisnumber, kinnitage asukoht ja vajutage Kinnita."
                          : `SMS template "${requestedName}" sent. Briefly confirm to the caller in their language.`,
                    }
                    : { success: false, error: result.error, instruction: `Tell the caller in their language that the SMS could not be sent right now. Do NOT claim it was sent.` }),
                },
              }));
              console.log(
                `[MediaStream] function_call_output sent tool=send_sms template="${requestedName}" success=${result.ok} call_id=${event.call_id} (callId=${callId})`
              );
              scheduleUserResponseCreate("tool-result", 50);
            }

            if (fnName === "confirm_manual_location") {
              let args: any = {};
              try {
                args = JSON.parse(event.arguments || "{}");
              } catch (e) {
                console.error(`[MediaStream] confirm_manual_location: failed to parse arguments "${event.arguments}":`, e);
              }
              const address = typeof args.address === "string" ? args.address.trim() : "";
              console.log(
                `[MediaStream] confirm_manual_location invoked address_len=${address.length} call_id=${event.call_id} (callId=${callId})`
              );
              if (address.length < 5) {
                openaiWs!.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        error: "invalid_manual_location",
                        message: "Manual location address is empty or too short. Ask the caller for a full address and confirm it.",
                      }),
                    },
                  })
                );
                console.log(
                  `[MediaStream] function_call_output sent tool=confirm_manual_location success=false error=invalid_manual_location call_id=${event.call_id} (callId=${callId})`
                );
                scheduleUserResponseCreate("tool-result", 50);
                break;
              }

              setLocationStatus("confirmed", "manual_voice_confirmed", { address });
              locationConfirmedValue = { ...(locationConfirmedValue || {}), address };

              openaiWs!.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({
                      success: true,
                      message: "Manual location confirmed.",
                    }),
                  },
                })
              );
              console.log(
                `[MediaStream] function_call_output sent tool=confirm_manual_location success=true call_id=${event.call_id} (callId=${callId})`
              );
              maybeEmitDeferredOccupantPrompt();
              maybeNudgeDeferredCallbackSms("manual_location_confirmed");
              scheduleUserResponseCreate("tool-result", 50);
            }
            break;
          }

          case "response.audio.done":
          case "response.output_audio.done": {
            const responseId = event.response_id || activeResponseId || null;
            if (!activeResponseId || !responseId || responseId !== activeResponseId) {
              break;
            }

            responseAudioDone = true;

            if (!responseHasAudio) {
              if (callDirection === "inbound" && activeResponseReason !== "initial-greeting") {
                console.warn(`[Diag-InboundTurn] response.audio.done no-audio responseId=${responseId} seq=${activeResponseInboundTranscriptSeq} activeResponseReason=${activeResponseReason} (callId=${callId})`);
                armResponseDoneNoAudioGrace(
                  responseId,
                  activeResponseInboundTranscriptSeq,
                  "response.audio.done-no-audio",
                  liveTurnSettings.no_audio_grace_ms
                );
                break;
              }
              maybeCompleteAiTurn("response.audio.done(no-audio)");
              break;
            }

            if (!responsePlaybackMarkName && streamSid && twilioWs.readyState === WebSocket.OPEN) {
              responsePlaybackMarkName = `response-playback:${responseId}:${Date.now()}`;
              console.log(`[MediaStream] Response audio complete, waiting for Twilio playback mark (callId=${callId}, responseId=${responseId}, mark=${responsePlaybackMarkName})`);
              twilioWs.send(JSON.stringify({
                event: "mark",
                streamSid,
                mark: { name: responsePlaybackMarkName },
              }));
              if (callDirection === "inbound" && activeResponseReason !== "initial-greeting") {
                console.log(`[Diag-InboundTurn] twilio.playback.mark sent mark=${responsePlaybackMarkName} responseId=${responseId} seq=${activeResponseInboundTranscriptSeq} chunks=${activeResponseTwilioChunks} bytes=${activeResponseTwilioBytes} (callId=${callId})`);
              }

              // Safety fallback: if Twilio never sends the mark back, force-complete the turn.
              // For the initial greeting this must be short; otherwise the caller's first
              // real answer after the greeting is dropped while greetingInProgress remains true.
              const markTimeoutMs = greetingInProgress ? 1800 : 10000;
              clearMarkFallback();
              markFallbackTimer = setTimeout(() => {
                if (responsePlaybackMarkName) {
                  console.warn(`[Diag-Gate] greetingPlaying timeout fallback fired=${greetingInProgress} — Twilio mark not received in ${markTimeoutMs}ms, force-completing turn (callId=${callId}, mark=${responsePlaybackMarkName})`);
                  responsePlaybackMarkName = null;
                  maybeCompleteAiTurn("mark-fallback-timeout");
                }
              }, markTimeoutMs);
            }
            break;
          }

          case "response.done": {
            const responseId = event.response?.id || activeResponseId || null;
            if (pendingInboundRecoveryAfterCancel && (!responseId || responseId === pendingInboundRecoveryAfterCancel.failedResponseId)) {
              const pending = pendingInboundRecoveryAfterCancel;
              clearPendingInboundRecoveryAfterCancel();
              ignoreAudioUntilNextResponse = false;
              activeResponseId = null;
              responsePlaybackMarkName = null;
              responseHasAudio = false;
              responseAudioDone = false;
              responseDoneReceived = false;
              responseAudioDeltaLogged = false;
              activeResponseTwilioChunks = 0;
              activeResponseTwilioBytes = 0;
              aiIsSpeaking = false;
              console.warn(`[Diag-InboundTurn] cancelled/stalled response.done received; sending recovery response seq=${pending.transcriptSeq} failedResponseId=${pending.failedResponseId || "none"} reason=${pending.reason} (callId=${callId})`);
              completeInboundTranscriptRecovery(pending.reason, pending.transcriptText, pending.transcriptSeq);
              break;
            }
            if (!activeResponseId || !responseId || responseId !== activeResponseId) {
              break;
            }

            const finishReason: string | null =
              event.response?.status_details?.reason ||
              event.response?.status_details?.type ||
              event.response?.status ||
              null;
            const outputTokens: number | null =
              typeof event.response?.usage?.output_tokens === "number"
                ? event.response.usage.output_tokens
                : null;
            lastResponseFinishReason = finishReason;
            lastResponseOutputTokens = outputTokens;

            responseDoneReceived = true;
            responseDoneCount += 1;
            console.log(
              `[Diag] response.done #${responseDoneCount} responseId=${responseId} finish=${finishReason} output_tokens=${outputTokens} hasAudio=${responseHasAudio} audioDeltas=${assistantAudioDeltaCount} (callId=${callId})`
            );
            if (callDirection === "inbound" && activeResponseReason !== "initial-greeting") {
              console.log(`[Diag-InboundTurn] response.done responseId=${responseId} seq=${activeResponseInboundTranscriptSeq} hasAudio=${responseHasAudio} twilioChunks=${activeResponseTwilioChunks} twilioBytes=${activeResponseTwilioBytes} finish=${finishReason} output_tokens=${outputTokens} (callId=${callId})`);
              if (activeResponseTwilioChunks === 0) {
                if (activeResponseReason === "tool-result" && !responseHasAudio) {
                  clearResponseDoneFallbackTimer();
                  console.log(
                    `[Diag-InboundTurn] response.done tool-result text-only — completing turn without no-audio grace (callId=${callId})`
                  );
                  maybeCompleteAiTurn("response.done-tool-text-only");
                  break;
                }
                armResponseDoneNoAudioGrace(
                  responseId,
                  activeResponseInboundTranscriptSeq,
                  "response.done-no-audio",
                  liveTurnSettings.no_audio_grace_ms
                );
                break;
              }
            }
            maybeCompleteAiTurn("response.done");
            break;
          }

          case "input_audio_buffer.speech_started":
            speechStartedCount += 1;
            callerSpeechActive = true;
            if (initialGreetingResponseFinished && !greetingInProgress) {
              hasPostGreetingSpeechStarted = true;
              logUserAudioActivity("speech_started");
            }
            console.log(`[Diag] speech_started #${speechStartedCount} (callId=${callId}) state{greeting=${greetingInProgress},aiSpeaking=${aiIsSpeaking},antiBargein=${antiBargeinEnabled}}`);
            const speechStartBlockReason = getCallerAudioBlockReason();
            if (speechStartBlockReason) {
              if (speechStartBlockReason === "greeting_playing") {
                console.log(`[GreetingGate] drop caller audio reason=greeting_playing callId=${callId}`);
              }
              console.log(`[TurnGate] drop caller audio reason=${speechStartBlockReason} source=speech_started callId=${callId}`);
              openaiWs!.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
              clearCallerSpeechWatchdog();
              break;
            }
            armCallerSpeechWatchdog("speech-started");
            console.log(`[MediaStream] Speech started (callId=${callId}, responseId=${activeResponseId})`);
            if (streamSid && twilioWs.readyState === WebSocket.OPEN && assistantPlaybackProtected()) {
              aiIsSpeaking = false;
              twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
            }
            break;

          case "input_audio_buffer.speech_stopped":
            speechStoppedCount += 1;
            callerSpeechActive = false;
            clearCallerSpeechWatchdog();
            console.log(`[Diag] speech_stopped #${speechStoppedCount} (callId=${callId})`);
            if (callDirection !== "inbound") {
              tryCommitCallerAudio("speech-stopped", 120);
            }
            break;

          case "input_audio_buffer.committed": {
            bufferCommittedCount += 1;
            const committedItemId = (event as { item_id?: string }).item_id || null;
            if (committedItemId) {
              lastCommittedUserItemId = committedItemId;
            }
            console.log(`[Diag] input_audio_buffer.committed #${bufferCommittedCount} item_id=${committedItemId || "?"} (callId=${callId})`);
            if (initialGreetingResponseFinished && committedItemId) {
              hasCommittedUserAudio = true;
              userAudioTurnCount += 1;
              logUserAudioActivity("committed", 0);
            }
            if (runtimeOwnsPostGreetingResponses() && committedItemId) {
              registerPendingCommittedTurn(committedItemId, framesForPendingCommit);
            } else if (callDirection !== "inbound" && committedItemId && !vadServerCreateResponseEnabled) {
              console.log(
                `[TurnGate] pending_user_audio_turn itemId=${committedItemId} transcript_len=0 frames=${framesForPendingCommit} callId=${callId}`
              );
              scheduleUserResponseCreate("audio-commit", 1200);
            } else if (vadServerCreateResponseEnabled && committedItemId) {
              responseCreateSentForItemIds.add(committedItemId);
            }
            break;
          }

          case "response.error":
          case "error": {
            responseErrorCount += 1;
            clearInboundTranscriptFallbackTimer();
            const errPayload = (event as { error?: { code?: string; message?: string } }).error || event;
            const errCode = (errPayload as { code?: string }).code || "(none)";
            const errMessage = (errPayload as { message?: string }).message || JSON.stringify(errPayload);
            console.error(
              `[Diag] OpenAI error #${responseErrorCount} code=${errCode} message=${errMessage} (callId=${callId}):`,
              JSON.stringify(errPayload)
            );
            const isSessionPatchRejected =
              errCode === "invalid_request_error" ||
              errCode === "missing_required_parameter" ||
              /unknown parameter.*['\"]session\./i.test(errMessage) ||
              /missing required parameter.*['\"]session\./i.test(errMessage);
            const isEmptyCommitError =
              /commit_empty|input_audio_buffer_commit_empty/i.test(errMessage) ||
              /input_audio_buffer_commit_empty/i.test(String((errPayload as { type?: string }).type || ""));

            if (isEmptyCommitError) {
              console.log(
                `[TurnGate] ignore_empty_user_turn callId=${callId} itemId=${lastCommittedUserItemId || "none"}`
              );
              clearStalePendingUserTurn("input_audio_buffer_commit_empty", lastCommittedUserItemId);
            }

            if (!sessionConfigured && !realtimeSessionUpdateFailed && isSessionPatchRejected) {
              realtimeSessionUpdateFailed = true;
              pendingInitialResponse = false;
              console.error(
                `[RealtimeGA] session.update failed — aborting, will not send response.create code=${errCode} patch=${JSON.stringify(lastGaSessionPatchForDiag)} (callId=${callId})`
              );
              transcriptLines.push(`[System]: OpenAI Realtime session configuration failed (${errCode})`);
              try {
                if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
              } catch {}
              hangUpCall();
              finalizeCall();
            } else if (sessionConfigured && isSessionPatchRejected && lastGaSessionPatchReason) {
              console.error(
                `[RealtimeGA] post-initial session.update rejected reason=${lastGaSessionPatchReason} code=${errCode} message=${errMessage} patch=${JSON.stringify(lastGaSessionPatchForDiag)} (callId=${callId})`
              );
              if (lastGaSessionPatchReason === "post-greeting-vad-tools") {
                console.error(`[GreetingGate] VAD was NOT enabled — session.update rejected (callId=${callId})`);
              }
            }
            break;
          }

          default:
            break;
        }
      } catch (err) {
        console.error("[MediaStream] Error parsing OpenAI message:", err);
      }
    });

    openaiWs.on("close", (code, reason) => {
      clearMarkFallback();
      clearTurnDetectionEnableTimer();
      clearPendingUserResponseTimer();
      clearInboundTranscriptFallbackTimer();
      clearInboundNoAudioTimer();
      clearResponseDoneFallbackTimer();
      clearPendingInboundRecoveryAfterCancel();
      clearCallerSpeechWatchdog();
      console.log(`[Diag-OpenAI] OpenAI websocket close code=${code} reason=${reason?.toString() || ""} (callId=${callId})`);
      openaiWs = null;
      finalizeCall();
    });

    openaiWs.on("error", (err) => {
      console.error(`[MediaStream] OpenAI WS error (callId=${callId}):`, err.message);
    });
  };

  // Hang up the Twilio call
  const hangUpCall = () => {
    if (!callSid || !config.twilio.isConfigured) return;

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls/${callSid}.json`;
    const authHeader = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");

    fetch(twilioUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Status: "completed" }).toString(),
    })
      .then(() => console.log(`[MediaStream] Twilio call ended (callSid=${callSid})`))
      .catch((err) => console.error(`[MediaStream] Failed to hang up:`, err));
  };

  // Save final call data to DB
  const finalizeCall = () => {
    if (!callId) return;
    if (callFinalized) return;
    callFinalized = true;

    try {
      sttShadowSession?.stop(callId);
      sttShadowSession = null;
    } catch (sttFinalizeErr) {
      console.error(`[STT] finalize_stop_failed callId=${callId}`, sttFinalizeErr);
    }

    recordIiziShadowTrace({
      callId,
      agentId: resolvedAgentIdRef,
      iiziCombinedMode: useCombinedRegLocationSms,
      eventType: "call_ended",
      payload: {},
      stateRef: iiziShadowStateRef,
    });
    if (useCombinedRegLocationSms && callDirection === "inbound") {
      try {
        ingestIiziBrainFlow(iiziBrainRef.current, "call_ended");
        touchIiziBrainLog("call_ended");
      } catch (err) {
        console.error(`[IIZI-Brain] call_end_ingest_failed callId=${callId}`, err);
      }
    }
    if (callDurationTimer) clearTimeout(callDurationTimer);
    pendingEndCall = null;
    clearEndCallHangupTimer();
    for (const turn of pendingCommittedUserTurns.values()) {
      if (turn.fallbackTimer) clearTimeout(turn.fallbackTimer);
    }
    pendingCommittedUserTurns.clear();
    clearTurnDetectionEnableTimer();
    clearPendingUserResponseTimer();
    clearInboundTranscriptFallbackTimer();
    clearInboundNoAudioTimer();
    clearResponseDoneFallbackTimer();
    clearPendingInboundRecoveryAfterCancel();
    clearCallerSpeechWatchdog();
    if (diagnosticSnapshotTimer) {
      clearInterval(diagnosticSnapshotTimer);
      diagnosticSnapshotTimer = null;
    }
    // Final diagnostic summary — single line so it's easy to grep per call.
    console.log(
      `[Diag-Final] callId=${callId} ` +
      `inFrames=${twilioInboundFrames}(fwd=${twilioInboundFramesForwarded},dropG=${twilioInboundFramesDropGreeting},dropC=${twilioInboundFramesDropCooldown},dropAB=${twilioInboundFramesDropAntiBargein},postGreeting=${twilioInboundFramesAfterGreeting}) ` +
      `vad{started=${speechStartedCount},stopped=${speechStoppedCount},committed=${bufferCommittedCount},transcripts=${userTranscriptCount}} ` +
      `items{created=${conversationItemCreatedCount}} ` +
      `resp{createSent=${responseCreateSentCount},created=${responseCreatedCount},done=${responseDoneCount},err=${responseErrorCount},active=${activeResponseId || "none"}} ` +
      `audio{response.audio.delta=${assistantAudioDeltaCount},response.output_audio.delta=${assistantOutputAudioDeltaCount},firstDeltaAt=${firstAssistantAudioDeltaAt || "none"},bytes=${totalAssistantAudioBytes},twilioOut=${twilioOutboundFrames},firstTwilioOutAt=${firstTwilioOutboundAt || "none"},sendErr=${twilioOutboundSendErrors}} ` +
      `twilio{start=${twilioStartReceived},stop=${twilioStopReceived},greetingMark=${twilioGreetingMarkReceived},firstCallerMediaAfterGreetingAt=${firstCallerMediaAfterGreetingAt || "none"}} ` +
      `session{created=${openaiSessionCreatedAt?"yes":"no"},updated=${openaiSessionUpdatedAt?"yes":"no"},config=${lastSessionConfigSent ? JSON.stringify(lastSessionConfigSent) : "none"}} ` +
      diagState() + ` break="${diagnoseBreakPoint()}"`
    );

    // Stop listening for inbound SMS replies for this call
    if (inboundSmsChannel) {
      try {
        inboundSmsChannel.unsubscribe();
      } catch {}
      inboundSmsChannel = null;
    }
    if (locationConfirmChannel) {
      try {
        locationConfirmChannel.unsubscribe();
      } catch {}
      locationConfirmChannel = null;
    }

    const endTime = new Date();
    const durationSeconds = callStartTime
      ? Math.round((endTime.getTime() - callStartTime.getTime()) / 1000)
      : null;

    const transcript = transcriptLines.length > 0 ? transcriptLines.join("\n") : null;

    console.log(`[MediaStream] Finalizing call (callId=${callId}), duration=${durationSeconds}s, transcript lines=${transcriptLines.length}`);

    updateCall(callId, {
      status: "completed",
      ended_at: endTime.toISOString(),
      duration_seconds: durationSeconds,
      transcript,
    });

    // Run post-call analysis if we have a transcript and analysis prompt
    if (transcript && agentAnalysisPrompt) {
      runPostCallAnalysis(callId, transcript, agentAnalysisPrompt);
    }

    // Post-call SMSes — send every "after" template in chronological (configured) order.
    // Skip a template if its name was already sent mid-call (avoids duplicates).
    const afterList = smsMessages.filter((m) => m.trigger === "after");
    if (afterList.length > 0) {
      const recipient = callDirection === "inbound" ? fromNumber : calledNumber;
      if (!recipient) {
        console.warn(`[MediaStream] Post-call SMS skipped: no recipient (callId=${callId})`);
      } else {
        // Send sequentially so they arrive in configured order.
        (async () => {
          for (const m of afterList) {
            if (smsSentNames.has(m.name)) {
              console.log(`[MediaStream] Post-call SMS "${m.name}" skipped (already sent during call) (callId=${callId})`);
              continue;
            }
            const body = substituteVarsRef(m.content);
            const r = await sendSms(recipient, body);
            console.log(`[MediaStream] Post-call SMS "${m.name}" → ${recipient} ok=${r.ok} sid=${r.sid || "-"} err=${r.error || "-"} (callId=${callId})`);
            if (r.ok) {
              smsSentNames.add(m.name);
              persistSmsMessage({
                call_id: callId || null,
                agent_id: resolvedAgentIdRef,
                template_name: m.name,
                direction: "outbound",
                from_number: config.twilio.fromNumber || "",
                to_number: recipient,
                body,
                twilio_sid: r.sid || null,
                status: "sent",
              }).catch(() => {});
            }
          }
        })().catch((err) => console.error(`[MediaStream] Post-call SMS loop error:`, err));
      }
    }
  };

  // Handle messages from Twilio
  twilioWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "connected":
          console.log("[MediaStream] Twilio stream connected");
          break;

        case "start":
          twilioStartReceived = true;
          streamSid = msg.start.streamSid;
          callId = msg.start.customParameters?.callId || "";
          agentId = msg.start.customParameters?.agentId || "";
          calledNumber = msg.start.customParameters?.calledNumber || "";
          fromNumber = msg.start.customParameters?.fromNumber || "";
          callDirection = (msg.start.customParameters?.direction === "inbound" ? "inbound" : "outbound");
          callSid = msg.start.customParameters?.callSid || "";
          campaignId = msg.start.customParameters?.campaignId || "";
          bridgeSelfTest = msg.start.customParameters?.bridgeSelfTest || "";
          logCallDeploymentIdentity();
          // Parse call variables
          const varsParam = msg.start.customParameters?.variables || "";
          if (varsParam) {
            try {
              callVariables = JSON.parse(varsParam);
              console.log(`[MediaStream] Parsed ${Object.keys(callVariables).length} call variables (callId=${callId})`);
            } catch (e) {
              console.warn(`[MediaStream] Failed to parse variables param (callId=${callId})`);
            }
          }
          console.log(`[Diag-Twilio] twilio.start received callId=${callId} streamSid=${streamSid} agentId=${agentId || "(resolve-by-number)"} callSid=${callSid} direction=${callDirection} bridgeSelfTest=${bridgeSelfTest || "none"}`);

          // Periodic diagnostic snapshot — proves end-to-end media flow.
          diagnosticSnapshotTimer = setInterval(() => {
            console.log(
              `[Diag-Snapshot] callId=${callId} ` +
              `inFrames=${twilioInboundFrames}(fwd=${twilioInboundFramesForwarded},dropG=${twilioInboundFramesDropGreeting},dropC=${twilioInboundFramesDropCooldown},dropAB=${twilioInboundFramesDropAntiBargein},postGreeting=${twilioInboundFramesAfterGreeting}) ` +
              `vad{started=${speechStartedCount},stopped=${speechStoppedCount},committed=${bufferCommittedCount},transcripts=${userTranscriptCount}} ` +
              `resp{created=${responseCreatedCount},done=${responseDoneCount},sent=${responseCreateSentCount},err=${responseErrorCount}} ` +
              `audio{response.audio.delta=${assistantAudioDeltaCount},response.output_audio.delta=${assistantOutputAudioDeltaCount},bytes=${totalAssistantAudioBytes},twilioOut=${twilioOutboundFrames},sendErr=${twilioOutboundSendErrors}} ` +
              diagState() + ` sessionCfg=${sessionConfigured} cooldownLeftMs=${Math.max(0, inboundAudioCooldownUntil - Date.now())}`
            );
          }, 5000);

          connectToOpenAI();
          try {
            const sttBrainHooks: SttShadowBrainHooks = {
              onDeepgramFinal: ({ callId: sttCallId, text }) => {
                try {
                  if (!useCombinedRegLocationSms || callDirection !== "inbound") return;
                  const shadowIngest = ingestIiziBrainTrustedShadowFinal(iiziBrainRef.current, "deepgram", text);
                  if (shadowIngest.shouldLogIntentResolution) {
                    logIiziBrainIntentResolution(sttCallId || callId || null, iiziBrainRef.current);
                  }
                  const snap = evaluateIiziBrain(iiziBrainRef.current, true);
                  logIiziBrainTrustedShadowTranscript(sttCallId || callId || null, "deepgram", text, snap);
                } catch (brainShadowErr) {
                  console.error(
                    `[IIZI-Brain] trusted_shadow_ingest_failed callId=${sttCallId || callId || "?"}`,
                    brainShadowErr,
                  );
                }
              },
            };
            sttShadowSession = createSttShadowSession(callId || "", sttBrainHooks);
            sttShadowSession.start(callId || "");
          } catch (sttAttachErr) {
            console.error(`[STT] attach_failed`, sttAttachErr);
          }
          break;

        case "media":
          twilioInboundFrames += 1;
          const mediaBlockReason = getCallerAudioBlockReason();
          if (mediaBlockReason) {
            if (mediaBlockReason === "greeting_uninterruptible") twilioInboundFramesDropGreeting += 1;
            if (mediaBlockReason === "post_playback_cooldown") twilioInboundFramesDropCooldown += 1;
            if (mediaBlockReason === "assistant_speaking") twilioInboundFramesDropAntiBargein += 1;
            turnGateDropCounts[mediaBlockReason] = (turnGateDropCounts[mediaBlockReason] || 0) + 1;
            const dropCount = turnGateDropCounts[mediaBlockReason];
            if (dropCount === 1 || dropCount % 25 === 0) {
              if (mediaBlockReason === "greeting_playing") {
                console.log(`[GreetingGate] drop caller audio reason=greeting_playing frame=${twilioInboundFrames} callId=${callId}`);
              }
              console.log(`[TurnGate] drop caller audio reason=${mediaBlockReason} count=${dropCount} callId=${callId}`);
            }
            break;
          }
          twilioInboundFramesAfterGreeting += 1;
          if (!firstInboundAudioAfterGreetingLogged) {
            firstInboundAudioAfterGreetingLogged = true;
            firstCallerMediaAfterGreetingAt = new Date().toISOString();
            const sinceGreeting = greetingCompletedAt ? Date.now() - greetingCompletedAt : -1;
            console.log(`[Diag-Twilio] first caller media timestamp after greeting=${firstCallerMediaAfterGreetingAt} msSinceGreetingComplete=${sinceGreeting} totalSinceStart=${twilioInboundFrames} (callId=${callId})`);
            sendTwilioBridgeSelfTestTone("first-caller-media-after-greeting");
          }
          if (greetingCompletedAt && Date.now() - greetingCompletedAt <= 5000) {
            console.log(`[Diag-Gate] caller media within first 5s after greeting frame=${twilioInboundFramesAfterGreeting} callId=${callId} ${diagState()}`);
          }
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN && sessionConfigured) {
            turnGateAcceptedFrames += 1;
            lastAcceptedCallerAudioAt = Date.now();
            if (turnGateAcceptedFrames === 1 || turnGateAcceptedFrames % 50 === 0) {
              console.log(`[TurnGate] accept caller audio reason=gate_open count=${turnGateAcceptedFrames} callId=${callId}`);
            }
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload,
            }));
            inputFramesSinceLastCommit += 1;
            twilioInboundFramesForwarded += 1;
            try {
              sttShadowSession?.sendAudioFrameBase64(msg.media?.payload ?? "");
            } catch (sttFwdErr) {
              console.error(`[STT] forward_frame_failed callId=${callId}`, sttFwdErr);
            }
            if (!firstInboundAudioForwardedToOpenAiAt) {
              firstInboundAudioForwardedToOpenAiAt = new Date().toISOString();
              console.log(
                `[Diag] first inbound audio forwarded to OpenAI at=${firstInboundAudioForwardedToOpenAiAt} payloadB64Len=${msg.media?.payload?.length || 0} (callId=${callId})`
              );
            }
          } else if (twilioInboundFrames % 50 === 0) {
            console.warn(`[Diag] Cannot forward inbound media: openaiState=${openaiWs?.readyState ?? "null"} sessionConfigured=${sessionConfigured} (callId=${callId})`);
          }
          break;

        case "mark": {
          const markName = msg.mark?.name || "";
          if (markName && responsePlaybackMarkName && markName === responsePlaybackMarkName) {
            if (greetingInProgress) twilioGreetingMarkReceived = true;
            console.log(`[Diag-Twilio] twilio.mark greeting received=${greetingInProgress ? "yes" : "no"} mark=${markName} (callId=${callId})`);
            if (callDirection === "inbound" && !greetingInProgress) {
              console.log(`[Diag-InboundTurn] twilio.playback.mark received mark=${markName} responseId=${activeResponseId || "none"} seq=${activeResponseInboundTranscriptSeq} chunks=${activeResponseTwilioChunks} bytes=${activeResponseTwilioBytes} (callId=${callId})`);
            }
            clearMarkFallback();
            responsePlaybackMarkName = null;
            maybeCompleteAiTurn("twilio.mark");
          }
          break;
        }

        case "stop":
          twilioStopReceived = true;
          console.log(`[Diag-Twilio] twilio.stop received (callId=${callId})`);
          try {
            sttShadowSession?.stop(callId);
            sttShadowSession = null;
          } catch (sttStopErr) {
            console.error(`[STT] twilio_stop_failed callId=${callId}`, sttStopErr);
          }
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          break;

        default:
          break;
      }
    } catch (err) {
      console.error("[MediaStream] Error parsing Twilio message:", err);
    }
  });

  twilioWs.on("close", (code, reason) => {
    console.log(`[Diag-Twilio] Twilio websocket close code=${code} reason=${reason?.toString() || ""} (callId=${callId})`);
    try {
      sttShadowSession?.stop(callId);
      sttShadowSession = null;
    } catch (sttCloseErr) {
      console.error(`[STT] twilio_ws_close_failed callId=${callId}`, sttCloseErr);
    }
    clearInboundTranscriptFallbackTimer();
    clearInboundNoAudioTimer();
    clearResponseDoneFallbackTimer();
    clearPendingInboundRecoveryAfterCancel();
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    } else {
      finalizeCall();
    }
  });

  twilioWs.on("error", (err) => {
    console.error(`[MediaStream] Twilio WS error (callId=${callId}):`, err.message);
  });
}
