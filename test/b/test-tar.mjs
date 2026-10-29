/**
 * Live + synthetic tests for `lib/tar.mjs`.
 *
 *   - downloads dsh-better-sidebar@0.13.1 from the npm registry and extracts it,
 *   - verifies the real plugin layout (`package.json`, `lib/index.js`, ...),
 *   - crafts hostile archives to prove path traversal / absolute paths /
 *     escaping symlinks are rejected,
 *   - checks pax long names, executable modes and root stripping.
 *
 * Run: node test/b/test-tar.mjs
 */

import assert from 'node:assert/strict'
import { readFile, stat, lstat, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { extractTgz } from '../../lib/tar.mjs'
import { downloadTarball } from '../../lib/registry.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'out-b')
await mkdir(join(outDir, 'tarballs'), { recursive: true })

/* ------------------------------------------------------------------ */
/* tiny ustar writer for the synthetic cases                            */
/* ------------------------------------------------------------------ */

function writeOctal(buffer, value, start, length) {
  buffer.write(value.toString(8).padStart(length - 1, '0'), start, length - 1, 'latin1')
  buffer[start + length - 1] = 0
}

/** Build one 512-byte ustar header. */
function makeHeader({ name, mode = 0o644, size = 0, typeflag = '0', linkname = '' }) {
  const block = Buffer.alloc(512, 0)
  block.write(name.slice(0, 100), 0, 100, 'utf8')
  writeOctal(block, mode, 100, 8)
  writeOctal(block, 0, 108, 8)
  writeOctal(block, 0, 116, 8)
  writeOctal(block, size, 124, 12)
  writeOctal(block, 0, 136, 12)
  block.fill(0x20, 148, 156) // checksum placeholder
  block.write(typeflag, 156, 1, 'latin1')
  block.write(linkname.slice(0, 100), 157, 100, 'utf8')
  block.write('ustar\0', 257, 6, 'latin1')
  block.write('00', 263, 2, 'latin1')
  let sum = 0
  for (let index = 0; index < 512; index += 1) sum += block[index]
  block.write(sum.toString(8).padStart(6, '0'), 148, 6, 'latin1')
  block[154] = 0
  block[155] = 0x20
  return block
}

function pad512(buffer) {
  const remainder = buffer.length % 512
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(512 - remainder, 0)])
}

/** One pax record (`"<length> key=value\n"`, length includes itself). */
function paxRecord(key, value) {
  const tail = ` ${key}=${value}\n`
  const tailLength = Buffer.byteLength(tail)
  let length = tailLength + 1
  while (String(length).length + tailLength !== length) length += 1
  return `${length}${tail}`
}

/**
 * Build a gzipped ustar archive.
 * entries: { name, type?: '0'|'5'|'2', mode?, data?, linkname? }
 */
function makeTar(entries) {
  const blocks = []
  for (const entry of entries) {
    const payload = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data)
    const typeflag = entry.type ?? '0'
    if (payload.length > 300 && entry.name.length > 100) {
      // Exercise the pax extended-header path (path longer than the 100-byte field).
      const pax = Buffer.from(paxRecord('path', entry.name), 'utf8')
      blocks.push(makeHeader({ name: 'PaxHeader', size: pax.length, typeflag: 'x' }), pad512(pax))
    }
    blocks.push(
      makeHeader({
        name: entry.name.slice(0, 100),
        mode: entry.mode,
        size: payload.length,
        typeflag,
        linkname: entry.linkname,
      }),
      pad512(payload),
    )
  }
  blocks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(blocks))
}

async function expectCode(promise, code, label) {
  try {
    await promise
    assert.fail(`${label}: expected error ${code}, but extraction succeeded`)
  } catch (error) {
    assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code} (${error.message})`)
  }
}

async function listFilesRecursive(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? root, entry.name))
}

/* ------------------------------------------------------------------ */
/* 1. real npm tarball                                                 */
/* ------------------------------------------------------------------ */

const tarballPath = join(outDir, 'tarballs', 'dsh-better-sidebar-0.13.1.tgz')
const download = await downloadTarball('dsh-better-sidebar', '0.13.1', tarballPath)
console.log(`downloaded ${download.file} (${download.sizeBytes} bytes)`)
assert(download.integrity === null || download.integrity.startsWith('sha512-'), 'unexpected integrity value')

const realDest = join(outDir, 'extract-better-sidebar-0.13.1')
await mkdir(realDest, { recursive: true })
const returned = await extractTgz(await readFile(tarballPath), realDest)
assert.equal(returned, realDest, 'extractTgz should return destDir')
const manifest = JSON.parse(await readFile(join(realDest, 'package.json'), 'utf8'))
assert.equal(manifest.name, 'dsh-better-sidebar')
assert.equal(manifest.version, '0.13.1')
assert((await stat(join(realDest, 'lib', 'index.js'))).isFile(), 'lib/index.js missing')
const extractedFiles = await listFilesRecursive(realDest)
assert(extractedFiles.length > 50, `expected >50 extracted files, got ${extractedFiles.length}`)
for (const file of extractedFiles) {
  assert(file.startsWith(realDest + '/'), `extracted file escaped destDir: ${file}`)
}
console.log(`real tarball: ${extractedFiles.length} files, package.json + lib/index.js OK`)

/* ------------------------------------------------------------------ */
/* 2. hostile archives are rejected                                    */
/* ------------------------------------------------------------------ */

const evilDest = join(outDir, 'extract-evil')
await expectCode(
  extractTgz(makeTar([{ name: 'package/../../evil.txt', data: 'pwned' }]), evilDest),
  'TAR_PATH_TRAVERSAL',
  'dot-dot path',
)
await expectCode(
  extractTgz(makeTar([{ name: '/tmp/absolute-evil.txt', data: 'pwned' }]), evilDest),
  'TAR_PATH_TRAVERSAL',
  'absolute path',
)
await expectCode(
  extractTgz(makeTar([{ name: 'package/lib/link', type: '2', linkname: '../../../etc/passwd' }]), evilDest),
  'TAR_PATH_TRAVERSAL',
  'escaping symlink',
)
await expectCode(extractTgz(makeTar([]), evilDest), 'TAR_EMPTY', 'empty archive')
await expectCode(extractTgz(Buffer.from('not-gzip'), evilDest), 'TAR_BAD_GZIP', 'not gzip')
console.log('hostile archives rejected (dot-dot, absolute, escaping symlink, empty, bad gzip)')

/* ------------------------------------------------------------------ */
/* 3. root stripping, long pax names, executable mode, symlinks        */
/* ------------------------------------------------------------------ */

const featureDest = join(outDir, 'extract-features')
const longName = `package/lib/${'very-long-directory-name/'.repeat(6)}long-file.js`
assert(longName.length > 100, 'long-name fixture must exceed 100 chars')
const featureTar = makeTar([
  { name: 'package/', type: '5', mode: 0o755 },
  { name: 'package/package.json', data: '{"name":"demo"}' },
  { name: 'package/bin/run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o755 },
  { name: 'package/lib/alias.js', type: '2', linkname: 'real.js' },
  { name: 'package/lib/real.js', data: 'export {}\n' },
  { name: longName, data: 'x'.repeat(400) },
])
await extractTgz(featureTar, featureDest)
assert.equal(await readFile(join(featureDest, 'package.json'), 'utf8'), '{"name":"demo"}')
const runMode = (await stat(join(featureDest, 'bin', 'run.sh'))).mode & 0o777
assert.equal(runMode, 0o755, `executable mode not preserved: ${runMode.toString(8)}`)
assert((await lstat(join(featureDest, 'lib', 'alias.js'))).isSymbolicLink(), 'relative symlink was not created')
assert.equal(await readFile(join(featureDest, 'lib', 'real.js'), 'utf8'), 'export {}\n')
await stat(join(featureDest, longName.slice('package/'.length)))
console.log('root stripping / pax long name / executable mode / relative symlink OK')

console.log('\ntar test OK')
