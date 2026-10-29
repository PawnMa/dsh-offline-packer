#!/usr/bin/env bash
# Boot one isolated test host for dsh-offline-packer verification.
#
#   bash verify/setup-host.sh                      # plugin host on 3084, verify/home
#   bash verify/setup-host.sh --no-plugin          # plain host (no plugin) on 3084
#   bash verify/setup-host.sh --port 3085 --home verify/home-installed
#   bash verify/setup-host.sh --dsh-bin "$DSH_PINNED_BIN" --port 3086 --home verify/home-historical
#   bash verify/setup-host.sh --stub-client        # dev-only: browser bundle placeholder when client.js is missing
#   bash verify/setup-host.sh --no-start           # only install the plugin into the home
#
# The script copies the current working tree of the project into the profile and
# then runs `test/install-dev-plugin.sh` from a *staged copy* of the project.
# Why the staging copy: verifier homes live inside verify/, which is inside the
# project, and the shipped installer does `cp -a <project> <profile>/node_modules/...`
# -- cp refuses to copy a directory into itself. Installing from the staged copy
# exercises exactly the shipped installer (same script, same code) while keeping
# the destination outside the copy source.
#
# It then starts `dsh --profile <p> --port <port>` in the background, waits for
# the authenticated page to answer 200, and writes:
#   verify/run/host-<port>.pid   verify/run/host-<port>.env
#   verify/run/cookies-<port>.jar   verify/logs/host-<port>.log
# and finally `wait`s for the server: run this script through a managed
# background job (bash tool run_in_background) so it stays alive; stop it with
# `bash verify/setup-host.sh --stop` / job_kill, or run `verify/teardown-host.sh`.
set -uo pipefail
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)/env.sh"

HOME_DIR="$VERIFY_DIR/home"
PROFILE=web
PORT="$PORT_MAIN"
DSH_BIN="$DSH_DEV_BIN"
WITH_PLUGIN=1
STUB_CLIENT=0
START=1
FRESH=0
STOP=0
WAIT_READY=300

usage() {
  sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home)        HOME_DIR="$2"; shift 2 ;;
    --home=*)      HOME_DIR="${1#*=}"; shift ;;
    --profile)     PROFILE="$2"; shift 2 ;;
    --port)        PORT="$2"; shift 2 ;;
    --dsh-bin)     DSH_BIN="$2"; shift 2 ;;
    --no-plugin)   WITH_PLUGIN=0; shift ;;
    --stub-client) STUB_CLIENT=1; shift ;;
    --no-start)    START=0; shift ;;
    --fresh)       FRESH=1; shift ;;
    --stop)        STOP=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

guard_port "$PORT"
guard_home "$HOME_DIR"
# Resolve to an absolute path (relative paths are anchored at the current dir).
case "$HOME_DIR" in
  /*) : ;;
  *) HOME_DIR="$PWD/$HOME_DIR" ;;
esac
HOME_DIR="$(realpath -m -- "$HOME_DIR")"
[ -f "$DSH_BIN" ] || die "dsh bin not found: $DSH_BIN"
[ -f "$DSH_PINNED_BIN" ] || warn "pinned rc.7 host missing: $DSH_PINNED_BIN"

if [ "$STOP" = 1 ]; then
  stop_host "$PORT"
  exit 0
fi

# --- 1) install / prepare the DSH_HOME -----------------------------------
if [ "$FRESH" = 1 ]; then
  stop_host "$PORT"
  info "removing previous test home: $HOME_DIR"
  rm -rf -- "$HOME_DIR"
fi
mkdir -p "$HOME_DIR"

if [ "$WITH_PLUGIN" = 1 ]; then
  info "installing dev plugin into $HOME_DIR (profile $PROFILE)"
  if ! bash "$PROJECT_DIR/test/install-dev-plugin.sh" "$HOME_DIR" "$PROFILE"; then
    # Older revisions of the shipped installer could not copy the project into a
    # home that lives inside the checkout; fall back to installing from a staged
    # copy (same installer, destination outside the copy source).
    warn "direct install failed; retrying from a staged project copy"
    rm -rf -- "$STAGE_DIR"
    mkdir -p "$STAGE_DIR"
    tar -C "$PROJECT_DIR" --exclude=./verify -cf - . | tar -C "$STAGE_DIR" -xf - \
      || die "failed to stage the project"
    bash "$STAGE_DIR/test/install-dev-plugin.sh" "$HOME_DIR" "$PROFILE" \
      || die "install-dev-plugin.sh failed (both direct and staged)"
  fi

  PLUGIN_DEST="$HOME_DIR/profiles/$PROFILE/node_modules/dsh-offline-packer"
  [ -f "$PLUGIN_DEST/package.json" ] || die "plugin was not installed: $PLUGIN_DEST/package.json missing"
  if [ ! -f "$PLUGIN_DEST/client.js" ]; then
    if [ "$STUB_CLIENT" = 1 ]; then
      warn "client.js is missing from the working tree (client owner not delivered yet)"
      warn "installing a VERIFY-ONLY placeholder client bundle into the installed copy only"
      cat > "$PLUGIN_DEST/client.js" <<'STUB'
/* VERIFY-ONLY placeholder client bundle.
 * Written by verify/setup-host.sh --stub-client into the *installed test copy*
 * because client.js has not been delivered yet. It deregisters nothing and
 * renders nothing: it only lets dsh-client-modules boot the host so the rest of
 * the environment (HTTP API, browser chain) can be validated. Never ship this. */
window.__ModuleLoader__.load({
  id: 'dsh-offline-packer',
  factory() {
    return { inject: [], apply() {} }
  },
})
STUB
    else
      warn "client.js missing: dsh-client-modules will refuse to boot this host (expected until the client task lands)"
    fi
  fi
  info "installed plugin files:"
  ( cd "$PLUGIN_DEST" && find . -maxdepth 2 -type f | sort | head -30 )
else
  info "plain host (no dev plugin installed) home=$HOME_DIR"
fi

if [ "$START" = 0 ]; then
  info "install-only mode requested (--no-start); not starting a server"
  exit 0
fi

# --- 2) start the server -------------------------------------------------
# Each bash tool call runs in its own PID namespace, so a process started by a
# *previous* call cannot be killed from this one (kill/pids are namespace-local).
# Port ownership across calls is therefore decided by the harness: stop an old
# host with job_kill on its managed background job, then re-run this script.
if code="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)" && [ -n "$code" ] && [ "$code" != "000" ]; then
  die "port $PORT is already in use by another host (HTTP $code); job_kill its managed background job first, then re-run"
fi
stop_host "$PORT" >/dev/null 2>&1 || true
LOG="$(host_log_file "$PORT")"
PIDFILE="$(host_pid_file "$PORT")"
ENVFILE="$(host_env_file "$PORT")"
JAR="$(host_cookie_jar "$PORT")"
RUN_CWD="$TMP_DIR/run-cwd"
mkdir -p "$RUN_CWD"
rm -f "$LOG" "$JAR" "$ENVFILE" "$PIDFILE"

# rc.7 (historical host) has no --no-open flag: pass it only when supported.
EXTRA_ARGS=()
HOST_VERSION="$(node "$DSH_BIN" --version 2>/dev/null | head -1)"
case "$HOST_VERSION" in
  0.2.*) EXTRA_ARGS+=(--no-open) ;;
esac
info "starting: DSH_HOME=$HOME_DIR node $DSH_BIN --profile $PROFILE --port $PORT ${EXTRA_ARGS[*]:-}"
( cd "$RUN_CWD" && DSH_HOME="$HOME_DIR" exec node "$DSH_BIN" --profile "$PROFILE" --port "$PORT" "${EXTRA_ARGS[@]}" ) \
  >"$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"
info "server pid=$PID log=$LOG"

TOKEN=""
ready=0
for i in $(seq 1 "$WAIT_READY"); do
  if [ -z "$TOKEN" ]; then
    TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  fi
  if [ -n "$TOKEN" ]; then
    # 0.2.x web gate: bootstrap the auth cookie from the printed ?token= URL.
    code="$(curl -sS --max-time 3 -c "$JAR" -b "$JAR" -L -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:$PORT/?token=$TOKEN" 2>/dev/null || true)"
  else
    # 0.1.x (rc.7) web has no token gate: an unauthenticated GET / is 200.
    code="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || true)"
  fi
  if [ "$code" = "200" ]; then ready=1; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 0.25
done

if [ "$ready" != 1 ]; then
  echo "===== HOST DID NOT BECOME READY (port $PORT) =====" >&2
  tail -60 "$LOG" >&2 || true
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  die "host failed to boot on port $PORT; see $LOG"
fi

if [ -n "$TOKEN" ]; then
  BASE="http://127.0.0.1:$PORT/?token=$TOKEN"
else
  BASE="http://127.0.0.1:$PORT/"
fi
cat > "$ENVFILE" <<EOF
PORT=$PORT
HOME=$HOME_DIR
PROFILE=$PROFILE
DSH_BIN=$DSH_BIN
DSH_VERSION=$("$DSH_BIN" --version 2>/dev/null | head -1)
TOKEN=$TOKEN
BASE=$BASE
LOG=$LOG
PID=$PID
STARTED_AT=$(now_iso)
EOF
# token is a secret for this boot only; keep it readable by this user.
chmod 600 "$ENVFILE" "$JAR" 2>/dev/null || true

say ""
say "HOST_READY port=$PORT pid=$PID"
say "  home      : $HOME_DIR"
say "  profile   : $PROFILE"
say "  dsh bin   : $DSH_BIN"
say "  base      : $BASE"
say "  env file  : $ENVFILE"
say "  log       : $LOG"
say "  token     : $TOKEN"
say ""
say "Now probing: curl -sS -b $JAR http://127.0.0.1:$PORT/dsh-offline-packer/api/state"
say "(keep this process alive while testing; stop with job_kill or --stop)"
say ""

# Park until the server exits or the job is killed.
wait "$PID"
rc=$?
info "server exited rc=$rc"
exit "$rc"
