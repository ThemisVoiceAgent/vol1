/**
 * 5331 Phase-E: wire-level adapter that presents the OpenAI GPT-Live WebSocket
 * (wss://api.openai.com/v1/live/sessions) behind the Realtime event surface that
 * src/ws/media-stream.ts already consumes.
 *
 * Design (bounded migration, flag-guarded):
 * - The adapter wraps a plain WebSocket and exposes the same send()/message surface used
 *   for the Realtime API. Outgoing Realtime-typed messages are translated to GPT-Live
 *   equivalents; incoming GPT-Live events are translated back to the Realtime shapes.
 * - Supported mappings (v1, evidence: developers.openai.com live docs 2026-10-07):
 *     session.update (initial)          → dropped; session config sent via session.start
 *                                         (model/instructions/audio.format/output.voice/tools)
 *     response.create {instructions}    → session.instructions.append (greeting read-aloud)
 *     input_audio_buffer.append {audio} → session.input_audio.append {audio}
 *     input_audio_buffer.commit         → no-op (GPT-Live manages turns)
 *     input_audio_buffer.clear          → no-op
 *     response.cancel                   → session.interrupt (if supported) / no-op
 *     conversation.item.create (system) → response.item.create (Responses input item)
 *     function_call_output              → response.item.create (function_call_output item)
 *     session.updated                   ← session.started (resolved config)
 *     session.output_audio.delta        → response.output_audio.delta {delta, response_id}
 *     session.input_transcript.delta    → conversation.item.input_audio_transcription.delta
 *     session.output_transcript.delta   → response.output_audio_transcript.delta
 *     response.output_item.done (fn)    → response.function_call_arguments.done {name, arguments}
 *     error                             → error (passthrough)
 *     session.closed                    → synthesized response.done + close passthrough
 * - speed: GPT-Live has no session.audio.output.speed — dropped with a one-time log
 *   (GPT_LIVE_EXPLICIT_SPEED_SUPPORTED=NO); pacing is handled by the agent prompt.
 */
import { WebSocket, type RawData } from "ws";

const LIVE_WS_URL = "wss://api.openai.com/v1/live/sessions";

export interface LiveAsRealtimeOptions {
  apiKey: string;
  model: string; // gpt-live-1
  /** Realtime-shaped session config (instructions, audio output, tools, voice). */
  sessionConfig: {
    instructions?: string;
    voice?: string;
    tools?: unknown[];
  };
  logger?: (msg: string) => void;
}

type PendingMessage = string;

export class LiveAsRealtimeSocket {
  private ws: WebSocket;
  private log: (msg: string) => void;
  private sessionStarted = false;
  private readonly pendingBeforeStart: PendingMessage[] = [];
  // 5331 Phase-E: Live speaks only once input audio flows + a delegated turn is requested.
  private turnKickPending = true;
  private startSent = false;
  private speedWarned = false;
  private activeResponseId: string | null = null;
  /** Call-id → function name cache from nested output_item.done events. */
  private pendingFunctionCalls = new Map<string, string>();

  /** Mirror of the WebSocket surface media-stream.ts uses. */
  public readyState: number = WebSocket.CONNECTING;
  public readonly OPEN = WebSocket.OPEN;

  private messageHandler: ((data: WebSocket.Data) => void) | null = null;
  private openHandler: (() => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((err: unknown) => void) | null = null;

  constructor(opts: LiveAsRealtimeOptions) {
    this.log = opts.logger ?? (() => {});
    this.ws = new WebSocket(LIVE_WS_URL, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });
    this.syncReadyState();

    this.ws.on("open", () => {
      this.syncReadyState();
      this.sendSessionStart(opts);
      this.openHandler?.();
    });
    this.ws.on("message", (data: RawData) => this.onLiveMessage(data));
    this.ws.on("close", () => {
      this.syncReadyState();
      this.closeHandler?.();
    });
    this.ws.on("error", (err) => {
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

    if (!this.startSent) {
      // Buffer everything until session.start is on the wire.
      this.pendingBeforeStart.push(raw);
      return;
    }

    switch (type) {
      case "session.update": {
        // The initial session config was already applied via session.start. Update is used
        // for VAD patches (Live manages turns) and speed (unsupported) — drop with a notice.
        const session = (msg.session || {}) as Record<string, unknown>;
        const audio = (session.audio || {}) as Record<string, unknown>;
        const output = (audio.output || {}) as Record<string, unknown>;
        if (output.speed !== undefined && !this.speedWarned) {
          this.speedWarned = true;
          this.log(
            `[LiveBridge] session.audio.output.speed not supported by GPT-Live — dropped; pacing via agent prompt (GPT_LIVE_EXPLICIT_SPEED_SUPPORTED=NO)`,
          );
        }
        // Tools arriving late (post-greeting activation) are forwarded as a Responses update.
        if (Array.isArray(session.tools) && session.tools.length > 0 && this.sessionStarted) {
          this.rawSend({
            type: "session.update",
            event_id: `bridge_tools_${Date.now()}`,
            session: {
              delegation: { responses: { tools: session.tools, tool_choice: "auto" } },
            },
          });
        }
        this.emitTranslated({ type: "session.updated" });
        break;
      }
      case "response.create": {
        // Greeting/turn start: Live speaks when instructed. Forward the word-for-word
        // greeting instructions as an instruction append.
        const response = (msg.response || {}) as Record<string, unknown>;
        const instructions = typeof response.instructions === "string" ? response.instructions : "";
        if (instructions) {
          this.rawSend({
            type: "session.instructions.append",
            event_id: `bridge_instr_${Date.now()}`,
            instructions,
          });
        }
        break;
      }
      case "input_audio_buffer.append": {
        this.rawSend({
          type: "session.input_audio.append",
          event_id: `bridge_in_${Date.now()}`,
          audio: msg.audio,
        });
        // 5331 Phase-E: Live's voice layer activates on the duplex loop — once caller audio
        // is flowing, kick the first delegated turn (proven: response.create alone with no
        // input audio produces zero speech; with audio + response.create the model speaks).
        if (this.turnKickPending && this.sessionStarted) {
          this.turnKickPending = false;
          this.rawSend({ type: "response.create", event_id: `bridge_kick_${Date.now()}` });
        }
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
        // Some call sites send this at the top level; normalize to the item form.
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
        // Unknown Realtime types are forwarded verbatim (Live rejects if unsupported —
        // the error event surfaces in the same channel as with Realtime).
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

  /** Allow media-stream to attach the initial session config after construction. */
  configure(opts: LiveAsRealtimeOptions): void {
    if (!this.startSent) this.sendSessionStart(opts);
  }

  // ---------------------------------------------------------------- internals

  private sendSessionStart(opts: LiveAsRealtimeOptions): void {
    if (this.startSent) return;
    this.startSent = true;
    const session: Record<string, unknown> = {
      model: opts.model,
      instructions: opts.sessionConfig.instructions || "",
      audio: {
        format: { type: "audio/pcmu", rate: 8000 },
        output: { voice: opts.sessionConfig.voice || "ash" },
      },
    };
    if (Array.isArray(opts.sessionConfig.tools) && opts.sessionConfig.tools.length > 0) {
      session.delegation = {
        responses: { tools: opts.sessionConfig.tools, tool_choice: "auto" },
      };
    }
    this.rawSend({ type: "session.start", event_id: `bridge_start_${Date.now()}`, session });
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
        // Flush anything buffered before start.
        const buffered = this.pendingBeforeStart.splice(0);
        this.emitTranslated({
          type: "session.updated",
          session: (msg.session || {}) as Record<string, unknown>,
        });
        for (const raw of buffered) this.send(raw);
        break;
      }
      case "session.output_audio.delta": {
        this.activeResponseId = this.activeResponseId || `live_${Date.now()}`;
        this.emitTranslated({
          type: "response.output_audio.delta",
          response_id: this.activeResponseId,
          delta: msg.delta,
        });
        break;
      }
      case "session.input_transcript.delta": {
        this.emitTranslated({
          type: "conversation.item.input_audio_transcription.delta",
          delta: msg.delta,
        });
        break;
      }
      case "session.output_transcript.delta": {
        this.emitTranslated({
          type: "response.output_audio_transcript.delta",
          response_id: this.activeResponseId,
          delta: msg.delta,
        });
        break;
      }
      case "response.output_item.done": {
        // Nested delegation item — function calls carry call_id/name/arguments.
        const item = (msg.item || {}) as Record<string, unknown>;
        if (item.type === "function_call") {
          const callId = String(item.call_id || "");
          this.pendingFunctionCalls.set(callId, String(item.name || ""));
          this.emitTranslated({
            type: "response.function_call_arguments.done",
            response_id: this.activeResponseId,
            item_id: item.id,
            call_id: callId,
            name: item.name,
            arguments: item.arguments,
          });
        }
        break;
      }
      case "error": {
        this.emitTranslated(msg);
        break;
      }
      case "session.closed": {
        // Synthesize the terminal response.done media-stream's finalize path expects.
        this.emitTranslated({
          type: "response.done",
          response: { status: "completed", usage: msg.usage },
        });
        this.emitTranslated(msg);
        break;
      }
      default:
        // Forward unknown informational events (usage, moderation, etc.) so diagnostics
        // stay visible; media-stream ignores types it does not handle.
        this.emitTranslated(msg);
    }
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
      this.log(`[LiveBridge] rawSend failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private syncReadyState(): void {
    this.readyState = this.ws.readyState;
  }

  /** Static helper used by media-stream to decide the bridge path. */
  public static readonly LIVE_WS_URL = LIVE_WS_URL;
}
