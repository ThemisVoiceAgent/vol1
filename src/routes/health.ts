import { Router } from "express";
import WebSocket from "ws";
import { config, getDeploymentIdentity } from "../config.js";

export const healthRouter = Router();
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

healthRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "orchestrator",
    version: "1.0.0",
    uptime: process.uptime(),
    providers: {
      twilio: {
        configured: config.twilio.isConfigured,
        status: config.twilio.isConfigured ? "READY" : "NOT_CONFIGURED",
      },
      openai: {
        configured: config.openai.isConfigured,
        status: config.openai.isConfigured ? "READY" : "NOT_CONFIGURED",
      },
      supabase: {
        configured: config.supabase.isConfigured,
        status: config.supabase.isConfigured ? "READY" : "NOT_CONFIGURED",
      },
    },
  });
});

healthRouter.post("/diag/openai-realtime-self-test", async (req, res) => {
  const correlationId = crypto.randomUUID();
  const voice = (req.body?.voice || req.query.voice || "alloy").toString();
  const startedAt = Date.now();
  const sessionConfig = {
    model: config.openai.realtimeModel,
    session_type: "realtime",
    output_modalities: ["audio"],
    audio_input_format: "audio/pcmu",
    audio_output_format: "audio/pcmu",
    voice,
    turn_detection: null,
    input_audio_transcription: { model: "whisper-1", language: "et" },
    tools_count: 0,
  };

  if (!config.openai.isConfigured) {
    return res.status(503).json({ ok: false, correlation_id: correlationId, error: "OPENAI_API_KEY missing" });
  }

  console.log(`[Diag-TestA] start correlationId=${correlationId} deployment=${JSON.stringify(getDeploymentIdentity())} session=${JSON.stringify(sessionConfig)}`);

  try {
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      const counters = {
        open: false,
        session_created: false,
        session_updated: false,
        response_create_sent: false,
        response_created: false,
        response_done: false,
        text_delta_count: 0,
        audio_delta_count: 0,
        output_audio_delta_count: 0,
        audio_bytes: 0,
        errors: [] as unknown[],
        close: null as null | { code: number; reason: string },
      };
      let settled = false;
      const ws = new WebSocket(`${OPENAI_REALTIME_URL}?model=${config.openai.realtimeModel}`, {
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`,
        },
      });
      const finish = (ok: boolean, reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
        const payload = { ok, reason, elapsed_ms: Date.now() - startedAt, sessionConfig, counters };
        console.log(`[Diag-TestA] final correlationId=${correlationId} ${JSON.stringify(payload)}`);
        resolve(payload);
      };
      const timeout = setTimeout(() => finish(false, "timeout"), 15000);

      ws.on("open", () => {
        counters.open = true;
        console.log(`[Diag-TestA] OpenAI WS open correlationId=${correlationId}`);
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: sessionConfig.output_modalities,
            instructions: "You are testing the realtime bridge. Reply briefly.",
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                transcription: sessionConfig.input_audio_transcription,
                turn_detection: sessionConfig.turn_detection,
              },
              output: {
                format: { type: "audio/pcmu" },
                voice,
              },
            },
          },
        }));
      });

      ws.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === "session.created") counters.session_created = true;
        if (event.type === "session.updated") {
          counters.session_updated = true;
          ws.send(JSON.stringify({
            type: "conversation.item.create",
            item: { type: "message", role: "user", content: [{ type: "input_text", text: "Say test." }] },
          }));
          counters.response_create_sent = true;
          ws.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio"] } }));
        }
        if (event.type === "response.created") counters.response_created = true;
        if (event.type === "response.text.delta" || event.type === "response.output_text.delta") counters.text_delta_count += 1;
        if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
          if (event.type === "response.output_audio.delta") counters.output_audio_delta_count += 1;
          else counters.audio_delta_count += 1;
          if (event.delta) counters.audio_bytes += Buffer.from(event.delta, "base64").length;
        }
        if (event.type === "response.done") {
          counters.response_done = true;
          finish(Boolean(counters.response_created && (counters.audio_delta_count + counters.output_audio_delta_count > 0 || counters.text_delta_count > 0)), "response.done");
        }
        if (event.type === "error" || event.type === "response.error") {
          counters.errors.push(event.error || event);
          console.error(`[Diag-TestA] OpenAI error correlationId=${correlationId}: ${JSON.stringify(event.error || event)}`);
        }
      });

      ws.on("close", (code, reason) => {
        counters.close = { code, reason: reason?.toString() || "" };
        finish(false, "ws.closed");
      });
      ws.on("error", (err) => {
        counters.errors.push(err.message);
        finish(false, "ws.error");
      });
    });

    return res.status(result.ok ? 200 : 500).json({ correlation_id: correlationId, ...result });
  } catch (error) {
    console.error(`[Diag-TestA] exception correlationId=${correlationId}:`, error);
    return res.status(500).json({ ok: false, correlation_id: correlationId, error: error instanceof Error ? error.message : "Unknown error" });
  }
});
