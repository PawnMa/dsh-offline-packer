#!/usr/bin/env bash
# Shared constants / helpers for the independent verification of dsh-offline-packer.
#
#   . /home/fc/dsh-offline-packer/verify/env.sh
#
# Conventions used by every script in this directory:
#   * test hosts are booted on ports 3084 (main), 3085 (offline-installed home),
#     3086 (host-pinned rc.7 historical check); port 3080 is the user's live GUI
#     and is NEVER touched.
#   * every DSH_HOME used here lives under verify/ ... except the read-only scan
#     source /home/fc/.dsh, which is never written.
#   * a booted host leaves three artifacts behind:
#       verify/run/host-<port>.pid      pid of the node process
#       verify/run/host-<port>.env      sourceable: PORT/HOME/PROFILE/DSH_BIN/TOKEN/LOG/BASE
#       verify/run/cookies-<port>.jar   authenticated curl cookie jar
#       verify/logs/host-<port>.log     server stdout+stderr
#   * scripts are idempotent and re-runnable; logs are append-or-replace, never
#     mixed with an older boot.

[ -n "${_VERIFY_ENV_SH:-}" ] && return 0
_VERIFY_ENV_SH=1

VERIFY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)"
PROJECT_DIR="$(cd -- "$VERIFY_DIR/.." >/dev/null 2>&1 && pwd -P)"

# --- hosts ---------------------------------------------------------------
# Development host under test: the user's global dsh 0.2.1-rc.2 install.
DSH_DEV_BIN=/home/fc/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
# Pure 0.1.0-rc.7 host used for historical-version artifacts.
DSH_PINNED_BIN=/home/fc/dsh-plugin-build/host-pinned/node_modules/@deepseek-ai/dsh/lib/bin.js
# Browser tooling (installed once by the Lead in the previous round).
PLAYWRIGHT_DIR=/home/fc/dsh-plugin-build/leadcheck/pw
CHROMIUM_BIN=/home/fc/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome

# --- filesystem ----------------------------------------------------------
USER_DSH_HOME=/home/fc/.dsh          # READ-ONLY scan source; never write here
LOG_DIR="$VERIFY_DIR/logs"
RUN_DIR="$VERIFY_DIR/run"
ART_DIR="$VERIFY_DIR/artifacts"
TMP_DIR="$VERIFY_DIR/tmp"
STAGE_DIR="$TMP_DIR/plugin-src"      # project copy used to install into in-tree homes

# --- ports ---------------------------------------------------------------
PORT_MAIN=3084
PORT_INSTALL=3085
PORT_HIST=3086
LIVE_GUI_PORT=3080

mkdir -p "$LOG_DIR" "$RUN_DIR" "$ART_DIR" "$TMP_DIR"

# --- tiny logging / assertion helpers ------------------------------------
say()  { printf '%s\n' "$*"; }
info() { printf '[info] %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
die()  { printf '\n[fatal] %s\n' "$*" >&2; exit 1; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Refuse to write the real user home: only read-only scans allowed there.
guard_home() {
  local target home
  target="$(realpath -m -- "$1")"
  home="$(realpath -m -- "$USER_DSH_HOME")"
  [ "$target" = "$home" ] && die "refusing to write the real DSH_HOME $USER_DSH_HOME (read-only scan only)"
  case "$target" in
    /home/fc/.dsh/*) die "refusing to write inside the real DSH_HOME ($target)" ;;
  esac
  return 0
}

# The user's live GUI is off limits; verification ports are 3084-3086.
guard_port() {
  [ "$1" = "$LIVE_GUI_PORT" ] && die "port $LIVE_GUI_PORT is the user's live GUI; use 3084-3086"
  case "$1" in
    3084|3085|3086) return 0 ;;
    *) warn "port $1 is outside the reserved verification range 3084-3086" ;;
  esac
  return 0
}

# --- per-host state ------------------------------------------------------
host_pid_file()   { printf '%s/host-%s.pid' "$RUN_DIR" "$1"; }
host_env_file()   { printf '%s/host-%s.env' "$RUN_DIR" "$1"; }
host_cookie_jar() { printf '%s/cookies-%s.jar' "$RUN_DIR" "$1"; }
host_log_file()   { printf '%s/host-%s.log' "$LOG_DIR" "$1"; }

# Load PORT/HOME/PROFILE/DSH_BIN/TOKEN/BASE for a running host. Returns non-zero
# when the env file is absent.
load_host_env() {
  local port="$1" env_file
  env_file="$(host_env_file "$port")"
  [ -f "$env_file" ] || return 1
  # shellcheck disable=SC1090
  . "$env_file"
  return 0
}

# Print the base URL of a booted host (http://127.0.0.1:<port>/?token=...).
host_base_url() {
  local port="$1"
  [ -n "${BASE:-}" ] && { printf '%s' "$BASE"; return 0; }
  load_host_env "$port" || return 1
  printf '%s' "$BASE"
}

# curl wrapper that reuses the authenticated cookie jar created at boot.
# usage: api_curl <port> <curl args...>   (URL passed by the caller)
api_curl() {
  local port="$1"; shift
  local jar
  jar="$(host_cookie_jar "$port")"
  touch "$jar"
  curl -sS --max-time "${API_TIMEOUT:-120}" -b "$jar" -c "$jar" "$@"
}

# Fetch one API path and print the body; extra args after the path are passed
# through. Usage: api_get <port> <path>
api_get() { api_curl "$1" "http://127.0.0.1:$1$2"; }

# POST a JSON body to an API path. Usage: api_post <port> <path> <json>
api_post() {
  api_curl "$1" -X POST -H 'content-type: application/json' --data "$3" "http://127.0.0.1:$1$2"
}

# HTTP status of one API request (body dropped). Usage: api_status <port> <path>
api_status() {
  api_curl "$1" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1$2"
}

# Compact JSON field extraction with node (no jq on this machine).
# usage: json_get <<<"$body" '.value.plugins | length'
json_get() {
  local expr="$1"
  node -e '
    let raw = ""
    process.stdin.on("data", (c) => { raw += c })
    process.stdin.on("end", () => {
      let value
      try { value = JSON.parse(raw) } catch (error) { console.error("invalid JSON: " + error.message); process.exit(2) }
      const rawExpr = process.argv[1]
      const expr = rawExpr.startsWith(".") ? "v" + rawExpr : rawExpr
      const fn = new Function("v", `return (${expr})`)
      let out
      try { out = fn(value) } catch (error) { console.error("expr failed: " + error.message); process.exit(3) }
      process.stdout.write(typeof out === "string" ? out : JSON.stringify(out))
    })
  ' "$expr"
}

# Wait until the given port answers an authenticated GET / with 200.
# usage: wait_http_ready <port> [tries] [sleep]
wait_http_ready() {
  local port="$1" tries="${2:-240}" pause="${3:-0.25}" i code
  local jar; jar="$(host_cookie_jar "$port")"
  for i in $(seq 1 "$tries"); do
    code="$(curl -sS --max-time 2 -b "$jar" -c "$jar" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null || true)"
    [ "$code" = "200" ] && return 0
    sleep "$pause"
  done
  return 1
}

# Kill one booted host (best effort) and clear its state files.
# usage: stop_host <port>
stop_host() {
  local port="$1" pid_file pid
  pid_file="$(host_pid_file "$port")"
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      kill -9 "$pid" 2>/dev/null || true
      echo "[stop] killed host pid=$pid port=$port"
    else
      echo "[stop] host port=$port already stopped"
    fi
    rm -f "$pid_file"
  fi
  rm -f "$(host_env_file "$port")"
}
