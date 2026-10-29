/**
 * Live npm-registry matrix test for `lib/registry.mjs`.
 *
 * Requires network access to registry.npmjs.org.
 *
 * Run: node test/b/test-matrix.mjs
 * Writes: test/out-b/matrix-dsh-better-sidebar.json
 */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { downloadTarball, encodePackageName, fetchPackument, listPluginVersions, resolveRegistry, satisfiesDsh } from '../../lib/registry.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'out-b')
await mkdir(outDir, { recursive: true })

function rowOf(matrix, version) {
  return matrix.versions.find((row) => row.version === version)
}

// ---------------------------------------------------------------- better-sidebar
const sidebar = await listPluginVersions('dsh-better-sidebar')
console.log(`registry: ${sidebar.registry}`)
console.log(`dsh-better-sidebar versions: ${sidebar.versions.length}, dshVersions: ${sidebar.dshVersions.length}`)
console.log('newest 5:', sidebar.versions.slice(0, 5).map((row) => `${row.version} (${row.published ?? '?'})`).join(', '))
console.log('dsh newest 5:', sidebar.dshVersions.slice(0, 5).map((row) => row.version).join(', '))
assert(sidebar.versions.length >= 30, `expected >=30 dsh-better-sidebar versions, got ${sidebar.versions.length}`)
assert(sidebar.dshVersions.length >= 20, `expected >=20 DSH versions, got ${sidebar.dshVersions.length}`)
assert(sidebar.warnings.length === 0, `unexpected warnings: ${sidebar.warnings.join('; ')}`)

const v0131 = rowOf(sidebar, '0.13.1')
assert(v0131 !== undefined, 'dsh-better-sidebar@0.13.1 missing from matrix')
assert(v0131.dshPeers.includes('^0.1.0-rc.7'), `0.13.1 dshPeers: ${JSON.stringify(v0131.dshPeers)}`)
assert(v0131.compatibleDsh.includes('0.1.0-rc.7'), `0.13.1 compatibleDsh should include 0.1.0-rc.7`)
assert(!v0131.compatibleDsh.includes('0.2.1-rc.2'), '0.13.1 must not be listed as compatible with 0.2.1-rc.2')
console.log('0.13.1:', JSON.stringify({ published: v0131.published, dshPeers: v0131.dshPeers, compatibleDsh: v0131.compatibleDsh.slice(0, 8) }))

const v028 = rowOf(sidebar, '0.28.2')
assert(v028 !== undefined, 'dsh-better-sidebar@0.28.2 missing from matrix')
assert(v028.dshPeers.some((range) => range.startsWith('^0.2.1-rc.1')), `0.28.2 dshPeers: ${JSON.stringify(v028.dshPeers)}`)
assert(v028.compatibleDsh.includes('0.2.1-rc.2'), `0.28.2 compatibleDsh should include 0.2.1-rc.2`)
assert(!v028.compatibleDsh.includes('0.1.0-rc.7'), '0.28.2 must not be compatible with 0.1.0-rc.7')
console.log('0.28.2:', JSON.stringify({ published: v028.published, dshPeers: v028.dshPeers, compatibleDsh: v028.compatibleDsh.slice(0, 8) }))

// Every compatibleDsh entry must actually satisfy one of the dshPeers ranges.
for (const row of sidebar.versions) {
  for (const dshVersion of row.compatibleDsh) {
    assert(
      row.dshPeers.some((range) => satisfiesDsh(dshVersion, range)),
      `${row.version} lists ${dshVersion} but no dshPeer range matches`,
    )
  }
}

// ---------------------------------------------------------------- dsh-unlag
const unlag = await listPluginVersions('dsh-unlag')
console.log(`\ndsh-unlag versions: ${unlag.versions.length}`)
console.log('newest 3:', unlag.versions.slice(0, 3).map((row) => `${row.version} dshPeers=${JSON.stringify(row.dshPeers)}`).join(' | '))
assert(unlag.versions.length >= 3, `expected >=3 dsh-unlag versions, got ${unlag.versions.length}`)
assert(unlag.dshVersions.length >= 20, 'dshVersions missing for dsh-unlag request')

await writeFile(
  join(outDir, 'matrix-dsh-better-sidebar.json'),
  `${JSON.stringify({ plugin: sidebar.plugin, registry: sidebar.registry, versions: sidebar.versions, dshVersions: sidebar.dshVersions }, null, 2)}\n`,
)

// ---------------------------------------------------------------- helpers / scoped names
assert.equal(encodePackageName('@deepseek-ai/dsh'), '@deepseek-ai%2fdsh')
assert.equal(encodePackageName('dsh-unlag'), 'dsh-unlag')
assert.equal(resolveRegistry(), 'https://registry.npmjs.org')
assert.equal(resolveRegistry('https://mirror.example/'), 'https://mirror.example')
const previousRegistry = process.env.DSH_OFFLINE_PACKER_REGISTRY
process.env.DSH_OFFLINE_PACKER_REGISTRY = 'https://mirror.example/'
assert.equal(resolveRegistry(), 'https://mirror.example')
if (previousRegistry === undefined) delete process.env.DSH_OFFLINE_PACKER_REGISTRY
else process.env.DSH_OFFLINE_PACKER_REGISTRY = previousRegistry
const scoped = await fetchPackument('@deepseek-ai/dsh')
assert(scoped.versions['0.1.0-rc.7'] !== undefined, 'scoped packument fetch failed')

// ---------------------------------------------------------------- error paths
await assert.rejects(
  () => listPluginVersions('dsh-offline-packer-package-does-not-exist-xyz'),
  (error) => {
    assert.equal(error.code, 'REGISTRY_HTTP')
    assert.equal(error.status, 404)
    return true
  },
)
await assert.rejects(
  () => downloadTarball('dsh-better-sidebar', '0.0.0-does-not-exist', join(outDir, 'tarballs', 'nope.tgz')),
  (error) => {
    assert.equal(error.code, 'VERSION_NOT_FOUND')
    return true
  },
)
console.log('error paths OK (REGISTRY_HTTP 404, VERSION_NOT_FOUND), scoped encoding OK')

console.log('\nmatrix test OK (snapshot: test/out-b/matrix-dsh-better-sidebar.json)')
