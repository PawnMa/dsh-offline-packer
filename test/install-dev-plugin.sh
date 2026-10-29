#!/usr/bin/env bash
# Install the development checkout of dsh-offline-packer into one DSH home/profile.
#
#   bash test/install-dev-plugin.sh <DSH_HOME> [profile]
#
# Development convenience only: copies the working tree into
# `$DSH_HOME/profiles/<profile>/node_modules/dsh-offline-packer`, initializes the
# profile from the shipped templates when it does not exist yet, and appends the
# bundle row to `dsh.profile.bundles`. No network access.
#
# The copy goes through a staging directory first, so a DSH_HOME placed inside
# this checkout (e.g. ./test/home) cannot make cp walk into its own output.
set -euo pipefail

SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
DSH_HOME="${1:?usage: install-dev-plugin.sh <DSH_HOME> [profile]}"
PROFILE="${2:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_NAME="dsh-offline-packer"
DEST="$PROFILE_DIR/node_modules/$PLUGIN_NAME"

mkdir -p "$PROFILE_DIR"
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  node - "$PROFILE_DIR" "$PROFILE" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [dir, profile] = process.argv.slice(2)
const bundles = profile === 'web'
  ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  : profile === 'headless'
    ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
    : ['@deepseek-ai/dsh-base']
fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
  name: `dsh-profile-${profile}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles } },
}, undefined, 2)
}\n`)
fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# dsh profile user patch layer\n[]\n')
fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
NODE
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/dsh-offline-packer-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/pkg"
cp -a "$SRC/package.json" "$SRC/index.js" "$SRC/client.js" "$SRC/cordis.patch.yml" "$SRC/README.md" "$STAGE/pkg/" 2>/dev/null || true
cp -a "$SRC/ARCHITECTURE.md" "$STAGE/pkg/" 2>/dev/null || true
cp -a "$SRC/lib" "$STAGE/pkg/lib"
if [ -f "$SRC/client.js" ]; then cp -a "$SRC/client.js" "$STAGE/pkg/client.js"; fi

rm -rf "$DEST"
mkdir -p "$PROFILE_DIR/node_modules"
cp -a "$STAGE/pkg" "$DEST"

node - "$PROFILE_DIR/package.json" "$PLUGIN_NAME" <<'NODE'
const fs = require('node:fs')
const [manifestPath, name] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
NODE

echo "[dev-install] $PLUGIN_NAME -> $DEST"
echo "[dev-install] bundles: $(node -e "console.log(JSON.stringify(require('$PROFILE_DIR/package.json').dsh.profile.bundles))")"
echo "[dev-install] restart dsh (or boot a test instance): DSH_HOME=$DSH_HOME node <dsh>/lib/bin.js --profile web --port 3081"
