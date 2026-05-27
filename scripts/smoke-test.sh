#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
url="${BASE_URL%/}${HEALTH_PATH}"
echo "GET $url"
code=$(curl -fsS -o /dev/null -w "%{http_code}" "$url" || echo "000")
if [[ "$code" != "200" ]]; then
  echo "Health check failed: HTTP $code" >&2
  exit 1
fi
echo "OK HTTP $code"
