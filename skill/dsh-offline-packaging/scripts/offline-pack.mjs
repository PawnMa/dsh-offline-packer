#!/usr/bin/env node
/**
 * offline-pack.mjs — script-driven offline packaging for DSH plugins.
 *
 * Wraps the headless engine of the installed `dsh-offline-packer` plugin, so the
 * packaging works without the web UI: list installed plugins, build a zero-network
 * offline package from an installed plugin (local channel), or build one published
 * version for a target DSH release (registry channel, needs network + npm).
 *
 * Usage:
 *   node offline-pack.mjs list      [--home H] [--profile P] [--all] [--json]
 *   node offline-pack.mjs matrix    --plugin NAME [--json]
 *   node offline-pack.mjs local     --plugin NAME [--output DIR] [--home H] [--profile P]
 *                                   [--target-dsh VER] [--dsh-install DIR] [--dsh-version VER]
 *                                   [--embed-host] [--embed-declared] [--extra a,b] [--json] [--quiet]
 *   node offline-pack.mjs registry  --plugin NAME --version VER --target-dsh VER
 *                                   [--output DIR] [--json] [--quiet]
 *
 * Common: --packer-dir DIR (dsh-offline-packer package dir; auto-detected otherwise,
 * or $DSH_OFFLINE_PACKER_DIR), -h/--help.
 *
 * stdout: human summary (or one JSON object with --json). stderr: logs/progress.
 * Exit codes: 0 ok, 1 engine error, 2 usage error.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = `offline-pack.mjs — DSH 插件离线打包（脚本通道）

用法:
  node offline-pack.mjs host       [--home H] [--profile P] [--dsh-install DIR] [--dsh-version VER] [--json]
  node offline-pack.mjs list       [--home H] [--profile P] [--all] [--json]
  node offline-pack.mjs matrix     --plugin NAME [--json]
  node offline-pack.mjs local      --plugin NAME [--output DIR] [--home H] [--profile P]
                                   [--target-dsh VER] [--dsh-install DIR] [--dsh-version VER]
                                   [--embed-host] [--embed-declared] [--extra a,b] [--json] [--quiet]
  node offline-pack.mjs registry   --plugin NAME --version VER --target-dsh VER
                                   [--output DIR] [--json] [--quiet]

公共项:
  --packer-dir DIR   dsh-offline-packer 包目录（默认自动探测，或 $DSH_OFFLINE_PACKER_DIR）
  -h, --help         帮助
`

const BOOLEAN_FLAGS = new Set(['json', 'quiet', 'all', 'help', 'embed-host', 'embed-declared'])

function parseArgs(argv) {
  const flags = new Set()
  const values = new Map()
  const positionals = []
  let i = 0
  while (i < argv.length) {
    const token = argv[i]
    if (token === '-h' || token === '--help') {
      flags.add('help')
      i += 1
      continue
    }
    if (!token.startsWith('--')) {
      positionals.push(token)
      i += 1
      continue
    }
    const eq = token.indexOf('=')
    if (eq !== -1) {
      values.set(token.slice(2, eq), token.slice(eq + 1))
      i += 1
      continue
    }
    const key = token.slice(2)
    if (BOOLEAN_FLAGS.has(key)) {
      flags.add(key)
      i += 1
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw usage(`--${key} 需要一个值`)
    values.set(key, next)
    i += 2
  }
  return { flags, values, positionals }
}

function usage(message) {
  return Object.assign(new Error(message), { code: 'USAGE' })
}

function log(message) {
  process.stderr.write(`${message}\n`)
}

function fmtBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '?'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function resolveHome(values) {
  const fromFlag = values.get('home')
  if (typeof fromFlag === 'string' && fromFlag.trim() !== '') return resolve(fromFlag.trim())
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

function resolveProfile(values) {
  const fromFlag = values.get('profile')
  if (typeof fromFlag === 'string' && fromFlag.trim() !== '') return fromFlag.trim()
  return 'web'
}

/** Find the installed dsh-offline-packer package: explicit flag/env, then any profile. */
function findPackerDir(values, home, profile) {
  const explicit = values.get('packer-dir') ?? process.env.DSH_OFFLINE_PACKER_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const dir = resolve(explicit.trim())
    if (existsSync(join(dir, 'package.json'))) return dir
    throw Object.assign(new Error(`--packer-dir 不是 dsh-offline-packer 包目录：${dir}`), { code: 'PACKER_NOT_FOUND' })
  }
  const candidates = [join(home, 'profiles', profile, 'node_modules', 'dsh-offline-packer')]
  const profilesDir = join(home, 'profiles')
  try {
    for (const name of readdirSync(profilesDir)) {
      candidates.push(join(profilesDir, name, 'node_modules', 'dsh-offline-packer'))
    }
  } catch {
    // No profiles directory yet; other errors below are actionable on their own.
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  throw Object.assign(
    new Error(
      `未找到 dsh-offline-packer。请先安装：DSH_HOME=<home> dsh plugin --profile ${profile} add <dsh-offline-packer-*.tgz>；` +
        `或用 --packer-dir 指定包目录。`,
    ),
    { code: 'PACKER_NOT_FOUND' },
  )
}

async function loadEngine(packerDir, name) {
  return import(pathToFileURL(join(packerDir, 'lib', `${name}.mjs`)).href)
}

function renderResult(result) {
  const vendored =
    Array.isArray(result.vendored) && result.vendored.length > 0
      ? `${result.vendored.length} 个（${result.vendored.join(', ')}）`
      : '无（全部由宿主提供）'
  const lines = [
    `插件        : ${result.pluginName}@${result.version}`,
    `目标 DSH    : ${result.targetDshVersion}`,
    `通道        : ${result.mode}`,
    `zip         : ${result.zipPath}`,
    `大小        : ${fmtBytes(result.sizeBytes)}`,
    `产物目录    : ${result.dir}`,
    `内嵌依赖    : ${vendored}`,
  ]
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    lines.push('警告        :')
    for (const line of result.warnings) lines.push(`  - ${line}`)
  }
  lines.push('', '离线安装（把 zip 拷到目标机后）：', `  unzip ${result.zipName}`, '  bash install-offline.sh --profile-dir <目标 profile 目录>')
  return lines.join('\n')
}

async function cmdHost({ values, flags }) {
  const home = resolveHome(values)
  const profile = resolveProfile(values)
  const packerDir = findPackerDir(values, home, profile)
  const host = await loadEngine(packerDir, 'host')
  const info = host.getHostInfo({
    ...(values.get('dsh-install') !== undefined ? { dshInstallDir: values.get('dsh-install') } : {}),
    ...(values.get('dsh-version') !== undefined ? { dshVersion: values.get('dsh-version') } : {}),
  })
  if (flags.has('json')) {
    process.stdout.write(`${JSON.stringify(info)}\n`)
    return
  }
  process.stdout.write(`DSH 安装目录 : ${info.dshInstallDir || '未定位'}\n`)
  process.stdout.write(`DSH 版本     : ${info.dshVersion}\n`)
  process.stdout.write(`探测来源     : ${info.source}\n`)
  process.stdout.write(`DSH_HOME     : ${info.dshHome}\nprofile      : ${info.profile}\nNode         : ${info.nodeVersion}\n`)
  process.stdout.write(`宿主提供依赖 : ${Array.isArray(info.hostProvided) ? info.hostProvided.length : 0} 个包\n`)
  if (Array.isArray(info.warnings) && info.warnings.length > 0) {
    process.stdout.write('警告:\n')
    for (const line of info.warnings) process.stdout.write(`  - ${line}\n`)
  }
  if (info.source !== 'argv' && info.source !== 'override' && info.source !== 'env' && info.source !== 'path') {
    process.stdout.write('提示：脚本上下文通常无法从 argv 识别宿主；如与目标机不符，请显式传 --dsh-install / --dsh-version / --target-dsh。\n')
  }
}

async function cmdList({ values, flags }) {
  const home = resolveHome(values)
  const profile = resolveProfile(values)
  const packerDir = findPackerDir(values, home, profile)
  const inventory = await loadEngine(packerDir, 'inventory')
  const result = await inventory.listPlugins(null, { dshHome: home, profile })
  const rows = result.plugins.filter((plugin) => (flags.has('all') ? true : plugin.official !== true))
  if (flags.has('json')) {
    process.stdout.write(`${JSON.stringify({ dshHome: result.dshHome, profile: result.profile, plugins: rows })}\n`)
    return
  }
  const shown = flags.has('all') ? '全部' : '非官方'
  process.stdout.write(`DSH_HOME: ${result.dshHome}  profile: ${result.profile}  (${rows.length} 个${shown}插件)\n`)
  for (const plugin of rows) {
    process.stdout.write(
      `  ${plugin.name}@${plugin.version ?? '?'}  [${plugin.kind}${plugin.enabled ? ', enabled' : ', disabled'}]` +
        `  peerDSH=${plugin.peerDsh ?? '—'}  ${fmtBytes(plugin.sizeBytes)}\n`,
    )
  }
  if (!flags.has('all')) process.stdout.write('提示：默认隐藏官方内置插件；--all 查看全部。\n')
}

async function cmdMatrix({ values, flags }) {
  const plugin = required(values, 'plugin')
  const home = resolveHome(values)
  const profile = resolveProfile(values)
  const packerDir = findPackerDir(values, home, profile)
  const registry = await loadEngine(packerDir, 'registry')
  const matrix = await registry.listPluginVersions(plugin)
  if (flags.has('json')) {
    process.stdout.write(`${JSON.stringify(matrix)}\n`)
    return
  }
  process.stdout.write(`${matrix.plugin}：${matrix.versions.length} 个版本（registry: ${matrix.registry}）\n`)
  for (const row of matrix.versions.slice(0, 30)) {
    process.stdout.write(
      `  ${String(row.version).padEnd(18)} dshPeer=${(row.dshPeers.join(' || ') || '—').padEnd(24)} 兼容目标数=${row.compatibleDsh.length}\n`,
    )
  }
  if (matrix.versions.length > 30) process.stdout.write(`  … 其余 ${matrix.versions.length - 30} 个版本用 --json 查看\n`)
}

function embedFrom({ values, flags }) {
  return {
    includeHostProvided: flags.has('embed-host'),
    includeAllDeclared: flags.has('embed-declared'),
    extraPackages: String(values.get('extra') ?? '')
      .split(/[,，\s]+/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  }
}

function runtimeFor(packerDir, home, outputRoot, { flags }) {
  return {
    ctx: null,
    outputRoot,
    log: flags.has('quiet') ? () => {} : log,
    progress: flags.has('quiet') ? () => {} : (phase, percent) => log(`[${percent ?? '…'}%] ${phase}`),
  }
}

async function cmdLocal({ values, flags }) {
  const plugin = required(values, 'plugin')
  const home = resolveHome(values)
  const profile = resolveProfile(values)
  const packerDir = findPackerDir(values, home, profile)
  const outputRoot = resolve(values.get('output') ?? join(home, 'offline-packages'))
  const local = await loadEngine(packerDir, 'local')
  try {
    const host = await loadEngine(packerDir, 'host')
    const info = host.getHostInfo({
      ...(values.get('dsh-install') !== undefined ? { dshInstallDir: values.get('dsh-install') } : {}),
      ...(values.get('dsh-version') !== undefined ? { dshVersion: values.get('dsh-version') } : {}),
    })
    if (!flags.has('quiet')) log(`宿主探测：DSH ${info.dshVersion}（来源 ${info.source}，安装目录 ${info.dshInstallDir || '未定位'}）`)
    if (info.source === 'profile-fallback' || info.source === 'unknown') {
      log('提示：未从 DSH 进程识别到宿主；如需按目标机版本标注/解析宿主依赖，请加 --target-dsh / --dsh-install / --dsh-version。')
    }
  } catch (error) {
    if (!flags.has('quiet')) log(`宿主探测失败（继续打包）：${error instanceof Error ? error.message : String(error)}`)
  }
  const targetDshVersion = values.get('target-dsh')
  const request = { pluginName: plugin, dshHome: home, profile, embed: embedFrom({ values, flags }) }
  if (targetDshVersion !== undefined && targetDshVersion.trim() !== '') request.targetDshVersion = targetDshVersion.trim()
  if (values.get('dsh-install') !== undefined) request.dshInstallDir = values.get('dsh-install')
  if (values.get('dsh-version') !== undefined) request.dshVersion = values.get('dsh-version')
  const result = await local.buildLocalPackage(request, runtimeFor(packerDir, home, outputRoot, { flags }))
  process.stdout.write(flags.has('json') ? `${JSON.stringify(result)}\n` : `${renderResult(result)}\n`)
}

async function cmdRegistry({ values, flags }) {
  const request = {
    pluginName: required(values, 'plugin'),
    version: required(values, 'version'),
    targetDshVersion: required(values, 'target-dsh'),
  }
  const home = resolveHome(values)
  const profile = resolveProfile(values)
  const packerDir = findPackerDir(values, home, profile)
  const outputRoot = resolve(values.get('output') ?? join(home, 'offline-packages'))
  const historical = await loadEngine(packerDir, 'historical')
  const result = await historical.buildRegistryPackage(request, runtimeFor(packerDir, home, outputRoot, { flags }))
  process.stdout.write(flags.has('json') ? `${JSON.stringify(result)}\n` : `${renderResult(result)}\n`)
}

function required(values, name) {
  const value = values.get(name)
  if (typeof value !== 'string' || value.trim() === '') throw usage(`缺少 --${name}`)
  return value.trim()
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    process.stdout.write(USAGE)
    return
  }
  const { flags, values, positionals } = parseArgs(argv)
  if (flags.has('help')) {
    process.stdout.write(USAGE)
    return
  }
  const command = positionals[0]
  if (command === undefined) throw usage('缺少子命令（list/matrix/local/registry）')
  switch (command) {
    case 'host':
      return cmdHost({ values, flags })
    case 'list':
      return cmdList({ values, flags })
    case 'matrix':
      return cmdMatrix({ values, flags })
    case 'local':
      return cmdLocal({ values, flags })
    case 'registry':
      return cmdRegistry({ values, flags })
    default:
      throw usage(`未知子命令：${command}`)
  }
}

main().then(
  () => {},
  (error) => {
    const code = typeof error?.code === 'string' ? error.code : 'ERROR'
    process.stderr.write(`错误 ${code}: ${error instanceof Error ? error.message : String(error)}\n`)
    if (code === 'USAGE') process.stderr.write(`\n${USAGE}`)
    process.exitCode = code === 'USAGE' ? 2 : 1
  },
)
