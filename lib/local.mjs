/**
 * Local packaging pipeline: an already-installed plugin -> offline package.
 *
 * Flow: inventory lookup -> host facts -> static runtime analysis -> vendor the
 * missing server dependencies into a temp `node_modules` -> assemble + zip.
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

/** Build a tagged, HTTP-friendly error. */
function failure(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

/**
 * Build an offline package from a plugin that is installed in `dshHome`/`profile`.
 *
 * @param {{
 *   pluginName: string,
 *   targetDshVersion?: string,
 *   dshHome?: string,
 *   profile?: string,
 * }} request packaging request.
 * @param {{ctx?: object|null, outputRoot: string,
 *   log?: (message: string) => void,
 *   progress?: (phase: string, percent: number|null) => void}} runtime
 *   host context, output directory, log sink and progress sink.
 * @returns {Promise<object>} the `result` documented in ARCHITECTURE.md.
 */
export async function buildLocalPackage(request, runtime = {}) {
  const pluginName = typeof request?.pluginName === 'string' ? request.pluginName.trim() : ''
  if (pluginName === '') throw failure('缺少插件名 pluginName', 'BAD_REQUEST')
  const ctx = runtime.ctx ?? null
  const log = typeof runtime.log === 'function' ? runtime.log : () => {}
  const progress = typeof runtime.progress === 'function' ? runtime.progress : () => {}
  const host = getHostInfo()
  const outputRoot =
    typeof runtime.outputRoot === 'string' && runtime.outputRoot !== ''
      ? runtime.outputRoot
      : join(host.dshHome, 'offline-packages')
  const targetDshVersion =
    typeof request.targetDshVersion === 'string' && request.targetDshVersion.trim() !== ''
      ? request.targetDshVersion.trim()
      : host.dshVersion

  progress('读取宿主信息', 5)
  log(`宿主：@deepseek-ai/dsh ${host.dshVersion}（${host.dshInstallDir || '未定位安装目录'}），node ${host.nodeVersion}`)
  progress('读取插件清单', 12)
  log(`扫描：home=${request.dshHome ?? host.dshHome} profile=${request.profile ?? host.profile}`)
  const inventory = await listPlugins(ctx, { dshHome: request.dshHome, profile: request.profile })
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

  const warnings = [...(Array.isArray(plugin.warnings) ? plugin.warnings : [])]
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

  const packages = []
  for (const name of [...analysis.externals, ...analysis.dynamicOptional]) {
    if (BROWSER_ONLY_PACKAGE.test(name)) {
      log(`跳过浏览器端模块 ${name}（由宿主客户端加载器提供，不参与服务端打包）`)
      continue
    }
    if (!packages.includes(name)) packages.push(name)
  }
  log(`需要检查的运行时依赖：${packages.length === 0 ? '（无）' : packages.join(', ')}`)

  progress('内嵌缺失依赖', 34)
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
            hostProvided: host.hostProvided,
            destNodeModules,
            log,
          })
    const hostSkipped = vendorResult.skipped.filter((entry) => entry.reason === 'host').length
    log(`依赖处理完成：内嵌 ${vendorResult.vendored.length} 个，宿主提供 ${hostSkipped} 个`)
    warnings.push(...vendorResult.warnings)

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
      vendored: vendorResult.vendored.map((entry) => `${entry.name}@${entry.version}`),
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
