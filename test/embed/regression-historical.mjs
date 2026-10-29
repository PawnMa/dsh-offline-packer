/**
 * Regression: the registry/historical path must be untouched by the task-9
 * `includeHostPackages` opt-in (historical never passes it).
 *
 * Rebuilds `dsh-better-sidebar@0.13.1 -> DSH 0.1.0-rc.7` through the real
 * registry pipeline and compares the pack-generated `package/` tree against the
 * frozen v1 artifact in `test/out-b` (captured before the opt-in existed).
 * Requires network + npm (~60-90 s, warm npm cache) and writes temporary output
 * under `test/out-embed/historical-regression/`, which is removed afterwards
 * (the frozen artifact in test/out-b stays authoritative).
 *
 * Run: `node test/embed/regression-historical.mjs`
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { buildRegistryPackage } from '../../lib/historical.mjs'

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const FROZEN_DIR = join(
  REPO_ROOT,
  'test',
  'out-b',
  'dsh-better-sidebar-offline-0.13.1-dsh-0.1.0-rc.7',
)
const FROZEN_ZIP = join(
  REPO_ROOT,
  'test',
  'out-b',
  'dsh-better-sidebar-offline-0.13.1-dsh-0.1.0-rc.7.zip',
)
const OUTPUT_ROOT = join(REPO_ROOT, 'test', 'out-embed', 'historical-regression')
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

rmSync(OUTPUT_ROOT, { recursive: true, force: true })
const started = Date.now()
const logs = []
const result = await buildRegistryPackage(
  { pluginName: 'dsh-better-sidebar', version: '0.13.1', targetDshVersion: '0.1.0-rc.7' },
  {
    ctx: null,
    outputRoot: OUTPUT_ROOT,
    log: (line) => {
      logs.push(line)
      if (/内嵌依赖|打包完成|staging:/.test(line)) console.log(`[historical] ${line.slice(0, 200)}`)
    },
  },
)
const elapsed = Math.round((Date.now() - started) / 1000)

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`PASS ${label}${detail ? `: ${detail}` : ''}`)
  else {
    failures += 1
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
  }
}

check('vendored count unchanged (157)', result.vendored.length === 157, `${result.vendored.length}`)
check('target version unchanged', result.targetDshVersion === '0.1.0-rc.7')

const actual = digestTree(join(result.dir, 'package'))
check(
  'package/ tree byte-identical to frozen v1 artifact',
  actual.aggregate === BASELINE.historical.packageTree.aggregate &&
    actual.fileCount === BASELINE.historical.packageTree.fileCount,
  `${actual.fileCount} files, aggregate ${actual.aggregate.slice(0, 16)}… (baseline ${BASELINE.historical.packageTree.fileCount} files)`,
)

// Same archive shape: 12859 package files + 5 top-level documents.
const zipListing = (await import('node:child_process')).execFileSync('unzip', ['-Z1', result.zipPath], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const entries = zipListing.split('\n').filter(Boolean)
check('zip entry count unchanged (12864)', entries.length === 12864, `${entries.length}`)
check('frozen artifact still present', statSync(FROZEN_ZIP).size === BASELINE.historical.zipSize, `${FROZEN_ZIP}`)

const summary = {
  generatedAt: new Date().toISOString(),
  elapsedSeconds: elapsed,
  vendoredCount: result.vendored.length,
  zipSizeBytes: result.sizeBytes,
  packageTree: actual,
  baselineCreated: BASELINE.capturedAt,
  frozenDirPresent: FROZEN_DIR,
}
const { writeFileSync } = await import('node:fs')
writeFileSync(join(OUTPUT_ROOT, '..', 'historical-regression-summary.json'), JSON.stringify(summary, null, 2) + '\n')

// The rebuilt 47 MB staging + zip are not needed: test/out-b holds the frozen one.
rmSync(OUTPUT_ROOT, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nHISTORICAL REGRESSION FAILED (${failures} failures)`)
  process.exit(1)
}
console.log(`\nHISTORICAL REGRESSION PASS — registry path unchanged (${elapsed}s, package/ tree identical)`)
