-- Full Intra call variables (Twilio Stream custom parameters are limited to ~256 chars).
ALTER TABLE themis_campaign_calls
  ADD COLUMN IF NOT EXISTS call_variables JSONB;
