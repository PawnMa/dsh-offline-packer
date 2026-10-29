/**
 * Unit test for the extra-vendor filter of lib/pack.mjs (registry-mode shape).
 *
 * `assembleOfflinePackage` must copy third-party packages from an already
 * resolved `node_modules` tree, keep nested `node_modules` (conflicting
 * versions), and skip everything the host provides: `@deepseek-ai/*`, `react*`,
 * `cordis`, declared peers and the plugin package itself.
 *
 * Run: `node test/a/test-pack-filter.mjs`
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assembleOfflinePackage } from '../../lib/pack.mjs'

// Keep the phase-1 regression baselines stable: this sandbox's
// /home/fc/.dsh profile fallback currently points at a different (host-pinned
// rc.7) installation, so pin the real running 0.2.1-rc.2 host explicitly.
process.env.DSH_INSTALL_DIR = process.env.DSH_INSTALL_DIR || '/home/fc/.local/lib/node_modules/@deepseek-ai/dsh'

const root = await mkdtemp(join(tmpdir(), 'offline-packer-pack-filter-'))

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
  const srcDir = join(root, 'src', 'my-plugin')
  await writePackage(srcDir, {
    name: 'my-plugin',
    version: '2.0.0',
    main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@huanlin/dsh-plugin-better-locale': '^0.1.0' },
    optionalDependencies: { 'native-thing': '^1.0.0' },
  })

  const extraVendorDir = join(root, 'resolved', 'node_modules')
  // Must be skipped.
  await writePackage(join(extraVendorDir, '@deepseek-ai', 'dsh-tools'), { name: '@deepseek-ai/dsh-tools', version: '0.2.1' })
  await writePackage(join(extraVendorDir, 'react'), { name: 'react', version: '18.0.0' })
  await writePackage(join(extraVendorDir, 'react-dom'), { name: 'react-dom', version: '18.0.0' })
  await writePackage(join(extraVendorDir, 'cordis'), { name: 'cordis', version: '4.0.0' })
  await writePackage(join(extraVendorDir, '@huanlin', 'dsh-plugin-better-locale'), {
    name: '@huanlin/dsh-plugin-better-locale',
    version: '0.1.0',
  })
  await writePackage(join(extraVendorDir, 'my-plugin'), { name: 'my-plugin', version: '2.0.0' })
  // Must be copied, including a nested conflicting dependency.
  await writePackage(join(extraVendorDir, 'real-lib'), {
    name: 'real-lib',
    version: '1.0.0',
    dependencies: { 'nested-dep': '2.0.0' },
  })
  await writePackage(join(extraVendorDir, 'real-lib', 'node_modules', 'nested-dep'), {
    name: 'nested-dep',
    version: '2.0.0',
  })
  await writePackage(join(extraVendorDir, 'another-lib'), { name: 'another-lib', version: '3.0.0' })

  const outputRoot = join(root, 'out')
  const result = await assembleOfflinePackage({
    srcDir,
    pluginName: 'my-plugin',
    version: '2.0.0',
    description: 'filter test',
    peerDsh: '^0.2.1-rc.1',
    targetDshVersion: '0.2.1-rc.2',
    mode: 'registry',
    extraVendorDir,
    outputRoot,
    log: () => {},
    warnings: ['pre-existing warning'],
    vendored: ['real-lib@1.0.0', 'another-lib@3.0.0', 'nested-dep@2.0.0'],
  })

  const packageDir = join(result.dir, 'package')
  const nodeModules = join(packageDir, 'node_modules')
  for (const kept of ['real-lib', 'another-lib']) {
    assert.ok(existsSync(join(nodeModules, kept, 'package.json')), `${kept} copied`)
  }
  assert.ok(
    existsSync(join(nodeModules, 'real-lib', 'node_modules', 'nested-dep', 'package.json')),
    'nested node_modules preserved inside a copied package',
  )
  for (const skipped of [
    join('@deepseek-ai', 'dsh-tools'),
    'react',
    'react-dom',
    'cordis',
    join('@huanlin', 'dsh-plugin-better-locale'),
    'my-plugin',
  ]) {
    assert.ok(!existsSync(join(nodeModules, skipped)), `${skipped} skipped`)
  }
  assert.ok(!existsSync(join(nodeModules, '.bin')), '.bin skipped')

  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, {})
  assert.equal(manifest.optionalDependencies, undefined, 'optionalDependencies removed')
  assert.equal(manifest.peerDependenciesMeta['@huanlin/dsh-plugin-better-locale'].optional, true)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'dsh block preserved')

  assert.equal(result.mode, 'registry')
  assert.deepEqual(result.vendored, ['real-lib@1.0.0', 'another-lib@3.0.0', 'nested-dep@2.0.0'])
  assert.deepEqual(result.warnings, ['pre-existing warning'])
  assert.ok(existsSync(result.zipPath))
  console.log(`PASS test-pack-filter: ${result.zipName} (${result.sizeBytes} B), vendored=${result.vendored.join(', ')}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
