#!/usr/bin/env bash
# Snapshot the real user DSH home (READ-ONLY) for the item-8 no-regression check.
#
#   bash verify/snapshot-user-home.sh before
#   ...run the verification...
#   bash verify/snapshot-user-home.sh after
#   diff -u verify/run/user-home-before.txt verify/run/user-home-after.txt
#
# Records: profile package.json (sha256 + mtime), the top-level entry list of the
# profile node_modules (with symlink targets and per-entry stat), the profile
# dir mtimes, and a shallow tree hash of the top 2 levels. Never writes inside
# /home/fc/.dsh.
set -uo pipefail
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)/env.sh"

LABEL="${1:?usage: snapshot-user-home.sh <before|after|label>}"
OUT="$RUN_DIR/user-home-$LABEL.txt"
PROFILE="$USER_DSH_HOME/profiles/web"
NM="$PROFILE/node_modules"

# Read-only by construction: everything below uses find/stat/sha256sum only;
# guard_home is deliberately NOT applied because this script *reads* the real home.

say "===== user-home snapshot '$LABEL' $(now_iso) ====="
say "home=$USER_DSH_HOME"
if [ ! -d "$PROFILE" ]; then
  say "PROFILE_MISSING=$PROFILE"
  exit 1
fi

{
  echo "# snapshot '$LABEL' $(now_iso)"
  echo "## profile package.json"
  if [ -f "$PROFILE/package.json" ]; then
    sha256sum "$PROFILE/package.json"
    stat -c '%n mtime=%y size=%s' "$PROFILE/package.json"
  else
    echo "MISSING $PROFILE/package.json"
  fi
  echo "## profile top-level files"
  find "$PROFILE" -maxdepth 1 -mindepth 1 -printf '%f\t%y\t%s\t%T@\n' 2>/dev/null | sort
  echo "## node_modules top-level entries (${NM})"
  if [ -d "$NM" ]; then
    find "$NM" -maxdepth 1 -mindepth 1 -printf '%f\t%y\t%l\t%s\t%T@\n' 2>/dev/null | sort
    echo "## node_modules scoped groups"
    find "$NM" -mindepth 2 -maxdepth 2 -name package.json -printf '%h\n' 2>/dev/null | sed "s#^$NM/##" | sort | sha256sum
    echo "## installed plugin versions (package.json name@version)"
    node - "$NM" <<'NODE'
const fs = require('fs')
const path = require('path')
const nm = process.argv[2]
const rows = []
for (const entry of fs.readdirSync(nm)) {
  if (entry.startsWith('.')) continue
  const dirs = entry.startsWith('@')
    ? fs.readdirSync(path.join(nm, entry)).map((sub) => path.join(entry, sub))
    : [entry]
  for (const rel of dirs) {
    const pkg = path.join(nm, rel, 'package.json')
    try {
      const manifest = JSON.parse(fs.readFileSync(pkg, 'utf8'))
      rows.push(`${manifest.name}@${manifest.version}`)
    } catch {
      rows.push(`${rel}@<no-manifest>`)
    }
  }
}
rows.sort()
console.log(`count=${rows.length}`)
console.log(rows.join('\n'))
NODE
  else
    echo "MISSING $NM"
  fi
} > "$OUT"

say "wrote $OUT ($(wc -l < "$OUT") lines)"
say "profile package.json sha256: $(grep -m1 -E '^[0-9a-f]{64} ' "$OUT" | cut -d' ' -f1)"
say "plugin count: $(grep -m1 '^count=' "$OUT")"
