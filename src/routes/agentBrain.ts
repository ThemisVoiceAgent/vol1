import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import {
  disableOlderBrainConfigVersions,
  fetchLatestEnabledBrainConfigRow,
  fetchMaxBrainConfigVersion,
  insertBrainConfigVersion,
} from "../agentBrainConfigRepo.js";
import { layerIiziBrainConfig } from "../flow/iiziBrainSpeechClassify.js";

export const agentBrainRouter = Router({ mergeParams: true });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireAdmin(req: Request, res: Response): boolean {
  const expected = config.orchestratorAdminSecret.trim();
  if (!expected) {
    res.status(503).json({ ok: false, error: "ORCHESTRATOR_ADMIN_SECRET not configured" });
    return false;
  }
  const got = (req.headers["x-orchestrator-admin-secret"] as string | undefined)?.trim() || "";
  if (got !== expected) {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return false;
  }
  return true;
}

/** GET /api/agents/:agentId/brain-config */
agentBrainRouter.get("/:agentId/brain-config", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const agentId = String(req.params.agentId || "").trim();
  if (!UUID_RE.test(agentId)) {
    return res.status(400).json({ ok: false, error: "Invalid agentId" });
  }
  if (!config.supabase.isConfigured) {
    return res.status(503).json({ ok: false, error: "Supabase not configured" });
  }
  const row = await fetchLatestEnabledBrainConfigRow(agentId);
  const effective = layerIiziBrainConfig((row?.config_json as object) ?? null);
  return res.json({
    ok: true,
    agentId,
    brainConfigDbVersion: row?.version ?? null,
    updated_at: row?.updated_at ?? null,
    effectiveConfig: effective,
  });
});

/** PUT /api/agents/:agentId/brain-config — body: { config_json: object } */
agentBrainRouter.put("/:agentId/brain-config", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const agentId = String(req.params.agentId || "").trim();
  if (!UUID_RE.test(agentId)) {
    return res.status(400).json({ ok: false, error: "Invalid agentId" });
  }
  if (!config.supabase.isConfigured) {
    return res.status(503).json({ ok: false, error: "Supabase not configured" });
  }
  const raw = req.body?.config_json;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return res.status(400).json({ ok: false, error: "Body must include config_json object" });
  }
  const maxV = await fetchMaxBrainConfigVersion(agentId);
  const nextV = maxV + 1;
  const inserted = await insertBrainConfigVersion(agentId, nextV, raw);
  if (!inserted) {
    return res.status(500).json({ ok: false, error: "Failed to insert brain config row" });
  }
  await disableOlderBrainConfigVersions(agentId, nextV);

  const effective = layerIiziBrainConfig((inserted.config_json as object) ?? null);
  return res.json({
    ok: true,
    agentId,
    brainConfigDbVersion: inserted.version,
    row: inserted,
    effectiveConfig: effective,
  });
});
