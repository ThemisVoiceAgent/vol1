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

const TZ_OPTIONS = {
  timeZone: "Europe/Tallinn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
} as const;

/** Format ISO timestamp as legacy "YYYY-MM-DD HH:mm:ss" in Europe/Tallinn time (+03/+02 DST-aware). */
export function formatLegacyCallDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", TZ_OPTIONS).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour"); // en-GB midnight edge case
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}
