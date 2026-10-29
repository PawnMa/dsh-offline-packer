/**
 * Unit test for lib/vendor.mjs.
 *
 * Builds a throwaway fixture plugin in the OS temp dir that exercises: flat
 * copying, nested-first resolution, duplicate/conflict handling, dependency
 * cycles, symlinked packages (dereferenced), host-provided skips and missing
 * packages. Run: `node test/a/test-vendor.mjs`
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { vendorExternals } from '../../lib/vendor.mjs'

const root = await mkdtemp(join(tmpdir(), 'offline-packer-vendor-test-'))

async function writePackage(dir, manifest, files = { 'index.js': 'export default 1\n' }) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
}

try {
  const plugin = join(root, 'plugin')
  await writePackage(plugin, {
    name: 'fixture-plugin',
    version: '1.0.0',
    main: 'index.js',
    dependencies: { 'dep-a': '1.0.0' },
  })
  await writeFile(join(plugin, 'index.js'), "import a from 'dep-a'\nexport default a\n")

  // dep-a 1.0.0 needs dep-b and dep-shared; its own nested dep-shared@2.0.0 must win.
  await writePackage(join(plugin, 'node_modules', 'dep-a'), {
    name: 'dep-a',
    version: '1.0.0',
    dependencies: { 'dep-b': '1.0.0', 'dep-shared': '1.0.0' },
  })
  await writePackage(join(plugin, 'node_modules', 'dep-a', 'node_modules', 'dep-shared'), {
    name: 'dep-shared',
    version: '2.0.0',
  })
  // dep-b -> dep-c -> dep-b cycle.
  await writePackage(join(plugin, 'node_modules', 'dep-b'), {
    name: 'dep-b',
    version: '1.0.0',
    dependencies: { 'dep-c': '1.0.0' },
  })
  await writePackage(join(plugin, 'node_modules', 'dep-c'), {
    name: 'dep-c',
    version: '1.0.0',
    dependencies: { 'dep-b': '1.0.0' },
  })
  // A package only reachable through a symlink must be copied as real files.
  const linkedTarget = join(root, 'linked-target')
  await writePackage(linkedTarget, { name: 'linked-pkg', version: '3.0.0' })
  await symlink(linkedTarget, join(plugin, 'node_modules', 'linked-pkg'))

  const destNodeModules = join(root, 'out', 'node_modules')
  const result = await vendorExternals({
    pluginDir: plugin,
    packages: ['dep-a', 'dep-b', 'linked-pkg', 'host-only', 'missing-pkg'],
    hostProvided: ['host-only', 'ws', 'yaml'],
    destNodeModules,
    log: () => {},
  })

  const names = result.vendored.map((entry) => entry.name)
  const versions = Object.fromEntries(result.vendored.map((entry) => [entry.name, entry.version]))
  assert.ok(names.includes('dep-a'), 'dep-a is vendored')
  assert.ok(names.includes('dep-b'), 'dep-b is vendored')
  assert.ok(names.includes('dep-c'), 'dep-c is vendored')
  assert.ok(names.includes('dep-shared'), 'dep-shared is vendored')
  assert.equal(versions['dep-shared'], '2.0.0', 'nested dep-shared@2.0.0 wins (Node resolution order)')
  assert.ok(names.includes('linked-pkg'), 'symlinked package is vendored')
  assert.equal(versions['linked-pkg'], '3.0.0')
  assert.ok(!names.includes('host-only'), 'host-provided package is not vendored')
  assert.ok(!names.includes('missing-pkg'), 'missing package is not vendored')
  assert.ok(
    result.skipped.some((entry) => entry.name === 'host-only' && entry.reason === 'host'),
    'host skip recorded',
  )
  assert.ok(
    result.skipped.some((entry) => entry.name === 'missing-pkg' && entry.reason === 'not-found'),
    'missing skip recorded',
  )
  assert.ok(result.warnings.some((warning) => warning.includes('missing-pkg')), 'missing package warning recorded')
  assert.ok(
    result.skipped.some((entry) => entry.reason === 'duplicate' || entry.reason === 'visited'),
    'cycle / duplicate handled without infinite recursion',
  )

  for (const name of ['dep-a', 'dep-b', 'dep-c', 'dep-shared', 'linked-pkg']) {
    assert.ok(existsSync(join(destNodeModules, name, 'package.json')), `${name} materialised on disk`)
  }
  assert.ok(
    !existsSync(join(destNodeModules, 'dep-a', 'node_modules')),
    'nested node_modules are flattened away, not duplicated',
  )
  assert.equal(JSON.parse(readFileSync(join(destNodeModules, 'dep-shared', 'package.json'), 'utf8')).version, '2.0.0')

  console.log('PASS test-vendor: vendored =', names.join(', '))
  console.log('PASS test-vendor: skipped  =', result.skipped.map((entry) => `${entry.name}:${entry.reason}`).join(', '))
  console.log('PASS test-vendor: warnings =', result.warnings.length)
} finally {
  await rm(root, { recursive: true, force: true })
}
