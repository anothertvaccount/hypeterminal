#!/usr/bin/env bash
# Build the terminal for the /terminal/ subpath and push it to the VPS static dir.
# Run from anywhere:  bash scripts/deploy-vps.sh
#
# The build bakes VITE_BASE_PATH (assets, router links, TV library path, icons all
# resolve under /terminal/), snapshots the SSR HTML as the static index.html, then
# tars the public dir straight onto the server. Pure static — no process to manage.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_PATH="${BASE_PATH:-/terminal/}"
REMOTE="my-vps"
DEST="/home/allofthesewords/domains/charts.allofthesewords.com/public_html/terminal"

# Git-bash mangles POSIX-looking env values (/terminal/ -> /Program Files/Git/...)
export MSYS_NO_PATHCONV=1

echo "==> building (base=$BASE_PATH)"
# The deployed site boots into LIVE mode (the in-app pill still switches either way).
# Local dev keeps VITE_PAPER_TRADE=true so the browser test suite exercises the
# simulated book (paper positions/orders are injected there).
VITE_BASE_PATH="$BASE_PATH" VITE_PAPER_TRADE=false pnpm build

echo "==> snapshotting SSR html as static index.html"
cd apps/terminal
PORT="${CAPTURE_PORT:-3129}" node .output/server/index.mjs >/tmp/deploy-capture.log 2>&1 &
CAPTURE_PID=$!
trap 'kill "$CAPTURE_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 15); do
	code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${CAPTURE_PORT:-3129}${BASE_PATH}" || true)
	[ "$code" = "200" ] && break
	sleep 1
done
curl -sf -o .output/public/index.html "http://localhost:${CAPTURE_PORT:-3129}${BASE_PATH}"
kill "$CAPTURE_PID" 2>/dev/null || true
trap - EXIT
grep -q "assets/" .output/public/index.html
echo "    index.html: $(wc -c < .output/public/index.html) bytes"

echo "==> uploading to $REMOTE:$DEST"
ssh -o BatchMode=yes "$REMOTE" "mkdir -p '$DEST'"
tar -C .output/public -cf - . | ssh -o BatchMode=yes "$REMOTE" "tar -xf - -C '$DEST'"

# SPA fallback for client-side routes (deep links like /terminal/perp).
ssh -o BatchMode=yes "$REMOTE" "cat > '$DEST/.htaccess'" << 'HTEOF'
# Terminal SPA: serve real files, fall back to the app shell for client routes.
RewriteEngine On
RewriteBase /terminal/
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^ index.html [L]
HTEOF

echo "==> done: https://charts.allofthesewords.com${BASE_PATH}"
