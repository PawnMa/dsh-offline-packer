#!/usr/bin/env node
/**
 * Regenerate the real offline packages used by run-installer-tests.sh with the
 * *current* lib/scripts.mjs (installer templates live in that file, so a stale
 * zip would test the old installer).
 *
 *   - dsh-unlag (local channel, no @deepseek-ai/dsh* peers)   -> compat check "skip"
 *   - dsh-better-sidebar@0.22.1 (registry/historical channel,
 *     peer ^0.1.7-rc.1)                                      -> compat check pass/fail
 *
 * Output: test/out-installer/*.zip (gitignored). Read-only w.r.t. the real
 * /home/fc/.dsh: the local channel only scans the installed plugin.
 *
 * Usage: node test/installer/build-fixtures.mjs [outputRoot]
 */
import { buildLocalPackage } from '../../lib/local.mjs'
import { buildRegistryPackage } from '../../lib/historical.mjs'

const outputRoot = process.argv[2] ?? new URL('../out-installer/', import.meta.url).pathname

const local = await buildLocalPackage(
  { pluginName: 'dsh-unlag', dshHome: '/home/fc/.dsh', profile: 'web', targetDshVersion: '0.2.1-rc.2' },
  { ctx: null, outputRoot, log: (line) => console.log('[local]', line) },
)
console.log('LOCAL_RESULT', JSON.stringify({ zipPath: local.zipPath, sizeBytes: local.sizeBytes }))

const registry = await buildRegistryPackage(
  { pluginName: 'dsh-better-sidebar', version: '0.22.1', targetDshVersion: '0.1.7-rc.2' },
  { ctx: null, outputRoot, log: (line) => console.log('[registry]', line) },
)
console.log('REGISTRY_RESULT', JSON.stringify({ zipPath: registry.zipPath, sizeBytes: registry.sizeBytes }))
