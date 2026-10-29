#!/usr/bin/env bash
# =============================================================================
# dsh-offline-packer 离线安装器兼容性测试
#
# 覆盖用户报障场景：离线机器 Node 8.17.0 / 魔改（非标准）DSH / PATH 上没有 dsh
# 命令 / profile 不在默认位置。用真实离线包（test/out-installer 下的 dsh-unlag
# 产物）解包后跑三种安装方式，并验证卸载、bash -n、PowerShell AST + DryRun、
# 内嵌 JS 的 ES5 兼容性（用 node@8.17.0 语法检查）。
#
# 第二轮（task-1 适配性校验）新增：用 dsh-better-sidebar@0.22.1（peer
# @deepseek-ai/dsh-session ^0.1.7-rc.1）产物验证「插件 DSH peer 范围 vs 探测到的
# 宿主版本」校验：不匹配默认 exit 2、--force 强制、--dry-run 只展示、宿主不可
# 探测 warning 继续、无 DSH peer 跳过、--uninstall 不受影响；bash/PS1/Node8 三路。
# 两个离线包都在测试开始时用当前 lib/scripts.mjs 重新生成（SKIP_FIXTURE_BUILD=1 可复用）。
#
# 用法：bash test/installer/run-installer-tests.sh
# 退出码：0 = 全部通过；1 = 有失败（逐条打印 FAIL）。
# 注意：全部用例都 `env -u DSH_HOME -u DSH_PROFILE_DIR` 并写沙盒 home，
#       绝不读写 /home/fc/.dsh（fixture 构建的 local 通道只读扫描已装插件）。
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT" || exit 1
OUT="$ROOT/test/out-installer"
LOG_DIR="$ROOT/test/installer/logs"
BUNDLE="dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2"
STAGING="$OUT/$BUNDLE"
ZIP="$STAGING.zip"
# dsh-better-sidebar@0.22.1 历史版本产物（适配性校验的「不匹配」样本）
BS_BUNDLE="dsh-better-sidebar-offline-0.22.1-dsh-0.1.7-rc.2"
BS_STAGING="$OUT/$BS_BUNDLE"
BS_ZIP="$BS_STAGING.zip"
EXTRACT_ROOT="$OUT/extract"
EX="$EXTRACT_ROOT/$BUNDLE"
BS_EX="$EXTRACT_ROOT/$BS_BUNDLE"
HOMES="$OUT/homes"
FAKEBIN="$OUT/fakebin"
NODE8=""
PWSH=""
NODE_NOW="$(command -v node)"

# 真正的 @deepseek-ai/dsh 安装目录（本机 0.2.1-rc.2）与 host-pinned（0.1.0-rc.7）
DSH_REAL="/home/fc/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh"
HOST_PINNED="/home/fc/dsh-plugin-build/host-pinned/node_modules/@deepseek-ai/dsh"

export PATH="/home/fc/.nvm/versions/node/v24.14.0/bin:/usr/local/bin:/usr/bin:/bin"

FAIL=0
LAST_EXIT=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }
section() { printf '\n===== %s =====\n' "$*"; }

rm -rf "$LOG_DIR" "$EXTRACT_ROOT" "$HOMES" "$FAKEBIN"
mkdir -p "$LOG_DIR" "$HOMES" "$FAKEBIN"

# 运行并把 stdout+stderr 落到 logs/<name>.log，退出码放到 LAST_EXIT。
run() {
  local name="$1"
  shift
  "$@" >"$LOG_DIR/$name.log" 2>&1
  LAST_EXIT=$?
  return 0
}
expect_exit() {
  local expected="$1" name="$2"
  if [ "$LAST_EXIT" = "$expected" ]; then
    pass "$name：退出码 $LAST_EXIT"
  else
    fail "$name：期望退出码 $expected，实际 $LAST_EXIT（见 logs/$name.log）"
  fi
}
expect_in_log() {
  local name="$1" pattern="$2"
  if grep -qF -- "$pattern" "$LOG_DIR/$name.log"; then
    pass "$name：包含「$pattern」"
  else
    fail "$name：缺少「$pattern」（见 logs/$name.log）"
  fi
}
expect_not_in_log() {
  local name="$1" pattern="$2"
  if grep -qF -- "$pattern" "$LOG_DIR/$name.log"; then
    fail "$name：不应出现「$pattern」（见 logs/$name.log）"
  else
    pass "$name：不含「$pattern」"
  fi
}
expect_file() {
  if [ -e "$1" ]; then pass "存在 $1"; else fail "缺失 $1"; fi
}
expect_no_file() {
  if [ ! -e "$1" ]; then pass "已清理 $1"; else fail "仍存在 $1"; fi
}
bundle_state() {
  # bundle_state <profile package.json> <plugin name> -> present|absent
  node -e '
var fs = require("fs")
var manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
var list = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles
var found = Array.isArray(list) && list.indexOf(process.argv[2]) !== -1
process.stdout.write(found ? "present" : "absent")
' "$1" "$2"
}
expect_bundle() {
  local want="$1" manifest="$2" name="$3" label="$4"
  local got
  got="$(bundle_state "$manifest" "$name")"
  if [ "$got" = "$want" ]; then pass "$label：bundles $want"; else fail "$label：bundles=$got，期望 $want"; fi
}

section "0. 用最新源码重新生成离线包 + 工具检查"
# 安装器模板就在 lib/scripts.mjs 里：复用旧 zip 会测到旧安装器，因此默认每次重建。
# 调试时可 SKIP_FIXTURE_BUILD=1 复用已有产物。
if [ "${SKIP_FIXTURE_BUILD:-0}" = "1" ] && [ -f "$ZIP" ] && [ -f "$BS_ZIP" ]; then
  pass "SKIP_FIXTURE_BUILD=1：复用已有离线包"
else
  run build-fixtures node "$ROOT/test/installer/build-fixtures.mjs"
  expect_exit 0 build-fixtures
fi
[ -f "$ZIP" ] || { echo "缺少离线包：$ZIP（fixture 构建失败，见 logs/build-fixtures.log）"; exit 1; }
[ -f "$BS_ZIP" ] || { echo "缺少离线包：$BS_ZIP（fixture 构建失败，见 logs/build-fixtures.log）"; exit 1; }
pass "离线包：$(basename "$ZIP")（$(stat -c%s "$ZIP" 2>/dev/null || echo '?') B）"
pass "离线包：$(basename "$BS_ZIP")（$(stat -c%s "$BS_ZIP" 2>/dev/null || echo '?') B）"
# 产物里的安装器必须与当前 generator 渲染结果逐字节一致（防止测旧模板）
run fixture-fresh node --input-type=module -e '
import { readFileSync } from "node:fs"
import { renderInstallers } from "./lib/scripts.mjs"
const cases = [
  ["dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2", { pluginName: "dsh-unlag", version: "1.12.3", targetDshVersion: "0.2.1-rc.2", mode: "local" }],
  ["dsh-better-sidebar-offline-0.22.1-dsh-0.1.7-rc.2", { pluginName: "dsh-better-sidebar", version: "0.22.1", targetDshVersion: "0.1.7-rc.2", mode: "registry" }],
]
for (const entry of cases) {
  const actualSh = readFileSync("test/out-installer/" + entry[0] + "/install-offline.sh", "utf8")
  const actualPs1 = readFileSync("test/out-installer/" + entry[0] + "/install-offline.ps1", "utf8")
  const flagMatch = /^HAS_VENDORED_DEPS=(\d)$/m.exec(actualSh)
  const rendered = renderInstallers({ ...entry[1], hasVendoredDeps: flagMatch !== null && flagMatch[1] === "1" })
  for (const pair of [["install-offline.sh", actualSh], ["install-offline.ps1", actualPs1]]) {
    if (pair[1] !== rendered[pair[0]]) {
      console.error(pair[0] + " 与当前 generator 不一致：" + entry[0])
      process.exit(1)
    }
  }
}
console.log("installers fresh")
'
expect_exit 0 fixture-fresh
expect_in_log fixture-fresh "installers fresh"
node --check "$ROOT/lib/scripts.mjs" && pass "node --check lib/scripts.mjs" || fail "node --check lib/scripts.mjs"

# npx 拉取 node@8.17.0（本机需网络；已缓存时会很快）
NODE8="$(npx -y node@8.17.0 -p 'process.execPath' 2>"$LOG_DIR/node8-resolve.err" | tail -1)"
if [ -n "$NODE8" ] && [ -x "$NODE8" ]; then
  pass "node8 可执行文件：$NODE8（$("$NODE8" -v)）"
else
  fail "无法通过 npx 获取 node@8.17.0（见 logs/node8-resolve.err）"
  NODE8=""
fi

if [ -x "$ROOT/staging/pwsh/pwsh" ]; then
  PWSH="$ROOT/staging/pwsh/pwsh"
elif [ -x "/home/fc/dsh-plugin-build/staging/pwsh/pwsh" ]; then
  PWSH="/home/fc/dsh-plugin-build/staging/pwsh/pwsh"
fi
if [ -n "$PWSH" ]; then
  pass "便携 pwsh：$PWSH（$("$PWSH" -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')）"
else
  fail "未找到便携 pwsh，跳过 PowerShell 行为测试（AST 仍可用 node 以外的检查）"
fi

section "1. 解包 + 包完整性"
run unzip-list unzip -Z1 "$ZIP"
expect_exit 0 unzip-list
grep -q "$BUNDLE/install-offline.sh" "$LOG_DIR/unzip-list.log" && pass "zip 含 install-offline.sh" || fail "zip 缺 install-offline.sh"
grep -q "$BUNDLE/install-offline.ps1" "$LOG_DIR/unzip-list.log" && pass "zip 含 install-offline.ps1" || fail "zip 缺 install-offline.ps1"
run unzip-test unzip -t "$ZIP"
expect_exit 0 unzip-test
expect_in_log unzip-test "No errors detected"

mkdir -p "$EXTRACT_ROOT"
run unzip-extract unzip -q "$ZIP" -d "$EXTRACT_ROOT"
expect_exit 0 unzip-extract
[ -f "$EX/install-offline.sh" ] && pass "解包得到 $EX" || fail "解包失败：$EX 不存在"
chmod +x "$EX/install-offline.sh"

run checksums bash -c "cd \"$EX\" && sha256sum -c CHECKSUMS.txt"
expect_exit 0 checksums
if grep -q "FAILED" "$LOG_DIR/checksums.log"; then fail "CHECKSUMS 校验失败"; else pass "CHECKSUMS.txt 全部通过"; fi

run sh-syntax bash -n "$EX/install-offline.sh"
expect_exit 0 sh-syntax

# 内嵌 JS：抽取 + node8 语法检查 + ES5 模式检查
mkdir -p "$LOG_DIR/embedded-js"
run extract-js node "$ROOT/test/installer/extract-embedded-js.mjs" "$EX/install-offline.sh" "$LOG_DIR/embedded-js"
expect_exit 0 extract-js
EMBEDDED_COUNT="$(ls "$LOG_DIR/embedded-js"/*.js 2>/dev/null | wc -l | tr -d ' ')"
pass "抽取到 $EMBEDDED_COUNT 个内嵌 JS 帮助脚本：$(cd "$LOG_DIR/embedded-js" && ls *.js | tr '\n' ' ' | sed 's/ *$//')"
if [ -n "$NODE8" ]; then
  for js in "$LOG_DIR/embedded-js"/*.js; do
    "$NODE8" --check "$js" 2>"$LOG_DIR/node8-check.err"
    if [ $? = 0 ]; then pass "node@8.17.0 --check $(basename "$js")"; else fail "node@8.17.0 无法解析 $(basename "$js")：$(cat "$LOG_DIR/node8-check.err")"; fi
  done
  ES5_FORBIDDEN="require\\(['\"]node:|\\bconst \\b|\\blet \\b|=>|\\?\\?|\\?\\.|\\.\\.\\.|fs\\.promises|rmSync|recursive: *true|Array\\.from|Object\\.fromEntries|\\basync \\b|\\bawait \\b"
  # 只扫代码行（跳过注释里提到的 API 名字）
  grep -nH -vE '^[[:space:]]*//' "$LOG_DIR/embedded-js"/NODE_*.js >"$LOG_DIR/embedded-js-code.txt" 2>/dev/null
  if grep -nE "$ES5_FORBIDDEN" "$LOG_DIR/embedded-js-code.txt" >"$LOG_DIR/es5-scan.log" 2>&1; then
    fail "内嵌 JS 出现非 ES5/Node 4+ 构造（见 logs/es5-scan.log）"
  elif grep -nE '\$\{|^[[:space:]]*`|[=(,+][[:space:]]*`' "$LOG_DIR/embedded-js-code.txt" >"$LOG_DIR/es5-scan-template.log" 2>&1; then
    fail "内嵌 JS 出现模板字符串（见 logs/es5-scan-template.log）"
  else
    pass "内嵌 JS 无 node: 前缀 / const/let / 箭头函数 / 展开 / ?? / ?. / fs.promises / 模板字符串"
  fi
fi

# 产物 manifest：dependencies 清空、peer optional
node -e '
var fs = require("fs")
var manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
var dependencies = manifest.dependencies || {}
var peers = manifest.peerDependencies || {}
var optional = manifest.peerDependenciesMeta || {}
var bad = []
if (Object.keys(dependencies).length !== 0) bad.push("dependencies 非空")
Object.keys(peers).forEach(function (name) {
  if (!optional[name] || optional[name].optional !== true) bad.push("peer 非 optional: " + name)
})
if (bad.length) { console.error(bad.join("; ")); process.exit(1) }
process.stdout.write("manifest ok")
' "$EX/package/package.json" >"$LOG_DIR/manifest-check.log" 2>&1
if [ $? = 0 ]; then pass "产物 manifest：dependencies:{}、peer 全部 optional"; else fail "产物 manifest 检查失败：$(cat "$LOG_DIR/manifest-check.log")"; fi

# README 必须写清三种特殊场景
for pattern in "--profile-dir" "DSH_PROFILE_DIR" "Node 8" "魔改" "未检测到 dsh 命令行/安装目录" "--dsh-install"; do
  if grep -qF -- "$pattern" "$EX/README.md"; then pass "README 覆盖「$pattern」"; else fail "README 缺少「$pattern」"; fi
done

# =============================================================================
section "1b. dsh-better-sidebar 0.22.1 产物（适配性校验样本）"
if [ -f "$LOG_DIR/embedded-js/NODE_COMPAT.js" ]; then
  pass "内嵌适配性校验器 NODE_COMPAT.js 已生成"
else
  fail "内嵌适配性校验器 NODE_COMPAT.js 缺失"
fi
run bs-unzip-list unzip -Z1 "$BS_ZIP"
expect_exit 0 bs-unzip-list
grep -qF "$BS_BUNDLE/install-offline.sh" "$LOG_DIR/bs-unzip-list.log" && pass "BS zip 含 install-offline.sh" || fail "BS zip 缺 install-offline.sh"
grep -qF "$BS_BUNDLE/install-offline.ps1" "$LOG_DIR/bs-unzip-list.log" && pass "BS zip 含 install-offline.ps1" || fail "BS zip 缺 install-offline.ps1"
run bs-unzip-test unzip -t "$BS_ZIP"
expect_exit 0 bs-unzip-test
expect_in_log bs-unzip-test "No errors detected"
run bs-unzip-extract unzip -q "$BS_ZIP" -d "$EXTRACT_ROOT"
expect_exit 0 bs-unzip-extract
[ -f "$BS_EX/install-offline.sh" ] && pass "BS 解包得到 $BS_EX" || fail "BS 解包失败：$BS_EX 不存在"
chmod +x "$BS_EX/install-offline.sh"
run bs-checksums bash -c "cd \"$BS_EX\" && sha256sum -c CHECKSUMS.txt"
expect_exit 0 bs-checksums
run bs-sh-syntax bash -n "$BS_EX/install-offline.sh"
expect_exit 0 bs-sh-syntax

# 产物 peer 必须是 ^0.1.7-rc.1（用户报障组合：0.22.1 + 老宿主）
node --input-type=module -e '
import { readFileSync } from "node:fs"
const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"))
const peers = manifest.peerDependencies || {}
const required = ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-tools"]
for (const name of required) {
  if (peers[name] !== "^0.1.7-rc.1") {
    console.error(name + " peer=" + peers[name] + "，期望 ^0.1.7-rc.1")
    process.exit(1)
  }
}
console.log("bs peers ok")
' "$BS_EX/package/package.json" >"$LOG_DIR/bs-peers.log" 2>&1
if [ $? = 0 ]; then pass "BS 产物 peer：dsh-session/llm/tools 均为 ^0.1.7-rc.1"; else fail "BS 产物 peer 检查失败：$(cat "$LOG_DIR/bs-peers.log")"; fi

# 包内 README「适配性校验 / missing export」小节
for pattern in "适配性校验" "SessionLogOffset" "dsh-better-sidebar@0.13.1" "dsh-better-sidebar@0.22.1" "dsh-better-sidebar@0.28.x" "--force" "missing export"; do
  if grep -qF -- "$pattern" "$BS_EX/README.md"; then pass "BS README 覆盖「$pattern」"; else fail "BS README 缺少「$pattern」"; fi
done
# 安装器文本里的新参数与新小节
for pattern in "--force" "适配性校验" "SessionLogOffset"; do
  if grep -qF -- "$pattern" "$BS_EX/install-offline.sh"; then pass "BS install-offline.sh 含「$pattern」"; else fail "BS install-offline.sh 缺「$pattern」"; fi
done
grep -qF -- "-Force" "$BS_EX/install-offline.ps1" && pass "BS install-offline.ps1 含「-Force」" || fail "BS install-offline.ps1 缺「-Force」"
grep -qF -- "适配性校验" "$BS_EX/install-offline.ps1" && pass "BS install-offline.ps1 含「适配性校验」" || fail "BS install-offline.ps1 缺「适配性校验」"

BOM_BS="$(head -c 3 "$BS_EX/install-offline.ps1" | od -An -tx1 | tr -d ' \n')"
if [ "$BOM_BS" = "efbbbf" ]; then pass "BS install-offline.ps1 带 UTF-8 BOM"; else fail "BS install-offline.ps1 缺 UTF-8 BOM（$BOM_BS）"; fi
if [ -n "$PWSH" ]; then
  run bs-ps-ast "$PWSH" -NoProfile -File "$ROOT/test/installer/ps-ast-check.ps1" "$BS_EX/install-offline.ps1"
  expect_exit 0 bs-ps-ast
  expect_in_log bs-ps-ast "AST OK"
else
  fail "跳过 BS install-offline.ps1 AST（无便携 pwsh）"
fi

# =============================================================================
section "2. 场景 A：正常 Node v24，全新 DSH_HOME"
HOME_A="$HOMES/a-node24"
rm -rf "$HOME_A"
run a-install env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$EX/install-offline.sh" --dsh-home "$HOME_A" --profile web
expect_exit 0 a-install
expect_in_log a-install "安装完成：dsh-unlag 1.12.3"
expect_in_log a-install "检测到宿主   : @deepseek-ai/dsh 0.2.1-rc.2"
expect_in_log a-install "定位来源     : --dsh-home + --profile"
expect_file "$HOME_A/profiles/web/package.json"
expect_file "$HOME_A/profiles/web/node_modules/dsh-unlag/package.json"
expect_file "$HOME_A/profiles/web/cordis.patch.yml"
expect_file "$HOME_A/profiles/web/pnpm-workspace.yaml"
expect_bundle present "$HOME_A/profiles/web/package.json" dsh-unlag a-install

run a-reinstall env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$EX/install-offline.sh" --dsh-home "$HOME_A" --profile web
expect_exit 0 a-reinstall
expect_in_log a-reinstall "dsh.profile.bundles 已包含 dsh-unlag（幂等）"

run a-uninstall env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$EX/install-offline.sh" --uninstall --dsh-home "$HOME_A" --profile web
expect_exit 0 a-uninstall
expect_in_log a-uninstall "已从 dsh.profile.bundles 移除 dsh-unlag"
expect_no_file "$HOME_A/profiles/web/node_modules/dsh-unlag"
expect_bundle absent "$HOME_A/profiles/web/package.json" dsh-unlag a-uninstall

run a-uninstall-again env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$EX/install-offline.sh" --uninstall --dsh-home "$HOME_A" --profile web
expect_exit 0 a-uninstall-again
expect_in_log a-uninstall-again "bundles 里本来就没有 dsh-unlag"
expect_in_log a-uninstall-again "插件目录不存在"

# =============================================================================
section "3. 场景 B：NODE_BIN=node@8.17.0，全新 DSH_HOME（用户报障场景）"
HOME_B="$HOMES/b-node8"
rm -rf "$HOME_B"
if [ -n "$NODE8" ]; then
  run b-install env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u DSH_PROFILE NODE_BIN="$NODE8" \
    bash "$EX/install-offline.sh" --dsh-home "$HOME_B" --profile web
  expect_exit 0 b-install
  expect_in_log b-install "Node           : $NODE8（v8.17.0）"
  expect_in_log b-install "检测到较旧的 Node（v8.17.0）"
  expect_in_log b-install "安装完成：dsh-unlag 1.12.3"
  expect_file "$HOME_B/profiles/web/node_modules/dsh-unlag/package.json"
  expect_bundle present "$HOME_B/profiles/web/package.json" dsh-unlag b-install

  run b-uninstall env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u DSH_PROFILE \
    bash "$EX/install-offline.sh" --uninstall --dsh-home "$HOME_B" --profile web --node "$NODE8"
  expect_exit 0 b-uninstall
  expect_in_log b-uninstall "已从 dsh.profile.bundles 移除 dsh-unlag"
  expect_no_file "$HOME_B/profiles/web/node_modules/dsh-unlag"
  expect_bundle absent "$HOME_B/profiles/web/package.json" dsh-unlag b-uninstall
else
  fail "跳过场景 B（node8 不可用）"
fi

# =============================================================================
section "4. 场景 C：--profile-dir + 假 dsh shim + 无任何真实 dsh 来源"
# 假 dsh：PATH 上存在但直接失败（模拟「非 dsh 命令 / 魔改版本」）
cat >"$FAKEBIN/dsh" <<'FAKE'
#!/bin/sh
# fake dsh used by installer compatibility tests: always fails
exit 1
FAKE
chmod +x "$FAKEBIN/dsh"
# 场景 C 要求「没有任何真实 dsh 来源」：把 HOME 指向全新目录，否则默认 ~/.dsh
# 里的 profiles/node_modules/@deepseek-ai/dsh 回退链接仍会被自动探测到。
C_HOME="$HOMES/c-home"
mkdir -p "$C_HOME"
PROFILE_C="$HOMES/c-custom/dsh-profile"          # 父目录故意不叫 profiles，证明没有拼 DSH_HOME
run c-install env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh" --profile-dir "$PROFILE_C" --node "$NODE8"
expect_exit 0 c-install
expect_in_log c-install "profile 目录   : $PROFILE_C"
expect_in_log c-install "定位来源     : --profile-dir"
expect_in_log c-install "检测到 dsh 命令，但没找到标准 @deepseek-ai/dsh 安装目录（可能是魔改版本）"
expect_in_log c-install "跳过宿主版本校验"
expect_in_log c-install "安装完成：dsh-unlag 1.12.3"
expect_not_in_log c-install "未安装 dsh 环境"
expect_file "$PROFILE_C/package.json"
expect_file "$PROFILE_C/node_modules/dsh-unlag/package.json"
expect_file "$PROFILE_C/cordis.patch.yml"
expect_bundle present "$PROFILE_C/package.json" dsh-unlag c-install

run c-reinstall env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh" --profile-dir "$PROFILE_C" --node "$NODE8"
expect_exit 0 c-reinstall
expect_in_log c-reinstall "dsh.profile.bundles 已包含 dsh-unlag（幂等）"

run c-uninstall env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh" --uninstall --profile-dir "$PROFILE_C" --node "$NODE8"
expect_exit 0 c-uninstall
expect_no_file "$PROFILE_C/node_modules/dsh-unlag"
expect_bundle absent "$PROFILE_C/package.json" dsh-unlag c-uninstall

# 4b. DSH_PROFILE_DIR 环境变量
PROFILE_C2="$HOMES/c2-env/custom-profile"
run c2-install env -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  DSH_PROFILE_DIR="$PROFILE_C2" HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh" --node "$NODE8"
expect_exit 0 c2-install
expect_in_log c2-install "定位来源     : DSH_PROFILE_DIR"
expect_not_in_log c2-install "与本次安装目标"
expect_file "$PROFILE_C2/node_modules/dsh-unlag/package.json"
expect_bundle present "$PROFILE_C2/package.json" dsh-unlag c2-install
run c2-uninstall env -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  DSH_PROFILE_DIR="$PROFILE_C2" HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh" --uninstall --node "$NODE8"
expect_exit 0 c2-uninstall
expect_no_file "$PROFILE_C2/node_modules/dsh-unlag"

# 4c. 优先级：--profile-dir 覆盖 DSH_PROFILE_DIR，并打印环境变量不一致警告
PROFILE_C3="$HOMES/c3-priority/target-profile"
PROFILE_C3_OTHER="$HOMES/c3-priority/ignored-profile"
run c3-priority env -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  DSH_PROFILE_DIR="$PROFILE_C3_OTHER" HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh" --profile-dir "$PROFILE_C3" --dry-run --node "$NODE8"
expect_exit 0 c3-priority
expect_in_log c3-priority "profile 目录   : $PROFILE_C3"
expect_in_log c3-priority "定位来源     : --profile-dir"
expect_not_in_log c3-priority "profile 目录   : $PROFILE_C3_OTHER"
expect_in_log c3-priority "环境变量 DSH_PROFILE_DIR=$PROFILE_C3_OTHER 与本次安装目标 $PROFILE_C3 不同"
if [ ! -e "$PROFILE_C3_OTHER" ]; then pass "c3：DSH_PROFILE_DIR 指定的目录未被写入"; else fail "c3：DSH_PROFILE_DIR 目录被写入"; fi

# 4d. 安全语义（事故回归）：显式 --dsh-home 优先于环境变量 DSH_PROFILE_DIR —— 必须装进 B 并警告
PROFILE_C4_ENV="$HOMES/c4-explicit-wins/env-profile"
PROFILE_C4_HOME="$HOMES/c4-explicit-wins/explicit-home"
run c4-explicit-wins env -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  DSH_PROFILE_DIR="$PROFILE_C4_ENV" HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh" --dsh-home "$PROFILE_C4_HOME" --node "$NODE8"
expect_exit 0 c4-explicit-wins
expect_in_log c4-explicit-wins "profile 目录   : $PROFILE_C4_HOME/profiles/web"
expect_in_log c4-explicit-wins "定位来源     : --dsh-home + --profile"
expect_in_log c4-explicit-wins "环境变量 DSH_PROFILE_DIR=$PROFILE_C4_ENV 与本次安装目标 $PROFILE_C4_HOME/profiles/web 不同"
expect_file "$PROFILE_C4_HOME/profiles/web/node_modules/dsh-unlag/package.json"
expect_bundle present "$PROFILE_C4_HOME/profiles/web/package.json" dsh-unlag c4-explicit-wins
if [ ! -e "$PROFILE_C4_ENV" ]; then pass "c4：环境变量 DSH_PROFILE_DIR 指定的目录未被写入（显式 --dsh-home 生效）"; else fail "c4：环境变量目录被写入"; fi
run c4-uninstall env -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  DSH_PROFILE_DIR="$PROFILE_C4_ENV" HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh" --uninstall --dsh-home "$PROFILE_C4_HOME" --node "$NODE8"
expect_exit 0 c4-uninstall
expect_no_file "$PROFILE_C4_HOME/profiles/web/node_modules/dsh-unlag"

# 4e. 无任何显式 profile 参数、只有环境变量 DSH_PROFILE_DIR -> 装进环境变量目录（不告警）
PROFILE_C5="$HOMES/c5-env-only/env-profile"
run c5-env-only env -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  DSH_PROFILE_DIR="$PROFILE_C5" HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh"
expect_exit 0 c5-env-only
expect_in_log c5-env-only "profile 目录   : $PROFILE_C5"
expect_in_log c5-env-only "定位来源     : DSH_PROFILE_DIR"
expect_not_in_log c5-env-only "与本次安装目标"
expect_file "$PROFILE_C5/node_modules/dsh-unlag/package.json"
expect_bundle present "$PROFILE_C5/package.json" dsh-unlag c5-env-only
run c5-uninstall env -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  DSH_PROFILE_DIR="$PROFILE_C5" HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh" --uninstall
expect_exit 0 c5-uninstall
expect_no_file "$PROFILE_C5/node_modules/dsh-unlag"

# 4f. 环境变量 DSH_HOME 与显式 --profile-dir 不一致 -> 用 --profile-dir 并警告
PROFILE_C6_ENV_HOME="$HOMES/c6-home-env/env-home"
PROFILE_C6_TARGET="$HOMES/c6-home-env/target-profile"
run c6-home-env env -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  DSH_HOME="$PROFILE_C6_ENV_HOME" HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
  bash "$EX/install-offline.sh" --profile-dir "$PROFILE_C6_TARGET" --dry-run --node "$NODE8"
expect_exit 0 c6-home-env
expect_in_log c6-home-env "profile 目录   : $PROFILE_C6_TARGET"
expect_in_log c6-home-env "定位来源     : --profile-dir"
expect_in_log c6-home-env "环境变量 DSH_HOME=$PROFILE_C6_ENV_HOME 与本次安装目标 $PROFILE_C6_TARGET 不同"
expect_no_file "$PROFILE_C6_ENV_HOME"

# =============================================================================
section "5. dsh 探测降级 / --dsh-install / nodes 缺失错误"
run e-dsh-install env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$EX/install-offline.sh" --dsh-home "$HOMES/e-dsh" --dsh-install "$DSH_REAL" --dry-run
expect_exit 0 e-dsh-install
expect_in_log e-dsh-install "检测到宿主   : @deepseek-ai/dsh 0.2.1-rc.2"
expect_in_log e-dsh-install "来源：--dsh-install / DSH_INSTALL_DIR"

# heal fallback 目录（profiles/node_modules/@deepseek-ai/dsh 符号链接，魔改宿主常见布局）
HOME_H="$HOMES/h-heal"
mkdir -p "$HOME_H/profiles/node_modules/@deepseek-ai"
ln -sfn "$HOST_PINNED" "$HOME_H/profiles/node_modules/@deepseek-ai/dsh"
run h-heal env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$EX/install-offline.sh" --dsh-home "$HOME_H" --dry-run
expect_exit 0 h-heal
expect_in_log h-heal "检测到宿主   : @deepseek-ai/dsh 0.1.0-rc.7"
expect_in_log h-heal "来源：自动探测"

# --dsh-install 指向非标准包（魔改宿主）→ info，不阻断
FAKE_DSH="$HOMES/fake-dsh-install"
mkdir -p "$FAKE_DSH"
printf '{\n  "name": "my-custom-dsh",\n  "version": "9.9.9"\n}\n' >"$FAKE_DSH/package.json"
run i-fake-install env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$EX/install-offline.sh" --dsh-home "$HOMES/i-fake" --dsh-install "$FAKE_DSH" --dry-run
expect_exit 0 i-fake-install
expect_in_log i-fake-install "指定的 dsh 安装目录不是标准 @deepseek-ai/dsh 包（可能是魔改版本）"
expect_in_log i-fake-install "跳过宿主版本校验"

# 找不到 node → 可操作错误（构造只含 dirname 的最小 PATH，确保 PATH 上没有 node/nodejs）
NONODE_BIN="$OUT/nonode-bin"
rm -rf "$NONODE_BIN"
mkdir -p "$NONODE_BIN"
ln -sfn /usr/bin/dirname "$NONODE_BIN/dirname"
run j-nonode env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  HOME="$HOMES/j-home" PATH="$NONODE_BIN" \
  /usr/bin/bash "$EX/install-offline.sh" --dsh-home "$HOMES/j-nonode"
expect_exit 1 j-nonode
expect_in_log j-nonode "未找到可用的 Node"
expect_in_log j-nonode "--node /path/to/node"
expect_no_file "$HOMES/j-nonode"

# --node 指向不存在的路径 → 可操作错误
run k-badnode env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$EX/install-offline.sh" --dsh-home "$HOMES/k-badnode" --node "$HOMES/does-not-exist/node"
expect_exit 1 k-badnode
expect_in_log k-badnode "找不到可用的 Node：--node"
expect_in_log k-badnode "NODE_BIN=/path/to/node"

# 所有日志里都不允许出现吓人的「未安装 dsh 环境」
if grep -rn "未安装 dsh 环境" "$LOG_DIR" >"$LOG_DIR/forbidden-phrase.log" 2>&1; then
  fail "输出里出现「未安装 dsh 环境」（见 logs/forbidden-phrase.log）"
else
  pass "所有安装输出均无「未安装 dsh 环境」措辞"
fi

# =============================================================================
section "6. PowerShell 版（PS5.1 语法 AST + BOM/CRLF + DryRun + 安装/卸载）"
PS1="$EX/install-offline.ps1"
BOM="$(head -c 3 "$PS1" | od -An -tx1 | tr -d ' \n')"
if [ "$BOM" = "efbbbf" ]; then pass "install-offline.ps1 带 UTF-8 BOM（efbbbf）"; else fail "install-offline.ps1 缺少 UTF-8 BOM（实际 $BOM）"; fi
LF_ONLY="$(awk '!/\r$/' "$PS1" | wc -l | tr -d ' ')"
if [ "$LF_ONLY" = "0" ]; then pass "install-offline.ps1 全部为 CRLF 行尾"; else fail "install-offline.ps1 有 $LF_ONLY 行不是 CRLF"; fi

if [ -n "$PWSH" ]; then
  run ps-ast "$PWSH" -NoProfile -File "$ROOT/test/installer/ps-ast-check.ps1" "$PS1"
  expect_exit 0 ps-ast
  expect_in_log ps-ast "AST OK"

  HOME_PS="$HOMES/ps-home"
  run ps-dryrun env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    "$PWSH" -NoProfile -File "$PS1" -DshHome "$HOME_PS" -DryRun
  expect_exit 0 ps-dryrun
  expect_in_log ps-dryrun "profile 目录   : $HOME_PS/profiles/web"
  expect_in_log ps-dryrun "定位来源     : -DshHome + -Profile"

  run ps-install env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    "$PWSH" -NoProfile -File "$PS1" -DshHome "$HOME_PS"
  expect_exit 0 ps-install
  expect_in_log ps-install "安装完成：dsh-unlag 1.12.3"
  expect_file "$HOME_PS/profiles/web/node_modules/dsh-unlag/package.json"
  expect_bundle present "$HOME_PS/profiles/web/package.json" dsh-unlag ps-install

  run ps-uninstall env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    "$PWSH" -NoProfile -File "$PS1" -Uninstall -DshHome "$HOME_PS"
  expect_exit 0 ps-uninstall
  expect_no_file "$HOME_PS/profiles/web/node_modules/dsh-unlag"
  expect_bundle absent "$HOME_PS/profiles/web/package.json" dsh-unlag ps-uninstall

  # -ProfileDir + 假 dsh（魔改模拟）
  PROFILE_PS_C="$HOMES/ps-c/custom-profile"
  run ps-profile-dir env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
    "$PWSH" -NoProfile -File "$PS1" -ProfileDir "$PROFILE_PS_C" -DryRun
  expect_exit 0 ps-profile-dir
  expect_in_log ps-profile-dir "profile 目录   : $PROFILE_PS_C"
  expect_in_log ps-profile-dir "定位来源     : -ProfileDir"
  expect_in_log ps-profile-dir "检测到 dsh 命令，但没找到标准 @deepseek-ai/dsh 安装目录"

  # -Node node8：只提示旧 Node，不影响安装
  run ps-node8 env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    "$PWSH" -NoProfile -File "$PS1" -DshHome "$HOMES/ps-node8" -Node "$NODE8" -DryRun
  expect_exit 0 ps-node8
  expect_in_log ps-node8 "v8.17.0"
  expect_in_log ps-node8 "检测到较旧的 Node"

  # 安全语义：显式 -DshHome 优先于环境变量 DSH_PROFILE_DIR，并打印不一致警告
  PROFILE_PS_WINS_ENV="$HOMES/ps-explicit-wins/env-profile"
  PS_WINS_HOME="$HOMES/ps-explicit-wins/explicit-home"
  run ps-explicit-wins env -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    DSH_PROFILE_DIR="$PROFILE_PS_WINS_ENV" HOME="$C_HOME" PATH="$FAKEBIN:/usr/bin:/bin" \
    "$PWSH" -NoProfile -File "$PS1" -DshHome "$PS_WINS_HOME" -DryRun
  expect_exit 0 ps-explicit-wins
  expect_in_log ps-explicit-wins "profile 目录   : $PS_WINS_HOME/profiles/web"
  expect_in_log ps-explicit-wins "定位来源     : -DshHome + -Profile"
  expect_in_log ps-explicit-wins "环境变量 DSH_PROFILE_DIR=$PROFILE_PS_WINS_ENV 与本次安装目标"
  expect_no_file "$PROFILE_PS_WINS_ENV"

  # -DshInstall 指向非标准包（魔改宿主）
  run ps-fake-install env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    "$PWSH" -NoProfile -File "$PS1" -DshHome "$HOMES/ps-fake" -DshInstall "$FAKE_DSH" -DryRun
  expect_exit 0 ps-fake-install
  expect_in_log ps-fake-install "指定的 dsh 安装目录不是标准 @deepseek-ai/dsh 包"
else
  fail "跳过 PowerShell 行为测试（未找到便携 pwsh）"
fi

# =============================================================================
section "7. 适配性校验（用户真实报障：better-sidebar 0.22.1 装到老宿主）"
# 事实：dsh-better-sidebar@0.22.1 的 @deepseek-ai/dsh-* peer 全是 ^0.1.7-rc.1；
# HOST_PINNED=0.1.0-rc.7（没有 SessionLogOffset，强装会整棵插件树加载失败），
# DSH_REAL=0.2.1-rc.2（满足 ^0.1.7-rc.1）。
BS_SH="$BS_EX/install-offline.sh"

# 7a. 默认拒绝：exit 2 + 中文版本对照提示 + 目标目录零写入
HOME_REJECT="$HOMES/compat-reject"
run bs-reject env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$BS_SH" --dsh-home "$HOME_REJECT" --dsh-install "$HOST_PINNED"
expect_exit 2 bs-reject
expect_in_log bs-reject "插件与宿主不匹配"
expect_in_log bs-reject "该插件版本声明需要 ^0.1.7-rc.1"
expect_in_log bs-reject "检测到宿主 DSH 0.1.0-rc.7"
expect_in_log bs-reject "dsh-better-sidebar 0.13.1"
expect_in_log bs-reject "0.22.1"
expect_in_log bs-reject "0.28.x"
expect_in_log bs-reject "SessionLogOffset"
expect_in_log bs-reject "--force"
expect_not_in_log bs-reject "安装完成"
expect_no_file "$HOME_REJECT"

# 7b. 通过：0.2.1-rc.2 满足 ^0.1.7-rc.1 -> 信息通过 + 真正安装
HOME_PASS="$HOMES/compat-pass"
run bs-pass env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$BS_SH" --dsh-home "$HOME_PASS" --dsh-install "$DSH_REAL"
expect_exit 0 bs-pass
expect_in_log bs-pass "适配性校验：通过"
expect_in_log bs-pass "宿主 0.2.1-rc.2"
expect_in_log bs-pass "安装完成：dsh-better-sidebar 0.22.1"
expect_file "$HOME_PASS/profiles/web/node_modules/dsh-better-sidebar/package.json"
expect_bundle present "$HOME_PASS/profiles/web/package.json" dsh-better-sidebar bs-pass

# 7c. --force：warning + 安装成功
HOME_FORCE="$HOMES/compat-force"
run bs-force env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$BS_SH" --dsh-home "$HOME_FORCE" --dsh-install "$HOST_PINNED" --force
expect_exit 0 bs-force
expect_in_log bs-force "已指定 --force"
expect_in_log bs-force "安装完成：dsh-better-sidebar 0.22.1"
expect_file "$HOME_FORCE/profiles/web/node_modules/dsh-better-sidebar/package.json"
expect_bundle present "$HOME_FORCE/profiles/web/package.json" dsh-better-sidebar bs-force

# 7d. --dry-run：展示校验结果、零写入、不中止
HOME_DRY="$HOMES/compat-dry"
run bs-dryrun env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$BS_SH" --dsh-home "$HOME_DRY" --dsh-install "$HOST_PINNED" --dry-run
expect_exit 0 bs-dryrun
expect_in_log bs-dryrun "适配性校验未通过"
expect_in_log bs-dryrun "正式安装会中止"
expect_in_log bs-dryrun "dsh-better-sidebar 0.13.1"
expect_not_in_log bs-dryrun "安装完成"
expect_no_file "$HOME_DRY"

# 7e. 没有 DSH peer 的插件（dsh-unlag）-> 跳过校验
run bs-skip env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$EX/install-offline.sh" --dsh-home "$HOMES/compat-skip" --dsh-install "$DSH_REAL" --dry-run
expect_exit 0 bs-skip
expect_in_log bs-skip "插件未声明 @deepseek-ai/dsh* peer 依赖，跳过适配性校验"
expect_no_file "$HOMES/compat-skip"

# 7f. 宿主不可探测（HOME 隔离 + PATH 无 dsh + 无 fallback）-> warning 后继续安装
HOME_UNKNOWN="$HOMES/compat-unknown"
run bs-unknown env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  HOME="$C_HOME" PATH="/usr/bin:/bin" \
  bash "$BS_SH" --dsh-home "$HOME_UNKNOWN" --node "$NODE_NOW"
expect_exit 0 bs-unknown
expect_in_log bs-unknown "无法校验插件与宿主适配性（未检测到宿主 DSH 版本）"
expect_in_log bs-unknown "插件声明的 DSH peer 范围：^0.1.7-rc.1"
expect_in_log bs-unknown "安装完成：dsh-better-sidebar 0.22.1"
expect_file "$HOME_UNKNOWN/profiles/web/node_modules/dsh-better-sidebar/package.json"

# 7g. --uninstall 不受影响：宿主不匹配也不得 exit 2
run bs-uninstall env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
  bash "$BS_SH" --uninstall --dsh-home "$HOME_PASS" --dsh-install "$HOST_PINNED"
expect_exit 0 bs-uninstall
expect_not_in_log bs-uninstall "插件与宿主不匹配"
expect_no_file "$HOME_PASS/profiles/web/node_modules/dsh-better-sidebar"
expect_bundle absent "$HOME_PASS/profiles/web/package.json" dsh-better-sidebar bs-uninstall

# 7h. --help 文档：--force 与「适配性校验 / SessionLogOffset」说明
run bs-help bash "$BS_SH" --help
expect_exit 0 bs-help
expect_in_log bs-help "--force"
expect_in_log bs-help "适配性校验"
expect_in_log bs-help "SessionLogOffset"

# 7i. Node 8.17.0（旧 Node）：拒绝 / 通过两条，验证新 ES5 helper 兼容
if [ -n "$NODE8" ]; then
  run bs-node8-reject env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u DSH_PROFILE \
    NODE_BIN="$NODE8" bash "$BS_SH" --dsh-home "$HOMES/compat-node8-reject" --dsh-install "$HOST_PINNED"
  expect_exit 2 bs-node8-reject
  expect_in_log bs-node8-reject "插件与宿主不匹配"
  expect_in_log bs-node8-reject "SessionLogOffset"
  expect_no_file "$HOMES/compat-node8-reject"

  run bs-node8-pass env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u DSH_PROFILE \
    NODE_BIN="$NODE8" bash "$BS_SH" --dsh-home "$HOMES/compat-node8-pass" --dsh-install "$DSH_REAL"
  expect_exit 0 bs-node8-pass
  expect_in_log bs-node8-pass "适配性校验：通过"
  expect_in_log bs-node8-pass "安装完成：dsh-better-sidebar 0.22.1"
  expect_file "$HOMES/compat-node8-pass/profiles/web/node_modules/dsh-better-sidebar/package.json"
  expect_bundle present "$HOMES/compat-node8-pass/profiles/web/package.json" dsh-better-sidebar bs-node8-pass
else
  fail "跳过 Node8 适配性校验用例（node@8.17.0 不可用）"
fi

# =============================================================================
section "8. PowerShell 版适配性校验（-DryRun / 拒绝 exit 2 / -Force / 跳过）"
if [ -n "$PWSH" ]; then
  BS_PS1="$BS_EX/install-offline.ps1"

  run bs-ps-dryrun env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    "$PWSH" -NoProfile -File "$BS_PS1" -DshHome "$HOMES/ps-compat-dry" -DshInstall "$HOST_PINNED" -DryRun
  expect_exit 0 bs-ps-dryrun
  expect_in_log bs-ps-dryrun "适配性校验未通过"
  expect_in_log bs-ps-dryrun "正式安装会中止"
  expect_in_log bs-ps-dryrun "dsh-better-sidebar 0.13.1"
  expect_no_file "$HOMES/ps-compat-dry"

  run bs-ps-reject env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    "$PWSH" -NoProfile -File "$BS_PS1" -DshHome "$HOMES/ps-compat-reject" -DshInstall "$HOST_PINNED"
  expect_exit 2 bs-ps-reject
  expect_in_log bs-ps-reject "插件与宿主不匹配"
  expect_in_log bs-ps-reject "0.13.1"
  expect_in_log bs-ps-reject "SessionLogOffset"
  expect_no_file "$HOMES/ps-compat-reject"

  run bs-ps-pass env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    "$PWSH" -NoProfile -File "$BS_PS1" -DshHome "$HOMES/ps-compat-pass" -DshInstall "$DSH_REAL"
  expect_exit 0 bs-ps-pass
  expect_in_log bs-ps-pass "适配性校验：通过"
  expect_in_log bs-ps-pass "安装完成：dsh-better-sidebar 0.22.1"
  expect_file "$HOMES/ps-compat-pass/profiles/web/node_modules/dsh-better-sidebar/package.json"

  run bs-ps-force env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    "$PWSH" -NoProfile -File "$BS_PS1" -DshHome "$HOMES/ps-compat-force" -DshInstall "$HOST_PINNED" -Force
  expect_exit 0 bs-ps-force
  expect_in_log bs-ps-force "已指定 -Force"
  expect_in_log bs-ps-force "安装完成：dsh-better-sidebar 0.22.1"
  expect_file "$HOMES/ps-compat-force/profiles/web/node_modules/dsh-better-sidebar/package.json"

  run bs-ps-skip env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    "$PWSH" -NoProfile -File "$EX/install-offline.ps1" -DshHome "$HOMES/ps-compat-skip" -DshInstall "$DSH_REAL" -DryRun
  expect_exit 0 bs-ps-skip
  expect_in_log bs-ps-skip "插件未声明 @deepseek-ai/dsh* peer 依赖，跳过适配性校验"
  expect_no_file "$HOMES/ps-compat-skip"

  run bs-ps-unknown env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_INSTALL_DIR -u NODE_BIN -u DSH_PROFILE \
    HOME="$C_HOME" PATH="/usr/bin:/bin" \
    "$PWSH" -NoProfile -File "$BS_PS1" -DshHome "$HOMES/ps-compat-unknown"
  expect_exit 0 bs-ps-unknown
  expect_in_log bs-ps-unknown "无法校验插件与宿主适配性（未检测到宿主 DSH 版本）"
  expect_in_log bs-ps-unknown "安装完成：dsh-better-sidebar 0.22.1"
  expect_file "$HOMES/ps-compat-unknown/profiles/web/node_modules/dsh-better-sidebar/package.json"
else
  fail "跳过 PowerShell 适配性校验用例（未找到便携 pwsh）"
fi

# =============================================================================
section "结果"
if [ "$FAIL" = "0" ]; then
  echo "ALL TESTS PASSED"
  exit 0
fi
echo "FAILED: $FAIL 项失败"
exit 1
