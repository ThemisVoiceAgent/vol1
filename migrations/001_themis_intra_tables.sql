-- Minimal tables for legacy Intra campaign adapter (Themis Railway runtime).
-- Run in Supabase SQL editor if themis_campaign_calls does not exist yet.

CREATE TABLE IF NOT EXISTS themis_campaigns (
  campaign_id BIGINT PRIMARY KEY,
  voice TEXT,
  callback_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS themis_campaign_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id BIGINT NOT NULL REFERENCES themis_campaigns (campaign_id) ON DELETE CASCADE,
  call_id UUID NOT NULL,
  fk_task_id TEXT,
  client_name TEXT,
  phone TEXT,
  debt_amount TEXT,
  twilio_call_sid TEXT,
  from_number TEXT,
  voice TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_themis_campaign_calls_campaign_id
  ON themis_campaign_calls (campaign_id);

CREATE INDEX IF NOT EXISTS idx_themis_campaign_calls_call_id
  ON themis_campaign_calls (call_id);

-- Optional: allow service role / anon read-write via RLS policies matching your calls table pattern.
