/**
 * Generated documentation and zero-network installer scripts.
 *
 * `renderInstallers` produces the two installation channels that ship inside
 * every offline package:
 *
 *   - `install-offline.sh`  bash 3.2+ (Linux / macOS / Windows Git Bash);
 *   - `install-offline.ps1` Windows PowerShell 5.1 (UTF-8 BOM + CRLF).
 *
 * Both are fully generic over plugin name/version/target DSH version, never
 * call npm/pnpm or touch the network, and are idempotent. They initialize a
 * missing profile from the DSH template, copy `package/` into
 * `$DSH_HOME/profiles/<profile>/node_modules/<plugin>` and append the bundle
 * row, warning about stale hand-written mount lines.
 */

/** Escape a value for a bash single-quoted string. */
function bashQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Escape a value for a PowerShell single-quoted string. */
function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** YAML-ish truthy flag for the installer templates. */
function flag(value) {
  return value ? '1' : '0'
}

/**
 * Render both installer scripts for one offline package.
 *
 * @param {{
 *   pluginName: string,
 *   version: string,
 *   targetDshVersion: string,
 *   hasVendoredDeps?: boolean,
 *   mode?: 'local'|'registry',
 * }} options plugin identity.
 * @returns {{'install-offline.sh': string, 'install-offline.ps1': string}}
 */
export function renderInstallers({ pluginName, version, targetDshVersion, hasVendoredDeps = false, mode = 'local' }) {
  const nameBash = bashQuote(pluginName)
  const versionBash = bashQuote(version)
  const targetBash = bashQuote(targetDshVersion)
  const namePs = powerShellQuote(pluginName)
  const versionPs = powerShellQuote(version)
  const targetPs = powerShellQuote(targetDshVersion)
  const modeLabel = mode === 'registry' ? 'registry（npm 历史版本）' : 'local（当前宿主已安装插件）'
  const vendored = flag(hasVendoredDeps)

  const sh = `#!/usr/bin/env bash
# =============================================================================
# ${pluginName} ${version} 离线安装 / 卸载脚本（Linux / macOS / Windows Git Bash）
#
# 目标宿主：@deepseek-ai/dsh ${targetDshVersion}
# 打包模式：${modeLabel}
# 生成器：dsh-offline-packer
#
# 本脚本是「零联网」通道：只做文件系统操作，并调用本机 node 读写 JSON（不执行
# npm / pnpm，不发起任何网络请求），等价于 DSH 官方 bundle 安装的最终状态：
#   1. 定位 profile 目录（默认 $DSH_HOME/profiles/<profile>，也可用
#      --profile-dir / DSH_PROFILE_DIR 直接指定；不存在时按 DSH 模板初始化）；
#   2. 把本分发包的 package/ 目录复制到
#      <profile 目录>/node_modules/${pluginName}；
#   3. 把 "${pluginName}" 追加到 profile package.json 的
#      dsh.profile.bundles（去重；插件自带的 dsh.bundle.patch 会在启动时挂载它）。
#
# 兼容性（重点）：
#   - node 可执行文件可用 --node <路径> 或 NODE_BIN 指定，默认依次尝试 node /
#     nodejs；内嵌 JS 全部是 ES5（require('fs')、var、字符串拼接，递归 mkdir 交给
#     shell 的 mkdir -p），因此 Node 4+/8.x 这类很旧的 Node 也能完成安装；
#   - 不要求 PATH 上有 dsh 命令：dsh 只用于「宿主版本校验」这一条可选提示，
#     探测不到时降级为 info，不影响安装（魔改 / 非标准安装同样适用）。
#
# 幂等：重复执行结果一致；--uninstall 可干净回滚。
#
# 用法：
#   bash install-offline.sh [选项]
#   bash install-offline.sh --help
#
# 选项：
#   --dsh-home <目录>    DSH_HOME；默认取环境变量 DSH_HOME，再默认 ~/.dsh
#   --profile <名字>     profile 名，默认 web；不存在时自动初始化
#   --profile-dir <目录> 直接指定 profile 目录（优先于 --dsh-home/--profile）
#   --node <路径>        node 可执行文件；默认依次尝试 node / nodejs
#   --dsh-install <目录> dsh 安装目录（仅用于宿主版本校验，找不到就跳过）
#   --plugin-src <目录>  插件源目录，默认本脚本同目录下的 package/
#   --uninstall          卸载：删除插件目录并从 bundles 移除（可重复执行）
#   --dry-run            只打印将执行的操作，不写任何文件
#   -h, --help           打印本帮助
#
# 示例：
#   bash install-offline.sh --dry-run
#   bash install-offline.sh
#   DSH_HOME=/opt/dsh bash install-offline.sh --profile web
#   bash install-offline.sh --profile-dir /srv/dsh/profiles/web
#   NODE_BIN=/opt/node/bin/node bash install-offline.sh
#   bash install-offline.sh --uninstall
# =============================================================================
set -euo pipefail

PLUGIN_NAME=${nameBash}
PLUGIN_VERSION=${versionBash}
DSH_VERSION_TARGET=${targetBash}
HAS_VENDORED_DEPS=${vendored}

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd -P)"

DSH_HOME_OPT=""
DSH_HOME_EXPLICIT=0
PROFILE=""
PROFILE_DIR_OPT=""
NODE_BIN_OPT=""
DSH_INSTALL_OPT=""
PLUGIN_SRC=""
DO_UNINSTALL=0
DRY_RUN=0

usage() {
  cat <<'USAGE'
dsh 插件离线安装脚本（零联网，兼容旧 Node，不依赖 dsh 命令）

用法：
  bash install-offline.sh [选项]

选项：
  --dsh-home <目录>    DSH_HOME；默认取环境变量 DSH_HOME，再默认 ~/.dsh
  --profile <名字>     profile 名，默认 web；不存在时自动初始化
  --profile-dir <目录> 直接指定 profile 目录（优先于 --dsh-home/--profile）
  --node <路径>        node 可执行文件；默认依次尝试 node / nodejs
  --dsh-install <目录> dsh 安装目录（仅用于宿主版本校验，找不到就跳过）
  --plugin-src <目录>  插件源目录，默认本脚本同目录下的 package/
  --uninstall          卸载：删除插件目录并从 bundles 移除（可重复执行）
  --dry-run            只打印将执行的操作，不写任何文件
  -h, --help           打印本帮助

环境变量：
  DSH_HOME         DSH 主目录（默认 ~/.dsh）
  DSH_PROFILE_DIR  直接指定 profile 目录（作为默认值；显式 --profile-dir/--dsh-home 优先）
  NODE_BIN         node 可执行文件（等价 --node）
  DSH_INSTALL_DIR  dsh 安装目录（等价 --dsh-install）

示例：
  bash install-offline.sh --dry-run
  bash install-offline.sh
  DSH_HOME=/opt/dsh bash install-offline.sh --profile web
  bash install-offline.sh --profile-dir /srv/dsh/profiles/web
  bash install-offline.sh --uninstall
USAGE
}

log()  { printf '[安装] %s\\n' "$*"; }
info() { printf '[信息] %s\\n' "$*"; }
warn() { printf '[警告] %s\\n' "$*" >&2; }
err()  { printf '[错误] %s\\n' "$*" >&2; }
die()  { err "$*"; exit 1; }
step() { printf '\\n== %s ==\\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home)
      [ $# -ge 2 ] || die "--dsh-home 需要一个目录参数"
      DSH_HOME_OPT="$2"; DSH_HOME_EXPLICIT=1; shift 2 ;;
    --dsh-home=*) DSH_HOME_OPT="\${1#*=}"; DSH_HOME_EXPLICIT=1; shift ;;
    --profile)
      [ $# -ge 2 ] || die "--profile 需要一个名字参数"
      PROFILE="$2"; shift 2 ;;
    --profile=*) PROFILE="\${1#*=}"; shift ;;
    --profile-dir)
      [ $# -ge 2 ] || die "--profile-dir 需要一个目录参数"
      PROFILE_DIR_OPT="$2"; shift 2 ;;
    --profile-dir=*) PROFILE_DIR_OPT="\${1#*=}"; shift ;;
    --node)
      [ $# -ge 2 ] || die "--node 需要一个可执行文件路径"
      NODE_BIN_OPT="$2"; shift 2 ;;
    --node=*) NODE_BIN_OPT="\${1#*=}"; shift ;;
    --dsh-install)
      [ $# -ge 2 ] || die "--dsh-install 需要一个目录参数"
      DSH_INSTALL_OPT="$2"; shift 2 ;;
    --dsh-install=*) DSH_INSTALL_OPT="\${1#*=}"; shift ;;
    --plugin-src)
      [ $# -ge 2 ] || die "--plugin-src 需要一个目录参数"
      PLUGIN_SRC="$2"; shift 2 ;;
    --plugin-src=*) PLUGIN_SRC="\${1#*=}"; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看帮助）" ;;
  esac
done

# ---- 参数补全 -------------------------------------------------------------
if [ -z "$DSH_HOME_OPT" ]; then
  if [ -n "\${DSH_HOME:-}" ]; then DSH_HOME_OPT="$DSH_HOME"; else DSH_HOME_OPT="$HOME/.dsh"; fi
fi
[ -n "$PROFILE" ] || PROFILE="web"
[ -n "$PLUGIN_SRC" ] || PLUGIN_SRC="$SCRIPT_DIR/package"

case "$PROFILE" in
  *[!A-Za-z0-9._-]*) die "profile 名不合法：$PROFILE" ;;
esac
case "$DSH_HOME_OPT" in
  /*) : ;;
  *) die "DSH_HOME 必须是绝对路径：$DSH_HOME_OPT" ;;
esac

abspath() {
  case "$1" in
    /*) printf '%s\\n' "$1" ;;
    *) printf '%s\\n' "$PWD/$1" ;;
  esac
}

strip_trailing_slash() {
  local value="$1"
  while [ "$value" != "/" ] && [ "\${value%/}" != "$value" ]; do value="\${value%/}"; done
  printf '%s\\n' "$value"
}

# profile 目录定位（优先级，显式 CLI 参数一律优先于环境变量）：
#   --profile-dir > --dsh-home + --profile > DSH_PROFILE_DIR >
#   $DSH_HOME + profile > ~/.dsh/profiles/<profile>
# 指定 profile 目录时直接使用该目录，不再拼接 DSH_HOME。
PROFILE_DIR=""
PROFILE_SOURCE=""
if [ -n "$PROFILE_DIR_OPT" ]; then
  PROFILE_DIR="$(strip_trailing_slash "$(abspath "$PROFILE_DIR_OPT")")"
  PROFILE_SOURCE="--profile-dir"
elif [ "$DSH_HOME_EXPLICIT" = "1" ]; then
  PROFILE_DIR="$DSH_HOME_OPT/profiles/$PROFILE"
  PROFILE_SOURCE="--dsh-home + --profile"
elif [ -n "\${DSH_PROFILE_DIR:-}" ]; then
  PROFILE_DIR="$(strip_trailing_slash "$(abspath "$DSH_PROFILE_DIR")")"
  PROFILE_SOURCE="DSH_PROFILE_DIR"
elif [ -n "\${DSH_HOME:-}" ]; then
  PROFILE_DIR="$DSH_HOME_OPT/profiles/$PROFILE"
  PROFILE_SOURCE="DSH_HOME + profile"
else
  PROFILE_DIR="$DSH_HOME_OPT/profiles/$PROFILE"
  PROFILE_SOURCE="默认（~/.dsh）"
fi

# 环境变量与最终目标不一致时给出醒目警告（环境变量只作为默认值，显式参数优先）。
ENV_PROFILE_DIR_EXPECT=""
if [ -n "\${DSH_PROFILE_DIR:-}" ]; then
  ENV_PROFILE_DIR_EXPECT="$(strip_trailing_slash "$(abspath "$DSH_PROFILE_DIR")")"
fi
ENV_HOME_PROFILE_DIR_EXPECT=""
if [ -n "\${DSH_HOME:-}" ]; then
  ENV_HOME_PROFILE_DIR_EXPECT="$(strip_trailing_slash "$(abspath "$DSH_HOME")")/profiles/$PROFILE"
fi

PROFILES_ROOT="$(dirname "$PROFILE_DIR")"
PLUGIN_DEST="$PROFILE_DIR/node_modules/$PLUGIN_NAME"
MANIFEST="$PROFILE_DIR/package.json"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

# ---- node 可执行文件（--node > NODE_BIN > node > nodejs） ------------------
try_node() {
  "$1" -e 'process.exit(0)' >/dev/null 2>&1
}

node_not_found_hint() {
  err "未找到可用的 Node（node / nodejs 都不在 PATH 上，或不可执行）。"
  err "  本安装器只用 Node 读写 JSON（不联网、不装包，兼容 Node 4+/8.x）。"
  err "  请安装 Node，或用 --node /path/to/node（或 NODE_BIN=/path/to/node）指定可执行文件。"
}

NODE_BIN_RESOLVED=""
if [ -n "$NODE_BIN_OPT" ]; then
  if ! try_node "$NODE_BIN_OPT"; then
    err "找不到可用的 Node：--node $NODE_BIN_OPT"
    node_not_found_hint
    exit 1
  fi
  NODE_BIN_RESOLVED="$NODE_BIN_OPT"
elif [ -n "\${NODE_BIN:-}" ]; then
  if ! try_node "$NODE_BIN"; then
    err "找不到可用的 Node：NODE_BIN=$NODE_BIN"
    node_not_found_hint
    exit 1
  fi
  NODE_BIN_RESOLVED="$NODE_BIN"
else
  for candidate in node nodejs; do
    if command -v "$candidate" >/dev/null 2>&1 && try_node "$candidate"; then
      NODE_BIN_RESOLVED="$(command -v "$candidate")"
      break
    fi
  done
  if [ -z "$NODE_BIN_RESOLVED" ]; then
    node_not_found_hint
    exit 1
  fi
fi

NODE_VERSION_RAW="$("$NODE_BIN_RESOLVED" --version 2>/dev/null || true)"
NODE_VERSION="\${NODE_VERSION_RAW#v}"
NODE_MAJOR="\${NODE_VERSION%%.*}"

# ---- 内嵌 node 辅助（ES5 / Node 4+ 兼容；只读写 JSON，不联网） --------------
node_plugin_info() {
  "$NODE_BIN_RESOLVED" - "$PLUGIN_SRC/package.json" <<'NODE_INFO'
var fs = require('fs')
var file = process.argv[2]
var manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
var patch = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
process.stdout.write([manifest.name || '', manifest.version || '', patch ? 'yes' : 'no'].join('|'))
NODE_INFO
}

node_dsh_version() {
  "$NODE_BIN_RESOLVED" - "$1" <<'NODE_VERSION'
var fs = require('fs')
var manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
process.stdout.write(String(manifest.version || 'unknown'))
NODE_VERSION
}

node_init_profile() {
  "$NODE_BIN_RESOLVED" - "$PROFILE_DIR" "$PROFILE" <<'NODE_INIT'
var fs = require('fs')
var path = require('path')
var dir = process.argv[2]
var profile = process.argv[3]
// 目录本身由 shell 的 mkdir -p 创建；这里只读写文件，避免使用
// fs.mkdirSync(dir, { recursive: true })（Node 10.12+ 才有）以兼容 Node 4+/8.x。
var created = []
var manifestPath = path.join(dir, 'package.json')
if (!fs.existsSync(manifestPath)) {
  var bundles
  if (profile === 'web') bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  else if (profile === 'headless') bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
  else bundles = ['@deepseek-ai/dsh-base']
  var manifest = {
    name: 'dsh-profile-' + path.basename(dir),
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: bundles } }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n')
  created.push('package.json')
}
var patchPath = path.join(dir, 'cordis.patch.yml')
if (!fs.existsSync(patchPath)) {
  fs.writeFileSync(patchPath, [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; \`!!js\` expressions allowed).',
    '[]',
    ''
  ].join('\\n'))
  created.push('cordis.patch.yml')
}
var workspacePath = path.join(dir, 'pnpm-workspace.yaml')
if (!fs.existsSync(workspacePath)) {
  fs.writeFileSync(workspacePath, 'packages:\\n  - .\\n\\nnodeLinker: hoisted\\nautoInstallPeers: false\\n')
  created.push('pnpm-workspace.yaml')
}
process.stdout.write(created.length ? created.join(',') : 'none')
NODE_INIT
}

node_add_bundle() {
  "$NODE_BIN_RESOLVED" - "$MANIFEST" "$PLUGIN_NAME" <<'NODE_ADD'
var fs = require('fs')
var file = process.argv[2]
var name = process.argv[3]
var manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
var list = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles.slice() : []
if (list.indexOf(name) !== -1) {
  process.stdout.write('already|' + JSON.stringify(list))
} else {
  list.push(name)
  manifest.dsh.profile.bundles = list
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\\n')
  process.stdout.write('added|' + JSON.stringify(list))
}
NODE_ADD
}

node_remove_bundle() {
  "$NODE_BIN_RESOLVED" - "$MANIFEST" "$PLUGIN_NAME" <<'NODE_REMOVE'
var fs = require('fs')
var file = process.argv[2]
var name = process.argv[3]
var manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
var current = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles
var list = Array.isArray(current) ? current.slice() : []
var index = list.indexOf(name)
if (index === -1) {
  process.stdout.write('absent|' + JSON.stringify(list))
} else {
  list.splice(index, 1)
  manifest.dsh.profile.bundles = list
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\\n')
  process.stdout.write('removed|' + JSON.stringify(list))
}
NODE_REMOVE
}

# ---- 可选：探测 dsh 安装目录（只用于版本校验，探测不到不影响安装） --------
# 探测顺序：--dsh-install / DSH_INSTALL_DIR → profiles/node_modules 回退目录
# （符号链接按 realpath，魔改宿主常用）→ PATH 上的 dsh 命令。
# 找不到时只打印 info：本安装器不依赖 dsh 命令（dsh-offline-bundle 同款思路）。
DSH_CMD_SEEN=0
DSH_PKG=""
DSH_PKG_SOURCE=""

resolve_link() {
  if command -v readlink >/dev/null 2>&1; then
    local resolved
    resolved="$(readlink -f "$1" 2>/dev/null || true)"
    if [ -n "$resolved" ]; then printf '%s\\n' "$resolved"; return 0; fi
  fi
  printf '%s\\n' "$1"
}

is_dsh_package_json() {
  [ -f "$1" ] && grep -qE '"name"[[:space:]]*:[[:space:]]*"@deepseek-ai/dsh"' "$1" 2>/dev/null
}

find_dsh_package_json() {
  local candidate real
  for candidate in "$PROFILES_ROOT/node_modules/@deepseek-ai/dsh" "$DSH_HOME_OPT/profiles/node_modules/@deepseek-ai/dsh"; do
    real="$(resolve_link "$candidate")"
    if is_dsh_package_json "$real/package.json"; then
      printf '%s\\n' "$real/package.json"
      return 0
    fi
  done
  if command -v dsh >/dev/null 2>&1; then
    local bin dir parent i
    bin="$(resolve_link "$(command -v dsh)")"
    dir="$(dirname "$bin")"
    i=0
    while [ $i -lt 12 ]; do
      if is_dsh_package_json "$dir/package.json"; then
        printf '%s\\n' "$dir/package.json"
        return 0
      fi
      parent="$(dirname "$dir")"
      [ "$parent" = "$dir" ] && break
      dir="$parent"
      i=$((i + 1))
    done
  fi
  return 1
}

DSH_INSTALL_TRY=""
if [ -n "$DSH_INSTALL_OPT" ]; then
  DSH_INSTALL_TRY="$DSH_INSTALL_OPT"
elif [ -n "\${DSH_INSTALL_DIR:-}" ]; then
  DSH_INSTALL_TRY="$DSH_INSTALL_DIR"
fi
if [ -n "$DSH_INSTALL_TRY" ]; then
  DSH_INSTALL_REAL="$(resolve_link "$DSH_INSTALL_TRY")"
  if is_dsh_package_json "$DSH_INSTALL_REAL/package.json"; then
    DSH_PKG="$DSH_INSTALL_REAL/package.json"
    DSH_PKG_SOURCE="--dsh-install / DSH_INSTALL_DIR"
  elif [ -d "$DSH_INSTALL_REAL" ]; then
    info "指定的 dsh 安装目录不是标准 @deepseek-ai/dsh 包（可能是魔改版本）：$DSH_INSTALL_TRY"
    info "  本安装不依赖 dsh 命令，继续安装；跳过宿主版本校验。"
  else
    info "指定的 dsh 安装目录不存在：$DSH_INSTALL_TRY，继续自动探测。"
  fi
fi
if command -v dsh >/dev/null 2>&1; then DSH_CMD_SEEN=1; fi
if [ -z "$DSH_PKG" ]; then
  DSH_PKG="$(find_dsh_package_json || true)"
  if [ -n "$DSH_PKG" ]; then DSH_PKG_SOURCE="自动探测"; fi
fi

restart_hint() {
  info "下一步（必须）：重启 dsh 进程（web / headless 按你平时的方式），然后刷新浏览器页面。"
  info "  例如：dsh --profile $PROFILE；非标准 / 魔改安装请运行它自己的启动脚本。"
  info "  验证：重启后打开 dsh 页面确认插件生效；或检查下面两个位置："
  info "    - $MANIFEST 的 dsh.profile.bundles 含「$PLUGIN_NAME」"
  info "    - $PLUGIN_DEST/package.json 存在"
  if [ -n "$DSH_PKG" ]; then
    info "  有 dsh 命令时可查：dsh --profile $PROFILE --dump-config 2>/dev/null | grep -F '$PLUGIN_NAME'"
  fi
}

# ---- 环境检查 -------------------------------------------------------------
step "检查安装环境"
info "Node           : $NODE_BIN_RESOLVED（$NODE_VERSION_RAW）"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) NODE_MAJOR_OK=0 ;;
  *) NODE_MAJOR_OK=1 ;;
esac
if [ "$NODE_MAJOR_OK" = "1" ] && [ "$NODE_MAJOR" -lt 10 ]; then
  info "检测到较旧的 Node（$NODE_VERSION_RAW）：本安装器兼容 Node 4+/8.x（内嵌 JS 为 ES5），安装不受影响。"
  info "  注意：DSH 宿主本身通常需要更新的 Node（>= 20），请确认 dsh 是用哪个 node 启动的。"
fi
if [ "$DSH_HOME_EXPLICIT" = "1" ] || [ -n "\${DSH_HOME:-}" ]; then
  info "DSH_HOME       : $DSH_HOME_OPT"
else
  info "DSH_HOME       : $DSH_HOME_OPT（默认值，可用 --dsh-home 覆盖）"
fi
info "profile        : $PROFILE"
info "profile 目录   : $PROFILE_DIR"
info "  定位来源     : $PROFILE_SOURCE"
if [ -n "$ENV_PROFILE_DIR_EXPECT" ] && [ "$ENV_PROFILE_DIR_EXPECT" != "$PROFILE_DIR" ]; then
  warn "环境变量 DSH_PROFILE_DIR=$DSH_PROFILE_DIR 与本次安装目标 $PROFILE_DIR 不同，已按显式参数/规则使用 $PROFILE_DIR；如非预期请 unset DSH_PROFILE_DIR。"
fi
if [ -n "$ENV_HOME_PROFILE_DIR_EXPECT" ] && [ "$ENV_HOME_PROFILE_DIR_EXPECT" != "$PROFILE_DIR" ]; then
  warn "环境变量 DSH_HOME=$DSH_HOME 与本次安装目标 $PROFILE_DIR 不同，已按显式参数/规则使用 $PROFILE_DIR；如非预期请 unset DSH_HOME。"
fi
info "插件源目录     : $PLUGIN_SRC"
info "目标宿主版本   : $DSH_VERSION_TARGET"

[ -f "$PLUGIN_SRC/package.json" ] || die "找不到插件清单：$PLUGIN_SRC/package.json（用 --plugin-src 指定正确的 package 目录）"

PLUGIN_INFO="$(node_plugin_info)"
IFS='|' read -r SRC_NAME SRC_VERSION SRC_PATCH <<< "$PLUGIN_INFO"
[ "$SRC_NAME" = "$PLUGIN_NAME" ] || die "插件源目录不是 $PLUGIN_NAME（实际：$SRC_NAME）"
if [ "$SRC_VERSION" != "$PLUGIN_VERSION" ]; then
  warn "插件源版本是 $SRC_VERSION，本分发包声明的是 $PLUGIN_VERSION；继续安装。"
fi
info "插件           : $SRC_NAME $SRC_VERSION（bundle patch: $SRC_PATCH）"

if [ "$HAS_VENDORED_DEPS" = "1" ]; then
  info "已内嵌服务端运行时依赖（package/node_modules），安装时无需 pnpm/npm。"
else
  info "插件服务端依赖全部由宿主提供（首次启动时宿主会生成 profiles/node_modules 回退目录）。"
fi

if [ -n "$DSH_PKG" ]; then
  DSH_ACTUAL="$(node_dsh_version "$DSH_PKG")"
  info "检测到宿主   : @deepseek-ai/dsh $DSH_ACTUAL（$DSH_PKG，来源：$DSH_PKG_SOURCE）"
  if [ "$DSH_ACTUAL" != "$DSH_VERSION_TARGET" ]; then
    warn "本分发包按 DSH $DSH_VERSION_TARGET 适配，当前宿主是 $DSH_ACTUAL。"
    warn "版本不匹配可能导致插件加载失败（魔改宿主可忽略此提示）。"
  fi
elif [ "$DSH_CMD_SEEN" = "1" ]; then
  info "检测到 dsh 命令，但没找到标准 @deepseek-ai/dsh 安装目录（可能是魔改版本）。"
  info "  本安装不依赖 dsh 命令，跳过宿主版本校验（可用 --dsh-install 指定）。"
else
  info "未检测到 dsh 命令行/安装目录；本安装不依赖 dsh 命令，跳过宿主版本校验（可用 --dsh-install 指定）。"
fi

# ---- 卸载通道 -------------------------------------------------------------
if [ "$DO_UNINSTALL" = "1" ]; then
  step "卸载 $PLUGIN_NAME"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] 将从 bundles 移除 $PLUGIN_NAME，并删除 $PLUGIN_DEST"
    exit 0
  fi
  if [ -f "$MANIFEST" ]; then
    REMOVE_RESULT="$(node_remove_bundle)"
    IFS='|' read -r REMOVE_ACTION REMOVE_LIST <<< "$REMOVE_RESULT"
    if [ "$REMOVE_ACTION" = "removed" ]; then
      log "已从 dsh.profile.bundles 移除 $PLUGIN_NAME"
    else
      info "bundles 里本来就没有 $PLUGIN_NAME"
    fi
    info "当前 bundles：$REMOVE_LIST"
  else
    info "profile 清单不存在：$MANIFEST，跳过 bundles 处理"
  fi
  if [ -d "$PLUGIN_DEST" ]; then
    rm -rf "$PLUGIN_DEST"
    log "已删除插件目录：$PLUGIN_DEST"
  else
    info "插件目录不存在：$PLUGIN_DEST"
  fi
  info "下一步（必须）：重启 dsh 进程，插件即不再加载。"
  exit 0
fi

# ---- 安装通道 -------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  step "预演（--dry-run，不写任何文件）"
  log "[dry-run] 初始化 profile（若缺失）：$PROFILE_DIR"
  log "[dry-run] 复制 $PLUGIN_SRC -> $PLUGIN_DEST"
  log "[dry-run] 追加 \\"$PLUGIN_NAME\\" 到 $MANIFEST 的 dsh.profile.bundles"
  if [ "$SRC_PATCH" = "yes" ] && [ -f "$PATCH_FILE" ] && grep -vE '^[[:space:]]*#' "$PATCH_FILE" | grep -qF "$PLUGIN_NAME"; then
    warn "[dry-run] $PATCH_FILE 里似乎有 $PLUGIN_NAME 的手写挂载行，正式安装时会再次提示删除（避免双挂载）。"
  fi
  restart_hint
  exit 0
fi

step "初始化 profile（若缺失）"
if [ -f "$MANIFEST" ]; then
  info "profile 已存在，跳过初始化：$MANIFEST"
else
  mkdir -p "$PROFILE_DIR"
  CREATED="$(node_init_profile)"
  log "已初始化 profile，新建文件：$CREATED"
fi

step "复制插件文件"
rm -rf "$PLUGIN_DEST"
mkdir -p "$PROFILE_DIR/node_modules" "$PLUGIN_DEST"
cp -R -p "$PLUGIN_SRC/." "$PLUGIN_DEST/"
[ -f "$PLUGIN_DEST/package.json" ] || die "复制失败：$PLUGIN_DEST/package.json 不存在"
log "已安装：$PLUGIN_DEST"

step "挂载到 profile bundles"
ADD_RESULT="$(node_add_bundle)"
IFS='|' read -r ADD_ACTION ADD_LIST <<< "$ADD_RESULT"
if [ "$ADD_ACTION" = "added" ]; then
  log "已追加 \\"$PLUGIN_NAME\\" 到 dsh.profile.bundles"
else
  info "dsh.profile.bundles 已包含 $PLUGIN_NAME（幂等）"
fi
info "当前 bundles：$ADD_LIST"

if [ "$SRC_PATCH" = "yes" ] && [ -f "$PATCH_FILE" ]; then
  if grep -vE '^[[:space:]]*#' "$PATCH_FILE" | grep -qF "$PLUGIN_NAME"; then
    warn "检测到 $PATCH_FILE 里可能还有 $PLUGIN_NAME 的手写挂载行。"
    warn "bundle 通道会自动挂载，请删除手写挂载行，否则可能双重挂载（duplicate prefix route）。"
  fi
fi

step "完成"
log "安装完成：$PLUGIN_NAME $PLUGIN_VERSION（目标 DSH $DSH_VERSION_TARGET）"
restart_hint
`

  const ps1Lines = `# =============================================================================
# ${pluginName} ${version} 离线安装 / 卸载脚本（Windows PowerShell 5.1+）
#
# 目标宿主：@deepseek-ai/dsh ${targetDshVersion}
# 打包模式：${modeLabel}
# 生成器：dsh-offline-packer
#
# 零联网通道：只做文件系统操作（不执行 npm / pnpm，不发起网络请求）。
# 本脚本用 PowerShell 自身读写 JSON，不依赖 node / dsh 命令。
#
# 幂等：重复执行结果一致；-Uninstall 可干净回滚。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1
#   powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1 -ProfileDir C:\\dsh\\profiles\\web
#   powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1 -Uninstall
# =============================================================================
[CmdletBinding()]
param(
  [string]$DshHome = '',
  [string]$Profile = 'web',
  [string]$ProfileDir = '',
  [string]$Node = '',
  [string]$DshInstall = '',
  [string]$PluginSrc = '',
  [switch]$Uninstall,
  [switch]$DryRun,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$PluginName = ${namePs}
$PluginVersion = ${versionPs}
$DshVersionTarget = ${targetPs}
$HasVendoredDeps = ${vendored === 1 ? '$true' : '$false'}

$ScriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ScriptDir)) {
  $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$DshHomeExplicit = -not [string]::IsNullOrEmpty($DshHome)
if ([string]::IsNullOrEmpty($DshHome)) {
  if (-not [string]::IsNullOrEmpty($env:DSH_HOME)) { $DshHome = $env:DSH_HOME }
  else { $DshHome = Join-Path $HOME '.dsh' }
}
if ([string]::IsNullOrEmpty($Profile)) { $Profile = 'web' }
if ([string]::IsNullOrEmpty($PluginSrc)) { $PluginSrc = Join-Path $ScriptDir 'package' }

# profile 目录定位（优先级，显式 CLI 参数一律优先于环境变量）：
#   -ProfileDir > -DshHome + -Profile > $env:DSH_PROFILE_DIR >
#   $env:DSH_HOME + Profile > ~/.dsh/profiles/<profile>
# 指定 profile 目录时直接使用该目录，不再拼接 DSH_HOME。
$ProfileDirSource = ''
if (-not [string]::IsNullOrEmpty($ProfileDir)) {
  if (-not [System.IO.Path]::IsPathRooted($ProfileDir)) { $ProfileDir = Join-Path (Get-Location).Path $ProfileDir }
  $ProfileDirSource = '-ProfileDir'
} elseif ($DshHomeExplicit) {
  $ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
  $ProfileDirSource = '-DshHome + -Profile'
} elseif (-not [string]::IsNullOrEmpty($env:DSH_PROFILE_DIR)) {
  $ProfileDir = $env:DSH_PROFILE_DIR
  if (-not [System.IO.Path]::IsPathRooted($ProfileDir)) { $ProfileDir = Join-Path (Get-Location).Path $ProfileDir }
  $ProfileDirSource = 'DSH_PROFILE_DIR'
} elseif (-not [string]::IsNullOrEmpty($env:DSH_HOME)) {
  $ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
  $ProfileDirSource = 'DSH_HOME + Profile'
} else {
  $ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
  $ProfileDirSource = '默认（~/.dsh）'
}
# 环境变量与最终目标不一致时给出醒目警告（环境变量只作为默认值，显式参数优先）
$envProfileDirExpect = ''
if (-not [string]::IsNullOrEmpty($env:DSH_PROFILE_DIR)) {
  $envProfileDirExpect = $env:DSH_PROFILE_DIR
  if (-not [System.IO.Path]::IsPathRooted($envProfileDirExpect)) { $envProfileDirExpect = Join-Path (Get-Location).Path $envProfileDirExpect }
}
$envHomeProfileDirExpect = ''
if (-not [string]::IsNullOrEmpty($env:DSH_HOME)) {
  $envHomeProfileDirExpect = Join-Path (Join-Path $env:DSH_HOME 'profiles') $Profile
}
$ProfilesRoot = Split-Path -Parent $ProfileDir
$PluginDest = Join-Path (Join-Path $ProfileDir 'node_modules') $PluginName
$ManifestPath = Join-Path $ProfileDir 'package.json'
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'

function Write-Log([string]$Message) { Write-Host "[安装] $Message" }
function Write-Info([string]$Message) { Write-Host "[信息] $Message" }
function Write-Warn([string]$Message) { Write-Host "[警告] $Message" -ForegroundColor Yellow }
function Write-Err([string]$Message) { Write-Host "[错误] $Message" -ForegroundColor Red }
function Write-Step([string]$Message) { Write-Host ''; Write-Host "== $Message ==" }
function Stop-Fail([string]$Message) { Write-Err $Message; exit 1 }

function Show-Usage {
  Write-Host '用法：powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1 [选项]'
  Write-Host ''
  Write-Host '  -DshHome <目录>    DSH_HOME；默认环境变量 DSH_HOME，再默认 ~/.dsh'
  Write-Host '  -Profile <名字>    profile 名，默认 web；不存在时自动初始化'
  Write-Host '  -ProfileDir <目录> 直接指定 profile 目录（优先于 -DshHome/-Profile）'
  Write-Host '  -Node <路径>       node 可执行文件；默认依次尝试 node / nodejs（仅用于信息提示）'
  Write-Host '  -DshInstall <目录> dsh 安装目录（仅用于宿主版本校验，找不到就跳过）'
  Write-Host '  -PluginSrc <目录>  插件源目录，默认本脚本同目录下的 package'
  Write-Host '  -Uninstall         卸载：删除插件目录并从 bundles 移除'
  Write-Host '  -DryRun            只打印将执行的操作，不写任何文件'
  Write-Host '  -Help              打印本帮助'
  Write-Host ''
  Write-Host '环境变量：DSH_HOME / DSH_PROFILE_DIR（仅作默认值，显式参数优先）/ NODE_BIN / DSH_INSTALL_DIR'
}

function Read-JsonFile([string]$Path) {
  return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8) | ConvertFrom-Json
}

function Resolve-NodeExecutable([string]$Explicit) {
  if (-not [string]::IsNullOrEmpty($Explicit)) {
    if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
    $command = Get-Command $Explicit -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    return $null
  }
  foreach ($name in @('node', 'nodejs')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
  }
  return $null
}

# 去掉结尾的 / 或 \（仅用于比较路径是否相同，不改变实际安装路径）
function Get-ComparablePath([string]$Path) {
  $value = $Path
  while ($value.Length -gt 1) {
    $last = $value[$value.Length - 1]
    if (($last -ne '/') -and ($last -ne ([char]92))) { break }
    $value = $value.Substring(0, $value.Length - 1)
  }
  return $value
}

function Write-JsonFile([string]$Path, $Value) {
  $text = $Value | ConvertTo-Json -Depth 20
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $text + [Environment]::NewLine, $utf8NoBom)
}

function Get-Bundles($Manifest) {
  $bundles = @()
  if ($null -ne $Manifest -and $null -ne $Manifest.dsh -and $null -ne $Manifest.dsh.profile -and $null -ne $Manifest.dsh.profile.bundles) {
    foreach ($entry in @($Manifest.dsh.profile.bundles)) { if ($null -ne $entry) { $bundles += [string]$entry } }
  }
  return ,$bundles
}

function Set-Bundles($Manifest, $Bundles) {
  if ($null -eq $Manifest.dsh) {
    $Manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if ($null -eq $Manifest.dsh.profile) {
    $Manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $Manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @($Bundles) -Force
}

function Initialize-Profile([string]$Dir, [string]$ProfileName) {
  $created = @()
  if (-not (Test-Path -LiteralPath $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
  $manifest = Join-Path $Dir 'package.json'
  if (-not (Test-Path -LiteralPath $manifest)) {
    if ($ProfileName -eq 'web') { $bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') }
    elseif ($ProfileName -eq 'headless') { $bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless') }
    else { $bundles = @('@deepseek-ai/dsh-base') }
    $value = [ordered]@{
      name = 'dsh-profile-' + (Split-Path -Leaf $Dir)
      private = $true
      dependencies = [ordered]@{}
      dsh = [ordered]@{ profile = [ordered]@{ bundles = @($bundles) } }
    }
    Write-JsonFile $manifest $value
    $created += 'package.json'
  }
  $patch = Join-Path $Dir 'cordis.patch.yml'
  if (-not (Test-Path -LiteralPath $patch)) {
    $template = @(
      '# Your patch layer for this dsh profile, applied after every bundle layer:',
      '# a top-level YAML array of loader patch entries (id-targeted config',
      '# overrides, disables, and insert lists; \`\`!!js\`\` expressions allowed).',
      '[]',
      ''
    ) -join [Environment]::NewLine
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($patch, $template, $utf8NoBom)
    $created += 'cordis.patch.yml'
  }
  $workspace = Join-Path $Dir 'pnpm-workspace.yaml'
  if (-not (Test-Path -LiteralPath $workspace)) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($workspace, "packages:\`r\`n  - .\`r\`n\`r\`nnodeLinker: hoisted\`r\`nautoInstallPeers: false\`r\`n", $utf8NoBom)
    $created += 'pnpm-workspace.yaml'
  }
  return ($created -join ',')
}

function Find-DshPackageJson([string]$ExplicitDir) {
  if (-not [string]::IsNullOrEmpty($ExplicitDir)) {
    $resolved = Resolve-Path -LiteralPath $ExplicitDir -ErrorAction SilentlyContinue
    if ($null -eq $resolved) {
      Write-Info "指定的 dsh 安装目录不存在：$ExplicitDir，继续自动探测。"
    } else {
      $candidate = Join-Path $resolved.Path 'package.json'
      if (Test-Path -LiteralPath $candidate) {
        try {
          if ((Read-JsonFile $candidate).name -eq '@deepseek-ai/dsh') { return @{ Path = $candidate; Source = '指定的安装目录' } }
        } catch { }
        Write-Info "指定的 dsh 安装目录不是标准 @deepseek-ai/dsh 包（可能是魔改版本）：$ExplicitDir"
        Write-Info '  本安装不依赖 dsh 命令，继续安装；跳过宿主版本校验。'
      } else {
        Write-Info "指定的 dsh 安装目录缺少 package.json：$ExplicitDir，继续自动探测。"
      }
    }
  }
  # profiles/node_modules 回退目录（heal fallback，魔改宿主常用；可能是指向真实安装目录的符号链接）
  $healCandidates = @(
    (Join-Path (Join-Path (Join-Path $ProfilesRoot 'node_modules') '@deepseek-ai') 'dsh'),
    (Join-Path (Join-Path (Join-Path (Join-Path $DshHome 'profiles') 'node_modules') '@deepseek-ai') 'dsh')
  )
  foreach ($candidate in $healCandidates) {
    $packageJson = Join-Path $candidate 'package.json'
    if (Test-Path -LiteralPath $packageJson) {
      try {
        if ((Read-JsonFile $packageJson).name -eq '@deepseek-ai/dsh') { return @{ Path = $packageJson; Source = '自动探测（profiles/node_modules 回退目录）' } }
      } catch { }
    }
  }
  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    $dir = Split-Path -Parent $command.Source
    for ($i = 0; $i -lt 12; $i++) {
      $candidate = Join-Path $dir 'package.json'
      if (Test-Path -LiteralPath $candidate) {
        try {
          if ((Read-JsonFile $candidate).name -eq '@deepseek-ai/dsh') { return @{ Path = $candidate; Source = 'PATH 上的 dsh 命令' } }
        } catch { }
      }
      $parent = Split-Path -Parent $dir
      if ([string]::IsNullOrEmpty($parent) -or $parent -eq $dir) { break }
      $dir = $parent
    }
    return @{ Path = $null; Source = 'PATH 上的 dsh 命令（非标准安装）' }
  }
  return @{ Path = $null; Source = '' }
}

function Show-RestartHint {
  Write-Info '下一步（必须）：重启 dsh 进程（web / headless 按你平时的方式），然后刷新浏览器页面。'
  Write-Info "  例如：dsh --profile $Profile；非标准 / 魔改安装请运行它自己的启动脚本。"
  Write-Info '  验证：重启后打开 dsh 页面确认插件生效；或检查下面两个位置：'
  Write-Info "    - $ManifestPath 的 dsh.profile.bundles 含「$PluginName」"
  Write-Info ("    - " + (Join-Path $PluginDest 'package.json') + ' 存在')
  if ($null -ne $dshPackageJson) {
    Write-Info "  有 dsh 命令时可查：dsh --profile $Profile --dump-config | Select-String -SimpleMatch '$PluginName'"
  }
}

if ($Help) { Show-Usage; exit 0 }

# ---- node 可执行文件（--Node > NODE_BIN > node > nodejs；仅用于信息提示） ----
$nodeExplicit = ''
if (-not [string]::IsNullOrEmpty($Node)) { $nodeExplicit = $Node }
elseif (-not [string]::IsNullOrEmpty($env:NODE_BIN)) { $nodeExplicit = $env:NODE_BIN }
$NodeBinResolved = Resolve-NodeExecutable $nodeExplicit
if ((-not [string]::IsNullOrEmpty($nodeExplicit)) -and [string]::IsNullOrEmpty($NodeBinResolved)) {
  Stop-Fail "找不到 -Node 指定的 Node：$nodeExplicit（请给 node 可执行文件的绝对路径，或设置 NODE_BIN）"
}
$NodeVersionRaw = ''
if (-not [string]::IsNullOrEmpty($NodeBinResolved)) {
  try { $NodeVersionRaw = (& $NodeBinResolved '--version' 2>$null | Select-Object -First 1) } catch { $NodeVersionRaw = '' }
}
$nodeMajor = 0
if ($NodeVersionRaw -match '^v?(\\d+)') { $nodeMajor = [int]$Matches[1] }

Write-Step '检查安装环境'
if (-not [string]::IsNullOrEmpty($NodeBinResolved)) {
  Write-Info "Node           : $NodeBinResolved（$NodeVersionRaw）"
  if ($nodeMajor -gt 0 -and $nodeMajor -lt 10) {
    Write-Info "检测到较旧的 Node（$NodeVersionRaw）：PowerShell 版不需要 Node，安装不受影响；"
    Write-Info '  但 DSH 宿主本身通常需要更新的 Node（>= 20），请确认 dsh 是用哪个 node 启动的。'
  }
} else {
  Write-Info 'Node           : 未检测到 node / nodejs（PowerShell 版不依赖 Node，继续安装）'
}
if ((-not [string]::IsNullOrEmpty($env:DSH_HOME)) -or $DshHomeExplicit) {
  Write-Info "DSH_HOME       : $DshHome"
} else {
  Write-Info "DSH_HOME       : $DshHome（默认值，可用 -DshHome 覆盖）"
}
Write-Info "profile        : $Profile"
Write-Info "profile 目录   : $ProfileDir"
Write-Info "  定位来源     : $ProfileDirSource"
if ((-not [string]::IsNullOrEmpty($envProfileDirExpect)) -and ((Get-ComparablePath $envProfileDirExpect) -ne (Get-ComparablePath $ProfileDir))) {
  Write-Warn "环境变量 DSH_PROFILE_DIR=$($env:DSH_PROFILE_DIR) 与本次安装目标 $ProfileDir 不同，已按显式参数/规则使用 $ProfileDir；如非预期请 unset DSH_PROFILE_DIR。"
}
if ((-not [string]::IsNullOrEmpty($envHomeProfileDirExpect)) -and ((Get-ComparablePath $envHomeProfileDirExpect) -ne (Get-ComparablePath $ProfileDir))) {
  Write-Warn "环境变量 DSH_HOME=$($env:DSH_HOME) 与本次安装目标 $ProfileDir 不同，已按显式参数/规则使用 $ProfileDir；如非预期请 unset DSH_HOME。"
}
Write-Info "插件源目录     : $PluginSrc"
Write-Info "目标宿主版本   : $DshVersionTarget"

if (-not (Test-Path -LiteralPath (Join-Path $PluginSrc 'package.json'))) {
  Stop-Fail "找不到插件清单：$(Join-Path $PluginSrc 'package.json')（用 -PluginSrc 指定正确的 package 目录）"
}
$sourceManifest = Read-JsonFile (Join-Path $PluginSrc 'package.json')
if ($sourceManifest.name -ne $PluginName) { Stop-Fail "插件源目录不是 $PluginName（实际：$($sourceManifest.name)）" }
if ($sourceManifest.version -ne $PluginVersion) { Write-Warn "插件源版本是 $($sourceManifest.version)，本分发包声明的是 $PluginVersion；继续安装。" }
$hasPatch = $false
if ($null -ne $sourceManifest.dsh -and $null -ne $sourceManifest.dsh.bundle -and $null -ne $sourceManifest.dsh.bundle.patch) { $hasPatch = $true }
Write-Info "插件           : $($sourceManifest.name) $($sourceManifest.version)（bundle patch: $hasPatch）"
if ($HasVendoredDeps) {
  Write-Info '已内嵌服务端运行时依赖（package\\node_modules），安装时无需 pnpm/npm。'
} else {
  Write-Info '插件服务端依赖全部由宿主提供（首次启动时宿主会生成 profiles\\node_modules 回退目录）。'
}

$dshExplicit = ''
if (-not [string]::IsNullOrEmpty($DshInstall)) { $dshExplicit = $DshInstall }
elseif (-not [string]::IsNullOrEmpty($env:DSH_INSTALL_DIR)) { $dshExplicit = $env:DSH_INSTALL_DIR }
$dshLookup = Find-DshPackageJson $dshExplicit
$dshPackageJson = $dshLookup.Path
if ($null -ne $dshPackageJson) {
  $dshManifest = Read-JsonFile $dshPackageJson
  Write-Info "检测到宿主   : @deepseek-ai/dsh $($dshManifest.version)（$dshPackageJson，来源：$($dshLookup.Source)）"
  if ($dshManifest.version -ne $DshVersionTarget) {
    Write-Warn "本分发包按 DSH $DshVersionTarget 适配，当前宿主是 $($dshManifest.version)。"
    Write-Warn '版本不匹配可能导致插件加载失败（魔改宿主可忽略此提示）。'
  }
} elseif ($dshLookup.Source -eq 'PATH 上的 dsh 命令（非标准安装）') {
  Write-Info '检测到 dsh 命令，但没找到标准 @deepseek-ai/dsh 安装目录（可能是魔改版本）。'
  Write-Info '  本安装不依赖 dsh 命令，跳过宿主版本校验（可用 -DshInstall 指定）。'
} else {
  Write-Info '未检测到 dsh 命令行/安装目录；本安装不依赖 dsh 命令，跳过宿主版本校验（可用 -DshInstall 指定）。'
}

if ($Uninstall) {
  Write-Step "卸载 $PluginName"
  if ($DryRun) {
    Write-Log "[dry-run] 将从 bundles 移除 $PluginName，并删除 $PluginDest"
    exit 0
  }
  if (Test-Path -LiteralPath $ManifestPath) {
    $manifest = Read-JsonFile $ManifestPath
    $bundles = Get-Bundles $manifest
    $index = [array]::IndexOf($bundles, $PluginName)
    if ($index -ge 0) {
      $newBundles = @()
      for ($i = 0; $i -lt $bundles.Count; $i++) { if ($i -ne $index) { $newBundles += $bundles[$i] } }
      Set-Bundles $manifest $newBundles
      Write-JsonFile $ManifestPath $manifest
      Write-Log "已从 dsh.profile.bundles 移除 $PluginName"
      Write-Info ("当前 bundles：" + (ConvertTo-Json -Compress -InputObject @($newBundles)))
    } else {
      Write-Info "bundles 里本来就没有 $PluginName"
    }
  } else {
    Write-Info "profile 清单不存在：$ManifestPath，跳过 bundles 处理"
  }
  if (Test-Path -LiteralPath $PluginDest) {
    Remove-Item -LiteralPath $PluginDest -Recurse -Force
    Write-Log "已删除插件目录：$PluginDest"
  } else {
    Write-Info "插件目录不存在：$PluginDest"
  }
  Write-Info '下一步（必须）：重启 dsh 进程，插件即不再加载。'
  exit 0
}

if ($DryRun) {
  Write-Step '预演（-DryRun，不写任何文件）'
  Write-Log "[dry-run] 初始化 profile（若缺失）：$ProfileDir"
  Write-Log "[dry-run] 复制 $PluginSrc -> $PluginDest"
  Write-Log "[dry-run] 追加 \`"$PluginName\`" 到 $ManifestPath 的 dsh.profile.bundles"
  if ($hasPatch -and (Test-Path -LiteralPath $PatchPath)) {
    $hitLines = Select-String -LiteralPath $PatchPath -SimpleMatch $PluginName | Where-Object { $_.Line -notmatch '^\\s*#' }
    if ($null -ne $hitLines) { Write-Warn "[dry-run] $PatchPath 里似乎有 $PluginName 的手写挂载行，正式安装时会再次提示删除（避免双挂载）。" }
  }
  Show-RestartHint
  exit 0
}

Write-Step '初始化 profile（若缺失）'
if (Test-Path -LiteralPath $ManifestPath) {
  Write-Info "profile 已存在，跳过初始化：$ManifestPath"
} else {
  $created = Initialize-Profile $ProfileDir $Profile
  Write-Log "已初始化 profile，新建文件：$created"
}

Write-Step '复制插件文件'
if (Test-Path -LiteralPath $PluginDest) { Remove-Item -LiteralPath $PluginDest -Recurse -Force }
$modulesDir = Join-Path $ProfileDir 'node_modules'
if (-not (Test-Path -LiteralPath $modulesDir)) { New-Item -ItemType Directory -Path $modulesDir -Force | Out-Null }
Copy-Item -LiteralPath $PluginSrc -Destination $PluginDest -Recurse -Force
if (-not (Test-Path -LiteralPath (Join-Path $PluginDest 'package.json'))) {
  Stop-Fail "复制失败：$(Join-Path $PluginDest 'package.json') 不存在"
}
Write-Log "已安装：$PluginDest"

Write-Step '挂载到 profile bundles'
$profileManifest = Read-JsonFile $ManifestPath
$bundles = Get-Bundles $profileManifest
if ([array]::IndexOf($bundles, $PluginName) -ge 0) {
  Write-Info "dsh.profile.bundles 已包含 $PluginName（幂等）"
} else {
  $newBundles = @($bundles) + @($PluginName)
  Set-Bundles $profileManifest $newBundles
  Write-JsonFile $ManifestPath $profileManifest
  Write-Log "已追加 \`"$PluginName\`" 到 dsh.profile.bundles"
}
$finalManifest = Read-JsonFile $ManifestPath
$finalBundles = Get-Bundles $finalManifest
Write-Info ("当前 bundles：" + (ConvertTo-Json -Compress -InputObject @($finalBundles)))

if ($hasPatch -and (Test-Path -LiteralPath $PatchPath)) {
  $hitLines = Select-String -LiteralPath $PatchPath -SimpleMatch $PluginName | Where-Object { $_.Line -notmatch '^\\s*#' }
  if ($null -ne $hitLines) {
    Write-Warn "检测到 $PatchPath 里可能还有 $PluginName 的手写挂载行。"
    Write-Warn 'bundle 通道会自动挂载，请删除手写挂载行，否则可能双重挂载（duplicate prefix route）。'
  }
}

Write-Step '完成'
Write-Log "安装完成：$PluginName $PluginVersion（目标 DSH $DshVersionTarget）"
Show-RestartHint
`

  const ps1 = `\uFEFF${ps1Lines.replace(/\r?\n/g, '\r\n')}`
  return { 'install-offline.sh': sh, 'install-offline.ps1': ps1 }
}

/**
 * Render the package README (Simplified Chinese).
 *
 * @param {{
 *   pluginName: string, version: string, description?: string,
 *   peerDsh?: string|null, targetDshVersion: string,
 *   mode: 'local'|'registry', vendored?: string[], warnings?: string[],
 *   zipName?: string, hostDshVersion?: string,
 * }} options
 * @returns {string} markdown
 */
export function renderReadme(options) {
  const {
    pluginName,
    version,
    description,
    peerDsh,
    targetDshVersion,
    mode,
    vendored = [],
    warnings = [],
    zipName = '',
    hostDshVersion = '',
  } = options
  const modeText = mode === 'registry' ? 'npm registry 历史版本（需要联网打包，产物本身离线可用）' : '当前宿主已安装插件（本地打包）'
  const vendoredText =
    vendored.length === 0
      ? '- 本包没有内嵌第三方运行时依赖：插件 `dependencies` 已清空，运行时依赖全部由宿主提供。'
      : vendored.map((entry) => `- \`${entry}\``).join('\n')
  const warningText =
    warnings.length === 0 ? '' : `\n## 打包警告\n\n打包过程中记录了以下警告，必要时请人工确认：\n\n${warnings.map((entry) => `- ${entry}`).join('\n')}\n`
  const peerText = typeof peerDsh === 'string' && peerDsh !== '' ? peerDsh : '未声明'
  const descriptionText = typeof description === 'string' && description !== '' ? description : '（插件未提供描述）'
  const hostText = hostDshVersion !== '' ? hostDshVersion : '未知'

  return `# ${pluginName} ${version} 离线安装包

> 面向**完全离线**（无网络、无 npm registry、无 pnpm store）的目标机器，把 DSH 插件
> \`${pluginName}@${version}\` 装进 **@deepseek-ai/dsh ${targetDshVersion}** 宿主。
> 由 \`dsh-offline-packer\` 生成，打包模式：${modeText}。

${descriptionText}

---

## 一、快速开始（TL;DR）

先把**整个目录**（不要只拷单个文件）复制到离线机器任意位置，保持内部相对结构不变，然后：

**通道 A：一键脚本（推荐；不需要 pnpm、不联网）**

\`\`\`bash
# Linux / macOS / Windows Git Bash
bash install-offline.sh --dry-run    # 先预演，确认 DSH_HOME / profile / 路径
bash install-offline.sh              # 正式安装（默认 ~/.dsh/profiles/web）
\`\`\`

\`\`\`powershell
# Windows PowerShell 5.1+ / pwsh（在分发包目录内）
powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1
\`\`\`

> **魔改 / 非标准安装、没有 \`dsh\` 命令、或 Node 很旧（如 8.17.0）？**
> 安装器不依赖 \`dsh\` 命令、也不要求新 Node：用 \`--profile-dir\`（或 \`DSH_PROFILE_DIR\`）
> 直接指定 profile 目录，用 \`--node\`（或 \`NODE_BIN\`）指定 node 路径即可。
> **显式参数始终优先于环境变量**（\`DSH_PROFILE_DIR\`/\`DSH_HOME\` 只作默认值；不一致时会打警告）。
> 详见第四节「特殊场景」。

**最后一步（两种通道都一样）：必须重启 dsh 进程**，然后刷新浏览器页面。

---

## 二、版本信息

| 组件 | 版本 | 说明 |
|---|---|---|
| 宿主 \`@deepseek-ai/dsh\` | \`${targetDshVersion}\`（目标） | 目标离线机器上应已装好这个版本的 dsh；本分发包**不含** dsh 本体和 node 运行时。魔改 / 非标准安装即使版本号不同也仍可安装，见第四节「特殊场景」 |
| 插件 \`${pluginName}\` | \`${version}\` | 本包只包含这一个插件版本 |
| 插件声明的 DSH 兼容范围 | \`${peerText}\` | 来自插件的 peerDependencies |
| 打包机宿主版本 | \`${hostText}\` | 仅作参考；本包按目标版本 \`${targetDshVersion}\` 生成 |
| Node.js | 宿主自带要求（通常 >= 20） | 离线机器需已有 node（dsh 自身运行依赖）；**安装器本身兼容 Node 4+/8.x**，可用 \`--node\`/\`NODE_BIN\` 指定路径 |
| pnpm | **不需要** | 通道 A 完全不需要 npm/pnpm |
| \`dsh\` 命令 | 可选 | 找不到 dsh 命令/安装目录**不影响安装**，只跳过宿主版本校验（只打印 info） |

> 版本不匹配（目标机器上的 dsh 版本与上面的目标版本不同）可能导致插件加载失败。
> 请先确认版本，再执行安装；魔改 / 非标准安装探测不到版本时会降级为 info，不阻断安装。

---

## 三、产物清单

| 文件/目录 | 用途 |
|---|---|
| \`package/\` | 插件本体（含 \`package/node_modules\` 内嵌依赖，若本次打包有） |
| \`install-offline.sh\` | Linux / macOS / Git Bash 一键安装（也可 \`--uninstall\` 卸载） |
| \`install-offline.ps1\` | Windows PowerShell 5.1+ 一键安装（也可 \`-Uninstall\` 卸载） |
| \`README.md\` | 本说明 |
| \`VERSIONS.txt\` | 本次打包的版本与依赖清单 |
| \`CHECKSUMS.txt\` | 所有文件的 SHA-256 校验和 |

校验完整性（在解压后的目录内）：

\`\`\`bash
sha256sum -c CHECKSUMS.txt
# macOS: shasum -a 256 -c CHECKSUMS.txt
\`\`\`

---

## 四、安装原理

\`install-offline.sh\` / \`install-offline.ps1\` 不调用 npm/pnpm、不访问网络；bash 版只调用本机 node
读写 JSON（PowerShell 版用 PowerShell 自身读写），只做：

1. **定位 profile 目录**，优先级从高到低（**显式 CLI 参数一律优先于环境变量**）：
   \`--profile-dir <目录>\` → \`--dsh-home\` + \`--profile\` → \`DSH_PROFILE_DIR\` →
   \`$DSH_HOME\` + profile → \`~/.dsh/profiles/web\`。
   指定 profile 目录时**直接使用该目录**，不再拼接 \`DSH_HOME\`。目录不存在时按 DSH 模板初始化
   \`package.json\`、\`cordis.patch.yml\`、\`pnpm-workspace.yaml\`。
   若环境变量 \`DSH_PROFILE_DIR\`/\`DSH_HOME\` 推导出的目录与最终目标不同，会打印醒目 \`[警告]\`
   （「已按显式参数/规则使用 X；如非预期请 unset」）；
2. 把 \`package/\` 复制到 \`<profile 目录>/node_modules/${pluginName}\`
   （重复安装会先删除旧目录，幂等）；
3. 把 \`"${pluginName}"\` 追加到 profile \`package.json\` 的 \`dsh.profile.bundles\`
   （去重；插件自带的 \`dsh.bundle.patch\` 会在启动时自动挂载它）。

如果 profile 的 \`cordis.patch.yml\` 里还有这个插件旧的手写挂载行，脚本会告警：
请删除手写行，否则会和 bundle 通道双重挂载（\`duplicate prefix route\`）。

### 特殊场景：魔改 DSH / 非标准安装 / 没有 dsh 命令 / 旧 Node

安装器**不依赖 \`dsh\` 命令**，也不要求较新的 Node：它只把 dsh 当作「可选的宿主版本校验」来源。
因此下面几种情况都能正常安装（真正的核心动作只有两个：复制 \`package/\`、追加 bundles）：

| 场景 | 安装器表现 | 你要做的 |
|---|---|---|
| 魔改 DSH / 非标准安装（没有标准 \`@deepseek-ai/dsh\` 包，或 \`dsh\` 命令只是包装脚本） | 输出 \`[信息] 检测到 dsh 命令，但没找到标准 @deepseek-ai/dsh 安装目录（可能是魔改版本）\` 或 \`[信息] 未检测到 dsh 命令行/安装目录\`，然后**继续安装** | 通常无需额外操作；想核对宿主版本时加 \`--dsh-install <dsh 安装目录>\` |
| 完全没有 \`dsh\` 命令 / DSH_HOME 不在默认位置 | 默认按 \`~/.dsh/profiles/web\` 定位 profile | 用 \`--profile-dir <profile 目录>\`（或 \`DSH_PROFILE_DIR=<profile 目录>\`）直接指定；PowerShell 用 \`-ProfileDir\` |
| Node 很旧（如 8.17.0）或 node 不在 PATH | 内嵌 JS 全部是 ES5（\`require('fs')\`、\`var\`、字符串拼接；递归建目录交给 shell 的 \`mkdir -p\`），Node 8 能正常完成安装 | 会打印 \`[信息] 检测到较旧的 Node\`；需要指定时用 \`--node /path/to/node\`（或 \`NODE_BIN=/path/to/node\`）；PowerShell 用 \`-Node\`。DSH 宿主本身一般仍需 Node >= 20，那是宿主的事 |
| 找不到 node / nodejs | 打印可操作的错误并退出（不会写坏 profile） | 安装 Node，或用 \`--node\` / \`NODE_BIN\` 指定可执行文件路径 |

示例：

\`\`\`bash
# 魔改 / 无 dsh 命令：直接指定 profile 目录
bash install-offline.sh --profile-dir /srv/dsh/profiles/web

# 指定 dsh 安装目录（仅用于宿主版本校验提示）
bash install-offline.sh --dsh-install /opt/dsh/lib/node_modules/@deepseek-ai/dsh

# 旧 Node（如 8.17.0）：指定 node 可执行文件
NODE_BIN=/opt/node-v8.17.0/bin/node bash install-offline.sh --profile-dir /srv/dsh/profiles/web
\`\`\`

\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1 -ProfileDir C:\\dsh\\profiles\\web
powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1 -Node C:\\nodejs\\node.exe -DshInstall D:\\dsh\\node_modules\\@deepseek-ai\\dsh
\`\`\`

Node 8 上的具体表现：安装、卸载都能正常完成；唯一区别是内嵌 JS 只用 ES5 写法，
不会出现 \`require('node:fs')\`、\`fs.mkdirSync(..., {recursive:true})\` 这类新 API 报错。

### 服务端运行时依赖

插件 \`package.json\` 的 \`dependencies\` 已清空，\`peerDependencies\` 全部标记为
\`optional\`，因此官方 \`dsh plugin add\` 通道也不会联网安装依赖。

${vendoredText}

宿主在**首次启动**时会自动生成 \`$DSH_HOME/profiles/node_modules\` 回退目录，
把 dsh 安装闭包里的包（含 \`ws\`、\`yaml\`、\`@deepseek-ai/*\` 等）链接给所有插件；
因此安装完成后的第一次启动可能比平时稍慢，属正常现象。

---

## 五、重启与验证（必做）

安装完成后**必须重启 dsh 进程**（用你平时启动 dsh 的方式，例如 \`dsh --profile web\`；
魔改 / 非标准安装请运行它自己的启动脚本），然后刷新浏览器页面。

不依赖 dsh 命令的验证方式（推荐，所有场景都适用）：

1. 重启后打开 dsh 页面，确认插件功能可用（例如设置面板里出现对应入口）；
2. 确认文件到位（profile 目录按实际安装位置替换，默认 \`~/.dsh/profiles/web\`）：

\`\`\`bash
ls -l "$PROFILE_DIR/node_modules/${pluginName}/package.json"
grep -F '${pluginName}' "$PROFILE_DIR/package.json"
\`\`\`

只有**有 dsh 命令**时，才可以用命令行核对配置（没有 dsh 命令请跳过这一步）：

\`\`\`bash
dsh --profile web --dump-config 2>/dev/null | grep -F '${pluginName}'
\`\`\`

\`\`\`powershell
dsh --profile web --dump-config 2>&1 | Select-String -SimpleMatch '${pluginName}'
\`\`\`

能查到插件条目、且启动日志里没有 \`entry apply failed\` / \`duplicate prefix route\`，
就说明插件已加载。

---

## 六、卸载

\`\`\`bash
bash install-offline.sh --uninstall
# 或指定：bash install-offline.sh --uninstall --dsh-home /path/to/.dsh --profile web
\`\`\`

\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1 -Uninstall
\`\`\`

卸载会从 \`dsh.profile.bundles\` 移除插件并删除
\`profiles/<profile>/node_modules/${pluginName}\`，可重复执行；完成后重启 dsh 生效。

---

## 七、高级：官方 CLI 通道（可选，需要 pnpm 和可用的 dsh 命令）

**仅适用于标准安装**（PATH 上有真正的 \`dsh\` 命令、profile 由 DSH 自己管理）。
魔改 / 非标准安装 / 没有 dsh 命令的机器请直接用通道 A（\`install-offline.sh\` 或 .ps1）。

如果目标机器上已经有 pnpm，也可以走官方通道（仍然零联网，因为
\`dependencies\` 已清空、peer 全部 optional）：

\`\`\`bash
dsh plugin --profile web add /绝对路径/package
\`\`\`

注意：路径必须是绝对路径；该通道会由 pnpm 生成 lockfile，但不会下载任何包。

---

## 八、常见问题

1. **重启后看不到插件**：确认 dsh 版本与本文档目标版本一致；确认 profile 名一致；
   查看 dsh 启动日志是否有 \`entry apply failed\`。
2. **首次启动后提示找不到某些模块**：确认是 \`node_modules\` 回退目录尚未生成——
   宿主第一次启动会自动生成；若插件报的模块不在宿主闭包里，说明该插件版本与本
   宿主不兼容，请换用匹配 DSH 版本的插件版本重新打包。
3. **Windows 下 PowerShell 执行策略**：使用
   \`powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1\`。
4. **不要混用版本**：不要把本包的 \`package/\` 与其他版本的安装脚本或 tgz 混用。
5. **GTK/GUI 无关**：本包只装插件文件，dsh 宿主、node 运行时需要目标机器自备。
6. **安装时出现「未检测到 dsh 命令行/安装目录」或「检测到 dsh 命令，但没找到标准
   @deepseek-ai/dsh 安装目录」**：这是 \`[信息]\` 级提示，不是错误——安装器不依赖 dsh
   命令，只跳过可选的宿主版本校验。魔改 / 非标准安装的机器可以直接忽略；想校验版本时
   加 \`--dsh-install <dsh 安装目录>\`（PowerShell：\`-DshInstall\`）。
7. **目标机器 Node 很旧（例如 \`node -v\` 是 8.17.0）**：安装器内嵌 JS 全部是 ES5，
   安装/卸载都能正常完成，只会打印一条 \`[信息] 检测到较旧的 Node\`。若 node 不在 PATH
   上，用 \`--node /path/to/node\` 或 \`NODE_BIN=/path/to/node\` 指定（PowerShell：\`-Node\`）。
   注意：DSH 宿主本身对 Node 版本有要求（通常 >= 20），这由宿主的启动方式决定，与本安装器无关。
8. **魔改 DSH 的 profile 不在 \`~/.dsh/profiles/web\`**：用 \`--profile-dir <profile 目录>\`
   直接指定（或设置 \`DSH_PROFILE_DIR\`），安装器会直接把插件装进该目录，不再拼接 DSH_HOME。
   profile 目录不存在时会按 DSH 模板初始化。**显式参数优先**：同时给了 \`--profile-dir\` /
   \`--dsh-home\` 时，环境变量 \`DSH_PROFILE_DIR\`/\`DSH_HOME\` 只作默认值；若两者推导出的目录与最终
   目标不同，安装器会打印 \`[警告]\` 说明已采用哪个目标，按提示 \`unset\` 即可。
${warningText}
---

## 九、打包信息

- 生成器：\`dsh-offline-packer\`（DSH 插件：图形化列出插件、一键离线打包）
- 插件：\`${pluginName}@${version}\`
- 目标宿主：\`@deepseek-ai/dsh@${targetDshVersion}\`
- 打包模式：${modeText}
- zip 文件名：\`${zipName || '（未知）'}\`
- 校验和：见 \`CHECKSUMS.txt\`
- 安装器兼容性：不依赖 \`dsh\` 命令；内嵌 JS 为 ES5（Node 4+/8.x 可跑）；profile 可用
  \`--profile-dir\` / \`DSH_PROFILE_DIR\` 直接指定；node 可用 \`--node\` / \`NODE_BIN\` 指定
`
}

/**
 * Render `VERSIONS.txt`: the exact identity of this package and its vendored
 * dependencies, for auditing an offline machine later.
 *
 * @param {{
 *   pluginName: string, version: string, targetDshVersion: string,
 *   mode: 'local'|'registry', vendored?: string[], hostDshVersion?: string,
 *   nodeVersion?: string, generatedAt?: string,
 * }} options
 * @returns {string}
 */
export function renderVersionsText(options) {
  const {
    pluginName,
    version,
    targetDshVersion,
    mode,
    vendored = [],
    hostDshVersion = '',
    nodeVersion = process.version,
    generatedAt = new Date().toISOString(),
  } = options
  const lines = [
    'dsh-offline-packer 离线包版本信息',
    '=================================',
    `生成时间        : ${generatedAt}`,
    `打包模式        : ${mode === 'registry' ? 'registry（npm 历史版本）' : 'local（当前宿主已安装插件）'}`,
    `插件            : ${pluginName}@${version}`,
    `目标 DSH 版本   : ${targetDshVersion}`,
    `打包机 DSH 版本 : ${hostDshVersion || '未知'}`,
    `打包机 Node     : ${nodeVersion}`,
    '',
  ]
  if (vendored.length === 0) {
    lines.push('内嵌依赖        : 无（插件运行时依赖全部由宿主提供）')
  } else {
    lines.push(`内嵌依赖        : ${vendored.length} 个`)
    for (const entry of vendored) lines.push(`  - ${entry}`)
  }
  lines.push('')
  return lines.join('\n')
}
