/**
 * Regression: the frozen default packaging path must be unchanged by the
 * task-9 `includeHostPackages` opt-in.
 *
 * Builds the same default local packages (no `embed` options) that were used to
 * capture `baseline-default-v1.json` and compares the pack-generated
 * `package/` tree byte-for-byte (aggregate SHA-256 over sorted
 * `<sha256>  <relative path>` lines) plus the reported vendored list.
 *
 * The top-level installer/README/VERSIONS templates are excluded from the
 * comparison because `lib/scripts.mjs` is owned by task-8 and changed
 * concurrently; `VERSIONS.txt` additionally carries a generation timestamp.
 *
 * Run: `node test/embed/regression-default.mjs`
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { buildLocalPackage } from '../../lib/local.mjs'

process.env.DSH_INSTALL_DIR = process.env.DSH_INSTALL_DIR || '/home/fc/.local/lib/node_modules/@deepseek-ai/dsh'

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const OUTPUT_ROOT = join(REPO_ROOT, 'test', 'out-embed', 'regression-default')
const USER_HOME = '/home/fc/.dsh'
const BASELINE = JSON.parse(readFileSync(join(REPO_ROOT, 'test', 'embed', 'baseline-default-v1.json'), 'utf8'))

function walkFiles(root) {
  const files = []
  const stack = ['']
  while (stack.length > 0) {
    const relativeDir = stack.pop()
    const dir = relativeDir === '' ? root : join(root, relativeDir)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) stack.push(relativePath)
      else if (entry.isFile()) files.push(relativePath)
    }
  }
  return files.sort()
}

function digestTree(root) {
  const files = walkFiles(root)
  const lines = files.map(
    (file) => `${createHash('sha256').update(readFileSync(join(root, file))).digest('hex')}  ${file}`,
  )
  return {
    fileCount: files.length,
    aggregate: createHash('sha256').update(lines.join('\n')).digest('hex'),
  }
}

let failures = 0
for (const [pluginName, bundleName] of [
  ['dsh-unlag', 'dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2'],
  ['dsh-better-sidebar', 'dsh-better-sidebar-offline-0.28.1-dsh-0.2.1-rc.2'],
]) {
  const outputRoot = join(OUTPUT_ROOT, pluginName)
  rmSync(outputRoot, { recursive: true, force: true })
  const result = await buildLocalPackage(
    { pluginName, dshHome: USER_HOME },
    { ctx: null, outputRoot, log: () => {} },
  )
  const expected = BASELINE.local[bundleName]
  if (expected === undefined) {
    failures += 1
    console.error(`FAIL baseline missing for ${bundleName}`)
    continue
  }
  const actual = digestTree(join(result.dir, 'package'))
  const treeOk = actual.aggregate === expected.packageTree.aggregate && actual.fileCount === expected.packageTree.fileCount
  const vendoredOk = JSON.stringify(result.vendored) === JSON.stringify(expected.vendored)
  if (treeOk && vendoredOk) {
    console.log(
      `PASS ${pluginName}: default package/ tree identical to v1 baseline (${actual.fileCount} files, aggregate ${actual.aggregate.slice(0, 16)}…), vendored=${JSON.stringify(result.vendored)}`,
    )
  } else {
    failures += 1
    console.error(
      `FAIL ${pluginName}: treeOk=${treeOk} (${actual.fileCount}/${expected.packageTree.fileCount}) vendored actual=${JSON.stringify(result.vendored)} expected=${JSON.stringify(expected.vendored)}`,
    )
  }
  // Keep only the zip/staging as evidence but drop nothing: report references both.
  if (!existsSync(result.zipPath)) {
    failures += 1
    console.error(`FAIL ${pluginName}: zip missing`)
  }
}

if (failures > 0) {
  console.error(`\nDEFAULT REGRESSION FAILED (${failures} failures)`)
  process.exit(1)
}
console.log('\nDEFAULT REGRESSION PASS — frozen default path unchanged (package/ tree + vendored list)')
