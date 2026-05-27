/** Map Twilio/DB call status to legacy Intra call_status + call_result. */
export function mapLegacyCallOutcome(dbStatus: string | null | undefined): {
  call_status: string;
  call_result: string;
} {
  const s = (dbStatus || "").toLowerCase().trim();

  switch (s) {
    case "completed":
      return { call_status: "completed", call_result: "unknown" };
    case "no-answer":
    case "no_answer":
      return { call_status: "no_answer", call_result: "no_answer" };
    case "busy":
      return { call_status: "busy", call_result: "busy" };
    case "failed":
    case "canceled":
      return { call_status: "failed", call_result: "failed" };
    case "in-progress":
    case "in_progress":
    case "ringing":
    case "initiated":
      return { call_status: s.replace(/-/g, "_"), call_result: "unknown" };
    default:
      return { call_status: s || "unknown", call_result: "unknown" };
  }
}

/** Format ISO timestamp as legacy "YYYY-MM-DD HH:mm:ss" (UTC). */
export function formatLegacyCallDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
