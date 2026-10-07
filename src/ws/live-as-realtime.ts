/**
 * 5331 Phase-E: wire-level adapter that presents the OpenAI GPT-Live WebSocket
 * (wss://api.openai.com/v1/live/sessions) behind the event surface src/ws/media-stream.ts
 * already consumes.
 *
 * DESIGN — per the official GPT-Live docs (Henri-reviewed 2026-10-07):
 *
 * - response.create is NOT a voice/speak trigger. It starts/continues DELEGATED Responses
 *   backend work only. media-stream's response.create (greeting) is ABSORBED.
 * - The spoken greeting is injected ONCE after session.started via
 *   session.instructions.append { delegation_id: null, content } — ACK = the
 *   session.instructions.appended event.
 * - Caller audio must keep flowing at all times (full duplex). media-stream's greeting
 *   gate is bypassed in live mode; the adapter forwards every input frame verbatim.
 * - Success signals are the Live event set: session.started, session.instructions.appended,
 *   session.input_transcript.delta, session.output_transcript.delta,
 *   session.output_audio.delta, session.usage.updated, session.closed, error.
 *   Realtime per-response done events do not exist in Live — playback completion is tracked
 *   by the Twilio output queue (media-stream mark logic).
 * - Delegation is mandatory for response.create: session.start always carries
 *   delegation { type: "responses", responses: { model, instructions, tool_choice, tools? } }.
 * - Voice frontend instructions stay SHORT (session.instructions); business logic lives in
 *   delegation.responses.instructions.
 * - speed: GPT-Live has no session.audio.output.speed — dropped with a one-time notice.
 */
import { WebSocket, type RawData } from "ws";

const LIVE_WS_URL = "wss://api.openai.com/v1/live/sessions";

export interface LiveAsRealtimeOptions {
  apiKey: string;
  model: string; // gpt-live-1
  /**
   * session.instructions — SHORT voice frontend prompt (identity/language/tone/pace/
   * interruption + delegation policy). Do NOT put the full business prompt here.
   */
  sessionConfig: {
    instructions?: string;
    voice?: string;
    tools?: unknown[];
    /** Detailed business logic — goes to delegation.responses.instructions. */
    backendInstructions?: string;
    /** The agent's spoken greeting text; used to build the greeting append content. */
    greetingText?: string;
    /**
     * Explicit greeting append content override (controlled technical test). When set it
     * replaces the greetingText-derived content. Set via env OPENAI_LIVE_GREETING_APPEND.
     */
    greetingAppendContent?: string;
  };
  /** Responses-delegation backend model. Live REQUIRES delegation for response.create. */
  backendModel?: string;
  logger?: (msg: string) => void;
}

type PendingMessage = string;

export class LiveAsRealtimeSocket {
  private ws: WebSocket;
  private log: (msg: string) => void;
  private sessionStarted = false;
  private readonly pendingBeforeStart: PendingMessage[] = [];
  private speedWarned = false;
  /** Outer response id synthesized for media-stream bookkeeping (Realtime-style). */
  private currentResponseId: string | null = null;
  /** Accumulated assistant text from nested delegation output_text deltas. */
  private outputText = "";
  /** Call-id → function name cache from nested output_item.done events. */
  private pendingFunctionCalls = new Map<string, string>();
  private opts: LiveAsRealtimeOptions | null = null;

  // ---- Live event-flow metrics (for acceptance evidence, logged to Railway) ----
  private liveSessionId: string | null = null;
  private inputAppends = 0;
  private inputBytes = 0;
  private outputAudioDeltas = 0;
  private outputAudioBytes = 0;
  private outputTranscriptDeltas = 0;
  private inputTranscriptDeltas = 0;
  private greetingAppendSent = false;
  private greetingAppendAck = false;
  private delegationCreated = 0;
  private responseEvents = 0;
  private errorCount = 0;

  /** Mirror of the WebSocket surface media-stream.ts uses. */
  public readyState: number = WebSocket.CONNECTING;
  public readonly OPEN = WebSocket.OPEN;

  private messageHandler: ((data: WebSocket.Data) => void) | null = null;
  private openHandler: (() => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((err: unknown) => void) | null = null;

  constructor(opts: LiveAsRealtimeOptions) {
    this.log = opts.logger ?? (() => {});
    this.opts = opts;
    this.ws = new WebSocket(LIVE_WS_URL, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });
    this.syncReadyState();

    this.ws.on("open", () => {
      this.syncReadyState();
      // session.start is DEFERRED until configure() provides the real prompts (the OpenAI WS
      // opens before the async agent-config load completes; sending empty instructions first
      // is not correct — session config is fixed at start).
      if (this.hasRealConfig(opts)) this.sendSessionStart(opts);
      this.openHandler?.();
    });
    this.ws.on("message", (data: RawData) => this.onLiveMessage(data));
    this.ws.on("close", () => {
      this.syncReadyState();
      this.closeHandler?.();
    });
    this.ws.on("error", (err) => {
      this.errorCount += 1;
      this.errorHandler?.(err);
    });
  }

  on(event: "message", cb: (data: WebSocket.Data) => void): void;
  on(event: "open", cb: () => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  on(event: string, cb: (...args: never[]) => void): void {
    if (event === "message") this.messageHandler = cb as typeof this.messageHandler;
    else if (event === "open") this.openHandler = cb as typeof this.openHandler;
    else if (event === "close") this.closeHandler = cb as typeof this.closeHandler;
    else if (event === "error") this.errorHandler = cb as typeof this.errorHandler;
  }

  /** Same surface as WebSocket.send(json-string). Translates Realtime → GPT-Live. */
  send(raw: PendingMessage): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // non-JSON is never sent by media-stream
    }
    const type = String(msg.type || "");

    if (!this.sessionStarted) {
      // Buffer everything until session.started (the adapter sends session.start on open).
      this.pendingBeforeStart.push(raw);
      return;
    }

    switch (type) {
      case "session.update": {
        // Initial session config was applied via session.start. Live manages turns natively;
        // VAD patches are meaningless. Late tool activation (post-greeting) is forwarded as a
        // delegation tools update. speed is not supported — dropped with a one-time notice.
        const session = (msg.session || {}) as Record<string, unknown>;
        const audio = (session.audio || {}) as Record<string, unknown>;
        const output = (audio.output || {}) as Record<string, unknown>;
        if (output.speed !== undefined && !this.speedWarned) {
          this.speedWarned = true;
          this.log(
            `session.audio.output.speed not supported by GPT-Live — dropped; pacing via agent prompt (GPT_LIVE_EXPLICIT_SPEED_SUPPORTED=NO)`,
          );
        }
        if (Array.isArray(session.tools) && session.tools.length > 0) {
          this.rawSend({
            type: "session.update",
            event_id: `bridge_tools_${Date.now()}`,
            session: {
              delegation: {
                type: "responses",
                responses: { tools: session.tools, tool_choice: "auto" },
              },
            },
          });
        }
        this.emitTranslated({ type: "session.updated" });
        break;
      }
      case "response.create": {
        // NOT a speak trigger in GPT-Live. Greeting injection happens via the ONE
        // session.instructions.append sent right after session.started (with the configured
        // greeting content). Delegated-backend work is started by Live itself / delegation
        // policy, not by this client event.
        break;
      }
      case "input_audio_buffer.append": {
        // Twilio PCMU payload forwarded DIRECTLY (no conversion, ordered, continuous —
        // full duplex: caller audio is never suppressed in live mode).
        this.rawSend({
          type: "session.input_audio.append",
          event_id: `bridge_in_${Date.now()}`,
          audio: msg.audio,
        });
        this.inputAppends += 1;
        if (typeof msg.audio === "string") this.inputBytes += msg.audio.length;
        if (this.inputAppends % 100 === 0) this.logMetrics("input_progress");
        break;
      }
      case "input_audio_buffer.commit":
      case "input_audio_buffer.clear":
        // GPT-Live manages turns continuously; no manual commit/clear exists.
        break;
      case "response.cancel":
        // Live has no client-driven response cancel; turn management is model-owned.
        break;
      case "conversation.item.create": {
        const item = (msg.item || {}) as Record<string, unknown>;
        this.rawSend({
          type: "response.item.create",
          event_id: `bridge_item_${Date.now()}`,
          item,
        });
        break;
      }
      case "function_call_output": {
        // Normalize to the Responses item form Live expects.
        this.rawSend({
          type: "response.item.create",
          event_id: `bridge_fnout_${Date.now()}`,
          item: {
            type: "function_call_output",
            call_id: msg.call_id,
            output: msg.output,
          },
        });
        break;
      }
      case "session.close":
        this.rawSend({ type: "session.close", event_id: `bridge_close_${Date.now()}` });
        break;
      default:
        // Unknown Realtime types are forwarded verbatim (Live rejects unsupported ones and
        // the error surfaces through the same channel).
        this.rawSend(msg);
    }
  }

  /** Same surface as WebSocket.close(). */
  close(): void {
    try {
      this.rawSend({ type: "session.close", event_id: `bridge_close_final_${Date.now()}` });
    } catch {
      /* socket may already be dead */
    }
    // Keep the socket until session.closed drains (media-stream's ws-close path handles it).
    setTimeout(() => {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
    }, 3000);
  }

  /** Attach the real session config (called by media-stream once agent prompts are loaded). */
  configure(opts: LiveAsRealtimeOptions): void {
    this.opts = opts;
    if (this.startSent) return;
    if (this.hasRealConfig(opts)) {
      this.sendSessionStart(opts); // fixed-at-start config: short frontend + backend split
    }
  }

  // ---------------------------------------------------------------- internals

  private startSent = false;
  private hasRealConfig(opts: LiveAsRealtimeOptions): boolean {
    // Real prompts loaded when the frontend instructions are non-empty (the agent prompt
    // resolved) — session config is FIXED at start so never send placeholders.
    return Boolean((opts.sessionConfig.instructions || "").trim());
  }

  private buildGreetingAppendContent(): string {
    const override = process.env.OPENAI_LIVE_GREETING_APPEND;
    if (override && override.trim()) return override.trim();
    const greeting = (this.opts?.sessionConfig.greetingText || "").trim();
    if (greeting) {
      return `Alusta kohe eesti keeles. Ütle sõna-sõnalt: "${greeting}" Seejärel peatu ja kuula.`;
    }
    return "Alusta kohe eesti keeles. Tervita helistajat nüüd, seejärel peatu ja kuula.";
  }

  private sendSessionStart(opts: LiveAsRealtimeOptions): void {
    if (this.startSent) return;
    this.startSent = true;
    const session: Record<string, unknown> = {
      model: opts.model,
      // SHORT voice frontend (identity/language/tone/pace/interruption/delegation policy).
      instructions: opts.sessionConfig.instructions || "",
      audio: {
        format: { type: "audio/pcmu", rate: 8000 },
        output: { voice: opts.sessionConfig.voice || "ash" },
      },
      // Delegation is mandatory for response.create; business logic rides the backend.
      delegation: {
        type: "responses",
        responses: {
          model: opts.backendModel || process.env.OPENAI_LIVE_BACKEND_MODEL || "gpt-6-luna",
          ...(opts.sessionConfig.backendInstructions
            ? { instructions: opts.sessionConfig.backendInstructions }
            : {}),
          tool_choice: "auto",
          parallel_tool_calls: false,
          ...(Array.isArray(opts.sessionConfig.tools) && opts.sessionConfig.tools.length > 0
            ? { tools: opts.sessionConfig.tools }
            : {}),
        },
      },
    };
    this.rawSend({ type: "session.start", event_id: `bridge_start_${Date.now()}`, session });
  }

  private sendGreetingAppendOnce(): void {
    if (this.greetingAppendSent) return;
    this.greetingAppendSent = true;
    this.rawSend({
      type: "session.instructions.append",
      event_id: "themis_initial_greeting",
      delegation_id: null,
      content: this.buildGreetingAppendContent(),
    });
    this.log(`greeting append sent (content len=${this.buildGreetingAppendContent().length})`);
    this.logMetrics("greeting_append_sent");
  }

  private onLiveMessage(data: RawData): void {
    let msg: Record<string, unknown>;
    try {
      const s = typeof data === "string" ? data : data.toString();
      msg = JSON.parse(s);
    } catch {
      return;
    }
    const type = String(msg.type || "");
    this.syncReadyState();

    switch (type) {
      case "session.started": {
        this.sessionStarted = true;
        const sess = (msg.session || {}) as Record<string, unknown>;
        this.liveSessionId = String(sess.id || msg.session_id || "") || null;
        // Flush buffered Realtime messages (session.update etc.) — order preserved.
        const buffered = this.pendingBeforeStart.splice(0);
        this.emitTranslated({
          type: "session.updated",
          session: sess,
        });
        for (const raw of buffered) this.send(raw);
        // Official greeting path: ONE session.instructions.append with delegation_id null.
        this.sendGreetingAppendOnce();
        break;
      }
      case "session.instructions.appended": {
        this.greetingAppendAck = true;
        this.log(`greeting append ACK (session.instructions.appended)`);
        this.logMetrics("greeting_append_acked");
        this.emitTranslated(msg);
        break;
      }
      case "session.delegation.created": {
        this.delegationCreated += 1;
        this.emitTranslated(msg);
        break;
      }
      case "response.event": {
        this.responseEvents += 1;
        this.processNestedResponseEvent((msg.event || {}) as Record<string, unknown>);
        break;
      }
      case "session.output_audio.delta": {
        if (!this.currentResponseId) {
          // Synthesize a Realtime-shaped response.created so media-stream's response-mismatch
          // guards accept the stream (Live has no outer response.created event).
          this.currentResponseId = `live_${Date.now()}`;
          this.emitTranslated({
            type: "response.created",
            response: { id: this.currentResponseId },
          });
        }
        this.outputAudioDeltas += 1;
        if (typeof msg.delta === "string") this.outputAudioBytes += msg.delta.length;
        if (this.outputAudioDeltas === 1) {
          this.log(`first output_audio.delta received (${this.outputAudioBytes} bytes total)`);
          this.logMetrics("first_output_audio");
        }
        this.emitTranslated({
          type: "response.output_audio.delta",
          response_id: this.currentResponseId,
          delta: msg.delta,
        });
        break;
      }
      case "session.input_transcript.delta": {
        this.inputTranscriptDeltas += 1;
        this.emitTranslated({
          type: "conversation.item.input_audio_transcription.delta",
          delta: msg.delta,
        });
        break;
      }
      case "session.output_transcript.delta": {
        this.outputTranscriptDeltas += 1;
        this.emitTranslated({
          type: "response.output_audio_transcript.delta",
          response_id: this.currentResponseId,
          delta: msg.delta,
        });
        break;
      }
      case "response.output_item.done": {
        // Top-level function calls (if any) — nested ones are handled in response.event.
        this.handleFunctionCallItem((msg.item || {}) as Record<string, unknown>);
        break;
      }
      case "error": {
        this.errorCount += 1;
        this.emitTranslated(msg);
        break;
      }
      case "session.closed": {
        // Flush any pending assistant text as a transcript-done so finalizeCall captures it,
        // then hand the Realtime-shaped terminal event to media-stream.
        this.flushOutputTranscript("session_closed");
        this.emitTranslated({
          type: "response.done",
          response: { status: "completed", usage: msg.usage },
        });
        this.emitTranslated(msg);
        this.logMetrics("session_closed");
        break;
      }
      case "session.usage.updated":
      default:
        // Forward informational events (usage, moderation, etc.) — media-stream ignores
        // types it does not handle.
        this.emitTranslated(msg);
    }
  }

  private processNestedResponseEvent(inner: Record<string, unknown>): void {
    const innerType = String(inner.type || "");
    switch (innerType) {
      case "response.created": {
        const resp = (inner.response || {}) as Record<string, unknown>;
        this.currentResponseId = String(resp.id || `live_${Date.now()}`);
        this.emitTranslated({
          type: "response.created",
          response: { id: this.currentResponseId },
        });
        break;
      }
      case "response.output_text.delta": {
        if (typeof inner.delta === "string") this.outputText += inner.delta;
        break;
      }
      case "response.output_item.done": {
        this.handleFunctionCallItem((inner.item || {}) as Record<string, unknown>);
        break;
      }
      case "response.completed": {
        // Nested response lifecycle completes → surface assistant text as a transcript-done
        // (Live has no outer output_audio.done; media-stream's finalize consumes this).
        this.flushOutputTranscript("nested_response_completed");
        break;
      }
      default:
        break;
    }
  }

  private handleFunctionCallItem(item: Record<string, unknown>): void {
    if (item.type !== "function_call") return;
    const callId = String(item.call_id || "");
    this.pendingFunctionCalls.set(callId, String(item.name || ""));
    this.emitTranslated({
      type: "response.function_call_arguments.done",
      response_id: this.currentResponseId,
      item_id: item.id,
      call_id: callId,
      name: item.name,
      arguments: item.arguments,
    });
  }

  private flushOutputTranscript(reason: string): void {
    if (!this.outputText) return;
    this.emitTranslated({
      type: "response.output_audio_transcript.done",
      response_id: this.currentResponseId,
      transcript: this.outputText,
    });
    this.log(`assistant text flushed (${this.outputText.length} chars, reason=${reason})`);
    this.outputText = "";
  }

  private logMetrics(reason: string): void {
    this.log(
      `metrics[${reason}] session=${this.liveSessionId || "-"} inAppend=${this.inputAppends} ` +
        `inBytes=${this.inputBytes} outDelta=${this.outputAudioDeltas} outBytes=${this.outputAudioBytes} ` +
        `outTxtDelta=${this.outputTranscriptDeltas} inTxtDelta=${this.inputTranscriptDeltas} ` +
        `appendSent=${this.greetingAppendSent} appendAck=${this.greetingAppendAck} ` +
        `delegated=${this.delegationCreated} respEvents=${this.responseEvents} errors=${this.errorCount}`,
    );
  }

  private emitTranslated(obj: Record<string, unknown>): void {
    const handler = this.messageHandler;
    if (!handler) return;
    handler(Buffer.from(JSON.stringify(obj)) as unknown as WebSocket.Data);
  }

  private rawSend(obj: Record<string, unknown>): void {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.log(`rawSend failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private syncReadyState(): void {
    this.readyState = this.ws.readyState;
  }

  /** Static helper used by media-stream to decide the bridge path. */
  public static readonly LIVE_WS_URL = LIVE_WS_URL;
}
