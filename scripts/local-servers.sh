#!/usr/bin/env bash
# Local terminal servers: list them, or turn them off.
#
# The terminal app is HOSTED ON THE VPS (https://charts.allofthesewords.com/terminal/,
# deployed by scripts/deploy-vps.sh). A node server should exist on a dev machine
# ONLY while a test is running — scripts/with-dev-server.sh guarantees that by
# shutting its server down on exit. This script is the safety net around it:
#
#   bash scripts/local-servers.sh list     # what is up right now?
#   bash scripts/local-servers.sh stop     # kill it (server + children) and verify
#   bash scripts/local-servers.sh status   # exit 0 when clean, 1 when something is up
#
# "status" is the check to run before you walk away, or from a session hook.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$REPO_ROOT/.dev-server.pid"
# Ports a local terminal server can occupy: vite dev, a built `.output` server,
# and the port scripts/deploy-vps.sh uses to snapshot index.html.
PORTS="${TERMINAL_DEV_PORTS:-3000 3100 3129}"

is_windows() {
	case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) return 0 ;; *) return 1 ;; esac
}

# "pid<TAB>command line" for every node process on this machine.
node_processes() {
	if is_windows; then
		MSYS_NO_PATHCONV=1 powershell -NoProfile -ExecutionPolicy Bypass \
			-File "$REPO_ROOT/scripts/lib/node-processes.ps1" 2>/dev/null
	else
		ps -eo pid=,args= 2>/dev/null | awk '{ pid = $1; $1 = ""; sub(/^ +/, ""); print pid "\t" $0 }'
	fi
}

# Local terminal servers: a vite dev server, or a built `.output/server` bundle.
# Deliberately a heuristic on the command line — it is reported, never silent, and
# TERMINAL_DEV_MATCH can narrow it further on an unusual setup.
discover() {
	node_processes | awk -F'\t' -v extra="${TERMINAL_DEV_MATCH:-}" '
		{
			cmd = tolower($2)
			if (cmd ~ /vite/ || cmd ~ /\.output[\/\\]server/ || (extra != "" && cmd ~ tolower(extra))) print
		}
	'
}

# "pid<TAB>port" for anything listening on the candidate ports.
listening() {
	local port pids
	for port in $PORTS; do
		if is_windows; then
			pids="$(MSYS_NO_PATHCONV=1 netstat -ano 2>/dev/null |
				awk -v suffix=":$port" '$0 ~ /LISTENING/ && index($2, suffix) { print $NF }' | sort -u)"
		else
			pids="$( (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) |
				awk -v suffix=":$port" '$0 ~ /LISTEN/ && index($4, suffix) { print $NF }' | grep -o '[0-9]\+' | sort -u)"
		fi
		for pid in $pids; do
			printf '%s\t%s\n' "$pid" "$port"
		done
	done
}

kill_tree() {
	local pid="$1"
	# The dev server spawns children (esbuild, the nitro worker); kill the tree or
	# they outlive the parent and keep the port.
	if is_windows; then
		MSYS_NO_PATHCONV=1 taskkill /PID "$pid" /T /F >/dev/null 2>&1
	else
		pkill -TERM -P "$pid" >/dev/null 2>&1
		kill -TERM "$pid" >/dev/null 2>&1
	fi
}

describe() {
	printf '  pid %-7s %s\n' "$1" "$2"
}

cmd_list() {
	local found listening_found
	found="$(discover)"
	listening_found="$(listening)"

	if [ -z "$found" ] && [ -z "$listening_found" ]; then
		echo "OK: no local terminal server running (ports: $PORTS)"
		return 0
	fi

	echo "Local terminal server(s) found:"
	[ -n "$found" ] && echo "$found" | while IFS=$'\t' read -r pid cmd; do describe "$pid" "$cmd"; done
	[ -n "$listening_found" ] && echo "Listening:" && echo "$listening_found" |
		while IFS=$'\t' read -r pid port; do describe "$pid" "port $port"; done
	[ -f "$PID_FILE" ] && echo "  (tracked pid file: $(cat "$PID_FILE"))"
	echo
	echo "Turn it off with: bash scripts/local-servers.sh stop"
	return 1
}

cmd_stop() {
	local found pids pid
	found="$(discover)"

	if [ -f "$PID_FILE" ]; then
		pid="$(cat "$PID_FILE" 2>/dev/null || true)"
		if [ -n "${pid:-}" ]; then
			echo "Stopping tracked pid $pid"
			kill_tree "$pid"
		fi
		rm -f "$PID_FILE"
	fi

	if [ -n "$found" ]; then
		echo "$found" | while IFS=$'\t' read -r pid cmd; do
			echo "Stopping pid $pid"
			kill_tree "$pid"
		done
	fi

	# Anything still holding a candidate port (e.g. a stray child).
	for pid in $(listening | awk -F'\t' '{ print $1 }' | sort -u); do
		echo "Stopping pid $pid still holding a port"
		kill_tree "$pid"
	done

	sleep 1
	if [ -z "$(discover)" ] && [ -z "$(listening)" ]; then
		echo "OK: all local terminal servers stopped (ports: $PORTS free)"
		return 0
	fi
	echo "WARNING: something is still up:" >&2
	cmd_list >&2
	return 1
}

cmd_status() {
	if [ -z "$(discover)" ] && [ -z "$(listening)" ]; then
		echo "clean"
		return 0
	fi
	echo "dirty"
	return 1
}

case "${1:-list}" in
list | ls | status-list) cmd_list ;;
stop | kill | down) cmd_stop ;;
status) cmd_status ;;
*)
	echo "usage: bash scripts/local-servers.sh [list|stop|status]" >&2
	exit 2
	;;
esac
