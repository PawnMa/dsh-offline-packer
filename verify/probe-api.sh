#!/usr/bin/env bash
# curl wrapper / assertion tool for the dsh-offline-packer HTTP API.
#
#   bash verify/probe-api.sh base
#   bash verify/probe-api.sh state [--home /home/fc/.dsh] [--profile web] [--min-plugins 10]
#   bash verify/probe-api.sh plugins [--home ...]
#   bash verify/probe-api.sh matrix dsh-better-sidebar [--min-versions 30]
#   bash verify/probe-api.sh package-local dsh-unlag [--home ...] [--target 0.2.1-rc.2]
#   bash verify/probe-api.sh package-registry dsh-better-sidebar 0.13.1 0.1.0-rc.7
#   bash verify/probe-api.sh job <jobId>
#   bash verify/probe-api.sh poll <jobId> [--timeout 600] [--interval 1]
#   bash verify/probe-api.sh download <zipName> [destDir]
#   bash verify/probe-api.sh raw GET /api/state [jsonBody]
#   bash verify/probe-api.sh fence GET /api/state
#
# Global options (before or after the command):
#   --port <N>     host port (default 3084, read from verify/run/host-<port>.env)
#   --json         print the raw JSON body instead of a human summary
#
# Exit codes: 0 = assertion passed / request succeeded; 1 = assertion failed or
# error envelope; 2 = request failed / timeout.
set -uo pipefail
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)/env.sh"

PORT="$PORT_MAIN"
RAW=0
CMD=""
ARGS=()

# Split argv into global flags (any position) and command positionals.
while [ $# -gt 0 ]; do
  case "$1" in
    --port)   PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --json)   RAW=1; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      if [ -z "$CMD" ]; then CMD="$1"; else ARGS+=("$1"); fi
      shift ;;
  esac
done

[ -n "$CMD" ] || die "no command given (try --help)"
guard_port "$PORT"

if ! load_host_env "$PORT"; then
  die "no running-host state for port $PORT (boot one with verify/setup-host.sh first)"
fi

# Positional parsing helpers: pull `--flag value` out of the command args.
TAKE_FLAG_VALUE=""
take_flag() {
  # take_flag <name> -> sets TAKE_FLAG_VALUE and *removes* the flag from ARGS.
  # A boolean flag with no following value (or at the end of ARGS) yields "1".
  # This must not be called through command substitution: that would run in a
  # subshell and the ARGS cleanup would be lost.
  local want="$1" out="" i=0
  local -a keep=()
  while [ $i -lt ${#ARGS[@]} ]; do
    if [ "${ARGS[$i]}" = "$want" ]; then
      if [ $((i + 1)) -lt ${#ARGS[@]} ] && [ "${ARGS[$((i + 1))]:0:2}" != "--" ]; then
        out="${ARGS[$((i + 1))]}"
        i=$((i + 2))
      else
        out="1"
        i=$((i + 1))
      fi
    else
      keep+=("${ARGS[$i]}")
      i=$((i + 1))
    fi
  done
  ARGS=("${keep[@]}")
  TAKE_FLAG_VALUE="$out"
}

# --- subcommands ---------------------------------------------------------
cmd_base() {
  say "BASE=$BASE"
  say "PORT=$PORT HOME=$HOME PROFILE=$PROFILE DSH_BIN=$DSH_BIN"
  say "LOG=$LOG PID=$PID"
}

cmd_raw() {
  local method path body code out
  method="${ARGS[0]:-GET}"
  path="${ARGS[1]:-/api/state}"
  body="${ARGS[2]:-}"
  local -a extra=()
  [ -n "$body" ] && extra=(-X POST -H 'content-type: application/json' --data "$body")
  out="$(api_curl "$PORT" -w $'\n%{http_code}' "${extra[@]}" "http://127.0.0.1:$PORT$path")"
  code="${out##*$'\n'}"
  say "HTTP $code"
  say "${out%$'\n'*}"
  [ "$code" = "200" ] && return 0
  return 1
}

cmd_state() {
  local home profile min body
  local include_official expected_plugins expect_hidden expect_official no_official
  local hidden official_count
  take_flag --home; home="$TAKE_FLAG_VALUE"
  take_flag --profile; profile="$TAKE_FLAG_VALUE"
  take_flag --min-plugins; min="$TAKE_FLAG_VALUE"
  take_flag --include-official; include_official="$TAKE_FLAG_VALUE"
  take_flag --expected-plugins; expected_plugins="$TAKE_FLAG_VALUE"
  take_flag --expect-hidden-official; expect_hidden="$TAKE_FLAG_VALUE"
  take_flag --expect-official-count; expect_official="$TAKE_FLAG_VALUE"
  take_flag --assert-no-official; no_official="$TAKE_FLAG_VALUE"
  min="${min:-1}"
  local query=""
  [ -n "$home" ] && query="home=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$home")"
  if [ -n "$profile" ]; then [ -n "$query" ] && query="$query&"; query="${query}profile=$profile"; fi
  if [ -n "$include_official" ]; then [ -n "$query" ] && query="$query&"; query="${query}includeOfficial=1"; fi
  body="$(api_get "$PORT" "/dsh-offline-packer/api/state${query:+?$query}")"
  [ -n "$body" ] || { echo "STATE_CHECK=FAIL empty body"; return 2; }
  [ "$RAW" = 1 ] && { say "$body"; return 0; }

  local ok dsh plugins profile_out home_out
  ok="$(json_get '.ok === true' <<<"$body" 2>/dev/null)"
  dsh="$(json_get '.value.host.dshVersion' <<<"$body" 2>/dev/null)"
  plugins="$(json_get '.value.plugins.length' <<<"$body" 2>/dev/null)"
  home_out="$(json_get '.value.dshHome' <<<"$body" 2>/dev/null)"
  profile_out="$(json_get '.value.profile' <<<"$body" 2>/dev/null)"
  say "ok=$ok host.dshVersion=$dsh dshHome=$home_out profile=$profile_out plugins=$plugins"
  node -e '
    const body = JSON.parse(require("fs").readFileSync(0, "utf8"))
    for (const p of (body.value?.plugins ?? [])) {
      console.log(`  - ${String(p.name).padEnd(28)} ${String(p.version ?? "-").padEnd(12)} kind=${String(p.kind ?? "?").padEnd(12)} installed=${p.installed} enabled=${p.enabled} size=${p.sizeBytes} files=${p.fileCount} dir=${p.dir ?? "-"}`)
    }
  ' <<<"$body"

  local fails=0
  [ "$ok" = "true" ] || { say "ASSERT_FAIL ok!==true"; fails=$((fails + 1)); }
  case "$dsh" in 0.2.1-rc.2|0.1.0-rc.7) : ;; *) say "ASSERT_FAIL unexpected host.dshVersion=$dsh"; fails=$((fails + 1)) ;; esac
  [ -n "$plugins" ] && [ "$plugins" -ge "$min" ] 2>/dev/null || { say "ASSERT_FAIL plugins=$plugins < $min"; fails=$((fails + 1)); }
  [ -n "$home_out" ] && [ -d "$home_out" ] || say "ASSERT_WARN dshHome not a directory: $home_out"

  hidden="$(json_get '.value.hiddenOfficial' <<<"$body" 2>/dev/null)"
  official_count="$(json_get '.value.officialCount' <<<"$body" 2>/dev/null)"
  say "hiddenOfficial=${hidden:-<absent>} officialCount=${official_count:-<absent>}"
  if [ -n "$expected_plugins" ] && [ "$plugins" != "$expected_plugins" ]; then
    say "ASSERT_FAIL plugins=$plugins != expected $expected_plugins"; fails=$((fails + 1))
  fi
  if [ -n "$expect_hidden" ] && [ "$hidden" != "$expect_hidden" ]; then
    say "ASSERT_FAIL hiddenOfficial=$hidden != expected $expect_hidden"; fails=$((fails + 1))
  fi
  if [ -n "$expect_official" ] && [ "$official_count" != "$expect_official" ]; then
    say "ASSERT_FAIL officialCount=$official_count != expected $expect_official"; fails=$((fails + 1))
  fi
  if [ -n "$no_official" ]; then
    NAMED="$(json_get '.value.plugins.filter(p => String(p.name).startsWith("@deepseek-ai/")).length' <<<"$body" 2>/dev/null)"
    FLAGGED="$(json_get '.value.plugins.filter(p => p.official === true).length' <<<"$body" 2>/dev/null)"
    if [ "$NAMED" = "0" ] && [ "$FLAGGED" = "0" ]; then
      say "ASSERT_OK no @deepseek-ai/* and no official===true in plugins"
    else
      say "ASSERT_FAIL official leaked into plugins (named=$NAMED flagged=$FLAGGED)"; fails=$((fails + 1))
    fi
  fi
  if [ -n "$include_official" ]; then
    OFFICIAL_ROWS="$(json_get '.value.plugins.filter(p => p.official === true).length' <<<"$body" 2>/dev/null)"
    say "official===true rows with includeOfficial=1: ${OFFICIAL_ROWS:-?}"
    if [ -n "$expect_official" ] && [ "$OFFICIAL_ROWS" != "$expect_official" ]; then
      say "ASSERT_FAIL official===true rows=$OFFICIAL_ROWS != expected $expect_official"; fails=$((fails + 1))
    fi
  fi

  if [ "$fails" = 0 ]; then
    say "STATE_CHECK=PASS plugins=$plugins dshVersion=$dsh"
    return 0
  fi
  say "STATE_CHECK=FAIL failures=$fails"
  return 1
}

cmd_plugins() {
  local home profile body query=""
  take_flag --home; home="$TAKE_FLAG_VALUE"
  take_flag --profile; profile="$TAKE_FLAG_VALUE"
  [ -n "$home" ] && query="?home=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$home")"
  [ -n "$profile" ] && { case "$query" in '') query="?profile=$profile" ;; *) query="$query&profile=$profile" ;; esac; }
  body="$(api_get "$PORT" "/dsh-offline-packer/api/plugins$query")"
  if [ "$RAW" = 1 ]; then say "$body"; return 0; fi
  say "$body" | node -e '
    const body = JSON.parse(require("fs").readFileSync(0, "utf8"))
    if (body.ok !== true) { console.log("PLUGINS_CHECK=FAIL", JSON.stringify(body)); process.exit(1) }
    const list = body.value?.plugins ?? []
    console.log(`dshHome=${body.value?.dshHome} profile=${body.value?.profile} plugins=${list.length}`)
    for (const p of list) console.log(`  - ${p.name}@${p.version ?? "?"} (${p.kind})`)
    console.log(list.length > 0 ? "PLUGINS_CHECK=PASS" : "PLUGINS_CHECK=FAIL empty")
  '
}

cmd_matrix() {
  local plugin min expect_version expect_peer body expect_error
  take_flag --min-versions; min="$TAKE_FLAG_VALUE"; min="${min:-1}"
  take_flag --expect-version; expect_version="$TAKE_FLAG_VALUE"
  take_flag --expect-peer; expect_peer="$TAKE_FLAG_VALUE"      # format: <version>:<range>
  take_flag --expect-error; expect_error="$TAKE_FLAG_VALUE"
  plugin="${ARGS[0]:-}"
  [ -n "$plugin" ] || die "usage: probe-api.sh matrix <plugin> [--min-versions N]"
  body="$(api_get "$PORT" "/dsh-offline-packer/api/matrix?plugin=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$plugin")")"
  [ -n "$body" ] || { echo "MATRIX_CHECK=FAIL empty body"; return 2; }
  [ "$RAW" = 1 ] && { say "$body"; return 0; }
  if [ "$expect_error" = "1" ]; then
    local okflag code
    okflag="$(json_get '.ok === false' <<<"$body" 2>/dev/null)"
    code="$(json_get '.error.code' <<<"$body" 2>/dev/null)"
    if [ "$okflag" = "true" ] && [ -n "$code" ]; then
      say "structured error envelope: $(json_get '.error' <<<"$body" 2>/dev/null)"
      say "MATRIX_CHECK=PASS (expected error code=$code)"
      return 0
    fi
    say "MATRIX_CHECK=FAIL expected a structured error envelope, got: $(head -c 300 <<<"$body")"
    return 1
  fi
  say "$body" | node -e '
    const { plugin, min, expectVersion, expectPeer } = JSON.parse(process.argv[1])
    const body = JSON.parse(require("fs").readFileSync(0, "utf8"))
    const fail = (m) => { console.log("ASSERT_FAIL " + m); process.exitCode = 1 }
    if (body.ok !== true) { console.log("MATRIX_CHECK=FAIL " + JSON.stringify(body)); process.exit(1) }
    const v = body.value
    console.log(`plugin=${v.plugin} versions=${v.versions.length} dshVersions=${(v.dshVersions ?? []).length}`)
    console.log("dshVersions:", (v.dshVersions ?? []).map((d) => d.version).join(", ").slice(0, 300))
    for (const row of v.versions.slice(0, 8)) console.log(`  - ${row.version.padEnd(14)} published=${row.published ?? "-"} dshPeers=${JSON.stringify(row.dshPeers ?? [])} compatible=${JSON.stringify(row.compatibleDsh ?? [])}`)
    if (v.versions.length > 8) console.log(`  ... (${v.versions.length - 8} more)`)
    if (v.versions.length < min) fail(`versions=${v.versions.length} < ${min}`)
    if (expectVersion) {
      const row = v.versions.find((r) => r.version === expectVersion)
      if (!row) fail(`version ${expectVersion} not present`)
      else if (expectPeer) {
        const [peerVersion, range] = expectPeer.split(":", 2).length === 1 ? [expectVersion, expectPeer] : expectPeer.split(":", 2)
        const hit = (row.dshPeers ?? []).includes(range)
        console.log(`peer check: ${peerVersion} dshPeers=${JSON.stringify(row.dshPeers)} contains ${JSON.stringify(range)}: ${hit}`)
        if (!hit) fail(`dshPeers of ${expectVersion} does not contain ${range}`)
      }
    }
    console.log(process.exitCode ? "MATRIX_CHECK=FAIL" : "MATRIX_CHECK=PASS")
  ' "$(node -e 'const [plugin,min,ev,ep]=process.argv.slice(1);process.stdout.write(JSON.stringify({plugin,min:Number(min),expectVersion:ev||null,expectPeer:ep||null}))' "$plugin" "$min" "$expect_version" "$expect_peer")"
}

cmd_package_local() {
  local plugin home profile target body payload include_official expect_error rawout http_code output_root
  take_flag --home; home="$TAKE_FLAG_VALUE"
  take_flag --profile; profile="$TAKE_FLAG_VALUE"
  take_flag --target; target="$TAKE_FLAG_VALUE"
  take_flag --include-official; include_official="$TAKE_FLAG_VALUE"
  take_flag --expect-error; expect_error="$TAKE_FLAG_VALUE"
  take_flag --output-root; output_root="$TAKE_FLAG_VALUE"
  plugin="${ARGS[0]:-}"
  [ -n "$plugin" ] || die "usage: probe-api.sh package-local <pluginName> [--home H] [--target V]"
  payload="$(node -e 'const p={pluginName:process.argv[1]};for(const [k,v] of [["home",process.argv[2]],["profile",process.argv[3]],["targetDshVersion",process.argv[4]]])if(v)p[k]=v;if(process.argv[5]==="1")p.includeOfficial=true;if(process.argv[6])p.outputRoot=process.argv[6];process.stdout.write(JSON.stringify(p))' "$plugin" "$home" "$profile" "$target" "$include_official" "$output_root")"
  rawout="$(api_curl "$PORT" -w $'\n%{http_code}' -X POST -H 'content-type: application/json' --data "$payload" "http://127.0.0.1:$PORT/dsh-offline-packer/api/package-local")"
  http_code="${rawout##*$'\n'}"
  body="${rawout%$'\n'*}"
  if [ "$RAW" = 1 ]; then say "$body"; return 0; fi
  say "POST /api/package-local payload=$payload -> HTTP $http_code"
  local ok jobId code
  ok="$(json_get '.ok === true' <<<"$body" 2>/dev/null)"
  jobId="$(json_get '.value.jobId' <<<"$body" 2>/dev/null)"
  if [ "$ok" = "true" ]; then
    say "PACKAGE_LOCAL_CHECK=PASS jobId=$jobId"
    return 0
  fi
  code="$(json_get '.error.code' <<<"$body" 2>/dev/null)"
  if [ "$expect_error" = "1" ] && [ -n "$code" ]; then
    case "$http_code" in 4*) : ;; *) say "ASSERT_WARN expected 4xx but got HTTP $http_code";; esac
    say "PACKAGE_LOCAL_CHECK=PASS (expected error HTTP $http_code code=$code) body=$body"
    return 0
  fi
  say "PACKAGE_LOCAL_CHECK=FAIL code=$code body=$body"
  return 1
}

cmd_package_registry() {
  local plugin version target body payload
  plugin="${ARGS[0]:-}"; version="${ARGS[1]:-}"; target="${ARGS[2]:-}"
  [ -n "$plugin" ] && [ -n "$version" ] && [ -n "$target" ] || die "usage: probe-api.sh package-registry <plugin> <version> <targetDshVersion>"
  payload="$(node -e 'process.stdout.write(JSON.stringify({pluginName:process.argv[1],version:process.argv[2],targetDshVersion:process.argv[3]}))' "$plugin" "$version" "$target")"
  body="$(api_post "$PORT" "/dsh-offline-packer/api/package-registry" "$payload")"
  if [ "$RAW" = 1 ]; then say "$body"; return 0; fi
  say "POST /api/package-registry payload=$payload"
  local ok jobId
  ok="$(json_get '.ok === true' <<<"$body" 2>/dev/null)"
  jobId="$(json_get '.value.jobId' <<<"$body" 2>/dev/null)"
  if [ "$ok" = "true" ]; then
    say "PACKAGE_REGISTRY_CHECK=PASS jobId=$jobId"
    return 0
  fi
  say "PACKAGE_REGISTRY_CHECK=FAIL body=$body"
  return 1
}

cmd_job() {
  local id body
  id="${ARGS[0]:-}"
  [ -n "$id" ] || die "usage: probe-api.sh job <jobId>"
  body="$(api_get "$PORT" "/dsh-offline-packer/api/job?id=$id")"
  if [ "$RAW" = 1 ]; then say "$body"; return 0; fi
  say "$body" | node -e '
    const body = JSON.parse(require("fs").readFileSync(0, "utf8"))
    if (body.ok !== true) { console.log("JOB_CHECK=FAIL", JSON.stringify(body)); process.exit(1) }
    const j = body.value
    console.log(`id=${j.id} kind=${j.kind} status=${j.status} startedAt=${j.startedAt} finishedAt=${j.finishedAt ?? "-"}`)
    console.log("progress=" + JSON.stringify(j.progress ?? null))
    if (j.result) console.log("result=" + JSON.stringify(j.result, null, 2))
    if (j.error) console.log("error=" + JSON.stringify(j.error))
    console.log("--- logs (last 40) ---")
    for (const line of (j.logs ?? []).slice(-40)) console.log(line)
    console.log(`JOB_CHECK=${j.status === "done" ? "PASS" : j.status === "error" ? "FAIL" : "RUNNING"}`)
    process.exit(j.status === "done" ? 0 : j.status === "running" ? 3 : 1)
  '
}

cmd_poll() {
  local id timeout interval deadline status body expect_error
  take_flag --timeout; timeout="$TAKE_FLAG_VALUE"; timeout="${timeout:-600}"
  take_flag --interval; interval="$TAKE_FLAG_VALUE"; interval="${interval:-1}"
  take_flag --expect-error; expect_error="$TAKE_FLAG_VALUE"
  id="${ARGS[0]:-}"
  [ -n "$id" ] || die "usage: probe-api.sh poll <jobId> [--timeout S] [--interval S]"
  deadline=$(( $(date +%s) + timeout ))
  say "polling job $id (timeout ${timeout}s, interval ${interval}s)"
  while :; do
    body="$(api_get "$PORT" "/dsh-offline-packer/api/job?id=$id")"
    [ -n "$body" ] || { echo "POLL_CHECK=FAIL empty body"; return 2; }
    status="$(json_get '.value.status' <<<"$body" 2>/dev/null)"
    case "$status" in
      done)  say "$body" | node -e '
               const j = JSON.parse(require("fs").readFileSync(0, "utf8")).value
               console.log("POLL_CHECK=PASS status=done")
               console.log("progress=" + JSON.stringify(j.progress ?? null))
               console.log("result=" + JSON.stringify(j.result, null, 2))
               console.log("--- logs (last 60) ---")
               for (const line of (j.logs ?? []).slice(-60)) console.log(line)
             '; return 0 ;;
      error) say "$body" | node -e '
               const j = JSON.parse(require("fs").readFileSync(0, "utf8")).value
               const expected = process.argv[1] === "1"
               console.log((expected ? "POLL_CHECK=PASS (expected job error)" : "POLL_CHECK=FAIL status=error") + " error=" + JSON.stringify(j.error))
               console.log("progress=" + JSON.stringify(j.progress ?? null))
               console.log("--- logs (last 60) ---")
               for (const line of (j.logs ?? []).slice(-60)) console.log(line)
             ' "$expect_error"; if [ "$expect_error" = "1" ]; then return 0; else return 1; fi ;;
      running) : ;;
      *) say "POLL_CHECK=FAIL unexpected job body: $body"; return 2 ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      say "POLL_CHECK=FAIL timeout after ${timeout}s (status=$status)"
      return 2
    fi
    sleep "$interval"
  done
}

cmd_download() {
  local name dest_dir out_file code size expect_error BODY output_root query
  take_flag --expect-error; expect_error="$TAKE_FLAG_VALUE"
  take_flag --output-root; output_root="$TAKE_FLAG_VALUE"
  name="${ARGS[0]:-}"
  dest_dir="${ARGS[1]:-$TMP_DIR/downloads}"
  [ -n "$name" ] || die "usage: probe-api.sh download <zipName> [destDir]"
  mkdir -p "$dest_dir"
  out_file="$dest_dir/$(basename -- "$name")"
  query="name=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$name")"
  if [ -n "$output_root" ]; then
    query="$query&outputRoot=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$output_root")"
  fi
  code="$(api_curl "$PORT" -o "$out_file" -w '%{http_code}' "http://127.0.0.1:$PORT/dsh-offline-packer/api/download?$query")"
  size="$(stat -c %s "$out_file" 2>/dev/null || echo 0)"
  say "GET /api/download?name=$name -> HTTP $code size=$size"
  if [ "$code" != "200" ]; then
    if [ "$expect_error" = "1" ]; then
      BODY="$(head -c 400 "$out_file" 2>/dev/null)"
      say "error body: $BODY"
      if printf '%s' "$BODY" | grep -q '"ok":false' && printf '%s' "$BODY" | grep -q '"code"'; then
        say "DOWNLOAD_CHECK=PASS (expected structured error, http=$code)"
        return 0
      fi
    fi
    say "DOWNLOAD_CHECK=FAIL http=$code body=$(head -c 300 "$out_file" 2>/dev/null)"
    return 1
  fi
  say "sha256=$(sha256sum "$out_file" | cut -d' ' -f1) file=$out_file"
  say "DOWNLOAD_CHECK=PASS file=$out_file"
  return 0
}

cmd_fence() {
  local path method body evil_code same_code
  method="${ARGS[0]:-GET}"
  path="${ARGS[1]:-/api/state}"
  evil_code="$(api_curl "$PORT" -o /dev/null -w '%{http_code}' -X "$method" \
    -H 'origin: http://evil.example' "http://127.0.0.1:$PORT$path")"
  same_code="$(api_curl "$PORT" -o /dev/null -w '%{http_code}' -X "$method" \
    -H "origin: http://127.0.0.1:$PORT" "http://127.0.0.1:$PORT$path")"
  say "cross-origin (http://evil.example) -> HTTP $evil_code (expect 403)"
  say "same-origin  (http://127.0.0.1:$PORT) -> HTTP $same_code (expect not 403)"
  if [ "$evil_code" = "403" ] && [ "$same_code" != "403" ]; then
    say "FENCE_CHECK=PASS"
    return 0
  fi
  say "FENCE_CHECK=FAIL"
  return 1
}

cmd_progress() {
  local id timeout interval log deadline body status phase percent line last prog_seq bad
  local -a seq=()
  take_flag --timeout; timeout="$TAKE_FLAG_VALUE"; timeout="${timeout:-300}"
  take_flag --interval; interval="$TAKE_FLAG_VALUE"; interval="${interval:-0.1}"
  take_flag --log; log="$TAKE_FLAG_VALUE"
  id="${ARGS[0]:-}"
  [ -n "$id" ] || die "usage: probe-api.sh progress <jobId> [--timeout S] [--interval S] [--log FILE]"
  deadline=$(( $(date +%s) + timeout ))
  say "watching job $id progress (timeout ${timeout}s interval ${interval}s)"
  [ -n "$log" ] && : > "$log"
  last=""
  while :; do
    body="$(api_get "$PORT" "/dsh-offline-packer/api/job?id=$id")"
    [ -n "$body" ] || { echo "PROGRESS_CHECK=FAIL empty body"; return 2; }
    status="$(json_get '.value.status' <<<"$body" 2>/dev/null)"
    phase="$(json_get '.value.progress.phase' <<<"$body" 2>/dev/null)"
    percent="$(json_get '.value.progress.percent' <<<"$body" 2>/dev/null)"
    line="${status}|${phase}|${percent}"
    if [ "$line" != "$last" ]; then
      say "  progress: status=${status:-?} phase=${phase:-<none>} percent=${percent:-<none>} t=$(date +%s%3N)"
      [ -n "$log" ] && printf '%s\n' "$line" >> "$log"
      seq+=("$line")
      last="$line"
    fi
    case "$status" in done|error) break ;; esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      say "PROGRESS_CHECK=FAIL timeout after ${timeout}s (last status=$status)"
      return 2
    fi
    sleep "$interval"
  done
  prog_seq="$(printf '%s\n' "${seq[@]}")"
  bad="$(printf '%s\n' "$prog_seq" | awk -F'|' '
    { p=$3; if (p=="" || p=="null") next; n=p+0; if (n<last) bad=1; last=n }
    END { print bad+0 }')"
  if [ "$bad" = "1" ]; then
    say "ASSERT_FAIL progress percent is not monotonically non-decreasing"
  else
    say "ASSERT_OK progress percent monotonically non-decreasing"
  fi
  FINAL_PHASE="$(json_get '.value.progress.phase' <<<"$body" 2>/dev/null)"
  FINAL_PERCENT="$(json_get '.value.progress.percent' <<<"$body" 2>/dev/null)"
  STARTED="$(json_get '.value.startedAt' <<<"$body" 2>/dev/null)"
  FINISHED="$(json_get '.value.finishedAt' <<<"$body" 2>/dev/null)"
  say "final: status=$status phase=${FINAL_PHASE:-?} percent=${FINAL_PERCENT:-?}"
  say "startedAt=${STARTED:-?} finishedAt=${FINISHED:-?} duration_ms=$([ -n "$STARTED" ] && [ -n "$FINISHED" ] && [ "$FINISHED" != null ] && echo $((FINISHED - STARTED)) || echo '?')"
  if [ "$status" != "done" ]; then
    say "PROGRESS_CHECK=FAIL status=$status"; return 1
  fi
  if [ "$bad" = "1" ] || [ "$FINAL_PHASE" != "完成" ] || [ "$FINAL_PERCENT" != "100" ]; then
    say "PROGRESS_CHECK=FAIL monotonic=$([ "$bad" = "1" ] && echo no || echo yes) final=${FINAL_PHASE}/${FINAL_PERCENT}"
    return 1
  fi
  say "PROGRESS_CHECK=PASS transitions=$((${#seq[@]} - 1)) final=完成/100"
  return 0
}

case "$CMD" in
  base)             cmd_base ;;
  state)            cmd_state ;;
  plugins)          cmd_plugins ;;
  matrix)           cmd_matrix ;;
  package-local)    cmd_package_local ;;
  package-registry) cmd_package_registry ;;
  job)              cmd_job ;;
  poll)             cmd_poll ;;
  progress)         cmd_progress ;;
  download)         cmd_download ;;
  fence)            cmd_fence ;;
  raw)              cmd_raw ;;
  *) die "unknown command: $CMD (try --help)" ;;
esac
exit $?
