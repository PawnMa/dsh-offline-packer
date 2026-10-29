/**
 * Vendor the Node-side runtime dependencies of a plugin.
 *
 * For every bare package name the plugin loads, resolve it, follow the package's
 * `dependencies` closure, and copy each package (real files, symlinks
 * dereferenced) into a flat `destNodeModules/<name>` tree.
 *
 * Packages the DSH installation already provides are skipped by default — the
 * host resolves them for every plugin at runtime, and shipping a second copy
 * would risk version mismatches.
 *
 * `includeHostProvided` (the local "embed host runtime" opt-in) turns that
 * around: host-provided packages are copied too, and they are resolved from the
 * **current installation directory** (`preferResolveFrom`, normally
 * `<dshInstallDir>/package.json`) rather than from the plugin directory. The
 * plugin directory can be served by a stale/healed
 * `$DSH_HOME/profiles/node_modules` symlink that points at a *different* DSH
 * installation, which would silently embed another host's package versions.
 * If a host package cannot be resolved from the current installation it is
 * skipped with a warning instead of falling back to the plugin location.
 *
 * Flat-first-win: a package name is copied once; when a second version is
 * reached it is skipped with a warning naming both sources.
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

/** Human label for where a package was resolved from. */
function sourceLabel(source) {
  if (source === 'host-install') return '当前 DSH 安装目录'
  if (source === 'plugin') return '插件位置'
  return '传递依赖'
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
 *   includeHostProvided?: boolean,
 *   preferResolveFrom?: string,
 * }} options `includeHostProvided` embeds host-provided packages too;
 *   `preferResolveFrom` is an anchor file inside the current DSH installation
 *   used to resolve those host packages (so their version matches the host).
 * @returns {Promise<{
 *   vendored: {name: string, version: string, from: string}[],
 *   skipped: {name: string, reason: string}[],
 *   warnings: string[],
 * }>}
 */
export async function vendorExternals({
  pluginDir,
  packages,
  hostProvided,
  destNodeModules,
  log = () => {},
  includeHostProvided = false,
  preferResolveFrom = '',
}) {
  if (typeof pluginDir !== 'string' || pluginDir === '') throw failure('缺少插件目录 pluginDir', 'BAD_REQUEST')
  if (typeof destNodeModules !== 'string' || destNodeModules === '') {
    throw failure('缺少依赖输出目录 destNodeModules', 'BAD_REQUEST')
  }
  const hostSet = new Set(Array.isArray(hostProvided) ? hostProvided : [])
  const requested = [
    ...new Set((Array.isArray(packages) ? packages : []).filter((name) => typeof name === 'string' && name !== '')),
  ]
  const hostAnchor =
    includeHostProvided && typeof preferResolveFrom === 'string' && preferResolveFrom !== '' ? preferResolveFrom : ''
  await mkdir(destNodeModules, { recursive: true })

  /** @type {{name: string, version: string, from: string}[]} */
  const vendored = []
  /** @type {{name: string, reason: string}[]} */
  const skipped = []
  /** @type {string[]} */
  const warnings = []
  /** name -> {version, dir, source} */
  const placed = new Map()
  const visitedDirs = new Set()
  let packageCount = 0

  const pluginAnchor = join(pluginDir, 'package.json')
  const requireFromPlugin = createRequire(pluginAnchor)

  /**
   * Resolve one requested package name to an absolute module path.
   *
   * Host-provided packages are resolved from the current installation when the
   * embed-host option is on; everything else keeps the Node lookup from the
   * plugin (or from the declaring dependency).
   *
   * @returns {{resolved: string, source: string} | null}
   */
  function resolvePackage(name, req, depth, origin) {
    if (depth === 0 && hostAnchor !== '' && hostSet.has(name)) {
      try {
        return { resolved: createRequire(hostAnchor).resolve(name), source: 'host-install' }
      } catch {
        return null
      }
    }
    try {
      return { resolved: req.resolve(name), source: origin }
    } catch {
      return null
    }
  }

  /**
   * Copy one resolved package and recurse into its dependencies.
   *
   * @param {string} name package name.
   * @param {string} fromDir directory of the package declaring this dependency.
   * @param {object} req createRequire anchored at the declaring package.
   * @param {number} depth recursion depth (0 = directly requested).
   * @param {string} origin where a non-host package resolution is anchored.
   */
  async function vendorOne(name, fromDir, req, depth, origin) {
    if (depth > MAX_DEPTH) {
      warnings.push(`依赖层级超过 ${MAX_DEPTH}，停止展开：${name}`)
      return
    }
    const isHostPackage = hostSet.has(name)
    if (isHostPackage && !includeHostProvided) {
      skipped.push({ name, reason: 'host' })
      return
    }
    if (isHostPackage && includeHostProvided && hostAnchor === '') {
      skipped.push({ name, reason: 'host-install-unknown' })
      warnings.push(`宿主包 ${name} 无法内嵌：当前未定位 DSH 安装目录（可用「手动指定宿主」指定），已跳过`)
      return
    }

    const resolution = resolvePackage(name, req, depth, origin)
    if (resolution === null) {
      skipped.push({ name, reason: 'not-found' })
      if (isHostPackage) {
        warnings.push(
          `宿主包 ${name} 无法从当前 DSH 安装目录解析（${hostAnchor || '未定位安装目录'}），已跳过（不回落插件位置，避免内嵌其他安装/过期 heal fallback 的版本）`,
        )
      } else {
        warnings.push(`无法从插件位置解析依赖 ${name}（${fromDir}），已跳过；离线安装后可能缺模块`)
      }
      return
    }
    const packageDir = packageDirFromResolved(realPathOf(resolution.resolved))
    if (packageDir === null) {
      skipped.push({ name, reason: 'not-found' })
      warnings.push(`依赖 ${name} 解析失败（${resolution.resolved}），已跳过`)
      return
    }
    const realPackageDir = realPathOf(packageDir)
    const manifest = readManifest(realPackageDir)
    if (manifest === null) {
      warnings.push(`依赖 ${name} 的 package.json 无法解析（${realPackageDir}），已跳过`)
      skipped.push({ name, reason: 'bad-manifest' })
      return
    }
    const version = typeof manifest.version === 'string' ? manifest.version : 'unknown'

    const existing = placed.get(name)
    if (existing !== undefined) {
      if (existing.dir !== realPackageDir) {
        warnings.push(
          `依赖 ${name} 版本冲突：已内嵌 ${existing.version}（${existing.dir}，来源：${sourceLabel(existing.source)}），` +
            `忽略另一份 ${version}（${realPackageDir}，来源：${sourceLabel(resolution.source)}）`,
        )
      }
      skipped.push({ name, reason: 'duplicate' })
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
    packageCount += 1
    placed.set(name, { version, dir: realPackageDir, source: resolution.source })
    vendored.push({ name, version, from: realPackageDir })
    log(`内嵌依赖 ${name}@${version}（${realPackageDir}，来源：${sourceLabel(resolution.source)}）`)

    // Only hard `dependencies` are followed: peers are either host-provided or
    // bundled by the plugin, and optional peers must stay optional offline.
    const dependencyNames = Object.keys(manifest.dependencies ?? {}).filter(
      (dependency) => typeof dependency === 'string' && dependency !== '' && dependency !== name,
    )
    const requireFromDependency = createRequire(join(realPackageDir, 'package.json'))
    for (const dependency of dependencyNames) {
      await vendorOne(dependency, realPackageDir, requireFromDependency, depth + 1, 'transitive')
    }
  }

  for (const name of requested) {
    await vendorOne(name, pluginDir, requireFromPlugin, 0, 'plugin')
  }

  const hostInstalled = vendored.filter((entry) => hostSet.has(entry.name)).length
  if (includeHostProvided) {
    log(`宿主提供包内嵌：${hostInstalled} 个（优先从当前 DSH 安装目录解析）`)
  }

  return { vendored, skipped, warnings }
}
