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
# 本脚本是「零联网」通道：只做文件系统操作和读取本地 node（不执行 npm /
# pnpm，不发起任何网络请求），等价于 DSH 官方 bundle 安装的最终状态：
#   1. 初始化 profile（不存在时按 DSH 模板写 package.json / cordis.patch.yml /
#      pnpm-workspace.yaml）；
#   2. 把本分发包的 package/ 目录复制到
#      $DSH_HOME/profiles/<profile>/node_modules/${pluginName}；
#   3. 把 "${pluginName}" 追加到 profile package.json 的
#      dsh.profile.bundles（去重；插件自带的 dsh.bundle.patch 会在启动时挂载它）。
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
#   --plugin-src <目录>  插件源目录，默认本脚本同目录下的 package/
#   --uninstall          卸载：删除插件目录并从 bundles 移除（可重复执行）
#   --dry-run            只打印将执行的操作，不写任何文件
#   -h, --help           打印本帮助
#
# 示例：
#   bash install-offline.sh --dry-run
#   bash install-offline.sh
#   DSH_HOME=/opt/dsh bash install-offline.sh --profile web
#   bash install-offline.sh --uninstall
# =============================================================================
set -euo pipefail

PLUGIN_NAME=${nameBash}
PLUGIN_VERSION=${versionBash}
DSH_VERSION_TARGET=${targetBash}
HAS_VENDORED_DEPS=${vendored}

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd -P)"

DSH_HOME_OPT=""
PROFILE=""
PLUGIN_SRC=""
DO_UNINSTALL=0
DRY_RUN=0

usage() {
  cat <<'USAGE'
dsh 插件离线安装脚本（零联网）

用法：
  bash install-offline.sh [选项]

选项：
  --dsh-home <目录>    DSH_HOME；默认取环境变量 DSH_HOME，再默认 ~/.dsh
  --profile <名字>     profile 名，默认 web；不存在时自动初始化
  --plugin-src <目录>  插件源目录，默认本脚本同目录下的 package/
  --uninstall          卸载：删除插件目录并从 bundles 移除（可重复执行）
  --dry-run            只打印将执行的操作，不写任何文件
  -h, --help           打印本帮助

示例：
  bash install-offline.sh --dry-run
  bash install-offline.sh
  DSH_HOME=/opt/dsh bash install-offline.sh --profile web
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
      DSH_HOME_OPT="$2"; shift 2 ;;
    --dsh-home=*) DSH_HOME_OPT="\${1#*=}"; shift ;;
    --profile)
      [ $# -ge 2 ] || die "--profile 需要一个名字参数"
      PROFILE="$2"; shift 2 ;;
    --profile=*) PROFILE="\${1#*=}"; shift ;;
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

PROFILE_DIR="$DSH_HOME_OPT/profiles/$PROFILE"
PLUGIN_DEST="$PROFILE_DIR/node_modules/$PLUGIN_NAME"
MANIFEST="$PROFILE_DIR/package.json"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

# ---- 内嵌 node 辅助（只做 JSON 读写，不联网） ------------------------------
node_plugin_info() {
  node - "$PLUGIN_SRC/package.json" <<'NODE_INFO'
const fs = require('node:fs')
const file = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
const patch = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
process.stdout.write([manifest.name || '', manifest.version || '', patch ? 'yes' : 'no'].join('|'))
NODE_INFO
}

node_dsh_version() {
  node - "$1" <<'NODE_VERSION'
const fs = require('node:fs')
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
process.stdout.write(String(manifest.version || 'unknown'))
NODE_VERSION
}

node_init_profile() {
  node - "$PROFILE_DIR" "$PROFILE" <<'NODE_INIT'
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
const profile = process.argv[3]
fs.mkdirSync(dir, { recursive: true })
const created = []
const manifestPath = path.join(dir, 'package.json')
if (!fs.existsSync(manifestPath)) {
  const bundles = profile === 'web'
    ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    : profile === 'headless'
      ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
      : ['@deepseek-ai/dsh-base']
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: 'dsh-profile-' + path.basename(dir),
    private: true,
    dependencies: {},
    dsh: { profile: { bundles } },
  }, null, 2) + '\\n')
  created.push('package.json')
}
const patchPath = path.join(dir, 'cordis.patch.yml')
if (!fs.existsSync(patchPath)) {
  fs.writeFileSync(patchPath, [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; \`!!js\` expressions allowed).',
    '[]',
    '',
  ].join('\\n'))
  created.push('cordis.patch.yml')
}
const workspacePath = path.join(dir, 'pnpm-workspace.yaml')
if (!fs.existsSync(workspacePath)) {
  fs.writeFileSync(workspacePath, 'packages:\\n  - .\\n\\nnodeLinker: hoisted\\nautoInstallPeers: false\\n')
  created.push('pnpm-workspace.yaml')
}
process.stdout.write(created.length ? created.join(',') : 'none')
NODE_INIT
}

node_add_bundle() {
  node - "$MANIFEST" "$PLUGIN_NAME" <<'NODE_ADD'
const fs = require('node:fs')
const file = process.argv[2]
const name = process.argv[3]
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
const list = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles.slice() : []
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
  node - "$MANIFEST" "$PLUGIN_NAME" <<'NODE_REMOVE'
const fs = require('node:fs')
const file = process.argv[2]
const name = process.argv[3]
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
const current = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles
const list = Array.isArray(current) ? current.slice() : []
const index = list.indexOf(name)
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

find_dsh_package_json() {
  if [ -n "\${DSH_INSTALL_DIR:-}" ] && [ -f "$DSH_INSTALL_DIR/package.json" ]; then
    printf '%s\\n' "$DSH_INSTALL_DIR/package.json"
    return 0
  fi
  if command -v dsh >/dev/null 2>&1; then
    local bin dir parent i
    bin="$(command -v dsh)"
    if command -v readlink >/dev/null 2>&1; then
      bin="$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")"
    fi
    dir="$(dirname "$bin")"
    i=0
    while [ $i -lt 12 ]; do
      if [ -f "$dir/package.json" ] && grep -qE '"name"[[:space:]]*:[[:space:]]*"@deepseek-ai/dsh"' "$dir/package.json" 2>/dev/null; then
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

restart_hint() {
  info "下一步（必须）：重启 dsh web 进程，然后刷新浏览器页面。"
  info "  用你平时启动 dsh 的命令重启（例如：dsh --profile $PROFILE）"
  info "  验证：dsh --profile $PROFILE --dump-config 2>/dev/null | grep -F '$PLUGIN_NAME'"
}

# ---- 环境检查 -------------------------------------------------------------
step "检查安装环境"
info "DSH_HOME       : $DSH_HOME_OPT"
info "profile        : $PROFILE"
info "profile 目录   : $PROFILE_DIR"
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

DSH_PKG="$(find_dsh_package_json || true)"
if [ -n "$DSH_PKG" ]; then
  DSH_ACTUAL="$(node_dsh_version "$DSH_PKG")"
  info "检测到宿主   : @deepseek-ai/dsh $DSH_ACTUAL（$DSH_PKG）"
  if [ "$DSH_ACTUAL" != "$DSH_VERSION_TARGET" ]; then
    warn "本分发包按 DSH $DSH_VERSION_TARGET 适配，当前宿主是 $DSH_ACTUAL。"
    warn "版本不匹配可能导致插件加载失败，请确认这对版本组合后再使用。"
  fi
else
  info "未找到 dsh 安装目录（可设置 DSH_INSTALL_DIR 指向它），跳过宿主版本校验。"
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
  info "下一步（必须）：重启 dsh web 进程，插件即不再加载。"
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
# 幂等：重复执行结果一致；-Uninstall 可干净回滚。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1
#   powershell -ExecutionPolicy Bypass -File .\\install-offline.ps1 -Uninstall
# =============================================================================
[CmdletBinding()]
param(
  [string]$DshHome = '',
  [string]$Profile = 'web',
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
if ([string]::IsNullOrEmpty($DshHome)) {
  if (-not [string]::IsNullOrEmpty($env:DSH_HOME)) { $DshHome = $env:DSH_HOME }
  else { $DshHome = Join-Path $HOME '.dsh' }
}
if ([string]::IsNullOrEmpty($Profile)) { $Profile = 'web' }
if ([string]::IsNullOrEmpty($PluginSrc)) { $PluginSrc = Join-Path $ScriptDir 'package' }

$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
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
  Write-Host '  -PluginSrc <目录>  插件源目录，默认本脚本同目录下的 package'
  Write-Host '  -Uninstall         卸载：删除插件目录并从 bundles 移除'
  Write-Host '  -DryRun            只打印将执行的操作，不写任何文件'
  Write-Host '  -Help              打印本帮助'
}

function Read-JsonFile([string]$Path) {
  return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8) | ConvertFrom-Json
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

function Find-DshPackageJson {
  if (-not [string]::IsNullOrEmpty($env:DSH_INSTALL_DIR)) {
    $candidate = Join-Path $env:DSH_INSTALL_DIR 'package.json'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    $path = $command.Source
    $dir = Split-Path -Parent $path
    for ($i = 0; $i -lt 12; $i++) {
      $candidate = Join-Path $dir 'package.json'
      if (Test-Path -LiteralPath $candidate) {
        try {
          $manifest = Read-JsonFile $candidate
          if ($manifest.name -eq '@deepseek-ai/dsh') { return $candidate }
        } catch { }
      }
      $parent = Split-Path -Parent $dir
      if ([string]::IsNullOrEmpty($parent) -or $parent -eq $dir) { break }
      $dir = $parent
    }
  }
  return $null
}

function Show-RestartHint {
  Write-Info '下一步（必须）：重启 dsh web 进程，然后刷新浏览器页面。'
  Write-Info "  用你平时启动 dsh 的命令重启（例如：dsh --profile $Profile）"
  Write-Info "  验证：dsh --profile $Profile --dump-config | Select-String -SimpleMatch '$PluginName'"
}

if ($Help) { Show-Usage; exit 0 }

Write-Step '检查安装环境'
Write-Info "DSH_HOME       : $DshHome"
Write-Info "profile        : $Profile"
Write-Info "profile 目录   : $ProfileDir"
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

$dshPackageJson = Find-DshPackageJson
if ($null -ne $dshPackageJson) {
  $dshManifest = Read-JsonFile $dshPackageJson
  Write-Info "检测到宿主   : @deepseek-ai/dsh $($dshManifest.version)（$dshPackageJson）"
  if ($dshManifest.version -ne $DshVersionTarget) {
    Write-Warn "本分发包按 DSH $DshVersionTarget 适配，当前宿主是 $($dshManifest.version)。"
    Write-Warn '版本不匹配可能导致插件加载失败，请确认这对版本组合后再使用。'
  }
} else {
  Write-Info '未找到 dsh 安装目录（可设置 DSH_INSTALL_DIR 指向它），跳过宿主版本校验。'
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
  Write-Info '下一步（必须）：重启 dsh web 进程，插件即不再加载。'
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

**最后一步（两种通道都一样）：必须重启 dsh web 进程**，然后刷新浏览器页面。

---

## 二、版本信息

| 组件 | 版本 | 说明 |
|---|---|---|
| 宿主 \`@deepseek-ai/dsh\` | \`${targetDshVersion}\`（目标） | 目标离线机器上必须已经装好这个版本的 dsh；本分发包**不含** dsh 本体和 node 运行时 |
| 插件 \`${pluginName}\` | \`${version}\` | 本包只包含这一个插件版本 |
| 插件声明的 DSH 兼容范围 | \`${peerText}\` | 来自插件的 peerDependencies |
| 打包机宿主版本 | \`${hostText}\` | 仅作参考；本包按目标版本 \`${targetDshVersion}\` 生成 |
| Node.js | 宿主自带要求（通常 >= 20） | 离线机器需已有 node（dsh 自身运行依赖） |
| pnpm | **不需要** | 通道 A 完全不需要 npm/pnpm |

> 版本不匹配（目标机器上的 dsh 版本与上面的目标版本不同）可能导致插件加载失败。
> 请先确认版本，再执行安装。

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

\`install-offline.sh\` / \`install-offline.ps1\` 不调用 npm/pnpm、不访问网络，只做：

1. 若 \`$DSH_HOME/profiles/<profile>\` 不存在，按 DSH 模板初始化 \`package.json\`、
   \`cordis.patch.yml\`、\`pnpm-workspace.yaml\`；
2. 把 \`package/\` 复制到 \`$DSH_HOME/profiles/<profile>/node_modules/${pluginName}\`
   （重复安装会先删除旧目录，幂等）；
3. 把 \`"${pluginName}"\` 追加到 profile \`package.json\` 的 \`dsh.profile.bundles\`
   （去重；插件自带的 \`dsh.bundle.patch\` 会在启动时自动挂载它）。

如果 profile 的 \`cordis.patch.yml\` 里还有这个插件旧的手写挂载行，脚本会告警：
请删除手写行，否则会和 bundle 通道双重挂载（\`duplicate prefix route\`）。

### 服务端运行时依赖

插件 \`package.json\` 的 \`dependencies\` 已清空，\`peerDependencies\` 全部标记为
\`optional\`，因此官方 \`dsh plugin add\` 通道也不会联网安装依赖。

${vendoredText}

宿主在**首次启动**时会自动生成 \`$DSH_HOME/profiles/node_modules\` 回退目录，
把 dsh 安装闭包里的包（含 \`ws\`、\`yaml\`、\`@deepseek-ai/*\` 等）链接给所有插件；
因此安装完成后的第一次启动可能比平时稍慢，属正常现象。

---

## 五、重启与验证（必做）

安装完成后**必须重启 dsh web 进程**（用你平时启动 dsh 的命令，例如 \`dsh --profile web\`），然后刷新浏览器页面。

命令行验证：

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

## 七、高级：官方 CLI 通道（可选，需要 pnpm）

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
${warningText}
---

## 九、打包信息

- 生成器：\`dsh-offline-packer\`（DSH 插件：图形化列出插件、一键离线打包）
- 插件：\`${pluginName}@${version}\`
- 目标宿主：\`@deepseek-ai/dsh@${targetDshVersion}\`
- 打包模式：${modeText}
- zip 文件名：\`${zipName || '（未知）'}\`
- 校验和：见 \`CHECKSUMS.txt\`
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
