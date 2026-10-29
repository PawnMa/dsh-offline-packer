/**
 * npm registry access for the "historical DSH adaptation" flow.
 *
 * Responsibilities:
 *   - fetch a packument (with the registry override env var and scoped-name encoding),
 *   - build the version matrix a DSH version <-> a plugin version (dshPeers + compatibleDsh),
 *   - answer "does DSH version X satisfy the peer range Y?" with npm-compatible
 *     prerelease semantics (this is what makes `^0.1.0-rc.7` accept `0.1.0-rc.8`),
 *   - download a registry tarball to disk (with sha512 integrity verification).
 *
 * Only Node builtins (global fetch, node:crypto, node:fs) are used.
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000
const DSH_PACKAGE = '@deepseek-ai/dsh'
const DSH_PEER_PREFIX = '@deepseek-ai/dsh-'
const MAX_COMPATIBLE_DSH = 30
const PACKUMENT_ACCEPT = 'application/json'
const USER_AGENT = 'dsh-offline-packer/0.1.0 (+https://registry.npmjs.org)'

/** Build a tagged error the HTTP layer can turn into `{code,message}`. */
function failure(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

/**
 * Resolve the registry base URL: explicit option > `DSH_OFFLINE_PACKER_REGISTRY` > npmjs.
 *
 * @param {string} [explicit] registry passed by the caller.
 * @returns {string} registry base URL without a trailing slash.
 */
export function resolveRegistry(explicit) {
  const raw =
    (typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : '') ||
    (typeof process.env.DSH_OFFLINE_PACKER_REGISTRY === 'string' && process.env.DSH_OFFLINE_PACKER_REGISTRY.trim() !== ''
      ? process.env.DSH_OFFLINE_PACKER_REGISTRY.trim()
      : '') ||
    DEFAULT_REGISTRY
  return raw.replace(/\/+$/, '')
}

/**
 * Encode a package name for a packument URL: scoped names become `@scope%2fname`
 * (the npm registry convention), unscoped names are percent-encoded.
 *
 * @param {string} name package name.
 * @returns {string} URL path segment.
 */
export function encodePackageName(name) {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    if (slash === -1) return encodeURIComponent(name)
    return `${name.slice(0, slash)}%2f${encodeURIComponent(name.slice(slash + 1))}`
  }
  return encodeURIComponent(name)
}

/**
 * Fetch one package document (packument) from the npm registry.
 *
 * @param {string} name package name.
 * @param {{registry?: string, timeoutMs?: number}} [options] registry override / timeout.
 * @returns {Promise<object>} parsed packument.
 */
export async function fetchPackument(name, options = {}) {
  const packageName = String(name ?? '').trim()
  if (packageName === '') throw failure('缺少包名', 'BAD_REQUEST')
  const registry = resolveRegistry(options.registry)
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const url = `${registry}/${encodePackageName(packageName)}`
  let response
  try {
    response = await fetch(url, {
      headers: { accept: PACKUMENT_ACCEPT, 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw failure(
      timedOut
        ? `访问 npm registry 超时（${timeoutMs / 1000}s）：${url}`
        : `无法访问 npm registry：${url}（${error instanceof Error ? error.message : String(error)}）`,
      timedOut ? 'REGISTRY_TIMEOUT' : 'REGISTRY_UNREACHABLE',
      { cause: error, url },
    )
  }
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300).replace(/\s+/g, ' ').trim()
    } catch {
      // The error body is best effort only.
    }
    throw failure(
      `npm registry 返回 HTTP ${response.status}（${packageName}）${detail !== '' ? `：${detail}` : ''}`,
      'REGISTRY_HTTP',
      { status: response.status, url },
    )
  }
  try {
    const parsed = await response.json()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('packument 不是对象')
    }
    return parsed
  } catch (error) {
    throw failure(
      `npm registry 返回的内容不是合法 packument（${packageName}）：${error instanceof Error ? error.message : String(error)}`,
      'REGISTRY_BAD_JSON',
      { cause: error, url },
    )
  }
}

/* ------------------------------------------------------------------ */
/* semver subset (exact / ^ / ~ / comparators / || / x-ranges)         */
/* ------------------------------------------------------------------ */

/** Parse a fully specified version (`1.2.3-rc.1`); returns null when invalid. */
function parseFullVersion(text) {
  if (typeof text !== 'string') return null
  const match = /^[v=]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    text.trim(),
  )
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) {
    const left = BigInt(a)
    const right = BigInt(b)
    return left === right ? 0 : left < right ? -1 : 1
  }
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** npm/semver version ordering, including prerelease rules. */
function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  const left = a.prerelease
  const right = b.prerelease
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1
    if (index >= right.length) return 1
    const order = compareIdentifier(left[index], right[index])
    if (order !== 0) return order
  }
  return 0
}

function sameTriple(a, b) {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch
}

function upperVersion(major, minor, patch) {
  // The `-0` prerelease makes the upper bound exclusive of prereleases of that
  // exact triple, mirroring npm's generated caret/tilde bounds.
  return { major, minor, patch, prerelease: ['0'] }
}

const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~|~>)?\s*(.+)$/
const PARTIAL_VERSION_RE =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * Expand one comparator token into primitive comparators.
 *
 * @param {string} token e.g. `^0.1.0-rc.7`, `>=0.2.0`, `1.2.x`.
 * @param {string} range original range (for error messages).
 * @returns {{op: string, ver: object}[]}
 */
function parseComparator(token, range) {
  const match = COMPARATOR_RE.exec(token)
  if (match === null) throw failure(`无法解析版本范围：${range}`, 'INVALID_RANGE')
  let op = match[1] ?? ''
  if (op === '~>') op = '~'
  const text = match[2].trim()
  if (text === '' || text === '*' || /^x$/i.test(text)) return []
  const parts = PARTIAL_VERSION_RE.exec(text)
  if (parts === null) throw failure(`无法解析版本范围：${range}`, 'INVALID_RANGE')
  const [majorText, minorText, patchText] = [parts[1], parts[2], parts[3]]
  const isWild = (value) => value === undefined || value === 'x' || value === 'X' || value === '*'
  if (isWild(majorText)) return []
  const major = Number(majorText)
  const hasMinor = !isWild(minorText)
  const hasPatch = !isWild(patchText)
  const minor = hasMinor ? Number(minorText) : 0
  const patch = hasPatch ? Number(patchText) : 0
  const prerelease = parts[4] === undefined ? [] : parts[4].split('.')
  const exact = { major, minor, patch, prerelease }
  const lower = (upper) => [
    { op: '>=', ver: { major, minor, patch, prerelease: [...prerelease] } },
    ...upper,
  ]
  switch (op) {
    case '':
    case '=': {
      if (hasMinor && hasPatch) return [{ op: '=', ver: exact }]
      if (hasMinor) return lower([{ op: '<', ver: upperVersion(major, minor + 1, 0) }])
      return lower([{ op: '<', ver: upperVersion(major + 1, 0, 0) }])
    }
    case '^': {
      if (major > 0) return lower([{ op: '<', ver: upperVersion(major + 1, 0, 0) }])
      if (minor > 0) return lower([{ op: '<', ver: upperVersion(0, minor + 1, 0) }])
      return lower([{ op: '<', ver: upperVersion(0, 0, patch + 1) }])
    }
    case '~': {
      if (!hasMinor) return lower([{ op: '<', ver: upperVersion(major + 1, 0, 0) }])
      return lower([{ op: '<', ver: upperVersion(major, minor + 1, 0) }])
    }
    case '>=': {
      // `>=1.2` means `>=1.2.0`, matching npm.
      return [{ op: '>=', ver: exact }]
    }
    case '>': {
      if (hasMinor && hasPatch) return [{ op: '>', ver: exact }]
      if (hasMinor) return [{ op: '>=', ver: { major, minor: minor + 1, patch: 0, prerelease: [] } }]
      return [{ op: '>=', ver: { major: major + 1, minor: 0, patch: 0, prerelease: [] } }]
    }
    case '<': {
      if (hasMinor && hasPatch) return [{ op: '<', ver: exact }]
      if (hasMinor) return [{ op: '<', ver: upperVersion(major, minor, 0) }]
      return [{ op: '<', ver: upperVersion(major, 0, 0) }]
    }
    case '<=': {
      if (hasMinor && hasPatch) return [{ op: '<=', ver: exact }]
      if (hasMinor) return [{ op: '<', ver: upperVersion(major, minor + 1, 0) }]
      return [{ op: '<', ver: upperVersion(major + 1, 0, 0) }]
    }
    default:
      throw failure(`无法解析版本范围：${range}`, 'INVALID_RANGE')
  }
}

function parseRange(range) {
  if (typeof range !== 'string' || range.trim() === '') {
    throw failure(`版本范围为空：${range}`, 'INVALID_RANGE')
  }
  return range.split('||').map((part) => {
    const comparators = []
    for (const token of part.trim().split(/\s+/).filter(Boolean)) {
      comparators.push(...parseComparator(token, range))
    }
    return comparators
  })
}

/**
 * npm-compatible range check for a DSH version against a peer range.
 *
 * Supported shapes: exact, `=`, `^`, `~`, `>=`, `<=`, `>`, `<`, `||`,
 * whitespace-joined comparator sets and x-ranges (`*`, `1.x`, `1.2.x`).
 * Prerelease rule: a prerelease version only matches when at least one
 * comparator carries a prerelease with the same major.minor.patch — except for
 * the wildcard range `*`, which accepts everything.
 *
 * @param {string} version concrete version, e.g. `0.1.0-rc.8`.
 * @param {string} range peer range, e.g. `^0.1.0-rc.7`.
 * @returns {boolean} whether the version satisfies the range.
 */
export function satisfiesDsh(version, range) {
  const parsedVersion = parseFullVersion(version)
  if (parsedVersion === null) throw failure(`无法解析版本号：${version}`, 'INVALID_VERSION')
  const sets = parseRange(range)
  return sets.some((comparators) => {
    if (comparators.length === 0) return true // `*`
    if (parsedVersion.prerelease.length > 0) {
      const allowed = comparators.some(
        (comparator) => comparator.ver.prerelease.length > 0 && sameTriple(comparator.ver, parsedVersion),
      )
      if (!allowed) return false
    }
    for (const comparator of comparators) {
      const order = compareVersions(parsedVersion, comparator.ver)
      switch (comparator.op) {
        case '=':
          if (order !== 0) return false
          break
        case '>':
          if (order <= 0) return false
          break
        case '>=':
          if (order < 0) return false
          break
        case '<':
          if (order >= 0) return false
          break
        case '<=':
          if (order > 0) return false
          break
        default:
          return false
      }
    }
    return true
  })
}

/* ------------------------------------------------------------------ */
/* version matrix                                                      */
/* ------------------------------------------------------------------ */

/** Collect DSH peer ranges of one manifest (`@deepseek-ai/dsh` and its siblings). */
function dshPeerRanges(peerDependencies) {
  if (peerDependencies === null || typeof peerDependencies !== 'object') return []
  const ranges = []
  for (const [name, range] of Object.entries(peerDependencies)) {
    if (typeof range !== 'string') continue
    if (name === DSH_PACKAGE || name.startsWith(DSH_PEER_PREFIX)) ranges.push(range.trim())
  }
  return [...new Set(ranges)]
}

function publishedTimestamp(value) {
  if (typeof value !== 'string') return Number.NaN
  return Date.parse(value)
}

/** Newest-first by publish time, falling back to semver order. */
function compareRowsNewestFirst(a, b) {
  const left = publishedTimestamp(a.published)
  const right = publishedTimestamp(b.published)
  const leftValid = Number.isFinite(left)
  const rightValid = Number.isFinite(right)
  if (leftValid && rightValid && left !== right) return right - left
  if (leftValid !== rightValid) return leftValid ? -1 : 1
  const leftVersion = parseFullVersion(a.version)
  const rightVersion = parseFullVersion(b.version)
  if (leftVersion !== null && rightVersion !== null) return compareVersions(rightVersion, leftVersion)
  return a.version < b.version ? 1 : a.version > b.version ? -1 : 0
}

/**
 * Build the version matrix for a published plugin.
 *
 * @param {string} pluginName npm package name.
 * @param {{registry?: string, timeoutMs?: number}} [options] registry/timeout overrides.
 * @returns {Promise<{plugin: string, versions: object[], dshVersions: object[], registry: string, warnings: string[]}>}
 */
export async function listPluginVersions(pluginName, options = {}) {
  const name = String(pluginName ?? '').trim()
  if (name === '') throw failure('缺少包名', 'BAD_REQUEST')
  const registry = resolveRegistry(options.registry)
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const warnings = []

  const packument = await fetchPackument(name, { registry, timeoutMs })
  const pluginVersions = packument.versions
  if (pluginVersions === null || typeof pluginVersions !== 'object' || Array.isArray(pluginVersions)) {
    throw failure(`npm registry 上没有 ${name} 的版本信息`, 'REGISTRY_BAD_PACKUMENT', {
      url: `${registry}/${encodePackageName(name)}`,
    })
  }
  const packumentTimes = packument.time !== null && typeof packument.time === 'object' ? packument.time : {}

  let dshPackument = null
  try {
    dshPackument = await fetchPackument(DSH_PACKAGE, { registry, timeoutMs })
  } catch (error) {
    warnings.push(`无法读取 ${DSH_PACKAGE} 的版本列表：${error instanceof Error ? error.message : String(error)}`)
  }
  const dshTimes =
    dshPackument !== null && dshPackument.time !== null && typeof dshPackument.time === 'object' ? dshPackument.time : {}
  const dshVersions =
    dshPackument !== null && dshPackument.versions !== null && typeof dshPackument.versions === 'object'
      ? Object.keys(dshPackument.versions)
          .filter((version) => version.startsWith('0.'))
          .map((version) => ({ version, published: dshTimes[version] ?? null }))
          .sort(compareRowsNewestFirst)
      : []

  const warnedRanges = new Set()
  const versions = []
  for (const [version, manifest] of Object.entries(pluginVersions)) {
    if (manifest === null || typeof manifest !== 'object') continue
    const dshPeers = dshPeerRanges(manifest.peerDependencies)
    const row = {
      version,
      published: packumentTimes[version] ?? null,
      dshPeers,
      compatibleDsh: [],
      deprecated: typeof manifest.deprecated === 'string' && manifest.deprecated !== '' ? manifest.deprecated : null,
    }
    if (dshPeers.length > 0 && dshVersions.length > 0) {
      for (const dshVersion of dshVersions) {
        if (row.compatibleDsh.length >= MAX_COMPATIBLE_DSH) break
        for (const range of dshPeers) {
          let matched = false
          try {
            matched = satisfiesDsh(dshVersion.version, range)
          } catch (error) {
            if (!warnedRanges.has(range)) {
              warnedRanges.add(range)
              warnings.push(`无法解析 peer 范围 ${range}：${error instanceof Error ? error.message : String(error)}`)
            }
          }
          if (matched) {
            row.compatibleDsh.push(dshVersion.version)
            break
          }
        }
      }
    }
    versions.push(row)
  }
  versions.sort(compareRowsNewestFirst)
  if (versions.length === 0) warnings.push(`${name} 没有任何已发布版本`)
  return { plugin: name, versions, dshVersions, registry, warnings }
}

/* ------------------------------------------------------------------ */
/* tarball download                                                    */
/* ------------------------------------------------------------------ */

/** Fallback tarball URL for a package when `dist.tarball` is missing. */
function guessTarballUrl(registry, packageName, version) {
  const slash = packageName.indexOf('/')
  const shortName = slash === -1 ? packageName : packageName.slice(slash + 1)
  // Canonical npm tarball path uses the literal (unencoded) scoped name.
  const base = `${registry}/${packageName}`
  return `${base}/-/${basename(shortName)}-${version}.tgz`
}

/**
 * Download a registry tarball, verify its declared sha512 integrity (when the
 * registry provides one) and stream it to `destFile`.
 *
 * @param {string} pluginName npm package name.
 * @param {string} version exact version.
 * @param {string} destFile target file path (parent directories are created).
 * @param {{registry?: string, timeoutMs?: number, packument?: object}} [options] overrides.
 * @returns {Promise<{file: string, url: string, integrity: string|null, sizeBytes: number}>}
 */
export async function downloadTarball(pluginName, version, destFile, options = {}) {
  const name = String(pluginName ?? '').trim()
  const resolvedVersion = String(version ?? '').trim()
  if (name === '') throw failure('缺少包名', 'BAD_REQUEST')
  if (resolvedVersion === '') throw failure('缺少版本号', 'BAD_REQUEST')
  if (typeof destFile !== 'string' || destFile.trim() === '') throw failure('缺少下载目标路径', 'BAD_REQUEST')
  const registry = resolveRegistry(options.registry)
  const packument = options.packument ?? (await fetchPackument(name, { registry, timeoutMs: options.timeoutMs }))
  const manifest = packument?.versions?.[resolvedVersion]
  if (manifest === null || typeof manifest !== 'object') {
    throw failure(`npm registry 上没有 ${name}@${resolvedVersion}`, 'VERSION_NOT_FOUND', {
      url: `${registry}/${encodePackageName(name)}`,
    })
  }
  const declaredUrl =
    manifest.dist !== null && typeof manifest.dist === 'object' && typeof manifest.dist.tarball === 'string'
      ? manifest.dist.tarball
      : ''
  const url = declaredUrl !== '' ? declaredUrl : guessTarballUrl(registry, name, resolvedVersion)
  const integrity =
    manifest.dist !== null && typeof manifest.dist === 'object' && typeof manifest.dist.integrity === 'string'
      ? manifest.dist.integrity
      : null
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_DOWNLOAD_TIMEOUT_MS

  await mkdir(dirname(destFile), { recursive: true })
  let response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/octet-stream', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw failure(
      timedOut
        ? `下载 tarball 超时（${timeoutMs / 1000}s）：${url}`
        : `下载 tarball 失败：${url}（${error instanceof Error ? error.message : String(error)}）`,
      timedOut ? 'REGISTRY_TIMEOUT' : 'REGISTRY_UNREACHABLE',
      { cause: error, url },
    )
  }
  if (!response.ok) {
    throw failure(`下载 tarball 失败：HTTP ${response.status}（${url}）`, 'REGISTRY_HTTP', {
      status: response.status,
      url,
    })
  }
  if (response.body === null) throw failure(`npm registry 返回了空的 tarball：${url}`, 'REGISTRY_BAD_TARBALL', { url })

  const hash = createHash('sha512')
  let sizeBytes = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      sizeBytes += chunk.length
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destFile))
  } catch (error) {
    await rm(destFile, { force: true }).catch(() => {})
    throw failure(
      `写入 tarball 失败：${destFile}（${error instanceof Error ? error.message : String(error)}）`,
      'TARBALL_WRITE_FAILED',
      { cause: error },
    )
  }
  const digest = `sha512-${hash.digest('base64')}`
  if (typeof integrity === 'string' && integrity.startsWith('sha512-') && integrity !== digest) {
    await rm(destFile, { force: true }).catch(() => {})
    throw failure(`tarball 完整性校验失败（${name}@${resolvedVersion}）`, 'TARBALL_INTEGRITY', {
      url,
      expected: integrity,
      actual: digest,
    })
  }
  return { file: destFile, url, integrity, sizeBytes }
}
