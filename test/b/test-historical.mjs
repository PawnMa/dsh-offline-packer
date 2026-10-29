/**
 * End-to-end historical packaging test: download dsh-better-sidebar@0.13.1
 * from npm, let npm install its runtime deps, and ask server-core's
 * `assembleOfflinePackage` to build the offline zip for DSH 0.1.0-rc.7.
 *
 * Requires network + npm. Takes several minutes the first time (npm cache is
 * warm on later runs).
 *
 * Run: node test/b/test-historical.mjs
 * Output: test/out-b/<plugin>-offline-<version>-dsh-<target>.zip
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { buildRegistryPackage } from '../../lib/historical.mjs'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'out-b')
const log = (message) => console.log(`[historical] ${message}`)

const start = Date.now()
const result = await buildRegistryPackage(
  { pluginName: 'dsh-better-sidebar', version: '0.13.1', targetDshVersion: '0.1.0-rc.7' },
  { outputRoot: outDir, log },
)
log(`done in ${((Date.now() - start) / 1000).toFixed(1)}s`)

// --- result contract -----------------------------------------------------
for (const field of ['dir', 'zipPath', 'zipName', 'sizeBytes', 'pluginName', 'version', 'targetDshVersion', 'mode', 'vendored', 'warnings']) {
  assert(field in result, `result.${field} missing: ${JSON.stringify(Object.keys(result))}`)
}
assert.equal(result.pluginName, 'dsh-better-sidebar')
assert.equal(result.version, '0.13.1')
assert.equal(result.targetDshVersion, '0.1.0-rc.7')
assert.equal(result.mode, 'registry')
assert(Array.isArray(result.warnings), 'warnings must be an array')
assert(existsSync(result.zipPath), `zip missing: ${result.zipPath}`)
assert((await stat(result.zipPath)).size > 0, 'zip is empty')
assert(result.zipName.endsWith('.zip'), `zipName: ${result.zipName}`)
assert(Array.isArray(result.vendored) && result.vendored.length > 0, 'vendored list must not be empty')
console.log(`result: ${JSON.stringify({ zipName: result.zipName, sizeBytes: result.sizeBytes, vendored: result.vendored.length, warnings: result.warnings })}`)

// --- zip structure -------------------------------------------------------
// The zip has one top-level directory named after the bundle (`<zipName minus .zip>`).
const bundleName = result.zipName.replace(/\.zip$/, '')
const { stdout: listing } = await run('unzip', ['-Z1', result.zipPath], { maxBuffer: 64 * 1024 * 1024 })
const entries = listing.split('\n').filter(Boolean)
assert(entries.includes(`${bundleName}/package/package.json`), 'zip lacks package/package.json')
assert(entries.includes(`${bundleName}/install-offline.sh`), 'zip lacks install-offline.sh')
assert(entries.includes(`${bundleName}/install-offline.ps1`), 'zip lacks install-offline.ps1')
assert(entries.includes(`${bundleName}/README.md`), 'zip lacks README.md')
assert(entries.includes(`${bundleName}/VERSIONS.txt`), 'zip lacks VERSIONS.txt')
assert(entries.includes(`${bundleName}/CHECKSUMS.txt`), 'zip lacks CHECKSUMS.txt')
assert(
  entries.some((entry) => entry.startsWith(`${bundleName}/package/node_modules/schemastery/`)),
  'zip lacks package/node_modules/schemastery/',
)
assert(
  entries.some((entry) => entry.startsWith(`${bundleName}/package/node_modules/ws/`)),
  'zip lacks package/node_modules/ws/',
)
assert(
  !entries.some((entry) => entry.startsWith(`${bundleName}/package/node_modules/node-pty/`)),
  'node-pty must not be vendored (unbuilt native module)',
)
assert(
  !entries.some((entry) => entry.startsWith(`${bundleName}/package/node_modules/react/`)),
  'host peer react must not be vendored',
)
assert(
  !entries.some((entry) => entry.startsWith(`${bundleName}/package/node_modules/@deepseek-ai/`)),
  'host packages @deepseek-ai/* must not be vendored',
)
console.log(`zip structure: ${entries.length} entries under ${bundleName}/`)

const { stdout: testOutput } = await run('unzip', ['-t', result.zipPath], { maxBuffer: 64 * 1024 * 1024 })
assert(/No errors detected/.test(testOutput), `unzip -t failed: ${testOutput.slice(-500)}`)

// --- rewritten manifest --------------------------------------------------
const { stdout: manifestText } = await run('unzip', ['-p', result.zipPath, `${bundleName}/package/package.json`], {
  maxBuffer: 16 * 1024 * 1024,
})
const manifest = JSON.parse(manifestText)
assert.deepEqual(manifest.dependencies, {}, `dependencies must be {}: ${JSON.stringify(manifest.dependencies)}`)
assert.equal(manifest.name, 'dsh-better-sidebar')
assert.equal(manifest.version, '0.13.1')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch must survive the rewrite')
for (const [peer, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
  assert.equal(meta?.optional, true, `peerDependenciesMeta[${peer}] must be {optional:true}`)
}

// --- checksums -----------------------------------------------------------
const { stdout: checksums } = await run('unzip', ['-p', result.zipPath, `${bundleName}/CHECKSUMS.txt`], {
  maxBuffer: 16 * 1024 * 1024,
})
assert(checksums.includes('install-offline.sh'), 'CHECKSUMS.txt does not cover install-offline.sh')
const total = listing.trim().split('\n').length
console.log(`zip checks passed (${total} listing lines, checksums size ${checksums.length} bytes)`)

console.log('\nhistorical packaging test OK')
console.log(`artifact: ${result.zipPath}`)
