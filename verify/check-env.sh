#!/usr/bin/env bash
# Read-only environment self-check for the independent verification session.
#
#   bash verify/check-env.sh
#
# Verifies the external tooling the formal verification depends on:
#   node / npm / pnpm, global dsh 0.2.1-rc.2 host, pure rc.7 pinned host,
#   playwright-core, chromium binary, npm registry reachability,
#   verification ports 3084-3086 free, live GUI on 3080 still answering,
#   read-only visibility of /home/fc/.dsh (plugin profile).
#
# Writes a transcript to verify/logs/check-env.log (tee) and never writes
# outside verify/.
set -uo pipefail
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)/env.sh"

LOG="$LOG_DIR/check-env.log"
: > "$LOG"
# tee everything this script prints, keeping exit codes intact.
exec > >(tee -a "$LOG") 2>&1

FAILS=0
ok()   { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
note() { printf 'INFO  %s\n' "$*"; }

say "===== check-env $(now_iso) ====="

# --- runtime -------------------------------------------------------------
NODE_V="$(node -v 2>/dev/null || true)"
[ -n "$NODE_V" ] && ok "node $NODE_V" || bad "node not found"
NPM_V="$(npm -v 2>/dev/null || true)"
[ -n "$NPM_V" ] && ok "npm $NPM_V" || bad "npm not found"
PNPM_V="$(pnpm -v 2>/dev/null || true)"
[ -n "$PNPM_V" ] && ok "pnpm $PNPM_V" || bad "pnpm not found"
note "unzip $(unzip -v 2>/dev/null | head -1)"
note "curl  $(curl --version 2>/dev/null | head -1)"
note "python3 $(python3 --version 2>/dev/null)"

# --- DSH hosts -----------------------------------------------------------
if [ -f "$DSH_DEV_BIN" ]; then
  DEV_V="$(node "$DSH_DEV_BIN" --version 2>/dev/null | head -1)"
  [ "$DEV_V" = "0.2.1-rc.2" ] && ok "dev host $DEV_V ($DSH_DEV_BIN)" \
    || bad "dev host version unexpected: '$DEV_V' expected 0.2.1-rc.2"
else
  bad "dev host missing: $DSH_DEV_BIN"
fi
if [ -f "$DSH_PINNED_BIN" ]; then
  PIN_V="$(node "$DSH_PINNED_BIN" --version 2>/dev/null | head -1)"
  [ "$PIN_V" = "0.1.0-rc.7" ] && ok "pinned rc.7 host $PIN_V ($DSH_PINNED_BIN)" \
    || bad "pinned host version unexpected: '$PIN_V' expected 0.1.0-rc.7"
else
  bad "pinned rc.7 host missing: $DSH_PINNED_BIN"
fi

# --- browser tooling -----------------------------------------------------
if [ -f "$PLAYWRIGHT_DIR/node_modules/playwright-core/package.json" ]; then
  PW_V="$(node -e 'console.log(require(process.argv[1]).version)' "$PLAYWRIGHT_DIR/node_modules/playwright-core/package.json" 2>/dev/null)"
  ok "playwright-core ${PW_V:-?} ($PLAYWRIGHT_DIR)"
else
  bad "playwright-core missing under $PLAYWRIGHT_DIR"
fi
if [ -x "$CHROMIUM_BIN" ]; then
  ok "chromium $(du -h "$CHROMIUM_BIN" | cut -f1) ($CHROMIUM_BIN)"
else
  bad "chromium binary missing: $CHROMIUM_BIN"
fi

# --- network -------------------------------------------------------------
REG_CODE="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/@deepseek-ai%2fdsh 2>/dev/null || true)"
[ "$REG_CODE" = "200" ] && ok "registry.npmjs.org reachable (HTTP 200)" || bad "registry.npmjs.org unreachable (HTTP ${REG_CODE:-none})"

# --- ports ---------------------------------------------------------------
for port in "$PORT_MAIN" "$PORT_INSTALL" "$PORT_HIST"; do
  code="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null || true)"
  if [ -z "$code" ] || [ "$code" = "000" ]; then ok "port $port free"; else bad "port $port already in use (HTTP $code)"; fi
done
LIVE_CODE="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$LIVE_GUI_PORT/" 2>/dev/null || true)"
LIVE_EFFECTIVE="${LIVE_CODE:-000}"
[ "$LIVE_EFFECTIVE" = "401" ] || [ "$LIVE_EFFECTIVE" = "200" ] \
  && ok "live GUI on $LIVE_GUI_PORT answering (HTTP $LIVE_EFFECTIVE; left untouched)" \
  || note "live GUI on $LIVE_GUI_PORT gave HTTP $LIVE_EFFECTIVE (not touched, informational)"

# --- read-only scan source ----------------------------------------------
PROFILE_PKG="$USER_DSH_HOME/profiles/web/package.json"
if [ -f "$PROFILE_PKG" ]; then
  read -r dep_count bundle_count < <(node -e '
    const p = require(process.argv[1])
    console.log(Object.keys(p.dependencies ?? {}).length, (p.dsh?.profile?.bundles ?? []).length)
  ' "$PROFILE_PKG" 2>/dev/null)
  ok "read-only scan source $USER_DSH_HOME: dependencies=${dep_count:-?} bundles=${bundle_count:-?}"
  note "  plugins: $(node -e 'const p=require(process.argv[1]);console.log(Object.keys(p.dependencies??{}).join(", "))' "$PROFILE_PKG" 2>/dev/null | head -c 400)"
else
  bad "user profile manifest not readable: $PROFILE_PKG"
fi

say ""
if [ "$FAILS" = 0 ]; then
  say "ENV_CHECK=PASS"
  exit 0
fi
say "ENV_CHECK=FAIL failures=$FAILS"
exit 1
