/**
 * Minimal dependency-free ZIP writer (deflate via node:zlib).
 *
 * Produces a standard "single disk, no Zip64" archive with:
 *   - local file headers + deflated payloads,
 *   - one central directory record per file with Unix mode bits in the
 *     external-attributes field (so `install-offline.sh` keeps its 0755 bit),
 *   - the end-of-central-directory record.
 *
 * Directory entries are omitted; extractors recreate directories from the file
 * paths. `unzip -t` must pass on every produced archive.
 */

import { open, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { promisify } from 'node:util'
import { deflateRaw } from 'node:zlib'

const deflateRawAsync = promisify(deflateRaw)

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const VERSION_NEEDED = 20
/** Unix platform (3) in the high byte of "version made by". */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED
/** General purpose bit 11: file names are UTF-8. */
const FLAG_UTF8 = 0x0800
const DEFLATE_METHOD = 8
const MAX_ENTRIES = 0xffff
const MAX_OFFSET = 0xffffffff
const S_IFREG = 0o100000

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

/** CRC-32 (IEEE 802.3) of a buffer. */
function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

/** Encode a JS date as the DOS date/time pair used by ZIP entries. */
function dosDateTime(date) {
  const year = date.getFullYear()
  const dosDate = ((Math.min(Math.max(year - 1980, 0), 127) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff
  return { dosDate, dosTime }
}

/** Normalize one relative archive path; rejects traversal and absolute paths. */
function archiveName(rootName, relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/')
  if (normalized.includes('\0')) throw Object.assign(new Error(`zip 路径包含 NUL：${relativePath}`), { code: 'ZIP_BAD_PATH' })
  if (normalized.startsWith('/') || isAbsolute(normalized)) {
    throw Object.assign(new Error(`zip 路径不能是绝对路径：${relativePath}`), { code: 'ZIP_BAD_PATH' })
  }
  const parts = []
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw Object.assign(new Error(`zip 路径包含 ..：${relativePath}`), { code: 'ZIP_BAD_PATH' })
    parts.push(part)
  }
  if (parts.length === 0) throw Object.assign(new Error(`zip 路径为空：${relativePath}`), { code: 'ZIP_BAD_PATH' })
  const name = `${rootName}/${parts.join('/')}`
  return name
}

/** Encode a Unix mode into the external-attributes field. */
function externalAttributes(mode) {
  const permissions = Number.isInteger(mode) ? mode & 0o777 : 0o644
  return ((S_IFREG | permissions) << 16) >>> 0
}

/**
 * Write `files` below `baseDir` into one ZIP archive.
 *
 * @param {string} zipPath output archive path (parent directories are created).
 * @param {{
 *   rootName: string,
 *   baseDir: string,
 *   files: {path: string, mode?: number}[],
 * }} options `files[].path` is relative to `baseDir`; `mode` overrides the on-disk mode.
 * @returns {Promise<{sizeBytes: number, fileCount: number}>}
 */
export async function zipDirectory(zipPath, { rootName, baseDir, files }) {
  if (typeof zipPath !== 'string' || zipPath === '') throw Object.assign(new Error('缺少 zip 输出路径'), { code: 'ZIP_BAD_PATH' })
  if (typeof rootName !== 'string' || rootName === '') throw Object.assign(new Error('缺少 zip 顶层目录名'), { code: 'ZIP_BAD_PATH' })
  if (typeof baseDir !== 'string' || baseDir === '') throw Object.assign(new Error('缺少 zip 基准目录'), { code: 'ZIP_BAD_PATH' })
  const list = Array.isArray(files) ? files : []
  if (list.length > MAX_ENTRIES) {
    throw Object.assign(new Error(`文件数超过 ZIP 上限（${MAX_ENTRIES}）`), { code: 'ZIP_TOO_MANY_FILES' })
  }
  await mkdir(dirname(zipPath), { recursive: true })
  const handle = await open(zipPath, 'w')
  const centralDirectory = []
  let offset = 0
  try {
    for (const file of list) {
      const relative = typeof file === 'string' ? file : file?.path
      const absolute = join(baseDir, relative)
      const content = await readFile(absolute)
      const fileStat = await stat(absolute)
      const mode = Number.isInteger(file?.mode) ? file.mode : fileStat.mode & 0o777
      const name = archiveName(rootName, relative)
      const nameBuffer = Buffer.from(name, 'utf8')
      const checksum = crc32(content)
      const deflated = await deflateRawAsync(content, { level: 6 })
      const { dosDate, dosTime } = dosDateTime(fileStat.mtime ?? new Date())

      const localHeader = Buffer.alloc(30)
      localHeader.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0)
      localHeader.writeUInt16LE(VERSION_NEEDED, 4)
      localHeader.writeUInt16LE(FLAG_UTF8, 6)
      localHeader.writeUInt16LE(DEFLATE_METHOD, 8)
      localHeader.writeUInt16LE(dosTime, 10)
      localHeader.writeUInt16LE(dosDate, 12)
      localHeader.writeUInt32LE(checksum, 14)
      localHeader.writeUInt32LE(deflated.length, 18)
      localHeader.writeUInt32LE(content.length, 22)
      localHeader.writeUInt16LE(nameBuffer.length, 26)
      localHeader.writeUInt16LE(0, 28)

      const localOffset = offset
      await handle.write(localHeader, 0, localHeader.length, offset)
      offset += localHeader.length
      await handle.write(nameBuffer, 0, nameBuffer.length, offset)
      offset += nameBuffer.length
      if (deflated.length > 0) {
        await handle.write(deflated, 0, deflated.length, offset)
        offset += deflated.length
      }

      const central = Buffer.alloc(46)
      central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0)
      central.writeUInt16LE(VERSION_MADE_BY, 4)
      central.writeUInt16LE(VERSION_NEEDED, 6)
      central.writeUInt16LE(FLAG_UTF8, 8)
      central.writeUInt16LE(DEFLATE_METHOD, 10)
      central.writeUInt16LE(dosTime, 12)
      central.writeUInt16LE(dosDate, 14)
      central.writeUInt32LE(checksum, 16)
      central.writeUInt32LE(deflated.length, 20)
      central.writeUInt32LE(content.length, 24)
      central.writeUInt16LE(nameBuffer.length, 28)
      central.writeUInt16LE(0, 30) // extra length
      central.writeUInt16LE(0, 32) // comment length
      central.writeUInt16LE(0, 34) // disk number
      central.writeUInt16LE(0, 36) // internal attributes
      central.writeUInt32LE(externalAttributes(mode), 38)
      central.writeUInt32LE(localOffset, 42)
      centralDirectory.push({ header: central, name: nameBuffer })
    }

    const centralOffset = offset
    for (const entry of centralDirectory) {
      await handle.write(entry.header, 0, entry.header.length, offset)
      offset += entry.header.length
      await handle.write(entry.name, 0, entry.name.length, offset)
      offset += entry.name.length
    }
    const centralSize = offset - centralOffset
    if (offset > MAX_OFFSET || centralOffset > MAX_OFFSET) {
      throw Object.assign(new Error('zip 超过 4GB，ZIP64 未实现'), { code: 'ZIP_TOO_LARGE' })
    }

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
    eocd.writeUInt16LE(0, 4) // this disk
    eocd.writeUInt16LE(0, 6) // central directory disk
    eocd.writeUInt16LE(centralDirectory.length, 8)
    eocd.writeUInt16LE(centralDirectory.length, 10)
    eocd.writeUInt32LE(centralSize, 12)
    eocd.writeUInt32LE(centralOffset, 16)
    eocd.writeUInt16LE(0, 20) // comment length
    await handle.write(eocd, 0, eocd.length, offset)
    offset += eocd.length
  } finally {
    await handle.close()
  }
  return { sizeBytes: offset, fileCount: list.length }
}

/** Build the archive-relative posix path of `file` below `baseDir` (helper for callers). */
export function zipEntryName(rootName, relativePath) {
  return posix.join(rootName, String(relativePath).replace(/\\/g, '/'))
}
