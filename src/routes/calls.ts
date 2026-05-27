import { Router, Request, Response } from "express";
import { startOutboundCall } from "../services/outboundCall.js";

export const callsRouter = Router();

interface StartCallBody {
  to_number: string;
  agent_id: string;
  campaign_id?: string;
  variables?: Record<string, string>;
  idempotency_key?: string;
  bridge_self_test?: string;
}

callsRouter.post("/start", async (req: Request<{}, {}, StartCallBody>, res: Response) => {
  const correlationId = crypto.randomUUID();
  console.log(`[${correlationId}] POST /api/calls/start`);

  const { to_number, agent_id, campaign_id, variables, bridge_self_test } = req.body;

  if (!to_number || !agent_id) {
    return res.status(400).json({
      success: false,
      status: "error",
      error: "Missing required fields: to_number, agent_id",
      correlation_id: correlationId,
    });
  }

  try {
    const result = await startOutboundCall(
      { to_number, agent_id, campaign_id, variables, bridge_self_test },
      correlationId
    );

    if (!result.ok) {
      if (result.status === "out_of_schedule") {
        return res.json({
          success: false,
          status: "out_of_schedule",
          error: result.error,
          schedule_status: result.schedule_status,
          correlation_id: correlationId,
        });
      }
      return res.json({
        success: false,
        status: result.status,
        error: result.error,
        correlation_id: correlationId,
      });
    }

    return res.json({
      success: true,
      status: "started",
      call_id: result.call_id,
      twilio_call_sid: result.twilio_call_sid,
      correlation_id: correlationId,
    });
  } catch (error) {
    console.error(`[${correlationId}] Error:`, error);
    return res.status(500).json({
      success: false,
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
      correlation_id: correlationId,
    });
  }
});
