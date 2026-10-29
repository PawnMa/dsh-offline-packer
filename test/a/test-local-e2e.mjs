/**
 * End-to-end local packaging test without touching the real user home.
 *
 * Builds a throwaway DSH home whose `web` profile installs a fixture plugin.
 * That plugin statically imports one host-provided package (`ws`) and one
 * private package (`vendor-dep-a`, which itself depends on `vendor-dep-b` and a
 * symlinked package). The test runs `buildLocalPackage` end-to-end and asserts:
 *
 *   - the plugin is discovered by the filesystem inventory fallback;
 *   - the host-provided package is NOT vendored, the private closure IS;
 *   - the produced package has `dependencies: {}` and optional peers;
 *   - the zip is valid and its manifest/CHECKSUMS/installers are present.
 *
 * Run: `node test/a/test-local-e2e.mjs`
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { buildLocalPackage } from '../../lib/local.mjs'

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const OUTPUT_ROOT = join(REPO_ROOT, 'test', 'out-a', '_e2e')
const root = await mkdtemp(join(tmpdir(), 'offline-packer-local-e2e-'))

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

async function writePackage(dir, manifest, files = { 'index.js': 'export default 1\n' }) {
  await writeJson(join(dir, 'package.json'), manifest)
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
}

try {
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'web')
  const pluginDir = join(profileDir, 'node_modules', 'fixture-plugin')
  await writeJson(join(profileDir, 'package.json'), {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'fixture-plugin': '1.2.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'fixture-plugin'] } },
  })
  await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')

  await writePackage(
    pluginDir,
    {
      name: 'fixture-plugin',
      version: '1.2.3',
      description: 'fixture plugin for the offline packager self test',
      main: 'lib/index.js',
      exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' }, './client': './lib/client.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', immediately: true, inject: [] } },
      dependencies: { 'vendor-dep-a': '1.0.0', ws: '^8.0.0' },
      peerDependencies: { '@deepseek-ai/dsh-tools': '*' },
    },
    {
      'lib/index.js': "import { WebSocketServer } from 'ws'\nimport depA from 'vendor-dep-a'\nexport const name = 'fixture-plugin'\nexport { WebSocketServer, depA }\n",
      'lib/client.js': 'export default 1\n',
      'cordis.patch.yml': "- insert:\n    - id: fixture-plugin\n      name: 'fixture-plugin'\n",
    },
  )
  // Private dependency closure, including a symlinked second-level package.
  await writePackage(join(pluginDir, 'node_modules', 'vendor-dep-a'), {
    name: 'vendor-dep-a',
    version: '1.0.0',
    dependencies: { 'vendor-dep-b': '2.0.0', 'vendor-dep-linked': '3.0.0' },
  })
  await writePackage(join(pluginDir, 'node_modules', 'vendor-dep-b'), { name: 'vendor-dep-b', version: '2.0.0' })
  const linkedTarget = join(root, 'vendor-dep-linked-real')
  await writePackage(linkedTarget, { name: 'vendor-dep-linked', version: '3.0.0' })
  await symlink(linkedTarget, join(pluginDir, 'node_modules', 'vendor-dep-linked'))

  const logs = []
  const result = await buildLocalPackage(
    { pluginName: 'fixture-plugin', dshHome: home, profile: 'web' },
    { ctx: null, outputRoot: OUTPUT_ROOT, log: (line) => logs.push(line) },
  )

  assert.equal(result.pluginName, 'fixture-plugin')
  assert.equal(result.version, '1.2.3')
  assert.equal(result.mode, 'local')
  assert.ok(result.zipPath.endsWith('.zip') && existsSync(result.zipPath), 'zip produced')
  assert.ok(result.sizeBytes > 0)

  const packageDir = join(result.dir, 'package')
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, {}, 'dependencies emptied')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], '*', 'peer list preserved')
  assert.deepEqual(manifest.peerDependenciesMeta, { '@deepseek-ai/dsh-tools': { optional: true } }, 'peers optional')
  assert.ok(manifest.dsh.bundle.patch === './cordis.patch.yml', 'dsh block preserved')

  assert.ok(existsSync(join(packageDir, 'node_modules', 'vendor-dep-a', 'package.json')), 'private dep vendored')
  assert.ok(existsSync(join(packageDir, 'node_modules', 'vendor-dep-b', 'package.json')), 'transitive dep vendored')
  assert.ok(existsSync(join(packageDir, 'node_modules', 'vendor-dep-linked', 'package.json')), 'symlinked dep vendored')
  assert.ok(!existsSync(join(packageDir, 'node_modules', 'ws')), 'host-provided package (ws) is not vendored')
  assert.ok(
    !existsSync(join(packageDir, 'node_modules', '@deepseek-ai')),
    'host package namespace is not vendored',
  )

  for (const file of ['install-offline.sh', 'install-offline.ps1', 'README.md', 'VERSIONS.txt', 'CHECKSUMS.txt']) {
    assert.ok(existsSync(join(result.dir, file)), `${file} written`)
  }
  assert.ok(result.vendored.some((entry) => entry.startsWith('vendor-dep-a@1.0.0')), 'result.vendored lists private dep')
  assert.ok(!result.vendored.some((entry) => entry.startsWith('ws@')), 'result.vendored excludes host dep')

  // The archive itself must be a valid zip and contain the expected root folder.
  const unzipTest = execFileSync('unzip', ['-t', result.zipPath], { encoding: 'utf8' })
  assert.match(unzipTest, /No errors detected/)
  const listing = execFileSync('unzip', ['-Z1', result.zipPath], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const rootName = result.zipName.replace(/\.zip$/, '')
  for (const entry of [
    `${rootName}/package/package.json`,
    `${rootName}/install-offline.sh`,
    `${rootName}/CHECKSUMS.txt`,
  ]) {
    assert.ok(listing.includes(entry), `zip contains ${entry}`)
  }

  // CHECKSUMS must verify from inside the staging directory (paths are ./relative).
  const checksumOutput = execFileSync('sha256sum', ['-c', 'CHECKSUMS.txt'], { cwd: result.dir, encoding: 'utf8' })
  assert.ok(!/FAILED/.test(checksumOutput), 'checksums verify')
  const expected = createHash('sha256').update(readFileSync(join(result.dir, 'package', 'package.json'))).digest('hex')
  assert.ok(readFileSync(join(result.dir, 'CHECKSUMS.txt'), 'utf8').includes(expected), 'package.json checksum present')

  // install-offline.sh must keep the executable bit inside the staging tree and the zip.
  const mode = (await import('node:fs/promises')).stat
  assert.ok(((await mode(join(result.dir, 'install-offline.sh'))).mode & 0o777) === 0o755, 'install-offline.sh is 0755')
  const unzipList = execFileSync('unzip', ['-Z', '-l', result.zipPath], { encoding: 'utf8' })
  assert.match(unzipList, new RegExp(`-rwxr-xr-x.*install-offline\\.sh`), 'zip stores install-offline.sh as 0755')

  console.log(`PASS test-local-e2e: zip=${result.zipName} (${result.sizeBytes} B)`)
  console.log(`PASS test-local-e2e: vendored = ${result.vendored.join(', ') || '(none)'}`)
  console.log(`PASS test-local-e2e: warnings = ${result.warnings.length}`)
  console.log(`PASS test-local-e2e: log lines = ${logs.length}`)
} finally {
  await rm(root, { recursive: true, force: true })
  if (process.env.KEEP_OUTPUT !== '1') await rm(OUTPUT_ROOT, { recursive: true, force: true })
}
