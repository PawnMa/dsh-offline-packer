#!/usr/bin/env bash
# Validate one offline-install zip produced by dsh-offline-packer.
#
#   bash verify/validate-zip.sh <zip> [--expect-plugin NAME] [--expect-version V]
#                                       [--expect-target V] [--dryrun] [--keep]
#
# Checks (each printed PASS/FAIL):
#   1  file exists, non-empty, zip magic
#   2  `unzip -t` clean
#   3  exactly one top-level directory named like the zip
#   4  required layout: package/ install-offline.sh install-offline.ps1 README.md
#      CHECKSUMS.txt VERSIONS.txt
#   5  install-offline.sh stored executable (zip external attrs), and is -x after
#      extraction; `bash -n` parses it
#   6  manifest: dependencies == {}, every peerDependenciesMeta entry optional,
#      name/version match, dsh.client.platform == web for bundle plugins
#   7  CHECKSUMS.txt: `sha256sum -c` all OK, covers scripts/manifest/README
#   8  README.md / VERSIONS.txt mention the plugin, version and target host
#   9  no absolute paths or `..` members in the archive
#  10  optional --dryrun: `install-offline.sh --dry-run --dsh-home <fresh>` exits 0
#      and writes nothing
#
# --legacy relaxes the new-package naming rule and the VERSIONS.txt requirement
# (used only to re-check the previous round's known-good artifact).
#
# Exit code 0 only when every required check passed.
set -uo pipefail
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)/env.sh"

ZIP=""
EXPECT_PLUGIN=""
EXPECT_VERSION=""
EXPECT_TARGET=""
DO_DRYRUN=0
KEEP=0
LEGACY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --expect-plugin)  EXPECT_PLUGIN="$2"; shift 2 ;;
    --expect-version) EXPECT_VERSION="$2"; shift 2 ;;
    --expect-target)  EXPECT_TARGET="$2"; shift 2 ;;
    --dryrun)         DO_DRYRUN=1; shift ;;
    --keep)           KEEP=1; shift ;;
    --legacy)         LEGACY=1; shift ;;
    -h|--help)        sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)               die "unknown option: $1" ;;
    *)                ZIP="$1"; shift ;;
  esac
done
[ -n "$ZIP" ] || die "usage: validate-zip.sh <zip> [--expect-plugin NAME] [--expect-version V] [--expect-target V] [--dryrun] [--keep]"
[ -f "$ZIP" ] || die "zip not found: $ZIP"
ZIP="$(realpath -- "$ZIP")"

FAILS=0
CHECKS=0
chk_pass() { CHECKS=$((CHECKS + 1)); printf 'PASS  %s\n' "$*"; }
chk_fail() { CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1)); printf 'FAIL  %s\n' "$*"; }
chk_warn() { printf 'WARN  %s\n' "$*"; }

say "===== validate-zip: $ZIP ====="
SIZE="$(stat -c %s "$ZIP")"
say "size=$SIZE bytes sha256=$(sha256sum "$ZIP" | cut -d' ' -f1)"
[ "$SIZE" -gt 0 ] && chk_pass "file non-empty ($SIZE bytes)" || chk_fail "file is empty"
MAGIC="$(head -c 4 "$ZIP" | od -An -tx1 | tr -d ' \n')"
[ "$MAGIC" = "504b0304" ] && chk_pass "zip magic PK\\x03\\x04" || chk_fail "bad zip magic: $MAGIC"

# --- extract into a throwaway dir ---------------------------------------
WORK="$TMP_DIR/validate/$(basename "$ZIP" .zip)-$$"
rm -rf -- "$WORK"
mkdir -p "$WORK/root"
cleanup() { [ "$KEEP" = 1 ] || rm -rf -- "$WORK"; }
trap cleanup EXIT

if ! unzip -q "$ZIP" -d "$WORK/root" 2>"$WORK/unzip.err"; then
  chk_fail "unzip extraction failed: $(cat "$WORK/unzip.err")"
  say "RESULT=FAIL checks=$CHECKS failures=$FAILS"
  exit 1
fi
chk_pass "extracted to $WORK"

if unzip -t "$ZIP" >"$WORK/unzip-t.log" 2>&1; then
  chk_pass "unzip -t: archive coherent ($(grep -c 'testing:' "$WORK/unzip-t.log") entries tested)"
else
  chk_fail "unzip -t reported corruption: $(tail -3 "$WORK/unzip-t.log")"
fi

# --- 3) single top-level dir --------------------------------------------
mapfile -t TOPS < <(find "$WORK/root" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
ROOT=""
if [ "${#TOPS[@]}" = 1 ] && [ -d "$WORK/root/${TOPS[0]}" ]; then
  ROOT="$WORK/root/${TOPS[0]}"
  chk_pass "single top-level directory: ${TOPS[0]}"
else
  chk_fail "expected exactly one top-level directory, found: ${TOPS[*]:-<none>}"
  ROOT="$WORK/root/$([ "${#TOPS[@]}" -gt 0 ] && printf '%s' "${TOPS[0]}" || printf 'none')"
fi
ROOTNAME="$(basename "$ROOT")"
if [ "$LEGACY" = 1 ]; then
  chk_warn "legacy mode: top-level dir name not checked strictly ($ROOTNAME)"
elif [ -n "$EXPECT_PLUGIN" ] && [ -n "$EXPECT_VERSION" ] && [ -n "$EXPECT_TARGET" ]; then
  WANT_DIR="$EXPECT_PLUGIN-offline-$EXPECT_VERSION-dsh-$EXPECT_TARGET"
  if [ "$ROOTNAME" = "$WANT_DIR" ]; then
    chk_pass "top-level dir name == $WANT_DIR"
  else
    chk_fail "top-level dir name is $ROOTNAME, expected $WANT_DIR"
  fi
elif printf '%s' "$ROOTNAME" | grep -Eq -- '-offline-[0-9][^/]*-dsh-[0-9][^/]*$'; then
  chk_pass "top-level dir name matches <plugin>-offline-<version>-dsh-<target>: $ROOTNAME"
else
  chk_fail "top-level dir name does not match expected pattern: $ROOTNAME"
fi

# --- 4) required layout -------------------------------------------------
for rel in package/package.json install-offline.sh install-offline.ps1 README.md CHECKSUMS.txt VERSIONS.txt; do
  if [ -e "$ROOT/$rel" ]; then
    chk_pass "layout: $rel present"
  elif [ "$LEGACY" = 1 ] && [ "$rel" = "VERSIONS.txt" ]; then
    chk_warn "legacy mode: $rel absent (previous-round layout)"
  else
    chk_fail "layout: $rel missing"
  fi
done
for extra in $(find "$ROOT" -mindepth 1 -maxdepth 1 -printf '%f\n'); do
  case "$extra" in
    package|install-offline.sh|install-offline.ps1|README.md|CHECKSUMS.txt|VERSIONS.txt) : ;;
    *) chk_warn "unexpected extra top-level entry: $extra" ;;
  esac
done

# --- 5) installer script ------------------------------------------------
if [ -f "$ROOT/install-offline.sh" ]; then
  [ -x "$ROOT/install-offline.sh" ] && chk_pass "install-offline.sh executable after extraction" \
    || chk_fail "install-offline.sh is not executable after extraction"
  if bash -n "$ROOT/install-offline.sh" 2>"$WORK/bash-n.log"; then
    chk_pass "bash -n install-offline.sh"
  else
    chk_fail "bash -n install-offline.sh: $(cat "$WORK/bash-n.log")"
  fi
  ZIPMODE="$(python3 - "$ZIP" install-offline.sh <<'PY'
import sys, zipfile
zip_path, member = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path) as zf:
    for info in zf.infolist():
        if info.filename.endswith("/" + member) or info.filename == member:
            print(oct((info.external_attr >> 16) & 0o777))
            break
    else:
        print("MISSING")
PY
)"
  case "$ZIPMODE" in
    0o755|0o775|0o777) chk_pass "zip external attrs keep install-offline.sh executable ($ZIPMODE)" ;;
    MISSING) chk_fail "install-offline.sh not found in zip member list" ;;
    *) chk_fail "install-offline.sh zip mode is $ZIPMODE (expected 0o755)" ;;
  esac
fi

# --- 6) package manifest ------------------------------------------------
if [ -f "$ROOT/package/package.json" ]; then
  node - "$ROOT/package/package.json" "$EXPECT_PLUGIN" "$EXPECT_VERSION" <<'NODE' > "$WORK/manifest.json" 2>&1
const fs = require('fs')
const [file, expectName, expectVersion] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
const results = []
const add = (name, ok, detail) => results.push({ name, ok, detail })
add('manifest parses', true)
if (expectName) add(`name == ${expectName}`, manifest.name === expectName, `name=${manifest.name}`)
else add('name is a non-empty string', typeof manifest.name === 'string' && manifest.name.length > 0, `name=${manifest.name}`)
if (expectVersion) add(`version == ${expectVersion}`, manifest.version === expectVersion, `version=${manifest.version}`)
else add('version is a non-empty string', typeof manifest.version === 'string' && manifest.version.length > 0, `version=${manifest.version}`)
const deps = manifest.dependencies
add('dependencies is an empty object', deps !== null && typeof deps === 'object' && !Array.isArray(deps) && Object.keys(deps).length === 0,
  `dependencies=${JSON.stringify(deps)}`)
const peers = manifest.peerDependencies ?? {}
const meta = manifest.peerDependenciesMeta ?? {}
const badMeta = Object.entries(meta).filter(([, v]) => v?.optional !== true).map(([k]) => k)
add('every peerDependenciesMeta entry is optional:true', badMeta.length === 0,
  `peers=${Object.keys(peers).length} meta=${Object.keys(meta).length} notOptional=${JSON.stringify(badMeta)}`)
const missingMeta = Object.keys(peers).filter((k) => !(k in meta))
add('every peerDependency has a peerDependenciesMeta entry', missingMeta.length === 0, `missing=${JSON.stringify(missingMeta)}`)
add('main or exports[.] present', typeof manifest.main === 'string' || manifest.exports?.['.'] !== undefined,
  `main=${manifest.main} exportsDot=${manifest.exports?.['.']}`)
if (manifest.dsh?.client) add('dsh.client.platform == web', manifest.dsh.client.platform === 'web', `platform=${manifest.dsh.client.platform}`)
else add('dsh.client optional', true, 'no dsh.client declared')
add('engines.dsh optional', true, `engines.dsh=${manifest.engines?.dsh}${typeof manifest.engines?.dsh === 'string' ? '' : ' (absent; informational)'}`)
console.log(JSON.stringify(results, null, 2))
process.exitCode = results.some((r) => !r.ok) ? 1 : 0
NODE
  MANIFEST_RC=$?
  if [ "$MANIFEST_RC" = 0 ]; then
    chk_pass "manifest assertions ($(grep -c '"name"' "$WORK/manifest.json") checks)"
  else
    chk_fail "manifest assertions failed"
  fi
  sed 's/^/      /' "$WORK/manifest.json"
else
  chk_fail "package/package.json missing (manifest checks skipped)"
fi

# --- 7) CHECKSUMS.txt ---------------------------------------------------
if [ -f "$ROOT/CHECKSUMS.txt" ]; then
  SUM_OUT="$WORK/sha256sum.out"
  ( cd "$ROOT" && sha256sum -c CHECKSUMS.txt ) >"$SUM_OUT" 2>&1
  SUM_RC=$?
  OK_COUNT="$(grep -c ': OK$' "$SUM_OUT" || true)"
  BAD_COUNT="$(grep -cE ': FAILED$|No such file' "$SUM_OUT" || true)"
  LINES="$(grep -c . "$ROOT/CHECKSUMS.txt" || true)"
  say "      CHECKSUMS.txt: lines=$LINES ok=$OK_COUNT bad=$BAD_COUNT"
  if [ "$SUM_RC" = 0 ] && [ "$BAD_COUNT" = 0 ] && [ "$OK_COUNT" = "$LINES" ]; then
    chk_pass "sha256sum -c CHECKSUMS.txt: $OK_COUNT/$LINES OK"
  else
    chk_fail "sha256sum -c CHECKSUMS.txt: rc=$SUM_RC ok=$OK_COUNT/$LINES bad=$BAD_COUNT"
    grep -vE ': OK$' "$SUM_OUT" | head -10 | sed 's/^/      /'
  fi
  for want in package/package.json install-offline.sh install-offline.ps1 README.md VERSIONS.txt; do
    if grep -qE "(\\./)?$want\$" "$ROOT/CHECKSUMS.txt"; then :; else chk_warn "CHECKSUMS.txt does not list $want"; fi
  done
else
  chk_fail "CHECKSUMS.txt missing"
fi

# --- 8) README / VERSIONS text -----------------------------------------
for rel in README.md VERSIONS.txt; do
  [ -f "$ROOT/$rel" ] || continue
  if [ -n "$EXPECT_VERSION" ] && ! grep -qF "$EXPECT_VERSION" "$ROOT/$rel"; then
    chk_fail "$rel does not mention version $EXPECT_VERSION"
  else
    chk_pass "$rel mentions version ${EXPECT_VERSION:-<skipped>}"
  fi
  if [ -n "$EXPECT_TARGET" ] && ! grep -qF "$EXPECT_TARGET" "$ROOT/$rel"; then
    chk_fail "$rel does not mention target DSH $EXPECT_TARGET"
  else
    chk_pass "$rel mentions target DSH ${EXPECT_TARGET:-<skipped>}"
  fi
done

# --- 9) archive member safety ------------------------------------------
BAD_PATHS="$(unzip -Z1 "$ZIP" | grep -E '^/|(^|/)\.\.(/|$)' || true)"
if [ -z "$BAD_PATHS" ]; then
  chk_pass "no absolute or ../ members in archive"
else
  chk_fail "unsafe archive members: $(echo "$BAD_PATHS" | head -5 | tr '\n' ' ')"
fi

# --- 10) optional install dry-run --------------------------------------
if [ "$DO_DRYRUN" = 1 ] && [ -f "$ROOT/install-offline.sh" ]; then
  DRYHOME="$TMP_DIR/validate/dryrun-home-$$"
  rm -rf -- "$DRYHOME"
  mkdir -p "$DRYHOME"
  if ( cd "$ROOT" && bash install-offline.sh --dry-run --dsh-home "$DRYHOME" --profile web ) \
      >"$WORK/dryrun.log" 2>&1; then
    if [ -z "$(find "$DRYHOME" -mindepth 1 2>/dev/null | head -1)" ]; then
      chk_pass "install-offline.sh --dry-run: exit 0, wrote nothing"
    else
      chk_fail "install-offline.sh --dry-run wrote files into the fresh home"
    fi
  else
    chk_fail "install-offline.sh --dry-run failed: $(tail -5 "$WORK/dryrun.log" | tr '\n' ' ')"
  fi
  say "      dry-run log: $WORK/dryrun.log"
  rm -rf -- "$DRYHOME"
fi

# --- summary ------------------------------------------------------------
say ""
say "files=$(find "$ROOT" -type f | wc -l) dir_size=$(du -sh "$ROOT" 2>/dev/null | cut -f1)"
if [ "$FAILS" = 0 ]; then
  say "RESULT=PASS checks=$CHECKS failures=0 zip=$ZIP"
  [ "$KEEP" = 1 ] && say "kept extraction at $ROOT"
  exit 0
fi
say "RESULT=FAIL checks=$CHECKS failures=$FAILS"
[ "$KEEP" = 1 ] && say "kept extraction at $ROOT"
exit 1
