# Themis Voicebot Runtime (exported)

This folder is a conservative deployment package exported from the current working voice bot orchestrator.
It contains the Node/Express runtime, Twilio webhook handlers, Twilio Media Stream WebSocket bridge, and OpenAI Realtime GA (gpt-realtime) integration.

## What is intentionally not included
- Frontend / Vite / UI code (root `frontend` and related packages).
- Any `.env` files or real secrets.
- Local dev-only caches (no `node_modules`, no `dist` committed).
- Legacy Intra adapter endpoints are **not included yet** (see below).

## Required environment variables
See `.env.example` in this folder for the full list.

Notable ones:
- `PUBLIC_BASE_URL` and `PUBLIC_WS_BASE_URL` must point to your Themis node domain.
- `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (only if call/call_events writeback is enabled/used)
- `THEMIS_AGENT_ID`, `THEMIS_API_TOKEN`, `THEMIS_DEFAULT_CALLBACK_URL`

## Local build commands
```bash
cd themis-voicebot-runtime
npm install
npm run build
```

## PM2 deployment commands
```bash
cd ~/domeenid/www.api.themis.ee/themis-voicebot
npm install
npm run build
pm2 start dist/index.js --name themis-voicebot
pm2 logs themis-voicebot
pm2 restart themis-voicebot
```

## Docker option
If you use the included Dockerfile:
```bash
docker build -t themis-voicebot-runtime .
docker run -p 3000:3000 --env-file .env themis-voicebot-runtime
```

## Themis Zone / PM2 suggested path
`~/domeenid/www.api.themis.ee/themis-voicebot`

## Twilio URLs to configure
- Voice webhook: https://node.api.themis.ee/twilio/voice
- Media stream: wss://node.api.themis.ee/twilio/stream
- Status callback: https://node.api.themis.ee/twilio/status
- Recording callback: https://node.api.themis.ee/twilio/recording-status

## Verification steps
1. `npm run typecheck` (if available)
2. `npm run build`
3. Start locally: `node dist/index.js` (or PM2 start)
4. `curl https://node.api.themis.ee/health`
5. Test one manual outbound call.

## Manual outbound test
```bash
curl -X POST https://node.api.themis.ee/api/calls/start \
  -H "Content-Type: application/json" \
  -d '{"to_number":"+372...","agent_id":"<THEMIS_AGENT_ID>"}'
```

## Shared code note
This export includes the full orchestrator `src/` tree (including IIZI-related modules used by shared `media-stream.ts`). Configure agents and env for **Themis outbound** only; IIZI deterministic inbound activates only for the IIZI agent profile in Supabase.

## Warning — secrets
Do **not** commit real `.env` files or API keys to Git.

Legacy Intra endpoints are not included yet:
- `/start_calls_campaign_api`
- `/get_campaign_statistics_api`

They must be added as the next step.
