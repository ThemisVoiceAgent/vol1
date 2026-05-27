/** Extract first E.164-like phone from comma/semicolon-separated list. */
export function firstValidPhone(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== "string") return null;

  const parts = raw.split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const normalized = normalizePhone(part);
    if (normalized) return normalized;
  }
  return null;
}

export function normalizePhone(input: string): string | null {
  const cleaned = input.replace(/[^\d+]/g, "");
  if (!cleaned) return null;

  let e164 = cleaned.startsWith("+") ? cleaned : `+${cleaned.replace(/^\+*/, "")}`;
  if (/^\+\d{8,15}$/.test(e164)) return e164;

  // Estonian local without country code: 5xxxxxxx → +3725xxxxxxx
  if (/^5\d{6,7}$/.test(cleaned)) {
    e164 = `+372${cleaned}`;
    if (/^\+\d{8,15}$/.test(e164)) return e164;
  }

  return null;
}
