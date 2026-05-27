import { Router, Request, Response } from "express";
import crypto from "crypto";
import { updateCall } from "../supabase.js";

export const formsRouter = Router();

interface IiziFallbackBody {
  secret?: unknown;
  caseId?: unknown;
  registrationNumber?: unknown;
  callbackPhoneNumber?: unknown;
  raw?: unknown;
  submittedAt?: unknown;
}

/**
 * Normalize Estonian-style registration plates.
 * - uppercase
 * - strip whitespace and non-alphanumerics
 * Examples: " 777amg " -> "777AMG", "abc-123" -> "ABC123"
 */
function normalizeRegistration(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
}

/**
 * Normalize Estonian/Finnish phone numbers.
 * - strip spaces, dashes, parens
 * - if starts with 00, replace with +
 * - if starts with 372/358 without +, prepend +
 * - if 7-8 digit local EE number, prepend +372
 * Conservative: returns whatever digits we can salvage with a + prefix.
 */
function normalizePhone(input: string): string {
  let s = input.trim().replace(/[\s\-().]/g, "");
  if (!s) return "";
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) {
    if (/^372\d{7,8}$/.test(s) || /^358\d{6,12}$/.test(s)) {
      s = "+" + s;
    } else if (/^[5-7]\d{6,7}$/.test(s)) {
      // Bare EE mobile (5xxxxxxx)
      s = "+372" + s;
    } else if (/^\d{6,15}$/.test(s)) {
      s = "+" + s;
    }
  }
  // Final sanity: + followed by 6-15 digits
  if (!/^\+\d{6,15}$/.test(s)) return "";
  return s;
}

formsRouter.options("/iizi-fallback", (_req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  });
  res.sendStatus(204);
});

formsRouter.post("/iizi-fallback", async (req: Request<{}, {}, IiziFallbackBody>, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");

  const correlationId = crypto.randomUUID();
  const { secret, caseId, registrationNumber, callbackPhoneNumber, raw, submittedAt } = req.body || {};

  // 1. Verify shared secret (Apps Script -> Railway)
  const expectedSecret = process.env.FORMS_SHARED_SECRET || "";
  if (!expectedSecret) {
    console.error(`[${correlationId}] FORMS_SHARED_SECRET not set on orchestrator`);
    return res.status(500).json({ ok: false, error: "Server not configured", correlation_id: correlationId });
  }
  if (typeof secret !== "string" || secret !== expectedSecret) {
    console.warn(`[${correlationId}] Invalid form secret (provided=${typeof secret === "string" ? "<string>" : typeof secret})`);
    return res.status(403).json({ ok: false, error: "Invalid secret", correlation_id: correlationId });
  }

  // 2. Validate caseId (must be a UUID matching calls.id)
  if (typeof caseId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caseId.trim())) {
    return res.status(400).json({ ok: false, error: "Invalid caseId (must be UUID)", correlation_id: correlationId });
  }
  const caseIdClean = caseId.trim();

  // 3. Normalize fields (both optional individually, but at least one must be present)
  const regRaw = typeof registrationNumber === "string" ? registrationNumber : "";
  const phoneRaw = typeof callbackPhoneNumber === "string" ? callbackPhoneNumber : "";
  const regNorm = regRaw ? normalizeRegistration(regRaw) : "";
  const phoneNorm = phoneRaw ? normalizePhone(phoneRaw) : "";

  if (!regNorm && !phoneNorm) {
    return res.status(400).json({
      ok: false,
      error: "At least one of registrationNumber or callbackPhoneNumber required",
      correlation_id: correlationId,
    });
  }

  console.log(`[${correlationId}] iizi-fallback: caseId=${caseIdClean} reg="${regNorm}" phone="${phoneNorm}"`);

  // 4. Persist into the same calls row using caseId
  const update: Record<string, unknown> = {
    form_submitted_at: typeof submittedAt === "string" ? submittedAt : new Date().toISOString(),
    form_submission_source: "google_form",
    form_raw: raw && typeof raw === "object" ? raw : { registrationNumber: regRaw, callbackPhoneNumber: phoneRaw },
  };
  if (regNorm) update.form_registration_number = regNorm;
  if (phoneNorm) update.form_callback_phone_number = phoneNorm;

  try {
    await updateCall(caseIdClean, update);
  } catch (err) {
    console.error(`[${correlationId}] Failed to persist form submission:`, err);
    return res.status(500).json({ ok: false, error: "Failed to save form data", correlation_id: correlationId });
  }

  return res.json({
    ok: true,
    caseId: caseIdClean,
    registrationNumber: regNorm || null,
    callbackPhoneNumber: phoneNorm || null,
    correlation_id: correlationId,
  });
});
