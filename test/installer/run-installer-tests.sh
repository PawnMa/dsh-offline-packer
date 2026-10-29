#!/usr/bin/env bash
# =============================================================================
# dsh-offline-packer 离线安装器兼容性测试
#
# 覆盖用户报障场景：离线机器 Node 8.17.0 / 魔改（非标准）DSH / PATH 上没有 dsh
# 命令 / profile 不在默认位置。用真实离线包（test/out-installer 下的 dsh-unlag
# 产物）解包后跑三种安装方式，并验证卸载、bash -n、PowerShell AST + DryRun、
# 内嵌 JS 的 ES5 兼容性（用 node@8.17.0 语法检查）。
#
# 用法：bash test/installer/run-installer-tests.sh
# 退出码：0 = 全部通过；1 = 有失败（逐条打印 FAIL）。
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
OUT="$ROOT/test/out-installer"
LOG_DIR="$ROOT/test/installer/logs"
BUNDLE="dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2"
STAGING="$OUT/$BUNDLE"
ZIP="$STAGING.zip"
EXTRACT_ROOT="$OUT/extract"
EX="$EXTRACT_ROOT/$BUNDLE"
HOMES="$OUT/homes"
FAKEBIN="$OUT/fakebin"
NODE8=""
PWSH=""

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

section "0. 工具与产物检查"
[ -f "$ZIP" ] || { echo "缺少离线包：$ZIP（先跑 test/out-installer 打包）"; exit 1; }
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
pass "抽取到 $EMBEDDED_COUNT 个内嵌 JS 帮助脚本：$(cd "$LOG_DIR/embedded-js" && ls *.js | tr '\n' ' ')"
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
section "结果"
if [ "$FAIL" = "0" ]; then
  echo "ALL TESTS PASSED"
  exit 0
fi
echo "FAILED: $FAIL 项失败"
exit 1
