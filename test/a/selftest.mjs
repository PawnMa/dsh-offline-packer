/**
 * Server-core self test (task-4), runnable on its own:
 *
 *   node test/a/selftest.mjs
 *
 * Covers: host facts (real 0.2.1-rc.2 install), read-only inventory of the real
 * user home (/home/fc/.dsh), runtime analysis of two real plugins, and full
 * offline packaging of `dsh-unlag` + `dsh-better-sidebar` into
 * `test/out-a/` with `unzip -t` / `sha256sum -c` / `bash -n` verification.
 * It never writes to the scanned DSH home.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { getHostInfo } from '../../lib/host.mjs'
import { analyzeRuntimeExternals } from '../../lib/analyze.mjs'
import { listPlugins } from '../../lib/inventory.mjs'
import { buildLocalPackage } from '../../lib/local.mjs'

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const OUTPUT_ROOT = join(REPO_ROOT, 'test', 'out-a')
const USER_HOME = '/home/fc/.dsh'
const USER_PROFILE = 'web'
const results = { host: null, inventory: null, analyze: {}, packages: [] }

function pass(section, detail) {
  console.log(`PASS ${section}: ${detail}`)
}

function sh(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options })
}

// ---------------------------------------------------------------- host facts
const host = getHostInfo()
results.host = host
assert.ok(host.dshInstallDir !== '', 'dshInstallDir resolved')
assert.ok(existsSync(join(host.dshInstallDir, 'package.json')), 'dshInstallDir holds a package.json')
assert.match(host.dshVersion, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, `dshVersion looks real (${host.dshVersion})`)
assert.equal(host.nodeVersion, process.version)
assert.ok(Array.isArray(host.hostProvided) && host.hostProvided.length >= 100, 'hostProvided closure collected')
for (const expected of ['ws', 'yaml', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/cordis']) {
  assert.ok(host.hostProvided.includes(expected), `hostProvided includes ${expected}`)
}
pass('host', `dsh ${host.dshVersion} @ ${host.dshInstallDir}; node ${host.nodeVersion}; hostProvided=${host.hostProvided.length}`)

// ----------------------------------------------------------------- inventory
const inventory = await listPlugins(null, { dshHome: USER_HOME, profile: USER_PROFILE })
results.inventory = {
  dshHome: inventory.dshHome,
  profile: inventory.profile,
  profileDir: inventory.profileDir,
  count: inventory.plugins.length,
  pluginNames: inventory.plugins.map((plugin) => plugin.name),
}
assert.equal(inventory.dshHome, USER_HOME)
assert.equal(inventory.profile, USER_PROFILE)
assert.equal(inventory.profileDir, join(USER_HOME, 'profiles', USER_PROFILE))
assert.ok(inventory.plugins.length >= 10, `inventory lists >= 10 plugins (${inventory.plugins.length})`)
for (const plugin of inventory.plugins) {
  assert.equal(typeof plugin.name, 'string')
  assert.ok(plugin.name.length > 0)
  assert.ok(plugin.version === null || typeof plugin.version === 'string', `${plugin.name}.version type`)
  assert.ok(['bundle', 'plugin', 'installation'].includes(plugin.kind), `${plugin.name}.kind = ${plugin.kind}`)
  assert.equal(typeof plugin.installed, 'boolean', `${plugin.name}.installed`)
  assert.equal(typeof plugin.enabled, 'boolean', `${plugin.name}.enabled`)
  assert.ok(plugin.dir === null || typeof plugin.dir === 'string')
  assert.ok(plugin.realDir === null || typeof plugin.realDir === 'string')
  assert.equal(typeof plugin.sizeBytes, 'number')
  assert.equal(typeof plugin.fileCount, 'number')
  assert.ok(plugin.peerDsh === null || typeof plugin.peerDsh === 'string')
  assert.ok(plugin.client === null || typeof plugin.client === 'object')
  assert.ok(plugin.bundlePatch === null || typeof plugin.bundlePatch === 'string')
  assert.ok(plugin.serverEntry === null || typeof plugin.serverEntry === 'string')
  assert.ok(Array.isArray(plugin.warnings), `${plugin.name}.warnings array`)
}
const byName = new Map(inventory.plugins.map((plugin) => [plugin.name, plugin]))
const unlag = byName.get('dsh-unlag')
assert.ok(unlag !== undefined, 'dsh-unlag listed')
assert.equal(unlag.version, '1.12.3')
assert.equal(unlag.kind, 'bundle')
assert.ok(unlag.dir !== null && unlag.realDir !== null)
assert.ok(unlag.sizeBytes > 0 && unlag.fileCount > 0)
assert.equal(unlag.enabled, true)
assert.ok(unlag.client !== null && unlag.client.platform === 'web')
const sidebar = byName.get('dsh-better-sidebar')
assert.ok(sidebar !== undefined, 'dsh-better-sidebar listed')
assert.equal(sidebar.version, '0.28.1')
assert.match(sidebar.peerDsh ?? '', /0\.2\.1-rc\.1/)
assert.equal(sidebar.serverEntry, 'lib/index.js')
pass(
  'inventory',
  `${inventory.plugins.length} plugins read-only from ${inventory.dshHome}/${inventory.profile} (dsh-unlag ${unlag.version}, dsh-better-sidebar ${sidebar.version})`,
)

// ------------------------------------------------------------------- analyze
for (const name of ['dsh-unlag', 'dsh-better-sidebar']) {
  const plugin = byName.get(name)
  const manifest = JSON.parse(readFileSync(join(plugin.realDir, 'package.json'), 'utf8'))
  const analysis = await analyzeRuntimeExternals({ dir: plugin.realDir, manifest })
  results.analyze[name] = analysis
  assert.ok(Array.isArray(analysis.externals) && Array.isArray(analysis.dynamicOptional) && Array.isArray(analysis.scanned))
  if (name === 'dsh-unlag') {
    assert.deepEqual(analysis.externals, [])
    assert.ok(analysis.scanned.includes('index.js'))
  } else {
    assert.ok(analysis.externals.includes('ws'), 'better-sidebar statically imports ws')
    assert.ok(analysis.externals.includes('yaml'), 'better-sidebar statically imports yaml')
    assert.ok(analysis.externals.includes('@deepseek-ai/schemastery'))
    assert.ok(analysis.scanned.includes('lib/index.js'))
  }
  pass('analyze', `${name}: files=${analysis.scanned.length} externals=[${analysis.externals.join(', ')}] dynamic=[${analysis.dynamicOptional.join(', ')}]`)
}

// --------------------------------------------------------------- packaging
await rm(OUTPUT_ROOT, { recursive: true, force: true })
for (const [pluginName, expectedVersion] of [
  ['dsh-unlag', '1.12.3'],
  ['dsh-better-sidebar', '0.28.1'],
]) {
  const started = Date.now()
  const result = await buildLocalPackage(
    { pluginName },
    { ctx: null, outputRoot: OUTPUT_ROOT, log: (line) => console.log(`  [${pluginName}] ${line}`) },
  )
  const elapsed = Date.now() - started
  results.packages.push({ ...result, elapsedMs: elapsed })

  assert.equal(result.pluginName, pluginName)
  assert.equal(result.version, expectedVersion)
  assert.equal(result.mode, 'local')
  assert.ok(typeof result.targetDshVersion === 'string' && result.targetDshVersion !== '')
  assert.ok(existsSync(result.zipPath), 'zip exists')
  assert.equal(statSync(result.zipPath).size, result.sizeBytes)
  assert.ok(result.sizeBytes > 0)
  assert.ok(result.dir.startsWith(OUTPUT_ROOT + '/'), 'staging inside outputRoot')
  assert.ok(result.zipPath.startsWith(OUTPUT_ROOT + '/'), 'zip inside outputRoot')

  const unzipTest = sh('unzip', ['-t', result.zipPath])
  assert.match(unzipTest, /No errors detected/, 'unzip -t clean')

  const packageDir = join(result.dir, 'package')
  const stagedManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  assert.deepEqual(stagedManifest.dependencies, {}, 'manifest dependencies {}')
  for (const [peer, meta] of Object.entries(stagedManifest.peerDependenciesMeta ?? {})) {
    assert.equal(meta.optional, true, `peer ${peer} optional`)
  }
  for (const peer of Object.keys(stagedManifest.peerDependencies ?? {})) {
    assert.ok(Object.hasOwn(stagedManifest.peerDependenciesMeta ?? {}, peer), `peer ${peer} has meta`)
  }

  for (const file of ['install-offline.sh', 'install-offline.ps1', 'README.md', 'VERSIONS.txt', 'CHECKSUMS.txt']) {
    assert.ok(existsSync(join(result.dir, file)), `${file} exists`)
  }
  assert.equal(statSync(join(result.dir, 'install-offline.sh')).mode & 0o777, 0o755)
  sh('bash', ['-n', join(result.dir, 'install-offline.sh')])
  const checksumOutput = sh('sha256sum', ['-c', 'CHECKSUMS.txt'], { cwd: result.dir })
  assert.ok(!/FAILED/.test(checksumOutput), 'sha256sum -c clean')
  const zipList = sh('unzip', ['-Z', '-l', result.zipPath])
  assert.match(zipList, /-rwxr-xr-x.*install-offline\.sh/, 'install-offline.sh 0755 inside zip')

  const ps1 = readFileSync(join(result.dir, 'install-offline.ps1'))
  assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'ps1 starts with UTF-8 BOM')
  assert.ok(ps1.includes(Buffer.from('\r\n')), 'ps1 uses CRLF')

  pass(
    'package',
    `${pluginName}@${result.version} -> ${result.zipName} (${result.sizeBytes} B, ${result.vendored.length} vendored, ${elapsed} ms)`,
  )
}

// Check the two artifacts the acceptance criteria name explicitly.
for (const pkg of results.packages) {
  assert.ok(pkg.zipName.startsWith(`${pkg.pluginName}-offline-${pkg.version}-dsh-`))
}
assert.equal(results.packages.length, 2)

writeFileSync(join(REPO_ROOT, 'test', 'a', 'selftest-results.json'), `${JSON.stringify(results, undefined, 2)}\n`)
console.log(`\nSELFTEST PASS — host ${host.dshVersion}, ${inventory.plugins.length} plugins, ${results.packages.length} offline packages in ${OUTPUT_ROOT}`)
