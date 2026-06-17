-- 005: Idempotency for Themis Google Sheets post-call export.
-- Idempotent — safe to run multiple times.

CREATE TABLE IF NOT EXISTS themis_sheet_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL,
  target TEXT NOT NULL DEFAULT 'google_sheet',
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT,
  exported_at TIMESTAMPTZ,
  status TEXT,
  error TEXT,
  row_range TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_themis_sheet_exports_call_target_sheet
  ON themis_sheet_exports (call_id, target, spreadsheet_id);

CREATE INDEX IF NOT EXISTS idx_themis_sheet_exports_call_id
  ON themis_sheet_exports (call_id);

NOTIFY pgrst, 'reload schema';
