/**
 * Host facts for the offline packager.
 *
 * Everything the packager needs to know about the running DSH installation:
 * where it lives, which version it is, which profile the process was started
 * for, and — most importantly — the full package name closure the installation
 * already provides to every plugin at runtime (`hostProvided`). Dependencies in
 * that closure must never be vendored into an offline package: the host's
 * profile module fallback already resolves them for the plugin.
 *
 * Detection is deliberately layered, because a modified/non-standard DSH often
 * has no real `dsh` CLI and lives outside the usual global prefixes:
 *
 *   1. `DSH_INSTALL_DIR` environment override;
 *   2. `process.argv[1]` (the running `bin.js`) realpath walked upwards;
 *   3. `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` (the "heal fallback"
 *      link DSH maintains for profile plugins — realpath is authoritative);
 *   4. `dsh` on `PATH` (realpath, then walk upwards);
 *   5. the usual global install prefixes (npm/pnpm/nvm/usr/NODE_PATH).
 *
 * The UI can also pass a manual `{ dshInstallDir, dshVersion }` override for a
 * host that even the profile fallback cannot identify (source `override`).
 *
 * Only Node builtins are used; filesystem reads are synchronous and cheap, and
 * the dependency closure is cached per installation directory.
 */

import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
const DSH_SCOPED_SEGMENTS = ['@deepseek-ai', 'dsh']
const DSH_SCOPED_PATH = join(...DSH_SCOPED_SEGMENTS)
/** Upper bound on packages visited while walking the installation closure. */
const MAX_CLOSURE_PACKAGES = 4000
/** Upper bound on directory levels walked up from a starting path. */
const MAX_WALK_UP = 16
/** Executable names a `dsh` command can have on this platform. */
const PATH_EXECUTABLES = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']

/** @type {Map<string, string[]>} */
const closureCache = new Map()

/** Read one package manifest from a directory, or null when missing/unreadable. */
function readManifest(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Read one manifest file, or null when missing/unreadable/invalid. */
function readManifestFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A version string from a manifest, or `'unknown'`. */
function versionOf(manifest) {
  const version = manifest?.version
  return typeof version === 'string' && version.trim() !== '' ? version.trim() : 'unknown'
}

/** Resolve a package directory the way Node resolves it from `anchor`. */
function packageDirFrom(anchor, packageName) {
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

/** Whether a path exists (following symlinks). */
function pathExists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Whether a path entry itself exists, even when a symlink is dangling. */
function linkEntryExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Walk up from a directory looking for the `@deepseek-ai/dsh` package.
 *
 * @param {string} startDir absolute directory to start at.
 * @returns {{dir: string, manifest: object} | null} canonical installation dir.
 */
function walkUpForDsh(startDir) {
  let dir = startDir
  for (let level = 0; level < MAX_WALK_UP; level += 1) {
    const manifest = readManifest(dir)
    if (manifest !== null && manifest.name === DSH_PACKAGE_NAME) {
      return { dir: realPathOf(dir), manifest }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Normalise any user-supplied "DSH install location" into the package directory.
 *
 * Accepts the package directory itself, its `package.json`, a `lib/`/`bin.js`
 * path inside it, or an install root that contains
 * `node_modules/@deepseek-ai/dsh` (the shape people usually point at).
 *
 * @param {string} input absolute path supplied by env/UI.
 * @returns {{dir: string, manifest: object} | null}
 */
function locateDshFromInput(input) {
  const target = resolve(input)
  if (!pathExists(target)) return null
  let stat
  try {
    stat = statSync(target)
  } catch {
    return null
  }
  if (stat.isFile()) return walkUpForDsh(dirname(target))
  if (!stat.isDirectory()) return null
  const direct = walkUpForDsh(target)
  if (direct !== null) return direct
  // Install roots: <root>/node_modules/@deepseek-ai/dsh or <root>/@deepseek-ai/dsh.
  const nested = [join(target, 'node_modules', DSH_SCOPED_PATH), join(target, DSH_SCOPED_PATH)]
  for (const candidate of nested) {
    if (!pathExists(candidate)) continue
    const manifest = readManifest(candidate)
    if (manifest !== null && manifest.name === DSH_PACKAGE_NAME) {
      return { dir: realPathOf(candidate), manifest }
    }
  }
  return null
}

/** Candidate filesystem locations of a globally installed `@deepseek-ai/dsh`. */
function commonGlobalCandidates() {
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '') candidates.push(value)
  }
  // <node>/../lib/node_modules/@deepseek-ai/dsh (npm's unix layout)
  push(join(dirname(process.execPath), '..', 'lib', 'node_modules', DSH_SCOPED_PATH))
  // npm/pnpm configured global prefix
  for (const key of ['npm_config_prefix', 'NPM_CONFIG_PREFIX']) {
    const prefix = process.env[key]
    if (typeof prefix === 'string' && prefix.trim() !== '') {
      push(join(prefix.trim(), 'lib', 'node_modules', DSH_SCOPED_PATH))
      push(join(prefix.trim(), 'node_modules', DSH_SCOPED_PATH))
    }
  }
  // Common per-user global prefixes
  push(join(homedir(), '.local', 'lib', 'node_modules', DSH_SCOPED_PATH))
  push(join(homedir(), '.npm-global', 'lib', 'node_modules', DSH_SCOPED_PATH))
  push(join(homedir(), '.local', 'share', 'pnpm', 'global', '5', 'node_modules', DSH_SCOPED_PATH))
  // System-wide prefixes
  push(join('/usr', 'local', 'lib', 'node_modules', DSH_SCOPED_PATH))
  push(join('/usr', 'lib', 'node_modules', DSH_SCOPED_PATH))
  // Anything the caller exposed through NODE_PATH
  const nodePath = process.env.NODE_PATH
  if (typeof nodePath === 'string' && nodePath !== '') {
    for (const entry of nodePath.split(delimiter)) {
      if (entry.trim() !== '') push(join(entry.trim(), DSH_SCOPED_PATH))
    }
  }
  return candidates
}

/**
 * Probe `process.argv[1]`: the path of the running CLI entry point.
 *
 * @returns {{dir: string, manifest: object} | null}
 */
function probeFromArgv() {
  const argv1 = process.argv[1]
  if (typeof argv1 !== 'string' || argv1.trim() === '') return null
  let entry
  try {
    entry = isAbsolute(argv1) ? argv1 : resolve(argv1)
    entry = realpathSync(entry)
  } catch {
    entry = resolve(argv1)
  }
  return walkUpForDsh(dirname(entry))
}

/**
 * Probe the profile module fallback DSH heals for plugins:
 * `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` — usually a symlink into
 * the live installation, which is why a non-standard/modified DSH still gets
 * identified even when its CLI is not `dsh` and argv carries no hint.
 *
 * @param {string} dshHome effective DSH home.
 * @param {string[]} warnings sink for a dangling fallback link.
 * @returns {{dir: string, manifest: object} | null}
 */
function probeProfileFallback(dshHome, warnings) {
  const linkPath = join(dshHome, 'profiles', 'node_modules', DSH_SCOPED_PATH)
  if (!linkEntryExists(linkPath)) return null
  let canonical
  try {
    canonical = realpathSync(linkPath)
  } catch (error) {
    warnings.push(
      `profile 回退目录中的 dsh 链接已失效：${linkPath}（${error instanceof Error ? error.message : String(error)}）`,
    )
    return null
  }
  const manifest = readManifest(canonical)
  if (manifest === null || manifest.name !== DSH_PACKAGE_NAME) return null
  return { dir: canonical, manifest }
}

/**
 * Probe this process's `PATH` for a `dsh` executable, realpath it (launchers
 * are often symlinks into the installation) and walk up to its package.
 *
 * @returns {{dir: string, manifest: object} | null}
 */
function probeFromPath() {
  const pathValue = process.env.PATH
  if (typeof pathValue !== 'string' || pathValue === '') return null
  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim() === '') continue
    for (const executable of PATH_EXECUTABLES) {
      const candidate = join(directory, executable)
      if (!pathExists(candidate)) continue
      let real
      try {
        real = realpathSync(candidate)
      } catch {
        real = candidate
      }
      const found = walkUpForDsh(dirname(real))
      if (found !== null) return found
    }
  }
  return null
}

/** Probe the usual global installation prefixes. */
function probeFromCommonPaths() {
  for (const candidate of commonGlobalCandidates()) {
    const manifest = readManifest(candidate)
    if (manifest !== null && manifest.name === DSH_PACKAGE_NAME) {
      return { dir: realPathOf(candidate), manifest }
    }
  }
  return null
}

/**
 * Best-effort version when the installation directory could not be read: the
 * heal-fallback `@deepseek-ai/dsh` manifest or the in-box `dsh-base` package
 * carries the same release number.
 *
 * @param {string} dshHome effective DSH home.
 * @param {string} profile effective profile name.
 * @returns {string} version or `'unknown'`.
 */
function fallbackVersion(dshHome, profile) {
  const candidates = [
    join(dshHome, 'profiles', 'node_modules', DSH_SCOPED_PATH, 'package.json'),
    join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
  ]
  for (const candidate of candidates) {
    const manifest = readManifestFile(candidate)
    const version = versionOf(manifest)
    if (version !== 'unknown') return version
  }
  return 'unknown'
}

/**
 * Walk the installation's dependency closure and collect every package name it
 * ships. These are exactly the names a profile plugin may import without
 * bundling them: DSH's profile module fallback links the installation's
 * packages into `$DSH_HOME/profiles/node_modules` at boot.
 *
 * The walk mirrors the host's own loader: `dependencies` + `peerDependencies`
 * of each discovered package, resolved from that package's position.
 *
 * @param {string} installDir DSH package directory.
 * @param {object} manifest its manifest.
 * @returns {string[]} sorted unique package names.
 */
function collectHostProvided(installDir, manifest) {
  const names = new Set()
  const visitedDirs = new Set([installDir])
  /** @type {{anchor: string, manifest: object}[]} */
  const queue = [{ anchor: join(installDir, 'package.json'), manifest }]
  while (queue.length > 0 && visitedDirs.size <= MAX_CLOSURE_PACKAGES) {
    const current = queue.shift()
    const declared = [
      ...Object.keys(current.manifest.dependencies ?? {}),
      ...Object.keys(current.manifest.peerDependencies ?? {}),
    ]
    for (const name of declared) {
      if (typeof name !== 'string' || name === '') continue
      names.add(name)
      const dir = packageDirFrom(current.anchor, name)
      if (dir === undefined) continue
      const realDir = realPathOf(dir)
      if (visitedDirs.has(realDir)) continue
      visitedDirs.add(realDir)
      const dependencyManifest = readManifest(realDir)
      if (dependencyManifest !== null) {
        queue.push({ anchor: join(realDir, 'package.json'), manifest: dependencyManifest })
      }
    }
  }
  return [...names].sort()
}

/** The profile the running process was started for. */
function detectProfile(argv = process.argv) {
  const args = argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--profile') {
      const value = args[index + 1]
      if (typeof value === 'string' && value.trim() !== '' && !value.startsWith('-')) return value.trim()
      return 'web'
    }
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length).trim()
      return value === '' ? 'web' : value
    }
  }
  // `dsh web ...`, `dsh headless ...`: the first positional that names a
  // built-in profile. Anything else keeps the default.
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    if (arg === 'web' || arg === 'headless') return arg
  }
  return 'web'
}

/** Resolve the effective DSH home (env override, otherwise `~/.dsh`). */
function detectDshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return resolve(fromEnv !== '' ? fromEnv : join(homedir(), '.dsh'))
}

/** Read a non-empty string override field. */
function overrideText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

/**
 * Read the running (or manually specified) host's facts.
 *
 * @param {{dshInstallDir?: string, dshVersion?: string}} [overrides] manual
 *   host override for a modified/non-standard DSH.
 * @returns {{
 *   dshHome: string,
 *   profile: string,
 *   dshInstallDir: string,
 *   dshVersion: string,
 *   nodeVersion: string,
 *   hostProvided: string[],
 *   source: 'env'|'argv'|'profile-fallback'|'path'|'override'|'unknown',
 *   overridden: {installDir: boolean, version: boolean},
 *   warnings: string[],
 * }} host facts; `dshInstallDir`/`dshVersion` are `''`/`'unknown'` and
 *   `hostProvided` is empty when the installation cannot be located.
 */
export function getHostInfo(overrides = {}) {
  const dshHome = detectDshHome()
  const profile = detectProfile()
  /** @type {string[]} */
  const warnings = []
  const overridden = { installDir: false, version: false }
  const overrideInstallRaw = overrideText(overrides?.dshInstallDir)
  const overrideVersionRaw = overrideText(overrides?.dshVersion)

  /** @type {{dir: string, manifest: object} | null} */
  let installation = null
  /** @type {string} */
  let source = 'unknown'

  // 1) Manual installation-directory override (UI: modified/non-standard DSH).
  if (overrideInstallRaw !== '') {
    const requested = resolve(overrideInstallRaw)
    installation = locateDshFromInput(requested)
    if (installation === null) {
      warnings.push(
        `手动指定的 DSH 安装目录不可用：${requested}（未找到名为 ${DSH_PACKAGE_NAME} 的 package.json），已回退自动探测`,
      )
    } else {
      overridden.installDir = true
      source = 'override'
    }
  }

  // 2) `DSH_INSTALL_DIR` environment override.
  if (installation === null) {
    const envRaw = overrideText(process.env.DSH_INSTALL_DIR)
    if (envRaw !== '') {
      installation = locateDshFromInput(envRaw)
      if (installation === null) {
        warnings.push(`环境变量 DSH_INSTALL_DIR 不可用：${envRaw}（未找到 ${DSH_PACKAGE_NAME}），已回退自动探测`)
      } else {
        source = 'env'
      }
    }
  }

  // 3) The running CLI entry point (argv[1] realpath walked upwards).
  if (installation === null) {
    installation = probeFromArgv()
    if (installation !== null) source = 'argv'
  }

  // 4) The profile module fallback DSH heals for plugins (verbatim realpath).
  if (installation === null) {
    installation = probeProfileFallback(dshHome, warnings)
    if (installation !== null) source = 'profile-fallback'
  }

  // 5) `dsh` on PATH (realpath, symlink-friendly).
  if (installation === null) {
    installation = probeFromPath()
    if (installation !== null) source = 'path'
  }

  // 6) The usual global installation prefixes.
  if (installation === null) {
    installation = probeFromCommonPaths()
    if (installation !== null) source = 'path'
  }

  const installDir = installation !== null ? installation.dir : ''
  let dshVersion = 'unknown'

  // Version precedence: manual override > installation manifest > fallback probe.
  if (overrideVersionRaw !== '') {
    dshVersion = overrideVersionRaw
    overridden.version = true
  } else if (installation !== null) {
    dshVersion = versionOf(installation.manifest)
  }
  if (dshVersion === 'unknown' && !overridden.version) {
    dshVersion = fallbackVersion(dshHome, profile)
  }
  if (dshVersion === 'unknown') {
    warnings.push('未能确定 DSH 版本（dshVersion=unknown）；可通过「手动指定宿主」或 DSH_INSTALL_DIR 指定安装位置')
  }

  // Host-provided dependency closure, computed from the final installation.
  let hostProvided = []
  if (installation === null) {
    warnings.push('未定位 DSH 安装目录，宿主依赖闭包为空；打包时可能无法正确区分宿主提供的依赖（可用「手动指定宿主」修正）')
  } else {
    const cached = closureCache.get(installDir)
    if (cached !== undefined) {
      hostProvided = cached
    } else {
      const manifest = readManifest(installDir)
      if (manifest === null) {
        warnings.push(`DSH 安装目录的 package.json 无法读取：${installDir}；宿主依赖闭包为空`)
      } else {
        hostProvided = collectHostProvided(installDir, manifest)
        closureCache.set(installDir, hostProvided)
      }
    }
    if (hostProvided.length === 0 && !warnings.some((warning) => warning.includes('宿主依赖闭包为空'))) {
      warnings.push(`DSH 安装清单没有可解析的依赖：${installDir}；宿主依赖闭包为空`)
    }
  }

  return {
    dshHome,
    profile,
    dshInstallDir: installDir,
    dshVersion,
    nodeVersion: process.version,
    hostProvided,
    source,
    overridden,
    warnings,
  }
}
