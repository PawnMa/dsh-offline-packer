#!/usr/bin/env bash
# Verify every offline package produced in test/out-a (task-4 artifacts).
#
#   bash test/a/verify-artifacts.sh
#
# For each zip: unzip -t, structure, manifest rewrite (dependencies {} / peers
# optional), sha256sum -c, bash -n, 0755 permission of install-offline.sh, then
# a real dry-run + install + uninstall against a throwaway DSH_HOME.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." >/dev/null 2>&1 && pwd -P)"
OUT="$ROOT/test/out-a"
FAILURES=0
CHECKS=0

# Safety net: this script must never touch the real user profile. The generated
# installers honour $DSH_PROFILE_DIR/$DSH_HOME from the environment, and this
# agent shell inherits them, so every installer call below runs with those
# variables stripped and HOME/DSH_HOME pointed into the throwaway work dir.
REAL_MANIFEST="/home/fc/.dsh/profiles/web/package.json"
REAL_MODULES="/home/fc/.dsh/profiles/web/node_modules"
real_fingerprint() {
  {
    sha256sum "$REAL_MANIFEST" 2>/dev/null || true
    ls -1 "$REAL_MODULES" 2>/dev/null | sort | sha256sum || true
  } | sha256sum | cut -d' ' -f1
}
REAL_BEFORE="$(real_fingerprint)"

clean_env() { env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_PROFILE "$@"; }

pass() { CHECKS=$((CHECKS + 1)); printf 'PASS %s\n' "$*"; }
fail() { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); printf 'FAIL %s\n' "$*" >&2; }
section() { printf '\n=== %s ===\n' "$*"; }

run() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$label"; else fail "$label"; fi
}

[ -d "$OUT" ] || { echo "缺少产物目录：$OUT（先运行 node test/a/selftest.mjs）" >&2; exit 1; }

shopt -s nullglob
ZIPS=("$OUT"/*-offline-*.zip)
[ "${#ZIPS[@]}" -gt 0 ] || { echo "$OUT 下没有离线包 zip" >&2; exit 1; }

for ZIP in "${ZIPS[@]}"; do
  section "$(basename "$ZIP")"
  run 'unzip -t 完整性' unzip -t "$ZIP"
  run 'zip 内 install-offline.sh 具有 0755 权限' bash -c "unzip -Z -l '$ZIP' | grep -qE '^-rwxr-xr-x.*install-offline\.sh$'"

  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  run '解压（unzip -q）' unzip -q "$ZIP" -d "$WORK"
  TOP="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -z "$TOP" ]; then
    fail 'zip 顶层目录存在'
    rm -rf "$WORK"
    continue
  fi
  STAGE="$TOP"

  for entry in package/package.json install-offline.sh install-offline.ps1 README.md VERSIONS.txt CHECKSUMS.txt; do
    run "结构：$entry 存在" test -f "$STAGE/$entry"
  done
  run '幂等：解压出两个离线包互不嵌套（顶层目录名 = zip 名）' test "$(basename "$STAGE")" = "$(basename "$ZIP" .zip)"

  if node - "$STAGE/package/package.json" <<'NODE'
const fs = require('node:fs')
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (manifest.dependencies === null || typeof manifest.dependencies !== 'object' || Object.keys(manifest.dependencies).length !== 0) {
  console.error('dependencies is not {}')
  process.exit(1)
}
const peers = manifest.peerDependencies && typeof manifest.peerDependencies === 'object' ? Object.keys(manifest.peerDependencies) : []
const meta = manifest.peerDependenciesMeta && typeof manifest.peerDependenciesMeta === 'object' ? manifest.peerDependenciesMeta : {}
for (const peer of peers) {
  if (meta[peer] === undefined || meta[peer].optional !== true) {
    console.error('peer not optional: ' + peer)
    process.exit(1)
  }
}
if (typeof manifest.dsh === 'object' && manifest.dsh !== null && manifest.dsh.bundle !== undefined && manifest.dsh.bundle.patch === undefined) {
  console.error('dsh.bundle.patch missing')
  process.exit(1)
}
NODE
  then pass 'manifest：dependencies 为空、peerDependenciesMeta 全 optional'; else fail 'manifest：dependencies 为空、peerDependenciesMeta 全 optional'; fi

  if (cd "$STAGE" && sha256sum -c CHECKSUMS.txt >/dev/null 2>&1); then
    pass 'sha256sum -c CHECKSUMS.txt'
  else
    fail 'sha256sum -c CHECKSUMS.txt'
  fi

  run 'bash -n install-offline.sh' bash -n "$STAGE/install-offline.sh"
  run 'install-offline.sh 在解压目录中可执行' test -x "$STAGE/install-offline.sh"

  FAKE_HOME="$WORK/fake-home"
  SANDBOX_HOME="$WORK/sandbox-home"
  FAKE_PROFILE="$WORK/profile"
  PROFILE_ARGS=(--dsh-home "$FAKE_HOME" --profile web)
  if grep -q -- '--profile-dir' "$STAGE/install-offline.sh"; then
    PROFILE_ARGS=(--profile-dir "$FAKE_PROFILE")
  fi

  if (cd "$STAGE" && clean_env HOME="$SANDBOX_HOME" ./install-offline.sh --dry-run "${PROFILE_ARGS[@]}" >/dev/null 2>&1); then
    pass 'install-offline.sh --dry-run'
  else
    fail 'install-offline.sh --dry-run'
  fi
  if [ -e "$FAKE_HOME" ] || [ -e "$FAKE_PROFILE" ] || [ -e "$SANDBOX_HOME" ]; then fail '--dry-run 不应创建任何文件'; else pass '--dry-run 零写入'; fi

  if (cd "$STAGE" && clean_env HOME="$SANDBOX_HOME" ./install-offline.sh "${PROFILE_ARGS[@]}" >/dev/null 2>&1); then
    pass 'install-offline.sh 正式安装'
  else
    fail 'install-offline.sh 正式安装'
  fi

  PLUGIN_NAME="$(basename "$STAGE" | sed -E 's/-offline-.*$//')"
  INSTALLED_PROFILE="$FAKE_HOME/profiles/web"
  [ -d "$FAKE_PROFILE" ] && INSTALLED_PROFILE="$FAKE_PROFILE"
  PLUGIN_DIR="$INSTALLED_PROFILE/node_modules/$PLUGIN_NAME"
  if [ -f "$PLUGIN_DIR/package.json" ]; then pass "安装后插件目录存在（$PLUGIN_NAME）"; else fail "安装后插件目录存在（$PLUGIN_NAME）"; fi
  if node - "$INSTALLED_PROFILE/package.json" "$PLUGIN_NAME" <<'NODE'
const fs = require('node:fs')
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
if (!Array.isArray(bundles) || !bundles.includes(process.argv[3])) process.exit(1)
NODE
  then pass '安装后 dsh.profile.bundles 已包含插件'; else fail '安装后 dsh.profile.bundles 已包含插件'; fi

  if (cd "$STAGE" && clean_env HOME="$SANDBOX_HOME" ./install-offline.sh "${PROFILE_ARGS[@]}" >/dev/null 2>&1); then
    pass '重复安装幂等'
  else
    fail '重复安装幂等'
  fi

  if (cd "$STAGE" && clean_env HOME="$SANDBOX_HOME" ./install-offline.sh --uninstall "${PROFILE_ARGS[@]}" >/dev/null 2>&1); then
    pass 'install-offline.sh --uninstall'
  else
    fail 'install-offline.sh --uninstall'
  fi
  if node - "$INSTALLED_PROFILE/package.json" "$PLUGIN_NAME" <<'NODE'
const fs = require('node:fs')
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
process.exit(bundles.includes(process.argv[3]) ? 1 : 0)
NODE
  then pass '卸载后 bundles 无残留'; else fail '卸载后 bundles 无残留'; fi
  if [ -d "$PLUGIN_DIR" ]; then fail '卸载后插件目录已删除'; else pass '卸载后插件目录已删除'; fi

  rm -rf "$WORK"
  trap - EXIT
done

REAL_AFTER="$(real_fingerprint)"
if [ "$REAL_BEFORE" = "$REAL_AFTER" ]; then pass '未触碰用户真实 profile（/home/fc/.dsh 指纹不变）'; else fail '用户真实 profile 被修改（/home/fc/.dsh 指纹变化）'; fi

printf '\n==== 汇总 ====\n检查 %d 项，失败 %d 项\n' "$CHECKS" "$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
