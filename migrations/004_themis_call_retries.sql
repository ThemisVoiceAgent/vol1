-- 004: Themis outbound single retry (+5h) for not-picked-up calls.
-- Narrow scope: adds retry bookkeeping columns to themis_campaign_calls.
-- Idempotent — safe to run multiple times.

ALTER TABLE themis_campaign_calls
  ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS original_call_id UUID,
  ADD COLUMN IF NOT EXISTS retry_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_status TEXT,
  ADD COLUMN IF NOT EXISTS retry_reason TEXT;

-- Fast lookup for the retry processor (due rows that are scheduled but not yet attempted).
CREATE INDEX IF NOT EXISTS idx_themis_campaign_calls_due_retries
  ON themis_campaign_calls (retry_scheduled_at)
  WHERE retry_status = 'scheduled' AND retry_attempted_at IS NULL;

-- Hard guard: at most one secondary (attempt 2) row per original call.
CREATE UNIQUE INDEX IF NOT EXISTS uq_themis_campaign_calls_one_retry_per_original
  ON themis_campaign_calls (original_call_id)
  WHERE original_call_id IS NOT NULL;
