## Export notes

Source repo: voice-loom-bot  
Source git commit hash: `5c209425aa4a2133c542d7582cca434659ac7b1c`  
Export date/time (UTC): `2026-05-27T09:52:01Z`

## What was copied
- `orchestrator/src/` → `themis-voicebot-runtime/src/` (full runtime source tree)
- `orchestrator/package-lock.json`, `orchestrator/Dockerfile` (build/deploy)
- Themis-specific: `README_DEPLOY.md`, `.env.example`, `EXPORT_NOTES.md`, `scripts/smoke-test.sh`
- **Not copied:** `orchestrator/node_modules`, `orchestrator/dist`, any `.env` / secrets

## Known limitations
- The legacy Intra adapter endpoints are not included in this export yet.

## Next planned step
- Add the legacy Intra adapter endpoints:
  - `/start_calls_campaign_api`
  - `/get_campaign_statistics_api`
