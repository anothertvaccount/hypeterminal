#!/usr/bin/env bash
# Run a command against a TRANSIENT local dev server.
#
#   bash scripts/with-dev-server.sh -- node scripts/probe-mobile-link.mjs
#   bash scripts/with-dev-server.sh -- node scripts/check-mobile.mjs
#   pnpm with-dev-server -- node scripts/probe-mobile-link.mjs
#
# The terminal app is HOSTED ON THE VPS. A local server exists only for the
# duration of the command: it is started, waited for, and ALWAYS stopped again on
# exit — success, failure, Ctrl-C or crash — so nothing is left listening. The
# `BASE_URL` environment variable is exported for the command to use.
#
# It refuses to start when a server is already up, which is what keeps a second
# instance from appearing. Use `bash scripts/local-servers.sh stop` for that case.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$REPO_ROOT/.dev-server.pid"
LOG_FILE="${TMPDIR:-/tmp}/terminal-dev-server.log"
PORT="${DEV_PORT:-3000}"
BASE_URL="${BASE_URL:-http://localhost:${PORT}/}"
READY_TIMEOUT="${READY_TIMEOUT:-90}"

is_windows() {
	case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) return 0 ;; *) return 1 ;; esac
}

listening_pids() {
	if is_windows; then
		MSYS_NO_PATHCONV=1 netstat -ano 2>/dev/null |
			awk -v suffix=":$PORT" '$0 ~ /LISTENING/ && index($2, suffix) { print $NF }' | sort -u
	else
		(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) |
			awk -v suffix=":$PORT" '$0 ~ /LISTEN/ && index($4, suffix) { print $NF }' | grep -o '[0-9]\+' | sort -u
	fi
}

DEV_PID=""
cleanup() {
	local status=$?
	if [ -n "$DEV_PID" ]; then
		if is_windows; then
			MSYS_NO_PATHCONV=1 taskkill /PID "$DEV_PID" /T /F >/dev/null 2>&1 || true
		else
			pkill -TERM -P "$DEV_PID" >/dev/null 2>&1 || true
			kill -TERM "$DEV_PID" >/dev/null 2>&1 || true
		fi
	fi
	rm -f "$PID_FILE"
	sleep 1
	for pid in $(listening_pids); do
		if is_windows; then
			MSYS_NO_PATHCONV=1 taskkill /PID "$pid" /T /F >/dev/null 2>&1 || true
		else
			kill -TERM "$pid" >/dev/null 2>&1 || true
		fi
	done
	sleep 1
	if [ -n "$(listening_pids)" ]; then
		echo "WARNING: port $PORT still in use — run: bash scripts/local-servers.sh stop" >&2
	else
		echo "==> local dev server stopped (port $PORT free)"
	fi
	return $status
}
trap cleanup EXIT INT TERM

if [ "$#" -eq 0 ]; then
	echo "usage: bash scripts/with-dev-server.sh -- <command> [args...]" >&2
	exit 2
fi
if [ "${1:-}" = "--" ]; then shift; fi

# Preflight: never start a second instance.
existing="$(listening_pids)"
if [ -n "$existing" ]; then
	echo "A server is already listening on port $PORT (pid $(echo "$existing" | tr '\n' ' '))." >&2
	echo "Stop it first:  bash scripts/local-servers.sh stop" >&2
	echo "Or reuse it without the wrapper by passing BASE_URL." >&2
	exit 1
fi

echo "==> starting dev server on $PORT (log: $LOG_FILE)"
: >"$LOG_FILE"
(
	cd "$REPO_ROOT"
	exec pnpm --filter @hypeterminal/terminal dev --port "$PORT" --strictPort
) >>"$LOG_FILE" 2>&1 &
DEV_PID=$!
echo "$DEV_PID" >"$PID_FILE"

ready=""
for _ in $(seq 1 "$READY_TIMEOUT"); do
	if [ -n "$(listening_pids)" ] && curl -sf -o /dev/null "$BASE_URL" 2>/dev/null; then
		ready="yes"
		break
	fi
	if ! kill -0 "$DEV_PID" 2>/dev/null; then
		echo "Dev server exited during startup. Last log lines:" >&2
		tail -n 20 "$LOG_FILE" >&2
		exit 1
	fi
	sleep 1
done
if [ -z "$ready" ]; then
	echo "Dev server did not become ready within ${READY_TIMEOUT}s. Last log lines:" >&2
	tail -n 20 "$LOG_FILE" >&2
	exit 1
fi

echo "==> ready: $BASE_URL"
echo "==> running: $*"
export BASE_URL PORT
status=0
"$@" || status=$?
echo "==> command finished (exit $status)"
exit "$status"
