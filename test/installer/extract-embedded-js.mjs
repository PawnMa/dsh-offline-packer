#!/usr/bin/env node
/**
 * Extract the embedded Node helper programs (heredoc blocks) from a generated
 * `install-offline.sh`, so each one can be syntax-checked with an old Node and
 * scanned for non-ES5 constructs.
 *
 * Usage: node extract-embedded-js.mjs <install-offline.sh> <out-dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [shPath, outDir] = process.argv.slice(2)
if (!shPath || !outDir) {
  console.error('usage: extract-embedded-js.mjs <install-offline.sh> <out-dir>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

const lines = readFileSync(shPath, 'utf8').split('\n')
const blocks = []
let current = null
for (const line of lines) {
  if (current === null) {
    const match = /<<'(NODE_[A-Z0-9_]+)'/.exec(line)
    if (match) current = { tag: match[1], lines: [] }
    continue
  }
  if (line.trim() === current.tag) {
    blocks.push(current)
    current = null
    continue
  }
  current.lines.push(line)
}
if (current !== null) {
  console.error(`unterminated heredoc: ${current.tag}`)
  process.exit(1)
}
for (const block of blocks) {
  writeFileSync(join(outDir, `${block.tag}.js`), `${block.lines.join('\n')}\n`)
  console.log(join(outDir, `${block.tag}.js`))
}
