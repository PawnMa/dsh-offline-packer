/**
 * Installed-plugin inventory for one DSH home/profile.
 *
 * Two data sources are supported:
 *
 * 1. The authoritative runtime service `ctx.get('pluginManager').listBundles()`.
 *    It knows selected bundles, install sources, removal availability and
 *    whether the package shipped with the installation — but only for the
 *    profile this process was started for.
 * 2. A pure filesystem scan of `<dshHome>/profiles/<profile>`: profile
 *    `dependencies`, `dsh.profile.bundles`, filled in with any top-level
 *    `node_modules` package that declares a `dsh` block. This is the only
 *    source when the UI asks to inspect a different home (for example the
 *    real user home while this plugin runs in an isolated test host).
 *
 * Package directories may be pnpm symlinks; both the declared `dir` and the
 * resolved `realDir` are returned, and all size measurements use `realDir`.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readdir, lstat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { getHostInfo } from './host.mjs'

/** Stop counting files after this many; keeps a pathological tree from wedging the UI. */
const MAX_SCAN_FILES = 200_000

/** Read one JSON manifest; null when missing or malformed. */
function readManifest(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Resolve a package directory from an anchor file, following Node's lookup order. */
function packageDirFromAnchor(anchor, packageName) {
  let searchPaths
  try {
    searchPaths = createRequire(anchor).resolve.paths(packageName) ?? []
  } catch {
    return undefined
  }
  for (const searchPath of searchPaths) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
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
 * Resolve one plugin package directory for a home/profile.
 *
 * Order: the profile's own `node_modules`, the shared
 * `<dshHome>/profiles/node_modules` fallback, then the running installation.
 *
 * @param {string} dshHome absolute DSH home.
 * @param {string} profile profile name.
 * @param {string} name package name.
 * @returns {{dir: string, realDir: string} | null}
 */
export function resolvePluginDir(dshHome, profile, name) {
  if (typeof dshHome !== 'string' || dshHome === '' || typeof name !== 'string' || name === '') return null
  const candidates = [
    join(dshHome, 'profiles', profile ?? 'web', 'node_modules', name),
    join(dshHome, 'profiles', 'node_modules', name),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) {
      return { dir: candidate, realDir: realPathOf(candidate) }
    }
  }
  const installDir = getHostInfo().dshInstallDir
  if (installDir !== '') {
    const found = packageDirFromAnchor(join(installDir, 'package.json'), name)
    if (found !== undefined) {
      const realDir = realPathOf(found)
      const dir = found
      return { dir, realDir }
    }
  }
  return null
}

/** Condition keys that point at the runtime module, in resolution-priority order. */
const RUNTIME_CONDITIONS = ['default', 'import', 'require', 'node', 'module', 'browser']

/**
 * Extract the runtime entry strings of an `exports["."]` condition tree.
 * Type-declaration conditions (`types`) are display metadata, never entrypoints.
 */
function exportStrings(value, out) {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) exportStrings(item, out)
    return
  }
  for (const key of RUNTIME_CONDITIONS) {
    if (Object.hasOwn(value, key)) exportStrings(value[key], out)
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'types' || RUNTIME_CONDITIONS.includes(key)) continue
    exportStrings(item, out)
  }
}

/**
 * Locate the package's server entry file (as declared, relative to the package).
 *
 * @param {string} dir package directory.
 * @param {object|null} manifest its manifest.
 * @returns {string|null} relative entry path, or null when nothing resolvable.
 */
function resolveServerEntry(dir, manifest) {
  if (manifest === null) return null
  const candidates = []
  const exported = manifest.exports
  if (typeof exported === 'string') {
    candidates.push(exported)
  } else if (exported !== null && typeof exported === 'object') {
    const dot = exported['.']
    if (typeof dot === 'string') candidates.push(dot)
    else if (dot !== null && typeof dot === 'object') exportStrings(dot, candidates)
  }
  if (typeof manifest.main === 'string') candidates.push(manifest.main)
  for (const relative of candidates) {
    if (typeof relative !== 'string' || !relative.startsWith('.')) continue
    const absolute = join(dir, relative)
    if (existsSync(absolute)) return relative.replace(/^\.\//, '')
  }
  for (const fallback of ['index.js', 'index.mjs', 'index.cjs']) {
    if (existsSync(join(dir, fallback))) return fallback
  }
  return null
}

/** Declared DSH compatibility range: the exact DSH peer, else every DSH peer range. */
function peerDshOf(manifest) {
  const peers = manifest?.peerDependencies
  if (peers === null || typeof peers !== 'object') return null
  const exact = peers['@deepseek-ai/dsh']
  if (typeof exact === 'string' && exact.trim() !== '') return exact.trim()
  const ranges = []
  for (const [name, range] of Object.entries(peers)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof range === 'string' && range.trim() !== '') ranges.push(range.trim())
  }
  const unique = [...new Set(ranges)]
  return unique.length === 0 ? null : unique.join(', ')
}

/** Read the `dsh.client` block into the contract's shape (or null). */
function clientOf(manifest) {
  const client = manifest?.dsh?.client
  if (client === null || typeof client !== 'object' || Array.isArray(client)) return null
  const value = {}
  if (typeof client.platform === 'string') value.platform = client.platform
  if (Array.isArray(client.inject)) value.inject = client.inject.filter((entry) => typeof entry === 'string')
  return value
}

/** Read the `dsh.bundle.patch` declaration as a display string (or null). */
function bundlePatchOf(manifest) {
  const patch = manifest?.dsh?.bundle?.patch
  if (typeof patch === 'string' && patch.trim() !== '') return patch.trim()
  if (Array.isArray(patch)) {
    const patches = patch.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    if (patches.length > 0) return patches.join(', ')
  }
  return null
}

/**
 * Recursively measure a directory. `.git` is skipped; symlinked directories are
 * followed with a visited-realpath guard, because pnpm stores packages outside
 * the profile and links them in.
 *
 * @param {string} root absolute directory.
 * @returns {Promise<{sizeBytes: number, fileCount: number, truncated: boolean}>}
 */
async function directoryStats(root) {
  let sizeBytes = 0
  let fileCount = 0
  let truncated = false
  /** @type {string[]} */
  const stack = [root]
  const visitedDirs = new Set()
  while (stack.length > 0) {
    const current = stack.pop()
    const realCurrent = realPathOf(current)
    if (visitedDirs.has(realCurrent)) continue
    visitedDirs.add(realCurrent)
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (entry.isSymbolicLink()) {
        let target
        try {
          target = await lstat(full)
        } catch {
          continue
        }
        if (target.isDirectory()) {
          stack.push(realPathOf(full))
          continue
        }
        sizeBytes += target.size
        fileCount += 1
      } else {
        let stat
        try {
          stat = await lstat(full)
        } catch {
          continue
        }
        sizeBytes += stat.size
        fileCount += 1
      }
      if (fileCount >= MAX_SCAN_FILES) {
        truncated = true
        return { sizeBytes, fileCount, truncated }
      }
    }
  }
  return { sizeBytes, fileCount, truncated }
}

/**
 * Build one `Plugin` row.
 *
 * @param {string} name package name.
 * @param {object} overrides fields collected from the service or the profile manifest.
 * @returns {Promise<object>} contract `Plugin`.
 */
async function buildPluginRow(name, overrides) {
  const resolved = overrides.resolved ?? resolvePluginDir(overrides.dshHome, overrides.profile, name)
  const dir = resolved?.dir ?? null
  const realDir = resolved?.realDir ?? null
  const manifest = realDir === null ? null : readManifest(realDir)
  const warnings = []
  if (dir === null) warnings.push('未找到插件目录：profile node_modules 与宿主安装目录都没有这个包')
  if (manifest !== null && (typeof manifest.version !== 'string' || manifest.version === '')) {
    warnings.push('package.json 缺少 version')
  }
  const serverEntry = manifest === null ? null : resolveServerEntry(realDir, manifest)
  if (dir !== null && manifest !== null && serverEntry === null) warnings.push('找不到服务端入口（main / exports["."]）')
  if (manifest === null && dir !== null) warnings.push('package.json 无法解析')
  const bundlePatch = bundlePatchOf(manifest)
  let kind = 'plugin'
  if (bundlePatch !== null) kind = 'bundle'
  else if (overrides.availability === 'installation') kind = 'installation'
  /**
   * Official = shipped by the DSH installation itself (in-box bundle, optional
   * catalog bundle, or anything resolved inside the installation directory) or
   * published under the harness scope. The packager UI hides these by default:
   * it exists to carry third-party plugins to offline machines.
   */
  const installDir = getHostInfo().dshInstallDir
  const installReal = installDir === '' ? '' : realPathOf(installDir)
  const insideInstall =
    installReal !== '' &&
    realDir !== null &&
    (realDir === installReal || realDir.startsWith(installReal + sep))
  const official =
    overrides.official === true ||
    overrides.availability === 'installation' ||
    name.startsWith('@deepseek-ai/') ||
    insideInstall
  const stats = realDir === null ? { sizeBytes: 0, fileCount: 0, truncated: false } : await directoryStats(realDir)
  if (stats.truncated) warnings.push(`文件数超过 ${MAX_SCAN_FILES}，大小统计已截断`)
  const version = typeof manifest?.version === 'string' && manifest.version !== '' ? manifest.version : (overrides.version ?? null)
  const description =
    typeof manifest?.description === 'string' && manifest.description.trim() !== ''
      ? manifest.description.trim()
      : undefined
  const source = typeof overrides.source === 'string' ? overrides.source : undefined
  const row = {
    name,
    version: version ?? null,
    kind,
    official,
    installed: dir !== null,
    enabled: overrides.enabled === true,
    dir,
    realDir,
    sizeBytes: stats.sizeBytes,
    fileCount: stats.fileCount,
    peerDsh: peerDshOf(manifest),
    client: clientOf(manifest),
    bundlePatch,
    serverEntry,
    warnings: [...warnings, ...(Array.isArray(overrides.warnings) ? overrides.warnings : [])],
  }
  if (description !== undefined) row.description = description
  if (source !== undefined) row.source = source
  if (typeof overrides.removable === 'boolean') row.removable = overrides.removable
  return row
}

/** Top-level package names under a `node_modules` directory (scoped directories expanded). */
async function topLevelPackages(nodeModulesDir) {
  let entries
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      let children
      try {
        children = await readdir(join(nodeModulesDir, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (child.isDirectory() || child.isSymbolicLink()) names.push(`${entry.name}/${child.name}`)
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) names.push(entry.name)
  }
  return names
}

/** Whether a top-level `node_modules` package looks like a DSH plugin. */
function declaresDsh(packageDir) {
  const manifest = readManifest(packageDir)
  return manifest !== null && manifest.dsh !== null && typeof manifest.dsh === 'object'
}

/**
 * Filesystem scan of one profile.
 *
 * @returns {Promise<object[]>} plugin rows.
 */
async function scanProfile({ dshHome, profile }) {
  const profileDir = join(dshHome, 'profiles', profile)
  const nodeModulesDir = join(profileDir, 'node_modules')
  const manifest = readManifest(profileDir)
  const dependencies = manifest?.dependencies !== null && typeof manifest?.dependencies === 'object' ? manifest.dependencies : {}
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((entry) => typeof entry === 'string' && entry !== '')
    : []
  const names = new Set([...bundles, ...Object.keys(dependencies)])
  for (const candidate of await topLevelPackages(nodeModulesDir)) {
    if (names.has(candidate)) continue
    if (await declaresDsh(join(nodeModulesDir, candidate))) names.add(candidate)
  }
  const rows = []
  for (const name of names) {
    const resolved = resolvePluginDir(dshHome, profile, name)
    const owned = Object.hasOwn(dependencies, name)
    rows.push(
      await buildPluginRow(name, {
        dshHome,
        profile,
        resolved,
        version: typeof resolved === 'object' && resolved !== null ? readManifest(resolved.realDir)?.version : null,
        enabled: bundles.includes(name),
        removable: owned,
        source: owned && typeof dependencies[name] === 'string' ? dependencies[name] : undefined,
      }),
    )
  }
  return rows
}

/**
 * Merge the authoritative service rows with the filesystem scan of the profile
 * manifest, so a non-bundle dependency that the service does not surface (or a
 * profile other than the running one) is still listed.
 */
async function scanWithService(ctx, target) {
  const info = getHostInfo()
  const sameTarget = resolve(target.dshHome) === resolve(info.dshHome) && target.profile === info.profile
  /** @type {object[] | null} */
  let serviceRows = null
  if (sameTarget) {
    try {
      const manager = ctx?.get?.('pluginManager')
      if (manager !== null && typeof manager === 'object' && typeof manager.listBundles === 'function') {
        const rows = await manager.listBundles()
        if (Array.isArray(rows)) serviceRows = rows
      }
    } catch {
      serviceRows = null
    }
  }
  const fsRows = await scanProfile(target)
  const fsByName = new Map(fsRows.map((row) => [row.name, row]))
  if (serviceRows === null) return fsRows

  const rows = []
  const covered = new Set()
  for (const serviceRow of serviceRows) {
    const name = serviceRow?.name
    if (typeof name !== 'string' || name === '') continue
    const availability = typeof serviceRow.availability === 'string' ? serviceRow.availability : undefined
    const resolved = resolvePluginDir(target.dshHome, target.profile, name)
    // Catalog entries for bundles that are neither installed nor built in are
    // not part of "what this host has installed".
    if (resolved === null && availability === 'missing') continue
    covered.add(name)
    const fsRow = fsByName.get(name)
    rows.push(
      await buildPluginRow(name, {
        dshHome: target.dshHome,
        profile: target.profile,
        resolved,
        availability,
        official: serviceRow.official === true || (typeof serviceRow.availability === 'string' && serviceRow.availability === 'installation'),
        version: typeof serviceRow.version === 'string' ? serviceRow.version : fsRow?.version ?? null,
        enabled: serviceRow.enabled === true || fsRow?.enabled === true,
        removable: typeof serviceRow.removable === 'boolean' ? serviceRow.removable : fsRow?.removable,
        source: typeof serviceRow.source === 'string' ? serviceRow.source : fsRow?.source,
        warnings: typeof serviceRow.error?.code === 'string' ? [`宿主插件管理报告 ${serviceRow.error.code}`] : [],
      }),
    )
  }
  // Profile-declared packages the service did not surface (non-bundle deps,
  // different profile semantics) still belong in the list.
  for (const fsRow of fsRows) {
    if (!covered.has(fsRow.name)) rows.push(fsRow)
  }
  return rows
}

/**
 * List the plugins installed in one DSH home/profile.
 *
 * @param {object|null} ctx cordis context (may be null in tests).
 * @param {{dshHome?: string, profile?: string}} [target] scan source; defaults
 *   to the running host's own home/profile.
 * @returns {Promise<{dshHome: string, profile: string, profileDir: string, plugins: object[]}>}
 */
export async function listPlugins(ctx, target = {}) {
  const info = getHostInfo()
  const dshHome = resolve(typeof target.dshHome === 'string' && target.dshHome.trim() !== '' ? target.dshHome.trim() : info.dshHome)
  const profile =
    typeof target.profile === 'string' && target.profile.trim() !== '' ? target.profile.trim() : info.profile
  const profileDir = join(dshHome, 'profiles', profile)
  const plugins = await scanWithService(ctx, { dshHome, profile })
  plugins.sort((left, right) => left.name.localeCompare(right.name))
  return { dshHome, profile, profileDir, plugins }
}
