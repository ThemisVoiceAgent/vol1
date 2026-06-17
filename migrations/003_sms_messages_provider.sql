-- Provider-aware SMS logging for sms_messages (Messente + Twilio).
-- Apply in the Supabase SQL editor BEFORE deploying the Messente provider.
-- Safe / idempotent: re-running is a no-op.

-- New nullable columns. Existing Twilio rows keep using twilio_sid unchanged.
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS sender_name text;

-- Hard backstop against duplicate Themis post-call SMS for the same call.
-- Scoped ONLY to the Themis post-call template so no other SMS flow
-- (during-call / after-call / IIZI / inbound) is affected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_messages_themis_post_call
  ON sms_messages (call_id)
  WHERE template_name = 'themis_post_call_sms_v1' AND call_id IS NOT NULL;
