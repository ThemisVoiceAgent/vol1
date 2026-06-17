import crypto from "crypto";
import { config } from "../config.js";

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

function parseServiceAccount(): ServiceAccount | null {
  const raw = config.themis.sheets.serviceAccountJson;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key || !parsed.token_uri) return null;
    return parsed;
  } catch {
    console.warn("[ThemisSheets] GOOGLE_SERVICE_ACCOUNT_JSON parse failed");
    return null;
  }
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claim}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  sign.end();
  const signature = sign.sign(sa.private_key, "base64url");
  return `${unsigned}.${signature}`;
}

async function getAccessToken(): Promise<string | null> {
  const sa = parseServiceAccount();
  if (!sa) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const assertion = signJwt(sa);
  try {
    const res = await fetch(sa.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      console.warn(`[ThemisSheets] token exchange HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
    return data.access_token;
  } catch (err) {
    console.warn("[ThemisSheets] token exchange error", err);
    return null;
  }
}

/** Quote sheet tab name for A1 notation (handles spaces and apostrophes). */
export function quoteSheetTab(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

export function isGoogleSheetsConfigured(): boolean {
  return (
    config.themis.sheets.exportEnabled &&
    !!config.themis.sheets.spreadsheetId &&
    !!config.themis.sheets.sheetName &&
    !!parseServiceAccount()
  );
}

export type AppendResult =
  | { ok: true; updatedRange: string }
  | { ok: false; error: string; status?: number };

/**
 * Append one horizontal row to the configured sheet (A:H).
 * Uses spreadsheets.values.append with USER_ENTERED + INSERT_ROWS.
 */
export async function appendSheetRow(values: string[][]): Promise<AppendResult> {
  const spreadsheetId = config.themis.sheets.spreadsheetId;
  const sheetName = config.themis.sheets.sheetName;
  if (!spreadsheetId || !sheetName) {
    return { ok: false, error: "missing_spreadsheet_config" };
  }

  const token = await getAccessToken();
  if (!token) return { ok: false, error: "auth_failed" };

  const range = `${quoteSheetTab(sheetName)}!A:H`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    });
    const body = (await res.json()) as {
      updates?: { updatedRange?: string };
      error?: { message?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        error: body.error?.message || `http_${res.status}`,
        status: res.status,
      };
    }
    const updatedRange = body.updates?.updatedRange || "";
    if (!updatedRange) return { ok: false, error: "missing_updated_range" };
    return { ok: true, updatedRange };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "append_failed" };
  }
}

export type UpdateResult = { ok: true } | { ok: false; error: string };

/** Update a single cell range (e.g. recording URL in column H). */
export async function updateSheetRange(range: string, value: string): Promise<UpdateResult> {
  const spreadsheetId = config.themis.sheets.spreadsheetId;
  if (!spreadsheetId) return { ok: false, error: "missing_spreadsheet_id" };

  const token = await getAccessToken();
  if (!token) return { ok: false, error: "auth_failed" };

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [[value]] }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: { message?: string } };
      return { ok: false, error: body.error?.message || `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "update_failed" };
  }
}

/** Extract column H range for a stored full row range like 'Tab'!A42:H42 */
export function recordingCellRange(fullRowRange: string): string | null {
  const m = fullRowRange.match(/!A(\d+):H\d+/i);
  if (!m) return null;
  const sheetPart = fullRowRange.split("!")[0];
  return `${sheetPart}!H${m[1]}`;
}
