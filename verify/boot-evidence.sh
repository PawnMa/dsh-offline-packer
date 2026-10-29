#!/usr/bin/env bash
# Collect boot evidence from a running verification host.
#
#   bash verify/boot-evidence.sh 3085 --expect-plugin dsh-unlag
#   bash verify/boot-evidence.sh 3086 --expect-plugin dsh-better-sidebar \
#        --probe "POST /sidebar/api/terminal.deps" --probe "POST /sidebar/api/settings.get"
#   bash verify/boot-evidence.sh 3084 --expect-plugin dsh-offline-packer \
#        --probe "GET /dsh-offline-packer/api/state"
#
# The host must have been started through a managed background job
# (setup-host.sh), so verify/run/host-<port>.env exists with its token and
# cookie jar. Evidence:
#   * startup log has no hard failures (entry apply failed / duplicate prefix
#     route / FAILED fiber / Cannot resolve / ERR_MODULE_NOT_FOUND / uncaught)
#   * GET / -> 200 (authenticated)
#   * window.__DSH_BOOT__ manifest parses, contains the expected plugin, and its
#     client bundle URL returns 200
#   * --dump-config contains the expected plugin (bundle patch applied)
#   * each --probe request answers 2xx (and {ok:true} when JSON)
# Prints EVIDENCE_RESULT=PASS/FAIL and exits non-zero on any hard failure.
set -uo pipefail
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)/env.sh"

PORT="$PORT_MAIN"
EXPECT_PLUGIN=""
ABSENT_PLUGIN=""
PROBES=()
CLIENT_SUBSTR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port)           PORT="$2"; shift 2 ;;
    --expect-plugin)  EXPECT_PLUGIN="$2"; shift 2 ;;
    --absent-plugin)  ABSENT_PLUGIN="$2"; shift 2 ;;
    --expect-client)  CLIENT_SUBSTR="$2"; shift 2 ;;
    --probe)          PROBES+=("$2"); shift 2 ;;
    -h|--help)        sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -[0-9]*)          PORT="${1#-}"; shift ;;
    *)                PORT="$1"; shift ;;   # allow: boot-evidence.sh 3085 ...
  esac
done

guard_port "$PORT"
load_host_env "$PORT" || die "no running host state for port $PORT (verify/run/host-$PORT.env missing)"
[ -f "$LOG" ] || die "host log missing: $LOG"

OUT="$ART_DIR/evidence-$PORT-$(date -u +%H%M%S)"
mkdir -p "$ART_DIR"
FAILS=0
say "===== boot-evidence port=$PORT home=$HOME ====="
say "dsh=$DSH_BIN ($DSH_VERSION) plugin-expected=${EXPECT_PLUGIN:-<any>}"
say ""

# --- 1) startup log scan -------------------------------------------------
say "--- startup log (${LOG}) ---"
HARD="$(grep -niE 'entry apply failed|duplicate prefix route|FAILED fiber|Cannot resolve|ERR_MODULE_NOT_FOUND|uncaught|startup failed|failed to import' "$LOG" || true)"
if [ -z "$HARD" ]; then
  chk_ok=1; say "PASS  startup log: no hard failures"
else
  chk_ok=0; FAILS=$((FAILS + 1))
  say "FAIL  startup log hard failures:"
  printf '%s\n' "$HARD" | head -20 | sed 's/^/      /'
fi
grep -niE 'warning|did not activate' "$LOG" | head -10 | sed 's/^/      warn-line: /' || true
say "      log line count: $(wc -l < "$LOG")"

# --- 2) authenticated page ----------------------------------------------
CODE="$(api_curl "$PORT" -o "$OUT.index.html" -w '%{http_code}' "http://127.0.0.1:$PORT/")"
say "GET / -> HTTP $CODE size=$(wc -c < "$OUT.index.html")"
if [ "$CODE" = "200" ]; then say "PASS  GET / 200"; else say "FAIL  GET / = $CODE"; FAILS=$((FAILS + 1)); fi

# --- 3) boot manifest ----------------------------------------------------
say ""
say "--- window.__DSH_BOOT__ manifest ---"
node - "$OUT.index.html" "${EXPECT_PLUGIN:-}" "${ABSENT_PLUGIN:-}" > "$OUT.manifest.txt" 2>&1 <<'NODE'
const fs = require('fs')
const [htmlPath, expect, absent] = process.argv.slice(2)
const html = fs.readFileSync(htmlPath, 'utf8')
const m = html.match(/(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*([\s\S]*?)<\/script>/)
if (!m) { console.log('FAIL: window.__DSH_BOOT__ not found in HTML'); process.exit(2) }
let graph
try { graph = JSON.parse(m[1].replaceAll('\\u003c', '<')) } catch (error) { console.log('FAIL: boot manifest is not valid JSON: ' + error.message); process.exit(2) }
const rows = Array.isArray(graph) ? graph : (graph.entries || graph.rows || graph)
console.log('boot manifest bytes: ' + m[1].length + ', entries: ' + rows.length)
const ids = rows.map((r) => String(r?.id ?? '')).filter(Boolean)
console.log('entry ids: ' + ids.slice(0, 60).join(', '))
if (expect) {
  const hit = ids.some((id) => id.includes(expect))
  console.log('manifest contains "' + expect + '": ' + (hit ? 'YES' : 'NO'))
  process.exit(hit ? 0 : 3)
}
if (absent) {
  const hit = ids.some((id) => id.includes(absent))
  console.log('manifest contains "' + absent + '" (must be absent): ' + (hit ? 'YES -> FAIL' : 'NO -> PASS'))
  process.exit(hit ? 3 : 0)
}
process.exit(0)
NODE
MANIFEST_RC=$?
cat "$OUT.manifest.txt" | sed 's/^/      /'
[ "$MANIFEST_RC" = 0 ] || { FAILS=$((FAILS + 1)); say "FAIL  boot manifest check (node exit $MANIFEST_RC)"; }

if [ -z "$ABSENT_PLUGIN" ]; then
CLIENT_URL="$(node - "$OUT.index.html" "${EXPECT_PLUGIN:-}" "$CLIENT_SUBSTR" <<'NODE'
const fs = require('fs')
const [htmlPath, expect, clientSubstr] = process.argv.slice(2)
const html = fs.readFileSync(htmlPath, 'utf8')
const m = html.match(/(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*([\s\S]*?)<\/script>/)
if (!m) process.exit(1)
let graph
try { graph = JSON.parse(m[1].replaceAll('\\u003c', '<')) } catch { process.exit(1) }
const rows = Array.isArray(graph) ? graph : (graph.entries || graph.rows || [])
const pick = clientSubstr
  ? rows.find((r) => String(r?.url ?? '').includes(clientSubstr))
  : rows.find((r) => String(r?.id ?? '').includes(expect))
process.stdout.write(pick?.url ?? '')
NODE
)"
if [ -n "$CLIENT_URL" ]; then
  case "$CLIENT_URL" in /*) : ;; *) CLIENT_URL="/$CLIENT_URL" ;; esac
  CCODE="$(api_curl "$PORT" -o "$OUT.client.js" -w '%{http_code}' "http://127.0.0.1:$PORT$CLIENT_URL")"
  say "GET client bundle $CLIENT_URL -> HTTP $CCODE size=$(wc -c < "$OUT.client.js")"
  if [ "$CCODE" = "200" ] && [ "$(wc -c < "$OUT.client.js")" -gt 100 ]; then
    say "PASS  plugin client bundle served"
  else
    say "FAIL  plugin client bundle not served (HTTP $CCODE)"; FAILS=$((FAILS + 1))
  fi
else
  say "WARN  no client bundle URL found in manifest for ${EXPECT_PLUGIN:-<any>}"
fi
fi

# --- 4) dump-config ------------------------------------------------------
say ""
say "--- --dump-config ---"
( cd "$TMP_DIR/run-cwd" 2>/dev/null || cd "$TMP_DIR"; DSH_HOME="$HOME" node "$DSH_BIN" --profile "$PROFILE" --dump-config ) > "$OUT.dump-config.txt" 2>&1
DUMP_RC=$?
say "dump-config exit=$DUMP_RC lines=$(wc -l < "$OUT.dump-config.txt")"
if [ -n "$ABSENT_PLUGIN" ]; then
  HITS="$(grep -cF "$ABSENT_PLUGIN" "$OUT.dump-config.txt" || true)"
  if [ "$DUMP_RC" = 0 ] && [ "$HITS" = 0 ]; then
    say "PASS  dump-config has no $ABSENT_PLUGIN line (hits=0)"
  else
    say "FAIL  dump-config still mentions $ABSENT_PLUGIN (hits=$HITS rc=$DUMP_RC)"; FAILS=$((FAILS + 1))
  fi
elif [ -n "$EXPECT_PLUGIN" ]; then
  HITS="$(grep -cF "$EXPECT_PLUGIN" "$OUT.dump-config.txt" || true)"
  if [ "$DUMP_RC" = 0 ] && [ "$HITS" -gt 0 ]; then
    say "PASS  dump-config mentions $EXPECT_PLUGIN ($HITS lines)"
    grep -nF "$EXPECT_PLUGIN" -A2 "$OUT.dump-config.txt" | head -8 | sed 's/^/      /'
  else
    say "FAIL  dump-config does not mention $EXPECT_PLUGIN (hits=$HITS rc=$DUMP_RC)"; FAILS=$((FAILS + 1))
  fi
fi

# --- 5) extra probes -----------------------------------------------------
for probe in "${PROBES[@]:-}"; do
  [ -n "$probe" ] || continue
  method="${probe%% *}"
  rest="${probe#* }"
  path="${rest%% *}"
  body=""
  case "$rest" in *" "*) body="${rest#* }" ;; esac
  tmp="$OUT.probe-$(echo "$path" | tr '/?=&' '____').json"
  if [ -n "$body" ]; then
    CODE="$(api_curl "$PORT" -o "$tmp" -w '%{http_code}' -X "$method" -H 'content-type: application/json' --data "$body" "http://127.0.0.1:$PORT$path")"
  else
    CODE="$(api_curl "$PORT" -o "$tmp" -w '%{http_code}' -X "$method" "http://127.0.0.1:$PORT$path")"
  fi
  BODY="$(head -c 400 "$tmp" 2>/dev/null || true)"
  say "PROBE $method $path -> $CODE ${BODY}"
  ok_json=1
  case "$CODE" in 2*) : ;; *) ok_json=0 ;; esac
  if printf '%s' "$BODY" | grep -q '"ok":true'; then :; else
    # 200 without a JSON envelope is acceptable only for non-JSON routes
    case "$BODY" in '{'*) ok_json=0 ;; esac
  fi
  if [ "$ok_json" = 1 ]; then say "PASS  probe $method $path"; else say "FAIL  probe $method $path (HTTP $CODE)"; FAILS=$((FAILS + 1)); fi
done

say ""
if [ "$FAILS" = 0 ]; then
  say "EVIDENCE_RESULT=PASS port=$PORT home=$HOME artifacts=$OUT.*"
  exit 0
fi
say "EVIDENCE_RESULT=FAIL failures=$FAILS port=$PORT"
exit 1
