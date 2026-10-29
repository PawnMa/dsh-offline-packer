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
 * Only Node builtins are used; every filesystem read is synchronous and cheap,
 * keyed by a small in-process cache so per-request calls stay cheap.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
/** Upper bound on packages visited while walking the installation closure. */
const MAX_CLOSURE_PACKAGES = 4000
/** Upper bound on directory levels walked up from `process.argv[1]`. */
const MAX_WALK_UP = 16

/** @type {Map<string, string[]>} */
const closureCache = new Map()

/** Read one package manifest, or null when it is missing/unreadable. */
function readManifest(dir) {
  try {
    const raw = readFileSync(join(dir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
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

/** Whether `dir` holds the running DSH package itself. */
function isDshInstallDir(dir) {
  const manifest = readManifest(dir)
  return manifest?.name === DSH_PACKAGE_NAME ? manifest : null
}

/** Candidate filesystem locations of a globally installed `@deepseek-ai/dsh`. */
function commonGlobalCandidates() {
  const scoped = join('@deepseek-ai', 'dsh')
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '') candidates.push(value)
  }
  // <node>/../lib/node_modules/@deepseek-ai/dsh (npm's unix layout)
  push(join(dirname(process.execPath), '..', 'lib', 'node_modules', scoped))
  // npm/pnpm configured global prefix
  for (const key of ['npm_config_prefix', 'NPM_CONFIG_PREFIX']) {
    const prefix = process.env[key]
    if (typeof prefix === 'string' && prefix.trim() !== '') {
      push(join(prefix.trim(), 'lib', 'node_modules', scoped))
      push(join(prefix.trim(), 'node_modules', scoped))
    }
  }
  // Common per-user global prefixes
  push(join(homedir(), '.local', 'lib', 'node_modules', scoped))
  push(join(homedir(), '.npm-global', 'lib', 'node_modules', scoped))
  push(join(homedir(), '.local', 'share', 'pnpm', 'global', '5', 'node_modules', scoped))
  // System-wide prefixes
  push(join('/usr', 'local', 'lib', 'node_modules', scoped))
  push(join('/usr', 'lib', 'node_modules', scoped))
  // Anything the caller exposed through NODE_PATH
  const nodePath = process.env.NODE_PATH
  if (typeof nodePath === 'string' && nodePath !== '') {
    for (const entry of nodePath.split(process.platform === 'win32' ? ';' : ':')) {
      if (entry.trim() !== '') push(join(entry.trim(), scoped))
    }
  }
  return candidates
}

/**
 * Find the running DSH installation.
 *
 * The authoritative signal is `process.argv[1]` — the `bin.js` path of the
 * running CLI. Realpath it and walk up until a package manifest whose name is
 * `@deepseek-ai/dsh` appears. When the process was not started through the DSH
 * CLI (unit tests, direct imports), fall back to the usual global locations.
 *
 * @returns {{dir: string, manifest: object} | null}
 */
function findDshInstallation() {
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.trim() !== '') {
    let entry
    try {
      entry = isAbsolute(argv1) ? argv1 : resolve(argv1)
      entry = realpathSync(entry)
    } catch {
      entry = resolve(argv1)
    }
    let dir = dirname(entry)
    for (let level = 0; level < MAX_WALK_UP; level += 1) {
      const manifest = isDshInstallDir(dir)
      if (manifest !== null) return { dir, manifest }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const candidate of commonGlobalCandidates()) {
    const manifest = isDshInstallDir(candidate)
    if (manifest !== null) {
      let dir = candidate
      try {
        dir = realpathSync(candidate)
      } catch {
        // Keep the uncanonicalised path when realpath fails.
      }
      return { dir, manifest }
    }
  }
  return null
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
      let realDir
      try {
        realDir = realpathSync(dir)
      } catch {
        realDir = dir
      }
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

/**
 * Read the running host's facts.
 *
 * @returns {{
 *   dshHome: string,
 *   profile: string,
 *   dshInstallDir: string,
 *   dshVersion: string,
 *   nodeVersion: string,
 *   hostProvided: string[],
 * }} host facts; `dshInstallDir`/`dshVersion` are `''`/`'unknown'` and
 *   `hostProvided` is empty when the installation cannot be located.
 */
export function getHostInfo() {
  const installation = findDshInstallation()
  let installDir = ''
  let dshVersion = 'unknown'
  let hostProvided = []
  if (installation !== null) {
    installDir = installation.dir
    const version = installation.manifest.version
    if (typeof version === 'string' && version.trim() !== '') dshVersion = version.trim()
    const cached = closureCache.get(installDir)
    if (cached !== undefined) {
      hostProvided = cached
    } else {
      hostProvided = collectHostProvided(installDir, installation.manifest)
      closureCache.set(installDir, hostProvided)
    }
  }
  return {
    dshHome: detectDshHome(),
    profile: detectProfile(),
    dshInstallDir: installDir,
    dshVersion,
    nodeVersion: process.version,
    hostProvided,
  }
}
