/**
 * Minimal, dependency-free tar.gz extraction for npm registry tarballs.
 *
 * npm tarballs are ustar archives whose entries all live under a single
 * top-level directory (`package/`); we strip that root so `extractTgz` unpacks
 * the plugin files directly into `destDir`. Pax (`x`) extension headers and
 * GNU long-name (`L`/`K`) headers are honoured; other exotic header types are
 * skipped. Path traversal (absolute paths, `..` segments, escaping symlinks) is
 * rejected with `code: 'TAR_PATH_TRAVERSAL'`.
 */

import { chmod, mkdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

const gunzipAsync = promisify(gunzip)
const BLOCK_SIZE = 512

/** Tagged error for the HTTP layer. */
function failure(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

function isZeroBlock(block) {
  for (let index = 0; index < block.length; index += 1) {
    if (block[index] !== 0) return false
  }
  return true
}

/** Read a NUL-terminated UTF-8 string out of a fixed-width header field. */
function readCString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length)
  const nullAt = slice.indexOf(0)
  return slice.subarray(0, nullAt === -1 ? slice.length : nullAt).toString('utf8')
}

/** Read a tar octal field; also support GNU base-256 encoding. */
function readOctal(buffer, start, length) {
  if (start >= buffer.length) return 0
  if ((buffer[start] & 0x80) !== 0) {
    let value = BigInt(buffer[start] & 0x7f)
    for (let index = start + 1; index < start + length && index < buffer.length; index += 1) {
      value = (value << 8n) | BigInt(buffer[index])
    }
    return Number(value)
  }
  const text = buffer.toString('latin1', start, start + length).replace(/\0.*$/s, '').trim()
  if (text === '') return 0
  const parsed = Number.parseInt(text, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

function alignBlock(size) {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
}

/** Verify the ustar checksum when the header claims to be ustar. */
function headerChecksumOk(header) {
  const magic = header.toString('latin1', 257, 263)
  if (magic !== 'ustar\0' && magic !== 'ustar ') return true // Not ustar: stay tolerant.
  const expected = readOctal(header, 148, 8)
  let unsigned = 0
  let signed = 0
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : header[index]
    unsigned += byte
    signed += byte < 128 ? byte : byte - 256
  }
  return expected === unsigned || expected === signed
}

/** Parse a pax extended header payload ("<len> <key>=<value>\n"). */
function parsePax(payload) {
  const fields = {}
  let offset = 0
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(payload.toString('latin1', offset, space), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > payload.length) break
    const record = payload.toString('utf8', space + 1, offset + length).replace(/\n$/, '')
    const equals = record.indexOf('=')
    if (equals > 0) fields[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return fields
}

/**
 * First pass: walk the archive and collect logical entries.
 *
 * @param {Buffer} data decompressed tar bytes.
 * @returns {object[]} entries with absolute paths inside the archive.
 */
function parseEntries(data) {
  const entries = []
  let offset = 0
  let pax = {}
  let longName = null
  let longLink = null
  while (offset + BLOCK_SIZE <= data.length) {
    const header = data.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(header)) break
    if (!headerChecksumOk(header)) {
      throw failure(`tar 头部校验和错误（偏移 ${offset}）`, 'TAR_BAD_HEADER', { offset })
    }
    const name = readCString(header, 0, 100)
    const mode = readOctal(header, 100, 8)
    let size = readOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    const prefix = readCString(header, 345, 155)
    const linkname = readCString(header, 157, 100)
    const dataStart = offset + BLOCK_SIZE
    if (typeflag !== 'x' && typeflag !== 'g' && typeflag !== 'L' && typeflag !== 'K' && dataStart + size > data.length) {
      throw failure(`tar 数据被截断（偏移 ${offset}，size ${size}）`, 'TAR_TRUNCATED', { offset })
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const payload = data.subarray(dataStart, dataStart + size)
      if (typeflag === 'x') pax = { ...pax, ...parsePax(payload) }
      offset = dataStart + alignBlock(size)
      continue
    }
    if (typeflag === 'L' || typeflag === 'K') {
      const value = data.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0+$/, '')
      if (typeflag === 'L') longName = value
      else longLink = value
      offset = dataStart + alignBlock(size)
      continue
    }
    if (pax.size !== undefined) {
      const paxSize = Number.parseInt(pax.size, 10)
      if (Number.isFinite(paxSize) && paxSize >= 0) size = paxSize
    }
    const rawName = pax.path ?? longName ?? (prefix === '' ? name : `${prefix}/${name}`)
    const rawLink = pax.linkpath ?? longLink ?? linkname
    const regular = typeflag === '0' || typeflag === '7' || typeflag === '\0'
    entries.push({
      path: rawName,
      linkname: rawLink,
      mode,
      size,
      typeflag,
      data: regular ? data.subarray(dataStart, dataStart + size) : null,
    })
    pax = {}
    longName = null
    longLink = null
    offset = dataStart + alignBlock(size)
  }
  return entries
}

/** Reject absolute paths, `..` segments and NUL bytes. */
function safeRelativePath(rawPath) {
  const normalized = rawPath.replace(/\\/g, '/')
  if (normalized.includes('\0')) throw failure(`tar 路径包含 NUL：${JSON.stringify(rawPath)}`, 'TAR_INVALID_PATH')
  if (normalized.startsWith('/')) throw failure(`tar 路径是绝对路径：${rawPath}`, 'TAR_PATH_TRAVERSAL', { path: rawPath })
  const parts = []
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw failure(`tar 路径包含 ..：${rawPath}`, 'TAR_PATH_TRAVERSAL', { path: rawPath })
    parts.push(part)
  }
  return parts.join('/')
}

function firstSegment(path) {
  const slash = path.indexOf('/')
  return slash === -1 ? path : path.slice(0, slash)
}

/**
 * Extract a `.tgz` buffer into `destDir`, stripping the archive's single
 * top-level directory (npm's `package/`).
 *
 * @param {Buffer|Uint8Array} tgzBuffer gzip-compressed tar bytes.
 * @param {string} destDir destination directory (created as needed).
 * @returns {Promise<string>} `destDir` — the extracted top-level directory.
 */
export async function extractTgz(tgzBuffer, destDir) {
  if (typeof destDir !== 'string' || destDir.trim() === '') throw failure('缺少解包目标目录', 'BAD_REQUEST')
  let compressed
  if (Buffer.isBuffer(tgzBuffer)) compressed = tgzBuffer
  else if (tgzBuffer instanceof Uint8Array) compressed = Buffer.from(tgzBuffer)
  else throw failure('tar 数据必须是 Buffer/Uint8Array', 'BAD_REQUEST')
  let data
  try {
    data = await gunzipAsync(compressed)
  } catch (error) {
    throw failure(
      `无法解压 gzip 数据：${error instanceof Error ? error.message : String(error)}`,
      'TAR_BAD_GZIP',
      { cause: error },
    )
  }
  const entries = parseEntries(data)
  if (entries.length === 0) throw failure('tar 里没有任何文件条目', 'TAR_EMPTY')

  // npm tarballs put everything below one directory (`package/`). Strip it when
  // every entry shares the same first path segment.
  const firstPath = entries.find((entry) => entry.path !== '')?.path ?? ''
  let root = firstPath === '' ? '' : firstSegment(firstPath)
  if (root !== '') {
    const shared = entries.every((entry) => entry.path === root || entry.path.startsWith(`${root}/`))
    if (!shared) root = ''
  }
  const stripRoot = (path) => {
    if (root === '') return path
    if (path === root) return ''
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  }

  const destRoot = resolve(destDir)
  const ensureInsideDest = (target, rawPath) => {
    if (target !== destRoot && !target.startsWith(destRoot + sep)) {
      throw failure(`tar 路径逃出目标目录：${rawPath}`, 'TAR_PATH_TRAVERSAL', { path: rawPath })
    }
  }

  await mkdir(destRoot, { recursive: true })
  for (const entry of entries) {
    const relative = safeRelativePath(stripRoot(entry.path))
    if (relative === '') continue
    const target = join(destRoot, ...relative.split('/'))
    ensureInsideDest(target, entry.path)
    if (entry.typeflag === '5') {
      await mkdir(target, { recursive: true })
      continue
    }
    if (entry.typeflag === '2') {
      const link = stripRoot(entry.linkname.replace(/\\/g, '/'))
      const absolute = resolve(dirname(target), link)
      ensureInsideDest(absolute, entry.linkname)
      await mkdir(dirname(target), { recursive: true })
      await unlink(target).catch(() => {})
      await symlink(link, target)
      continue
    }
    if (entry.typeflag === '0' || entry.typeflag === '7' || entry.typeflag === '\0') {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.data)
      await chmod(target, (entry.mode & 0o777) || 0o644)
      continue
    }
    // Hard links and unknown/vendor-specific types (`U`, `S`, ...) are skipped;
    // npm tarballs do not rely on them.
  }
  return destDir
}
