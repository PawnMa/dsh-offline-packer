/**
 * Offline package assembly (shared by the local and the registry pipelines).
 *
 * Given a ready plugin source directory (and optionally an extra `node_modules`
 * tree of resolved runtime dependencies) this module produces the final,
 * zero-network offline package:
 *
 *   <outputRoot>/<plugin>-offline-<version>-dsh-<target>/
 *     package/            plugin files, dependencies rewritten to {}
 *     install-offline.sh  bash installer (mode 0755)
 *     install-offline.ps1 PowerShell 5.1 installer (UTF-8 BOM, CRLF)
 *     README.md
 *     VERSIONS.txt
 *     CHECKSUMS.txt
 *   <outputRoot>/<plugin>-offline-<version>-dsh-<target>.zip
 *
 * Third-party packages are copied into `package/node_modules` so the plugin
 * resolves them from its own directory offline. Everything the DSH host itself
 * provides is skipped (`@deepseek-ai/*`, `react*`, `cordis`, declared peers, and
 * the plugin package itself).
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

import { getHostInfo } from './host.mjs'
import { renderInstallers, renderReadme, renderVersionsText } from './scripts.mjs'
import { zipDirectory } from './zip.mjs'

/** Suffixes / names that are never part of the shipped plugin source. */
const SKIPPED_SOURCE_NAMES = new Set(['.git', 'node_modules', 'package-lock.json', 'npm-shrinkwrap.json'])
const SKIPPED_SOURCE_SUFFIXES = ['.tgz', '.log']

/** Build a tagged, HTTP-friendly error. */
function failure(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

/** Make a string safe for a staging directory / zip file name. */
function fileSafeName(value) {
  return String(value).replace(/[^A-Za-z0-9._@+~ -]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Recursively list files below `root`, returning posix-relative paths + modes. */
async function listFiles(root, { skipNames = new Set() } = {}) {
  const files = []
  /** @type {string[]} */
  const stack = ['']
  while (stack.length > 0) {
    const relativeDir = stack.pop()
    const dir = relativeDir === '' ? root : join(root, relativeDir)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (skipNames.has(entry.name)) continue
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(relativePath)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(absolute)
      files.push({ path: relativePath, mode: info.mode & 0o777, sizeBytes: info.size })
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  return files
}

/** Filter used while copying the plugin source into `staging/package`. */
function sourceFilter(rootDir) {
  return (source) => {
    const rel = relative(rootDir, source)
    if (rel === '') return true
    const segments = rel.split(sep)
    if (SKIPPED_SOURCE_NAMES.has(segments[0])) return false
    if (segments.some((segment) => segment === '.git' || segment === 'node_modules')) return false
    const name = segments[segments.length - 1]
    if (SKIPPED_SOURCE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false
    return true
  }
}

/**
 * Copy the plugin source into `staging/package`, skipping node_modules, .git,
 * lock files, tarballs and logs. `*.map` files are kept on purpose.
 */
async function copyPluginSource(srcDir, packageDir) {
  await cp(srcDir, packageDir, {
    recursive: true,
    force: true,
    dereference: true,
    preserveTimestamps: true,
    filter: sourceFilter(srcDir),
  })
}

/** Browser-platform modules that must never ship inside the server package. */
function isBrowserPlatformPackage(name) {
  return (
    name === 'react' ||
    name === 'react-dom' ||
    name.startsWith('react-') ||
    name.startsWith('react-dom/') ||
    name.startsWith('@deepseek-ai/dsh-client-')
  )
}

/**
 * Whether one vendored package must stay out of the offline package.
 *
 * Default behaviour (the frozen v1 contract): skip the plugin itself,
 * browser-platform modules, the host namespace (`@deepseek-ai/*`), bare
 * `cordis` and every declared peer — the target host already provides those.
 *
 * Opt-ins owned by the local "embed more" flow:
 *  - `includeHostPackages`: also embed host-namespace and peer packages (still
 *    never the plugin itself or browser-platform modules);
 *  - `keepPackages`: names the caller explicitly asked for (declared deps /
 *    extra packages) — kept even when they are host-namespace or peer packages;
 *    the self/browser rules still win.
 */
function shouldSkipVendoredPackage(name, { pluginName, peerNames, keepPackages, includeHostPackages }) {
  if (name === pluginName) return true
  if (isBrowserPlatformPackage(name)) return true
  if (keepPackages.has(name)) return false
  if (includeHostPackages) return false
  if (peerNames.has(name)) return true
  if (name === 'cordis' || name === '@deepseek-ai/cordis') return true
  if (name.startsWith('@deepseek-ai/')) return true
  return false
}

/** Filter for copying one extra-vendor package tree: skip host/peer sub-packages. */
function vendorFilter(packageRoot, options) {
  return (source) => {
    if (source === packageRoot) return true
    const rel = relative(packageRoot, source)
    if (rel === '') return true
    const segments = rel.split(sep)
    if (segments.includes('.git') || segments.includes('.bin')) return false
    // Check only package positions: the path root, and anything after node_modules.
    let expectPackage = false
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      if (segment === 'node_modules') {
        expectPackage = true
        continue
      }
      if (!expectPackage) continue
      if (segment.startsWith('@')) {
        const scopedName = `${segment}/${segments[index + 1] ?? ''}`
        if (shouldSkipVendoredPackage(scopedName, options)) return false
        expectPackage = false
        index += 1
        continue
      }
      if (shouldSkipVendoredPackage(segment, options)) return false
      expectPackage = false
    }
    return true
  }
}

/** Top-level package names in a `node_modules` directory (scopes expanded). */
async function topLevelVendorPackages(nodeModulesDir) {
  let entries
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (entry.name.startsWith('@')) {
      let children
      try {
        children = await readdir(join(nodeModulesDir, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (!child.name.startsWith('.') && (child.isDirectory() || child.isSymbolicLink())) {
          names.push(`${entry.name}/${child.name}`)
        }
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) names.push(entry.name)
  }
  return names.sort()
}

/**
 * Copy the vendored packages of `extraVendorDir` into `package/node_modules`,
 * keeping nested `node_modules` trees (which is how conflicting versions
 * survive). Which packages are copied depends on the options documented on
 * {@link shouldSkipVendoredPackage}. Returns the copied top-level package names.
 */
async function copyVendoredDependencies(extraVendorDir, packageDir, options) {
  const destNodeModules = join(packageDir, 'node_modules')
  const names = await topLevelVendorPackages(extraVendorDir)
  const copied = []
  for (const name of names) {
    if (shouldSkipVendoredPackage(name, options)) continue
    const source = join(extraVendorDir, name)
    if (!existsSync(source)) continue
    const destination = join(destNodeModules, name)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      force: true,
      dereference: true,
      preserveTimestamps: true,
      filter: vendorFilter(source, options),
    })
    copied.push(name)
  }
  return copied
}

/** Rewrite the shipped manifest: no install-time dependencies, all peers optional. */
async function rewriteManifest(packageDir) {
  const manifestPath = join(packageDir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw failure(`无法读取插件清单 ${manifestPath}：${error instanceof Error ? error.message : String(error)}`, 'BAD_MANIFEST', {
      cause: error,
    })
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw failure(`插件清单不是对象：${manifestPath}`, 'BAD_MANIFEST')
  }
  manifest.dependencies = {}
  // Optional dependencies would be installed from the registry during the
  // official-channel install; drop them so the package stays zero-network.
  if (manifest.optionalDependencies !== null && typeof manifest.optionalDependencies === 'object') {
    delete manifest.optionalDependencies
  }
  if (manifest.peerDependencies !== null && typeof manifest.peerDependencies === 'object') {
    const meta =
      manifest.peerDependenciesMeta !== null && typeof manifest.peerDependenciesMeta === 'object'
        ? manifest.peerDependenciesMeta
        : {}
    for (const peer of Object.keys(manifest.peerDependencies)) {
      const existing = meta[peer]
      meta[peer] = { ...(existing !== null && typeof existing === 'object' ? existing : {}), optional: true }
    }
    manifest.peerDependenciesMeta = meta
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  return manifest
}

/** SHA-256 of one file. */
async function sha256File(path) {
  const content = await readFile(path)
  return createHash('sha256').update(content).digest('hex')
}

/** Write `CHECKSUMS.txt` for every file below `root` (excluding the file itself). */
async function writeChecksums(root) {
  const files = await listFiles(root, { skipNames: new Set(['CHECKSUMS.txt']) })
  const lines = []
  for (const file of files) {
    const digest = await sha256File(join(root, file.path))
    lines.push(`${digest}  ./${file.path}`)
  }
  lines.sort()
  await writeFile(join(root, 'CHECKSUMS.txt'), `${lines.join('\n')}\n`, 'utf8')
  return lines.length
}

/**
 * Assemble one offline package.
 *
 * @param {{
 *   srcDir: string,
 *   pluginName: string,
 *   version: string,
 *   description?: string,
 *   peerDsh?: string|null,
 *   targetDshVersion: string,
 *   mode: 'local'|'registry',
 *   extraVendorDir?: string,
 *   outputRoot: string,
 *   log?: (message: string) => void,
 *   progress?: (phase: string, percent: number|null) => void,
 *   warnings?: string[],
 *   vendored?: string[],
 *   includeHostPackages?: boolean,
 *   keepVendoredPackages?: string[],
 *   vendoredVersions?: Record<string, string>,
 * }} options
 *   `includeHostPackages`/`keepVendoredPackages` are opt-ins used by the local
 *   embed flow; leaving them out keeps the frozen default behaviour.
 *   `vendoredVersions` decorates the actually-copied package names with their
 *   resolved versions in `result.vendored`.
 * @returns {Promise<{
 *   dir: string, zipPath: string, zipName: string, sizeBytes: number,
 *   pluginName: string, version: string, targetDshVersion: string,
 *   mode: 'local'|'registry', vendored: string[], warnings: string[],
 * }>}
 */
export async function assembleOfflinePackage(options) {
  const {
    srcDir,
    pluginName,
    version,
    description,
    peerDsh,
    targetDshVersion,
    mode,
    extraVendorDir,
    outputRoot,
    vendored: preVendored,
  } = options
  const log = typeof options.log === 'function' ? options.log : () => {}
  const progress = typeof options.progress === 'function' ? options.progress : () => {}
  const warnings = Array.isArray(options.warnings) ? [...options.warnings] : []

  if (typeof srcDir !== 'string' || srcDir === '' || !existsSync(join(srcDir, 'package.json'))) {
    throw failure(`插件源目录不存在或缺少 package.json：${srcDir}`, 'PLUGIN_SOURCE_MISSING')
  }
  if (typeof outputRoot !== 'string' || outputRoot === '') {
    throw failure('缺少输出目录 outputRoot', 'BAD_REQUEST')
  }
  if (typeof pluginName !== 'string' || pluginName === '' || typeof version !== 'string' || version === '') {
    throw failure('缺少插件名或版本号', 'BAD_REQUEST')
  }
  const targetVersion = typeof targetDshVersion === 'string' && targetDshVersion !== '' ? targetDshVersion : version
  const modeValue = mode === 'registry' ? 'registry' : 'local'
  const bundleName = `${fileSafeName(pluginName)}-offline-${fileSafeName(version)}-dsh-${fileSafeName(targetVersion)}`
  const stagingDir = join(outputRoot, bundleName)
  const zipPath = join(outputRoot, `${bundleName}.zip`)
  const zipName = basename(zipPath)

  progress('准备输出目录', 45)
  await mkdir(outputRoot, { recursive: true })
  log(`staging: ${stagingDir}`)
  await rm(stagingDir, { recursive: true, force: true })
  await rm(zipPath, { force: true })
  await mkdir(stagingDir, { recursive: true })
  const packageDir = join(stagingDir, 'package')

  progress('复制插件文件', 52)
  log('复制插件文件（跳过 node_modules / .git / lock / tgz / log）')
  await copyPluginSource(srcDir, packageDir)

  const sourceManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const peers = sourceManifest.peerDependencies !== null && typeof sourceManifest.peerDependencies === 'object' ? sourceManifest.peerDependencies : {}
  const peerNames = new Set(Object.keys(peers))
  const includeHostPackages = options.includeHostPackages === true
  const keepPackages = new Set(
    Array.isArray(options.keepVendoredPackages)
      ? options.keepVendoredPackages.filter((name) => typeof name === 'string' && name !== '')
      : [],
  )
  const vendoredVersions =
    options.vendoredVersions !== null && typeof options.vendoredVersions === 'object' ? options.vendoredVersions : null
  const vendorOptions = { pluginName, peerNames, keepPackages, includeHostPackages }

  let copiedVendored = []
  progress('内嵌运行时依赖', 60)
  if (typeof extraVendorDir === 'string' && extraVendorDir !== '' && existsSync(extraVendorDir)) {
    log(`复制运行时依赖：${extraVendorDir} -> package/node_modules`)
    copiedVendored = await copyVendoredDependencies(extraVendorDir, packageDir, vendorOptions)
    if (copiedVendored.length === 0) {
      log('没有需要内嵌的依赖（全部由宿主提供）')
    } else {
      log(`内嵌依赖 ${copiedVendored.length} 个：${copiedVendored.join(', ')}`)
    }
    if (includeHostPackages) {
      const hostNamespace = copiedVendored.filter((name) => name.startsWith('@deepseek-ai/') || peerNames.has(name))
      if (hostNamespace.length > 0) {
        const preview = hostNamespace.slice(0, 10).join(', ')
        const more = hostNamespace.length > 10 ? ` 等 ${hostNamespace.length} 个` : ''
        warnings.push(
          `产物内嵌了宿主命名空间/peer 包（${preview}${more}），可能与宿主各持一份，造成服务实例重复或单例状态不一致；仅在目标机缺少这些包时使用。react/react-dom/@deepseek-ai/dsh-client-* 等浏览器模块始终不会内嵌。`,
        )
      }
    }
  } else {
    log('没有额外依赖目录（插件依赖全部由宿主提供）')
  }

  progress('生成安装脚本', 70)
  log('重写 package/package.json（dependencies:{}，peer 全部 optional）')
  const stagedManifest = await rewriteManifest(packageDir)

  const hasVendoredDeps = copiedVendored.length > 0
  log('生成 install-offline.sh / install-offline.ps1')
  const installers = renderInstallers({
    pluginName,
    version,
    targetDshVersion: targetVersion,
    hasVendoredDeps,
    mode: modeValue,
  })
  const installShPath = join(stagingDir, 'install-offline.sh')
  const installPs1Path = join(stagingDir, 'install-offline.ps1')
  await writeFile(installShPath, installers['install-offline.sh'], 'utf8')
  await writeFile(installPs1Path, installers['install-offline.ps1'], 'utf8')
  await chmod(installShPath, 0o755)
  await chmod(installPs1Path, 0o644)

  const host = getHostInfo()
  let vendoredList
  if (Array.isArray(preVendored) && preVendored.length > 0) {
    // Legacy caller-supplied list (kept for backwards compatibility).
    vendoredList = [...new Set(preVendored)]
  } else {
    // "Actually present in the artifact": the packages copied above, optionally
    // decorated with their resolved versions for the UI.
    vendoredList = copiedVendored.map((name) => {
      const resolvedVersion = vendoredVersions !== null ? vendoredVersions[name] : undefined
      return typeof resolvedVersion === 'string' && resolvedVersion !== '' ? `${name}@${resolvedVersion}` : name
    })
  }

  log('生成 README.md / VERSIONS.txt')
  await writeFile(
    join(stagingDir, 'README.md'),
    renderReadme({
      pluginName,
      version,
      description: typeof description === 'string' && description !== '' ? description : stagedManifest.description,
      peerDsh,
      targetDshVersion: targetVersion,
      mode: modeValue,
      vendored: vendoredList,
      warnings,
      zipName,
      hostDshVersion: host.dshVersion,
    }),
    'utf8',
  )
  await writeFile(
    join(stagingDir, 'VERSIONS.txt'),
    renderVersionsText({
      pluginName,
      version,
      targetDshVersion: targetVersion,
      mode: modeValue,
      vendored: vendoredList,
      hostDshVersion: host.dshVersion,
    }),
    'utf8',
  )

  progress('生成校验清单', 86)
  log('生成 CHECKSUMS.txt')
  const checksumCount = await writeChecksums(stagingDir)

  progress('打包 zip', 94)
  log(`打包 zip：${zipName}`)
  const files = await listFiles(stagingDir)
  const zipEntries = files.map((file) => ({
    path: file.path,
    mode: file.path === 'install-offline.sh' ? 0o755 : file.mode,
  }))
  const zipResult = await zipDirectory(zipPath, { rootName: bundleName, baseDir: stagingDir, files: zipEntries })

  const result = {
    dir: stagingDir,
    zipPath,
    zipName,
    sizeBytes: zipResult.sizeBytes,
    pluginName,
    version,
    targetDshVersion: targetVersion,
    mode: modeValue,
    vendored: vendoredList,
    warnings,
  }
  progress('完成', 100)
  log(
    `完成：${zipName}（${zipResult.sizeBytes} B，${zipResult.fileCount} 个文件，${vendoredList.length} 个内嵌依赖，校验和 ${checksumCount} 条）`,
  )
  return result
}
