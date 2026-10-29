#!/usr/bin/env bash
# Replay a produced offline zip into an isolated DSH home.
#
#   bash verify/offline-install.sh <zip> --home <abs-home> [--profile web] \
#        [--dry-run] [--uninstall] [--keep]
#
# Steps: extract the zip into verify/tmp/artifact/<name>/, then run its
# `install-offline.sh` from the extracted directory with DSH_HOME explicitly
# unset (so the installer can never fall back to the real /home/fc/.dsh) and
# --dsh-home <home> explicit. Prints the installer log and INSTALL_RESULT=... .
#
# The home is NOT booted here: boot it with
#   bash verify/setup-host.sh --no-plugin --home <home> --port 3085
# and inspect it with
#   bash verify/boot-evidence.sh 3085 --expect-plugin <plugin>
set -uo pipefail
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)/env.sh"

ZIP=""
HOME_DIR=""
PROFILE=web
MODE=install     # install | dryrun | uninstall
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --home)      HOME_DIR="$2"; shift 2 ;;
    --profile)   PROFILE="$2"; shift 2 ;;
    --dry-run)   MODE=dryrun; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --keep)      KEEP=1; shift ;;
    -h|--help)   sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)          die "unknown option: $1" ;;
    *)           ZIP="$1"; shift ;;
  esac
done
[ -n "$ZIP" ] || die "usage: offline-install.sh <zip> --home <abs-home> [--profile web] [--dry-run|--uninstall] [--keep]"
[ -n "$HOME_DIR" ] || die "--home is required (never default to the real DSH_HOME)"
[ -f "$ZIP" ] || die "zip not found: $ZIP"
ZIP="$(realpath -- "$ZIP")"
case "$HOME_DIR" in /*) : ;; *) HOME_DIR="$PWD/$HOME_DIR" ;; esac
HOME_DIR="$(realpath -m -- "$HOME_DIR")"
guard_home "$HOME_DIR"
guard_port "$PORT_INSTALL"   # only used to keep the convention visible

ART="$TMP_DIR/artifact/$(basename "$ZIP" .zip)"
EXTRACT="$ART/extracted"
if [ ! -f "$EXTRACT/install-offline.sh" ]; then
  rm -rf -- "$EXTRACT"
  mkdir -p "$EXTRACT"
  info "extracting $ZIP -> $EXTRACT"
  unzip -q "$ZIP" -d "$EXTRACT" || die "unzip failed"
fi
ROOT="$(find "$EXTRACT" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$ROOT" ] || die "no top-level directory inside $EXTRACT"
[ -f "$ROOT/install-offline.sh" ] || die "install-offline.sh missing under $ROOT"

say "===== offline-install mode=$MODE ====="
say "zip=$ZIP"
say "extracted=$ROOT"
say "home=$HOME_DIR profile=$PROFILE"
say "zip sha256=$(sha256sum "$ZIP" | cut -d' ' -f1)"

CMD=(bash "$ROOT/install-offline.sh" --dsh-home "$HOME_DIR" --profile "$PROFILE")
case "$MODE" in
  dryrun)    CMD+=(--dry-run) ;;
  uninstall) CMD+=(--uninstall) ;;
esac

# Belt and braces: the installer falls back to $DSH_HOME when --dsh-home is
# absent. We pass --dsh-home, and also clear DSH_HOME so an installer bug can
# never reach the real user home.
LOG="$LOG_DIR/offline-install-$(basename "$ZIP" .zip)-$MODE.log"
if env -u DSH_HOME "${CMD[@]}" >"$LOG" 2>&1; then
  INSTALL_RC=0
else
  INSTALL_RC=$?
fi
cat "$LOG"
say "installer_exit=$INSTALL_RC log=$LOG"

fails=0
if [ "$INSTALL_RC" != 0 ]; then
  say "INSTALL_RESULT=FAIL installer_exit=$INSTALL_RC"
  exit 1
fi

if [ "$MODE" = dryrun ]; then
  if [ -n "$(find "$HOME_DIR" -mindepth 1 2>/dev/null | head -1)" ]; then
    say "INSTALL_RESULT=FAIL dry-run wrote files into $HOME_DIR"
    exit 1
  fi
  say "INSTALL_RESULT=PASS (dry-run wrote nothing)"
  exit 0
fi

PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
PLUGIN="$(node -e 'const p=require(process.argv[1]);process.stdout.write(String(p.name))' "$ROOT/package/package.json" 2>/dev/null || true)"
[ -n "$PLUGIN" ] || PLUGIN="$(grep -m1 '^# ' "$ROOT/README.md" 2>/dev/null | sed 's/^# //' | cut -d' ' -f1)"
say "plugin=$PLUGIN"

if [ "$MODE" = uninstall ]; then
  if [ -e "$PROFILE_DIR/node_modules/$PLUGIN" ]; then
    say "ASSERT_FAIL plugin directory still present after uninstall: $PROFILE_DIR/node_modules/$PLUGIN"
    fails=$((fails + 1))
  fi
  if node -e '
      const fs=require("fs")
      const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))
      process.exit((p.dsh?.profile?.bundles??[]).includes(process.argv[2]) ? 1 : 0)
    ' "$PROFILE_DIR/package.json" "$PLUGIN" 2>/dev/null; then
    say "uninstall: bundles no longer contains $PLUGIN"
  else
    say "ASSERT_FAIL bundles still contains $PLUGIN after uninstall"
    fails=$((fails + 1))
  fi
  [ "$fails" = 0 ] && say "INSTALL_RESULT=PASS (uninstall)" || say "INSTALL_RESULT=FAIL failures=$fails"
  exit "$fails"
fi

# install mode: assert the plugin directory and the bundle row landed.
if [ -d "$PROFILE_DIR/node_modules/$PLUGIN" ]; then
  say "installed plugin dir: $PROFILE_DIR/node_modules/$PLUGIN ($(find "$PROFILE_DIR/node_modules/$PLUGIN" -type f | wc -l) files)"
else
  say "ASSERT_FAIL plugin directory missing: $PROFILE_DIR/node_modules/$PLUGIN"
  fails=$((fails + 1))
fi
if node -e '
    const fs=require("fs")
    const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))
    process.exit((p.dsh?.profile?.bundles??[]).includes(process.argv[2]) ? 0 : 1)
  ' "$PROFILE_DIR/package.json" "$PLUGIN"; then
  say "bundles now contains $PLUGIN"
else
  say "ASSERT_FAIL bundles does not contain $PLUGIN"
  fails=$((fails + 1))
fi
if [ -f "$PROFILE_DIR/node_modules/$PLUGIN/package.json" ]; then
  say "installed version: $(node -e 'console.log(require(process.argv[1]).version)' "$PROFILE_DIR/node_modules/$PLUGIN/package.json" 2>/dev/null)"
fi

if [ "$fails" = 0 ]; then say "INSTALL_RESULT=PASS home=$HOME_DIR plugin=$PLUGIN"; else say "INSTALL_RESULT=FAIL failures=$fails"; fi
exit "$fails"
