/**
 * "Package a published plugin version for a historical DSH release."
 *
 * Flow (see ARCHITECTURE.md §2 lib/historical.mjs):
 *   1. download the npm tarball of `plugin@version` (sha512 verified),
 *   2. extract it into a scratch directory and read the manifest,
 *   3. check the plugin's DSH peer ranges against `targetDshVersion`
 *      (a mismatch is only a warning — the caller may deliberately package a
 *      combination the author did not declare),
 *   4. install the runtime dependency tree with npm (`--omit=dev --omit=peer
 *      --ignore-scripts --no-save`, 10 minute timeout) into the scratch dir,
 *      then use `node_modules/<plugin>` as the plugin source and
 *      `node_modules` as the vendored dependency source,
 *   5. hand both to server-core's `assembleOfflinePackage` (lib/pack.mjs) and
 *      return its result untouched.
 *
 * The scratch directory is removed on success and kept (with a logged path)
 * on failure so the operator can inspect what npm produced.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { assembleOfflinePackage } from './pack.mjs'
import { downloadTarball, resolveRegistry, satisfiesDsh } from './registry.mjs'
import { extractTgz } from './tar.mjs'

const NPM_TIMEOUT_MS = 10 * 60 * 1000
const LOG_TAIL_CHARS = 8000

/** Tagged error for the HTTP layer. */
function failure(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function tail(text, limit = LOG_TAIL_CHARS) {
  return text.length <= limit ? text : `…${text.slice(-limit)}`
}

/** Keep only a safe fragment for scratch file names. */
function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9@._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/** npm executable name (Windows shims need `npm.cmd`). */
function npmCommand() {
  const override = process.env.DSH_OFFLINE_PACKER_NPM?.trim()
  if (override !== undefined && override !== '') return override
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** Collect the DSH peer ranges declared by a plugin manifest. */
function dshPeerRanges(manifest) {
  const peers = manifest.peerDependencies
  if (peers === null || typeof peers !== 'object') return []
  const ranges = []
  for (const [name, range] of Object.entries(peers)) {
    if (typeof range !== 'string') continue
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) ranges.push(range.trim())
  }
  return [...new Set(ranges)]
}

/**
 * Run a child process with output capture, a hard timeout and npm-specific
 * error codes.
 *
 * @param {string[]} args npm arguments.
 * @param {{log: Function}} context logging callback.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runNpm(args, { log }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(npmCommand(), args, {
        cwd: undefined,
        env: {
          ...process.env,
          npm_config_update_notifier: 'false',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_progress: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })
    } catch (error) {
      rejectPromise(failure(`无法启动 npm：${error instanceof Error ? error.message : String(error)}`, 'NPM_SPAWN_FAILED', { cause: error }))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      log(`npm 超过 ${NPM_TIMEOUT_MS / 60000} 分钟仍未完成，正在终止进程`)
      child.kill('SIGKILL')
    }, NPM_TIMEOUT_MS)
    const settle = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    child.stdout?.on('data', (chunk) => {
      stdout = tail(stdout + chunk.toString())
    })
    child.stderr?.on('data', (chunk) => {
      stderr = tail(stderr + chunk.toString())
    })
    child.on('error', (error) => {
      settle(() => {
        if (error?.code === 'ENOENT') {
          rejectPromise(
            failure(
              `找不到 npm 可执行文件（${npmCommand()}）。请先安装 Node.js/npm，或先在有网络的机器上打好离线包。`,
              'NPM_MISSING',
              { cause: error },
            ),
          )
        } else {
          rejectPromise(
            failure(`启动 npm 失败：${error instanceof Error ? error.message : String(error)}`, 'NPM_SPAWN_FAILED', {
              cause: error,
            }),
          )
        }
      })
    })
    child.on('close', (code, signal) => {
      settle(() => {
        if (timedOut) {
          rejectPromise(
            failure(`npm 安装超时（超过 ${NPM_TIMEOUT_MS / 60000} 分钟）`, 'NPM_TIMEOUT', {
              stdout: tail(stdout),
              stderr: tail(stderr),
            }),
          )
          return
        }
        if (code !== 0) {
          rejectPromise(
            failure(
              `npm 安装运行时依赖失败（退出码 ${code ?? signal ?? 'unknown'}）：${tail(stderr) || tail(stdout) || '无输出'}`,
              'NPM_FAILED',
              { exitCode: code, signal, stdout: tail(stdout), stderr: tail(stderr) },
            ),
          )
          return
        }
        resolvePromise({ stdout, stderr })
      })
    })
  })
}

/**
 * Direct dependencies that need an install script (native addons) cannot work
 * in the offline package because npm ran with `--ignore-scripts`. Shipping a
 * half-built copy is worse than shipping none: it would shadow a working copy
 * provided by the target DSH host (e.g. node-pty). Drop such direct
 * dependencies from the vendored tree and report them.
 *
 * `DSH_OFFLINE_PACKER_KEEP_NATIVE_DEPS=1` disables the pruning.
 *
 * @param {string} installedDir plugin package dir inside `node_modules`.
 * @param {string} nodeModulesDir installed `node_modules`.
 * @param {string[]} warnings warning sink.
 * @returns {Promise<string[]>} removed `name@version` entries.
 */
async function pruneUnbuiltNativeDependencies(installedDir, nodeModulesDir, warnings) {
  if (process.env.DSH_OFFLINE_PACKER_KEEP_NATIVE_DEPS === '1') return []
  let rootManifest
  try {
    rootManifest = JSON.parse(await readFile(join(installedDir, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const directDependencies = [
    ...Object.keys(rootManifest.dependencies ?? {}),
    ...Object.keys(rootManifest.optionalDependencies ?? {}),
  ]
  const removed = []
  for (const name of directDependencies) {
    const dependencyDir = join(nodeModulesDir, name)
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(dependencyDir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const scripts = manifest?.scripts
    if (scripts === null || typeof scripts !== 'object') continue
    const hooks = ['preinstall', 'install', 'postinstall'].filter((hook) => typeof scripts[hook] === 'string')
    if (hooks.length === 0) continue
    try {
      await rm(dependencyDir, { recursive: true, force: true })
      removed.push(`${name}@${typeof manifest.version === 'string' ? manifest.version : '?'}`)
    } catch {
      // Best effort: leaving the directory only over-vendors.
    }
  }
  if (removed.length > 0) {
    warnings.push(
      `已从 vendor 依赖中剔除需要安装脚本的包：${removed.join(', ')}（npm 以 --ignore-scripts 运行，原生绑定未构建；这些包依赖目标 DSH 宿主提供，否则相关功能会降级）`,
    )
  }
  return removed
}

/**
 * Warn when installed dependencies declare native build scripts that
 * `--ignore-scripts` skipped.
 *
 * @param {string} nodeModulesDir installed `node_modules`.
 * @returns {Promise<string[]>} warnings.
 */
async function buildScriptWarnings(nodeModulesDir) {
  const warnings = []
  let entries
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true })
  } catch {
    return warnings
  }
  const packageDirs = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      let scoped = []
      try {
        scoped = await readdir(join(nodeModulesDir, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of scoped) {
        if (child.isDirectory()) packageDirs.push(`${entry.name}/${child.name}`)
      }
    } else {
      packageDirs.push(entry.name)
    }
  }
  for (const relative of packageDirs) {
    if (warnings.length >= 5) break
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(nodeModulesDir, relative, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const scripts = manifest?.scripts
    if (scripts === null || typeof scripts !== 'object') continue
    const hooks = ['preinstall', 'install', 'postinstall'].filter((hook) => typeof scripts[hook] === 'string')
    if (hooks.length > 0) {
      warnings.push(`依赖 ${relative} 声明了安装脚本（${hooks.join('/')}），--ignore-scripts 已跳过；若它需要原生构建，请在目标机验证`)
    }
  }
  return warnings
}

/**
 * Build an offline package for a published plugin version targeting one DSH
 * release.
 *
 * @param {{pluginName: string, version: string, targetDshVersion: string}} request user request.
 * @param {{ctx?: object, outputRoot?: string, log?: Function, progress?: Function}} runtime host runtime.
 * @returns {Promise<object>} server-core `assembleOfflinePackage` result.
 */
export async function buildRegistryPackage(request, runtime = {}) {
  const pluginName = String(request?.pluginName ?? '').trim()
  const version = String(request?.version ?? '').trim()
  const targetDshVersion = String(request?.targetDshVersion ?? '').trim()
  if (pluginName === '') throw failure('缺少字段 pluginName', 'BAD_REQUEST')
  if (version === '') throw failure('缺少字段 version', 'BAD_REQUEST')
  if (targetDshVersion === '') throw failure('缺少字段 targetDshVersion', 'BAD_REQUEST')
  const log = typeof runtime.log === 'function' ? runtime.log : () => {}
  const progress = typeof runtime.progress === 'function' ? runtime.progress : () => {}
  const outputRoot = String(runtime.outputRoot ?? process.cwd())
  const registry = resolveRegistry(runtime.registry)
  const warnings = []

  await mkdir(outputRoot, { recursive: true })
  const scratchBase = process.env.DSH_OFFLINE_PACKER_TMPDIR?.trim() || tmpdir()
  const workDir = await mkdtemp(join(scratchBase, 'dsh-offline-packer-'))
  progress('准备临时目录', 5)
  log(`临时工作目录：${workDir}`)

  try {
    const tarballPath = join(workDir, `${safeFilePart(pluginName)}-${safeFilePart(version)}.tgz`)
    progress('下载 tarball', 15)
    log(`正在从 ${registry} 下载 ${pluginName}@${version} …`)
    const download = await downloadTarball(pluginName, version, tarballPath, { registry })
    log(`已下载 tarball：${download.file}（${formatBytes(download.sizeBytes)}）`)

    const extractDir = join(workDir, 'extract')
    await mkdir(extractDir, { recursive: true })
    progress('解包 tarball', 25)
    log('正在解包 tarball …')
    await extractTgz(await readFile(tarballPath), extractDir)

    const manifestPath = join(extractDir, 'package.json')
    if (!existsSync(manifestPath)) {
      throw failure(`tarball 解包后没有 package.json（${pluginName}@${version}）`, 'BAD_PACKAGE_MANIFEST', {
        workDir,
      })
    }
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      throw failure(
        `无法解析 ${pluginName}@${version} 的 package.json：${error instanceof Error ? error.message : String(error)}`,
        'BAD_PACKAGE_MANIFEST',
        { workDir },
      )
    }
    if (typeof manifest.version === 'string' && manifest.version !== version) {
      warnings.push(`registry 上 ${pluginName}@${version} 的 manifest 版本是 ${manifest.version}，按请求版本打包`)
    }
    if (typeof manifest.name === 'string' && manifest.name !== pluginName) {
      warnings.push(`manifest 名称 ${manifest.name} 与请求的 ${pluginName} 不一致`)
    }

    // Peer compatibility is advisory: package what the user asked for.
    const peerRanges = dshPeerRanges(manifest)
    const peerDsh = peerRanges.length > 0 ? peerRanges.join(', ') : null
    if (peerRanges.length === 0) {
      warnings.push(`插件没有声明 @deepseek-ai/dsh* peer 依赖，无法判断与 DSH ${targetDshVersion} 的兼容性`)
    } else {
      const compatible = peerRanges.some((range) => {
        try {
          return satisfiesDsh(targetDshVersion, range)
        } catch {
          return false
        }
      })
      if (compatible) {
        log(`peer 兼容性检查通过：DSH ${targetDshVersion} 落在 ${peerDsh}`)
      } else {
        const message = `目标 DSH ${targetDshVersion} 不满足插件声明的 peer 范围（${peerDsh}），仍继续打包`
        warnings.push(message)
        log(`警告：${message}`)
      }
    }

    progress('安装运行时依赖（npm）', 35)
    log('正在用 npm 安装运行时依赖（--omit=dev --omit=peer --ignore-scripts）…')
    const npmResult = await runNpm(
      [
        'install',
        '--omit=dev',
        '--omit=peer',
        '--ignore-scripts',
        '--no-save',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        '--prefix',
        workDir,
        tarballPath,
      ],
      { log },
    )
    if (npmResult.stderr.trim() !== '') log(`npm: ${npmResult.stderr.trim().split('\n').slice(-5).join('\n')}`)

    const nodeModulesDir = join(workDir, 'node_modules')
    const installedDir = join(nodeModulesDir, pluginName)
    if (!existsSync(join(installedDir, 'package.json'))) {
      throw failure(
        `npm 安装后没有找到 ${join('node_modules', pluginName, 'package.json')}（退出码 0 但产物缺失）`,
        'NPM_INSTALL_MISSING',
        { workDir },
      )
    }
    log(`运行时依赖已安装：${nodeModulesDir}`)

    if (existsSync(join(installedDir, 'node_modules'))) {
      warnings.push('npm 在插件目录内安装了嵌套依赖（版本冲突）；打包引擎会跳过插件自带的 node_modules，请验证产物')
    }
    const pruned = await pruneUnbuiltNativeDependencies(installedDir, nodeModulesDir, warnings)
    if (pruned.length > 0) log(`已从 vendor 中剔除未构建的原生依赖：${pruned.join(', ')}`)
    warnings.push(...(await buildScriptWarnings(nodeModulesDir)))

    progress('生成离线包', 44)
    log(`正在调用打包引擎（mode=registry, targetDshVersion=${targetDshVersion}）…`)
    const result = await assembleOfflinePackage({
      srcDir: installedDir,
      pluginName,
      version,
      description: typeof manifest.description === 'string' ? manifest.description : undefined,
      peerDsh,
      targetDshVersion,
      mode: 'registry',
      extraVendorDir: nodeModulesDir,
      outputRoot,
      progress,
      log,
      warnings,
    })
    if (result === null || typeof result !== 'object') {
      throw failure('打包引擎没有返回结果', 'PACK_EMPTY_RESULT', { workDir })
    }
    if (!Array.isArray(result.warnings)) result.warnings = [...warnings]
    log(`打包完成：${result.zipPath ?? result.zipName ?? '(未知路径)'}`)

    try {
      await rm(workDir, { recursive: true, force: true })
      log('已清理临时工作目录')
    } catch (error) {
      warnings.push(`临时目录清理失败：${workDir}（${error instanceof Error ? error.message : String(error)}）`)
    }
    return result
  } catch (error) {
    // Keep the scratch directory on failure so the operator can inspect it.
    log(`打包失败，保留临时目录：${workDir}`)
    if (error !== null && typeof error === 'object') {
      error.workDir = workDir
    }
    throw error
  }
}
