#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$REPO_ROOT/themis-voicebot-runtime"
ORCH="$REPO_ROOT/orchestrator"
mkdir -p "$DEST/src" "$DEST/scripts"
rsync -a --exclude node_modules --exclude dist --exclude .env --exclude .env.local \
  "$ORCH/src/" "$DEST/src/"
cp "$ORCH/package-lock.json" "$DEST/package-lock.json"
cp "$ORCH/Dockerfile" "$DEST/Dockerfile"
echo "COPY_OK files=$(find "$DEST/src" -name '*.ts' | wc -l)"
