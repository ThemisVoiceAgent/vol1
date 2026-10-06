-- 5331 Phase-B migration (Henri runs in Supabase SQL editor — service vol1-pfcv project)
-- Adds the missing answered_at column so webhook answered-event writes land and
-- call_pickup_date can propagate to Intra statistics.
-- Idempotent. No data changes; historical rows keep answered_at = NULL.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS answered_at timestamptz;

-- Optional verification (should return one row with answered_at column present):
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'calls' AND column_name = 'answered_at';
