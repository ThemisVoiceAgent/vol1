/** Shared transcript normalization for IIZI deterministic matching (not for audit storage). */

export function normalizeTriggerPhrase(raw: string): string {
  let t = raw.toLowerCase().trim();
  t = t.replace(/[''`]/g, "'");
  t = t.replace(/[äå]/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/õ/g, "o");
  t = t.replace(/ё/g, "е");
  t = t.replace(/[^\p{L}\p{N}\s]/gu, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** Full transcript normalization (Latin + Cyrillic). */
export function normalizeIiziTranscript(raw: string): string {
  return normalizeTriggerPhrase(raw);
}

export function transcriptHasCyrillic(raw: string): boolean {
  return /[\u0400-\u04FF]/.test(raw);
}
