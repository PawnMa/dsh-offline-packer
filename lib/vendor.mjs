/**
 * Vendor the Node-side runtime dependencies of a plugin.
 *
 * For every bare package name the plugin loads, resolve it from the plugin's own
 * position, follow the package's `dependencies` closure, and copy each package
 * (real files, symlinks dereferenced) into a flat `destNodeModules/<name>` tree.
 *
 * Packages the DSH installation already provides are skipped — the host's
 * `$DSH_HOME/profiles/node_modules` fallback resolves them for every plugin at
 * runtime, and shipping a second copy would risk version mismatches.
 *
 * Flat-first-win: a package name is copied once; if a second version is reached
 * it is skipped with a warning (that is what Node's own flat resolution would
 * see from the plugin directory).
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** Stop descending after this many dependency edges. */
const MAX_DEPTH = 30
/** Stop after this many copied packages. */
const MAX_PACKAGES = 2000

/** Build a tagged, HTTP-friendly error. */
function failure(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

/** Read a package manifest, or null. */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Realpath that never throws. */
function realPathOf(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Walk up from a resolved module file to its containing package directory.
 *
 * @param {string} resolvedPath absolute path returned by `require.resolve`.
 * @returns {string|null}
 */
function packageDirFromResolved(resolvedPath) {
  let dir = dirname(resolvedPath)
  for (let level = 0; level < 16; level += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Filter used when copying one package: never follow into dependency trees. */
function packageCopyFilter(packageRoot) {
  return (source) => {
    if (source === packageRoot) return true
    const rel = relative(packageRoot, source)
    const segments = rel.split(sep)
    if (segments.includes('.git')) return false
    if (segments.includes('node_modules')) return false
    if (segments.includes('.bin')) return false
    return true
  }
}

/**
 * Vendor the plugin's server-side runtime dependencies.
 *
 * @param {{
 *   pluginDir: string,
 *   packages: string[],
 *   hostProvided: string[],
 *   destNodeModules: string,
 *   log?: (message: string) => void,
 * }} options
 * @returns {Promise<{
 *   vendored: {name: string, version: string, from: string}[],
 *   skipped: {name: string, reason: string}[],
 *   warnings: string[],
 * }>}
 */
export async function vendorExternals({ pluginDir, packages, hostProvided, destNodeModules, log = () => {} }) {
  if (typeof pluginDir !== 'string' || pluginDir === '') throw failure('缺少插件目录 pluginDir', 'BAD_REQUEST')
  if (typeof destNodeModules !== 'string' || destNodeModules === '') {
    throw failure('缺少依赖输出目录 destNodeModules', 'BAD_REQUEST')
  }
  const hostSet = new Set(Array.isArray(hostProvided) ? hostProvided : [])
  const requested = [...new Set((Array.isArray(packages) ? packages : []).filter((name) => typeof name === 'string' && name !== ''))]
  await mkdir(destNodeModules, { recursive: true })

  /** @type {{name: string, version: string, from: string}[]} */
  const vendored = []
  /** @type {{name: string, reason: string}[]} */
  const skipped = []
  /** @type {string[]} */
  const warnings = []
  /** name -> {version, dir} */
  const placed = new Map()
  const visitedDirs = new Set()
  let packageCount = 0

  const pluginAnchor = join(pluginDir, 'package.json')
  const requireFromPlugin = createRequire(pluginAnchor)

  /**
   * Copy one resolved package and recurse into its dependencies.
   *
   * @param {string} name package name.
   * @param {string} fromDir directory the package was resolved from.
   * @param {object} req createRequire anchored at the requesting package.
   * @param {number} depth recursion depth.
   */
  async function vendorOne(name, fromDir, req, depth) {
    if (depth > MAX_DEPTH) {
      warnings.push(`依赖层级超过 ${MAX_DEPTH}，停止展开：${name}`)
      return
    }
    if (hostSet.has(name)) {
      skipped.push({ name, reason: 'host' })
      return
    }
    const existing = placed.get(name)
    if (existing !== undefined) {
      if (existing.dir !== fromDir) {
        warnings.push(`依赖 ${name} 版本冲突：已内嵌 ${existing.version}（${existing.dir}），忽略另一份（${fromDir}）`)
      }
      skipped.push({ name, reason: 'duplicate' })
      return
    }
    let resolved
    try {
      resolved = req.resolve(name)
    } catch {
      skipped.push({ name, reason: 'not-found' })
      warnings.push(`无法从插件位置解析依赖 ${name}（${fromDir}），已跳过；离线安装后可能缺模块`)
      return
    }
    const packageDir = packageDirFromResolved(realPathOf(resolved))
    if (packageDir === null) {
      skipped.push({ name, reason: 'not-found' })
      warnings.push(`依赖 ${name} 解析失败（${resolved}），已跳过`)
      return
    }
    const realPackageDir = realPathOf(packageDir)
    const manifest = readManifest(realPackageDir)
    if (manifest === null) {
      warnings.push(`依赖 ${name} 的 package.json 无法解析（${realPackageDir}），已跳过`)
      skipped.push({ name, reason: 'bad-manifest' })
      return
    }
    if (visitedDirs.has(realPackageDir)) {
      skipped.push({ name, reason: 'visited' })
      return
    }
    if (packageCount >= MAX_PACKAGES) {
      warnings.push(`内嵌依赖数量超过 ${MAX_PACKAGES}，停止展开：${name}`)
      return
    }
    visitedDirs.add(realPackageDir)
    const destination = join(destNodeModules, name)
    await mkdir(dirname(destination), { recursive: true })
    await cp(realPackageDir, destination, {
      recursive: true,
      force: true,
      dereference: true,
      preserveTimestamps: true,
      filter: packageCopyFilter(realPackageDir),
    })
    const version = typeof manifest.version === 'string' ? manifest.version : 'unknown'
    packageCount += 1
    placed.set(name, { version, dir: realPackageDir })
    vendored.push({ name, version, from: realPackageDir })
    log(`内嵌依赖 ${name}@${version}（${realPackageDir}）`)

    // Only hard `dependencies` are followed: peers are either host-provided or
    // bundled by the plugin, and optional peers must stay optional offline.
    const dependencyNames = Object.keys(manifest.dependencies ?? {}).filter(
      (dependency) => typeof dependency === 'string' && dependency !== '' && dependency !== name,
    )
    const requireFromDependency = createRequire(join(realPackageDir, 'package.json'))
    for (const dependency of dependencyNames) {
      await vendorOne(dependency, realPackageDir, requireFromDependency, depth + 1)
    }
  }

  for (const name of requested) {
    await vendorOne(name, pluginDir, requireFromPlugin, 0)
  }

  return { vendored, skipped, warnings }
}
