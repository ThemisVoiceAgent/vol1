import { Router, Request, Response } from "express";
import crypto from "crypto";
import { config } from "../config.js";
import { updateCall } from "../supabase.js";

export const locationRouter = Router();

const AZURE_REVERSE_URL = "https://atlas.microsoft.com/search/address/reverse/json";

interface ConfirmBody {
  caseId?: unknown;
  token?: unknown;
  lat?: unknown;
  lon?: unknown;
}

/**
 * Verify HMAC-SHA256(caseId) using LOCATION_TOKEN_SECRET.
 * Tokens are hex-encoded. Constant-time compare.
 */
function verifyToken(caseId: string, token: string): boolean {
  const secret = process.env.LOCATION_TOKEN_SECRET || "";
  if (!secret) {
    console.warn("[location] LOCATION_TOKEN_SECRET not set — token verification disabled (DEV ONLY)");
    return true; // Permissive in dev so you can test before configuring the secret
  }
  const expected = crypto.createHmac("sha256", secret).update(caseId).digest("hex");
  if (token.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const key = process.env.AZURE_MAPS_KEY || "";
  if (!key) {
    console.error("[location] AZURE_MAPS_KEY not set, cannot reverse-geocode");
    return null;
  }
  const url = `${AZURE_REVERSE_URL}?api-version=1.0&query=${lat},${lon}&subscription-key=${encodeURIComponent(key)}&language=et-EE`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[location] Azure reverse-geocode HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    const data: any = await res.json();
    const first = data?.addresses?.[0]?.address;
    if (!first) return null;
    return (
      first.freeformAddress ||
      [first.streetNameAndNumber, first.municipality, first.country].filter(Boolean).join(", ") ||
      null
    );
  } catch (err) {
    console.error("[location] reverseGeocode error:", err);
    return null;
  }
}

locationRouter.options("/confirm", (_req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  });
  res.sendStatus(204);
});

locationRouter.post("/confirm", async (req: Request<{}, {}, ConfirmBody>, res: Response) => {
  // CORS — page is hosted on Azure Storage static website, different origin
  res.set("Access-Control-Allow-Origin", "*");

  const correlationId = crypto.randomUUID();
  const { caseId, token, lat, lon } = req.body || {};

  // Validate
  if (typeof caseId !== "string" || !caseId.trim()) {
    return res.status(400).json({ ok: false, error: "Missing caseId", correlation_id: correlationId });
  }
  if (typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ ok: false, error: "Missing token", correlation_id: correlationId });
  }
  const latNum = typeof lat === "number" ? lat : Number(lat);
  const lonNum = typeof lon === "number" ? lon : Number(lon);
  if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) {
    return res.status(400).json({ ok: false, error: "Invalid lat", correlation_id: correlationId });
  }
  if (!Number.isFinite(lonNum) || lonNum < -180 || lonNum > 180) {
    return res.status(400).json({ ok: false, error: "Invalid lon", correlation_id: correlationId });
  }

  if (!verifyToken(caseId.trim(), token.trim())) {
    console.warn(`[${correlationId}] Invalid token for caseId=${caseId}`);
    return res.status(403).json({ ok: false, error: "Invalid token", correlation_id: correlationId });
  }

  console.log(`[${correlationId}] Location confirm: caseId=${caseId} lat=${latNum} lon=${lonNum}`);

  // Reverse-geocode (best-effort — still persist even if it fails)
  const address = (await reverseGeocode(latNum, lonNum)) || `${latNum.toFixed(5)}, ${lonNum.toFixed(5)}`;

  try {
    await updateCall(caseId.trim(), {
      location_confirmed: true,
      location_lat: latNum,
      location_lon: lonNum,
      location_address: address,
      location_confirmed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[${correlationId}] Failed to persist location:`, err);
    return res.status(500).json({ ok: false, error: "Failed to save location", correlation_id: correlationId });
  }

  return res.json({
    ok: true,
    address,
    lat: latNum,
    lon: lonNum,
    correlation_id: correlationId,
  });
});
