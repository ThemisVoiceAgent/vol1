# THEMIS 5331 — Phase C prepared SQL (PREPARE ONLY — DO NOT EXECUTE WITHOUT HENRI'S APPROVAL)

Status: PREPARED 2026-09-17 / NOT EXECUTED / no production DB writes performed.
All statements target the voicebot **Supabase** (Postgres) database — the same DB the
voicebot reads agent config from. Intra's MySQL DB does NOT hold agent settings
(probes 2026-09-17: zero supabase references in manager/ tree; settings live in
Supabase `agents` table consumed via edge function `agent-config`).

Run every statement in the Supabase SQL editor. Each block captures its own
before-value so the rollback is self-contained.

---

## E — voice_speed → 1.25

Prod current value could NOT be read read-only this phase: the Supabase URL/service
key exist only in the Railway voicebot env (not in Intra config, not in any server
env file reachable via the themis.ee SSH account). If a Railway-side read becomes
possible before execution, capture:

    SELECT id, name, settings->>'voice_speed' AS current_voice_speed
    FROM agents WHERE id = '<THEMIS_AGENT_UUID>';

### Step 1 — capture before-value (for the report + rollback)

    SELECT id, name,
           settings->>'voice_speed' AS current_voice_speed,
           settings AS full_settings_before
    FROM agents
    WHERE id = '<THEMIS_AGENT_UUID>';

### Step 2 — apply 1.25 (guarded: only flips when the key exists, so an unset
### speed can be reviewed first instead of silently appearing)

    UPDATE agents
    SET settings = jsonb_set(settings, '{voice_speed}', '1.25'::jsonb, true)
    WHERE id = '<THEMIS_AGENT_UUID>'
      AND settings ? 'voice_speed';

### Step 2b — ONLY if Step 1 shows the key is absent AND Henri approves creating it:

    UPDATE agents
    SET settings = jsonb_set(settings, '{voice_speed}', '1.25'::jsonb, true)
    WHERE id = '<THEMIS_AGENT_UUID>';

### Rollback (substitute the value from Step 1)

    UPDATE agents
    SET settings = jsonb_set(settings, '{voice_speed}', '<current_voice_speed>'::jsonb, true)
    WHERE id = '<THEMIS_AGENT_UUID>';

Notes:
- Clamp path verified in code: `clampVoiceSpeed` (src/ws/media-stream.ts:462-474)
  steps to 0.05 grid, clamps 1.0–1.5 → 1.25 passes through unchanged.
- OpenAI GA docs (https://platform.openai.com/docs/api-reference/realtime-sessions,
  captured 2026-09-17): session.audio.output.speed = "1.0 default, 0.25 minimum,
  1.5 maximum" → 1.25 valid for gpt-realtime-2.1.

---

## D-DB — greeting / system_prompt target semantics (Tanel's request)

Two variants. TÕB (own debt-collection client) calls must NOT name the creditor;
external-client calls must include it. Because no reliable discriminator exists in
the payload (see report §D-conditional), BOTH variants are prepared; choose ONE
per the agreed discriminator (config var with Themis client ids, or new column —
schema change, forbidden this phase) before execution.

Find the agent row first:

    SELECT id, name, greeting, system_prompt FROM agents WHERE id = '<THEMIS_AGENT_UUID>';

### Variant 1 — TÕB (Themis-own client) — creditor NOT named in opening

    UPDATE agents
    SET greeting = '<TÕB_GREETING>',
        system_prompt = '<TÕB_SYSTEM_PROMPT>'
    WHERE id = '<THEMIS_AGENT_UUID>';

### Variant 2 — external client — creditor named in opening

    UPDATE agents
    SET greeting = '<EXTERNAL_GREETING>',
        system_prompt = '<EXTERNAL_SYSTEM_PROMPT>'
    WHERE id = '<THEMIS_AGENT_UUID>';

### Rollback

    UPDATE agents
    SET greeting = '<current greeting from SELECT above>',
        system_prompt = '<current system_prompt from SELECT above>'
    WHERE id = '<THEMIS_AGENT_UUID>';

Content drafting rule (from Tanel's semantics, to be finalized with Henri before
execution): the opening states the debt amount and Themis as the caller; the
creditor (TÕB) is mentioned only if the debtor asks or in the external variant;
no identity-verification phrasing anywhere in greeting or prompt (matches the
code-side removal of "verify identity" in applyCallContext.ts).

---

## MODEL — no SQL required

Realtime model switch is code-side (OPENAI_REALTIME_MODEL default in
src/config.ts = gpt-realtime-2.1; Railway env var OPENAI_REALTIME_MODEL, if set,
overrides and must be cleared/updated at deploy time). Agents.voice stays valid:
`sage`/`ash` are supported voices on gpt-realtime-2.1 (OpenAI GA docs, voice list:
alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar).
