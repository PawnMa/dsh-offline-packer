/**
 * Static analysis of a plugin's Node-side runtime imports.
 *
 * The offline package must keep every third-party package the server half loads
 * at runtime, and must not ship anything the host already provides. This module
 * scans the declared server entry plus the `lib/**` JavaScript files and returns
 * bare package specifiers split into:
 *
 *   - `externals`       — statically required (ESM `import` / `export ... from`);
 *   - `dynamicOptional` — only reached through `import()` / `require()` /
 *                         `createRequire(...)(...)`, i.e. loadable lazily;
 *   - `scanned`         — the files that were actually read.
 *
 * Node builtins, relative/absolute paths, URL specifiers and package subpaths
 * are filtered out. The packager vendors both lists by default (better to ship
 * one package too many than to break the plugin offline).
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { join } from 'node:path'

/** Files larger than this are skipped (client bundles can be several MB, but not unbounded). */
const MAX_FILE_BYTES = 32 * 1024 * 1024
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'types'])

/** Node builtins, both bare and `node:`-prefixed spellings. */
const BUILTINS = new Set(builtinModules.map((name) => (name.startsWith('node:') ? name.slice(5) : name)))

/** ESM static imports: `import x from "pkg"`, `import {a} from "pkg"`, `import "pkg"`. */
const STATIC_IMPORT_RE = /(?:^|[\n;])\s*import\s+(?:(?:[\w$*{},\s]+?)\s+from\s+)?['"]([^'"]+)['"]/g
/** ESM re-exports: `export {a} from "pkg"`, `export * from "pkg"`. */
const STATIC_EXPORT_RE = /(?:^|[\n;])\s*export\s+(?:(?:[\w$*{},\s]+?)\s+from\s+)?['"]([^'"]+)['"]/g
/** Dynamic imports: `import("pkg")`. */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
/** CommonJS requires: `require("pkg")`. */
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
/** createRequire chains: `createRequire(...)("pkg")`. */
const CREATE_REQUIRE_RE = /\bcreateRequire\s*\([^()]*\)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * Normalize one raw specifier to a package name, or null when it is not a bare
 * package request (builtin, path, URL, template fragment, internal `#import`).
 *
 * @param {string} specifier raw captured string.
 * @returns {string|null}
 */
function normalizeSpecifier(specifier) {
  if (typeof specifier !== 'string') return null
  const value = specifier.trim()
  if (value === '') return null
  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('#')) return null
  // Any `node:`/`file:`/`http:` style scheme, including our own builtin prefix.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null
  if (BUILTINS.has(value)) return null
  if (value.includes('${') || /[\s'"\\]/.test(value)) return null
  if (value.startsWith('@')) {
    const parts = value.split('/')
    if (parts.length < 2 || parts[1] === '') return null
    return `${parts[0]}/${parts[1]}`
  }
  const first = value.split('/')[0]
  return first === '' ? null : first
}

/** Collect matches of one global regex into a set of normalized package names. */
function collect(regex, text, into) {
  for (const match of text.matchAll(regex)) {
    const name = normalizeSpecifier(match[1])
    if (name !== null) into.add(name)
  }
}

/** Read an `exports["."]` condition tree into runtime entry strings. */
function exportEntryStrings(value, out) {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) exportEntryStrings(item, out)
    return
  }
  const priority = ['default', 'import', 'require', 'node', 'module', 'browser']
  for (const key of priority) {
    if (Object.hasOwn(value, key)) exportEntryStrings(value[key], out)
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'types' || priority.includes(key)) continue
    exportEntryStrings(item, out)
  }
}

/** The declared server entry paths of a manifest, relative to the package. */
function declaredEntries(manifest) {
  const entries = []
  const exported = manifest?.exports
  if (typeof exported === 'string') {
    entries.push(exported)
  } else if (exported !== null && typeof exported === 'object') {
    exportEntryStrings(exported['.'], entries)
  }
  if (typeof manifest?.main === 'string') entries.push(manifest.main)
  return entries.filter((entry) => typeof entry === 'string' && entry.startsWith('.'))
}

/**
 * Recursively collect JavaScript files below `root`, skipping
 * `node_modules`, `.git` and `types` directories.
 *
 * @param {string} root package directory.
 * @returns {Promise<string[]>} absolute paths below `root/lib`.
 */
async function walkLib(root) {
  const files = []
  /** @type {string[]} */
  const stack = [join(root, 'lib')]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        stack.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const dot = entry.name.lastIndexOf('.')
      if (dot === -1) continue
      if (!SCRIPT_EXTENSIONS.has(entry.name.slice(dot))) continue
      files.push(join(dir, entry.name))
    }
  }
  return files
}

/**
 * Analyze which bare packages a plugin's Node side loads at runtime.
 *
 * @param {{dir: string, manifest: object|null}} options plugin directory and its manifest.
 * @returns {Promise<{externals: string[], scanned: string[], dynamicOptional: string[]}>}
 */
export async function analyzeRuntimeExternals({ dir, manifest }) {
  /** @type {string[]} */
  const candidates = []
  if (typeof dir === 'string' && dir !== '' && existsSync(dir)) {
    for (const relative of declaredEntries(manifest)) {
      const absolute = join(dir, relative)
      if (existsSync(absolute)) candidates.push(absolute)
    }
    for (const fallback of ['index.js', 'index.mjs', 'index.cjs']) {
      const absolute = join(dir, fallback)
      if (existsSync(absolute)) candidates.push(absolute)
    }
    candidates.push(...(await walkLib(dir)))
  }

  const scanned = []
  const seen = new Set()
  const externals = new Set()
  const dynamic = new Set()
  for (const absolute of candidates) {
    if (seen.has(absolute)) continue
    seen.add(absolute)
    let text
    try {
      const buffer = await readFile(absolute)
      if (buffer.byteLength > MAX_FILE_BYTES) continue
      text = buffer.toString('utf8')
    } catch {
      continue
    }
    scanned.push(absolute.startsWith(`${dir}/`) ? absolute.slice(dir.length + 1) : absolute)
    collect(STATIC_IMPORT_RE, text, externals)
    collect(STATIC_EXPORT_RE, text, externals)
    collect(DYNAMIC_IMPORT_RE, text, dynamic)
    collect(REQUIRE_RE, text, dynamic)
    collect(CREATE_REQUIRE_RE, text, dynamic)
  }
  for (const name of externals) dynamic.delete(name)
  return {
    externals: [...externals].sort(),
    scanned: scanned.sort(),
    dynamicOptional: [...dynamic].sort(),
  }
}
