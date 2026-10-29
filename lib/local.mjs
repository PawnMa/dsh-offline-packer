/**
 * Local packaging pipeline: an already-installed plugin -> offline package.
 *
 * Flow: inventory lookup -> host facts (auto-detected or manually overridden)
 * -> static runtime analysis -> merge the user's "embed more" options -> vendor
 * the missing server dependencies into a temp `node_modules` -> assemble + zip.
 *
 * Embed options (all optional, default off — the frozen v1 behaviour):
 *  - `includeHostProvided`: also embed the packages the host normally provides
 *    (host `hostProvided` is treated as empty during vendoring);
 *  - `includeAllDeclared`: add every `dependencies`/`optionalDependencies` name
 *    from the plugin manifest;
 *  - `extraPackages`: extra package names requested by the user (local
 *    resolution only; `name@version` is accepted but the version is ignored
 *    with a warning because the local channel has no version picker).
 *
 * Nothing in the scanned DSH home is written: the only outputs are the staging
 * directory and the zip below `outputRoot`.
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeRuntimeExternals } from './analyze.mjs'
import { getHostInfo } from './host.mjs'
import { listPlugins } from './inventory.mjs'
import { assembleOfflinePackage } from './pack.mjs'
import { vendorExternals } from './vendor.mjs'

/** Browser-runtime modules; the host's client module loader provides these. */
const BROWSER_ONLY_PACKAGE = /^(?:react|react-dom|react-[a-z0-9-]+|@deepseek-ai\/dsh-client-[a-z0-9-]+)$/
/** npm package-name shape (optionally scoped), used to validate extraPackages. */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i

/** Build a tagged, HTTP-friendly error. */
function failure(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

/**
 * Normalise the raw `embed` request object. Unknown fields are ignored and
 * package entries are trimmed/de-duplicated; `name@version` strings are kept
 * for the next step so it can warn about local resolution.
 *
 * @param {unknown} raw request.embed
 * @returns {{includeHostProvided: boolean, includeAllDeclared: boolean, extraPackages: string[]}}
 */
function normaliseEmbed(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const extraPackages = []
  if (Array.isArray(source.extraPackages)) {
    for (const entry of source.extraPackages) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      if (trimmed !== '' && !extraPackages.includes(trimmed)) extraPackages.push(trimmed)
    }
  }
  return {
    includeHostProvided: source.includeHostProvided === true,
    includeAllDeclared: source.includeAllDeclared === true,
    extraPackages,
  }
}

/**
 * Read one `extraPackages` entry into a bare package name.
 *
 * The local channel resolves packages from what is installed on this machine,
 * so a requested `name@version` cannot be honoured: the version suffix is
 * dropped with a warning instead of failing the job.
 *
 * @param {string} entry raw user entry.
 * @param {string[]} warnings sink.
 * @param {(message: string) => void} log sink.
 * @returns {string|null} package name, or null when the entry is unusable.
 */
function parseExtraPackage(entry, warnings, log) {
  const raw = String(entry).trim()
  if (raw === '') return null
  let name = raw
  let requestedVersion = ''
  const separator = raw.lastIndexOf('@')
  if (separator > 0) {
    name = raw.slice(0, separator)
    requestedVersion = raw.slice(separator + 1).trim()
  }
  if (!PACKAGE_NAME_RE.test(name)) {
    const message = `extraPackages 里的包名不合法，已忽略：${raw}`
    warnings.push(message)
    log(`警告：${message}`)
    return null
  }
  if (requestedVersion !== '') {
    const message = `本地通道不支持版本选择（${raw}），已按本地已安装版本内嵌 ${name}`
    warnings.push(message)
    log(`警告：${message}`)
  }
  return name
}

/**
 * Build an offline package from a plugin installed in `dshHome`/`profile`.
 *
 * @param {{
 *   pluginName: string,
 *   targetDshVersion?: string,
 *   dshHome?: string,
 *   profile?: string,
 *   dshInstallDir?: string,
 *   dshVersion?: string,
 *   embed?: {includeHostProvided?: boolean, includeAllDeclared?: boolean, extraPackages?: string[]},
 * }} request packaging request.
 * @param {{ctx?: object|null, outputRoot: string,
 *   log?: (message: string) => void,
 *   progress?: (phase: string, percent: number|null) => void}} runtime
 *   host context, output directory, log sink and progress sink.
 * @returns {Promise<object>} the `result` documented in ARCHITECTURE.md.
 */
export async function buildLocalPackage(request, runtime = {}) {
  const requestObject = request !== null && typeof request === 'object' ? request : {}
  const pluginName = typeof requestObject.pluginName === 'string' ? requestObject.pluginName.trim() : ''
  if (pluginName === '') throw failure('缺少插件名 pluginName', 'BAD_REQUEST')
  const ctx = runtime.ctx ?? null
  const log = typeof runtime.log === 'function' ? runtime.log : () => {}
  const progress = typeof runtime.progress === 'function' ? runtime.progress : () => {}
  const embed = normaliseEmbed(requestObject.embed)

  progress('读取宿主信息', 5)
  const host = getHostInfo({
    dshInstallDir: typeof requestObject.dshInstallDir === 'string' ? requestObject.dshInstallDir : undefined,
    dshVersion: typeof requestObject.dshVersion === 'string' ? requestObject.dshVersion : undefined,
  })
  const outputRoot =
    typeof runtime.outputRoot === 'string' && runtime.outputRoot !== ''
      ? runtime.outputRoot
      : join(host.dshHome, 'offline-packages')
  const targetDshVersion =
    typeof requestObject.targetDshVersion === 'string' && requestObject.targetDshVersion.trim() !== ''
      ? requestObject.targetDshVersion.trim()
      : host.dshVersion

  const overriddenText = [
    host.overridden.installDir ? '安装目录手动指定' : '',
    host.overridden.version ? '版本手动指定' : '',
  ]
    .filter(Boolean)
    .join('，')
  log(
    `宿主：@deepseek-ai/dsh ${host.dshVersion}（${host.dshInstallDir || '未定位安装目录'}），node ${host.nodeVersion}；宿主依赖闭包 ${host.hostProvided.length} 个包；探测来源：${host.source}${overriddenText !== '' ? `（${overriddenText}）` : ''}`,
  )
  const warnings = []
  for (const warning of Array.isArray(host.warnings) ? host.warnings : []) {
    warnings.push(warning)
    log(`宿主警告：${warning}`)
  }

  progress('读取插件清单', 12)
  log(`扫描：home=${requestObject.dshHome ?? host.dshHome} profile=${requestObject.profile ?? host.profile}`)
  const inventory = await listPlugins(ctx, { dshHome: requestObject.dshHome, profile: requestObject.profile })
  const plugin = inventory.plugins.find((row) => row.name === pluginName)
  if (plugin === undefined) {
    throw failure(
      `当前 home/profile 里没有找到插件 ${pluginName}（${inventory.dshHome} / ${inventory.profile}）`,
      'PLUGIN_NOT_FOUND',
      { dshHome: inventory.dshHome, profile: inventory.profile },
    )
  }
  if (typeof plugin.realDir !== 'string' || plugin.realDir === '') {
    throw failure(`插件 ${pluginName} 的目录不存在（可能未安装或依赖缺失）`, 'PLUGIN_NOT_FOUND', {
      dshHome: inventory.dshHome,
      profile: inventory.profile,
    })
  }
  warnings.push(...(Array.isArray(plugin.warnings) ? plugin.warnings : []))

  if (targetDshVersion !== host.dshVersion) {
    const message = `目标 DSH 版本（${targetDshVersion}）与当前宿主（${host.dshVersion}）不同；依赖按当前宿主解析，产物在目标版本上可能需要重新验证`
    warnings.push(message)
    log(`警告：${message}`)
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(plugin.realDir, 'package.json'), 'utf8'))
  } catch (error) {
    throw failure(
      `无法读取插件清单 ${join(plugin.realDir, 'package.json')}：${error instanceof Error ? error.message : String(error)}`,
      'BAD_MANIFEST',
      { cause: error },
    )
  }

  progress('分析运行时依赖', 22)
  log('分析服务端运行时依赖…')
  const analysis = await analyzeRuntimeExternals({ dir: plugin.realDir, manifest })
  log(
    `扫描 ${analysis.scanned.length} 个文件；静态依赖 ${analysis.externals.length} 个，动态依赖 ${analysis.dynamicOptional.length} 个`,
  )

  /** Packages to resolve/vendor; order is analysis -> declared -> extra. */
  const packages = []
  const addPackage = (name) => {
    if (typeof name !== 'string' || name === '') return
    if (!packages.includes(name)) packages.push(name)
  }
  for (const name of [...analysis.externals, ...analysis.dynamicOptional]) {
    if (BROWSER_ONLY_PACKAGE.test(name)) {
      log(`跳过浏览器端模块 ${name}（由宿主客户端加载器提供，不参与服务端打包）`)
      continue
    }
    addPackage(name)
  }
  const analysisPackageCount = packages.length

  // Explicitly requested packages (declared deps / extra names) are kept even
  // when they are host-namespace or peer packages: "点名即带".
  const declaredNames = []
  if (embed.includeAllDeclared) {
    const declared =
      manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
    const optional =
      manifest.optionalDependencies !== null && typeof manifest.optionalDependencies === 'object'
        ? manifest.optionalDependencies
        : {}
    for (const name of [...Object.keys(declared), ...Object.keys(optional)]) {
      if (typeof name === 'string' && name !== '' && !declaredNames.includes(name)) declaredNames.push(name)
    }
    for (const name of declaredNames) addPackage(name)
    log(`embed.includeAllDeclared=true：追加插件声明的 ${declaredNames.length} 个依赖（dependencies + optionalDependencies，不做浏览器过滤）`)
    const warning =
      `已启用「内嵌全部声明依赖」：除分析到的服务端依赖外，还会内嵌插件 package.json 声明的 ${declaredNames.length} 个 dependencies/optionalDependencies（含前端库），产物体积会明显增大；` +
      '若其中含宿主命名空间包（@deepseek-ai/*）或 peer 包，可能与宿主各持一份，注意单例服务风险。'
    warnings.push(warning)
    log(`警告：${warning}`)
  }

  const extraNames = []
  for (const entry of embed.extraPackages) {
    const name = parseExtraPackage(entry, warnings, log)
    if (name === null) continue
    extraNames.push(name)
    addPackage(name)
  }
  if (extraNames.length > 0) {
    log(`embed.extraPackages：追加 ${extraNames.length} 个额外包：${extraNames.join(', ')}`)
  }

  progress('合并额外内嵌包', 30)
  log(
    `需要检查的运行时依赖：${packages.length} 个（分析 ${analysisPackageCount} + 声明 ${declaredNames.length} + 额外 ${extraNames.length}）`,
  )

  // `includeHostProvided` forces host-provided packages to be vendored too.
  // Those packages are resolved from the current installation directory, never
  // from the plugin location: `$DSH_HOME/profiles/node_modules` may be a stale
  // "heal fallback" symlink pointing at a different DSH installation.
  let effectiveHostProvided = host.hostProvided
  let preferResolveFrom = ''
  if (embed.includeHostProvided) {
    if (host.dshInstallDir !== '') {
      preferResolveFrom = join(host.dshInstallDir, 'package.json')
      log(`宿主依赖将从当前安装目录解析：${host.dshInstallDir}`)
    } else {
      warnings.push(
        '已启用「内嵌宿主运行时依赖」，但当前未定位 DSH 安装目录；宿主包无法从当前安装解析，将被跳过（可先用「手动指定宿主」指定安装目录）',
      )
      log('警告：未定位 DSH 安装目录，includeHostProvided 将跳过宿主包')
    }
    const warning =
      '已启用「内嵌宿主运行时依赖」：产物会把 ws / @deepseek-ai/* 等宿主通常提供的包也复制进 package/node_modules。' +
      `宿主包优先从当前 DSH 安装目录解析${host.dshInstallDir !== '' ? `（${host.dshInstallDir}）` : ''}，确保内嵌版本与宿主一致；` +
      '宿主命名空间包可能与宿主各持一份，造成服务实例重复或单例状态不一致；仅在目标机缺少这些包时使用。' +
      'react / react-dom / @deepseek-ai/dsh-client-* 等浏览器模块始终不会内嵌。'
    warnings.push(warning)
    log(`警告：${warning}`)
  } else {
    const explicitlyRequested = new Set([...declaredNames, ...extraNames])
    if (explicitlyRequested.size > 0) {
      // Explicitly requested names must be vendored even when the host would
      // otherwise provide them ("点名即带").
      effectiveHostProvided = host.hostProvided.filter((name) => !explicitlyRequested.has(name))
    }
  }

  progress('内嵌运行时依赖', 34)
  let tempDir = null
  let succeeded = false
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-offline-packer-local-'))
    const destNodeModules = join(tempDir, 'node_modules')
    log(`临时依赖目录：${tempDir}`)
    const vendorResult =
      packages.length === 0
        ? { vendored: [], skipped: [], warnings: [] }
        : await vendorExternals({
            pluginDir: plugin.realDir,
            packages,
            hostProvided: effectiveHostProvided,
            destNodeModules,
            log,
            includeHostProvided: embed.includeHostProvided,
            preferResolveFrom,
          })
    const hostSkipped = vendorResult.skipped.filter((entry) => entry.reason === 'host').length
    const hostEmbedded = embed.includeHostProvided
      ? vendorResult.vendored.filter((entry) => host.hostProvided.includes(entry.name)).length
      : 0
    log(
      `依赖处理完成：解析到 ${vendorResult.vendored.length} 个，宿主提供 ${hostSkipped} 个` +
        (embed.includeHostProvided ? `，其中强制内嵌宿主包 ${hostEmbedded} 个（来源：当前安装目录）` : ''),
    )
    warnings.push(...vendorResult.warnings)

    const vendoredVersions = {}
    for (const entry of vendorResult.vendored) vendoredVersions[entry.name] = entry.version

    const result = await assembleOfflinePackage({
      srcDir: plugin.realDir,
      pluginName: plugin.name,
      version: typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : plugin.version ?? 'unknown',
      description: typeof manifest.description === 'string' ? manifest.description : plugin.description,
      peerDsh: plugin.peerDsh ?? null,
      targetDshVersion,
      mode: 'local',
      extraVendorDir: join(tempDir, 'node_modules'),
      outputRoot,
      log,
      progress,
      warnings,
      includeHostPackages: embed.includeHostProvided,
      keepVendoredPackages: [...new Set([...declaredNames, ...extraNames])],
      vendoredVersions,
    })
    succeeded = true
    return result
  } finally {
    if (tempDir !== null) {
      if (succeeded) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      } else {
        log(`打包失败，临时目录保留以便排查：${tempDir}`)
      }
    }
  }
}
