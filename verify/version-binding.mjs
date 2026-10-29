#!/usr/bin/env node
/**
 * Delta5 (v0.1.4) browser check: target-driven version-binding UX in the
 * 「离线打包」→ plugin → "Version history…" matrix panel.
 *
 *   node verify/version-binding.mjs --port 3084 --scan-home /home/fc/.dsh \
 *        --plugin dsh-better-sidebar --target 0.1.0-rc.7 \
 *        --out verify/artifacts/delta5 --json verify/artifacts/delta5/history.json
 *
 * Assertions:
 *  - matrix panel opens and loads rows from the npm registry
 *  - default target == host DSH version; only data-compatible=yes rows visible;
 *    filter note shows "Versions compatible with <target>: n/total"; selected
 *    plugin version == newest compatible version
 *  - after setting the target to <target>: filter note n/total (expected
 *    11/36 for dsh-better-sidebar -> 0.1.0-rc.7), rows all compatible, selected
 *    version == 0.13.1, selected-version DSH chips include the target
 *  - filter toggle: show all -> full row count incl. data-compatible=no rows;
 *    toggle back -> compatible-only rows again
 *  - no console errors / page errors
 *
 * Exit: 0 PASS, 1 FAIL, 2 setup error.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PW_DIR = process.env.PLAYWRIGHT_DIR ?? '/home/fc/dsh-plugin-build/leadcheck/pw'
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`

const opts = {
  port: 3084,
  base: '',
  scanHome: '/home/fc/.dsh',
  plugin: 'dsh-better-sidebar',
  target: '0.1.0-rc.7',
  outDir: join(HERE, 'artifacts', 'delta5'),
  jsonOut: '',
  timeoutMs: 60000,
}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  const next = () => argv[++i]
  switch (a) {
    case '--port': opts.port = Number(next()); break
    case '--base': opts.base = next(); break
    case '--scan-home': opts.scanHome = next(); break
    case '--plugin': opts.plugin = next(); break
    case '--target': opts.target = next(); break
    case '--out': opts.outDir = resolve(next()); break
    case '--json': opts.jsonOut = resolve(next()); break
    case '--timeout': opts.timeoutMs = Number(next()); break
    case '-h': case '--help':
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''))
      process.exit(0)
    default: console.error(`unknown argument: ${a}`); process.exit(2)
  }
}

function readHostBase(port) {
  const envFile = join(HERE, 'run', `host-${port}.env`)
  if (!existsSync(envFile)) return ''
  const m = readFileSync(envFile, 'utf8').match(/^BASE=(.*)$/m)
  return m ? m[1].trim() : ''
}
const base = opts.base || readHostBase(opts.port)
if (!base) { console.error(`[fatal] no base URL for port ${opts.port}; boot with verify/setup-host.sh`); process.exit(2) }
if (!existsSync(CHROMIUM_BIN)) { console.error(`[fatal] chromium not found: ${CHROMIUM_BIN}`); process.exit(2) }

let chromium
try {
  const require = createRequire(join(PW_DIR, 'package.json'))
  ;({ chromium } = require('playwright-core'))
} catch (error) {
  console.error(`[fatal] cannot load playwright-core from ${PW_DIR}: ${error.message}`)
  process.exit(2)
}

mkdirSync(opts.outDir, { recursive: true })
const shot = (name) => join(opts.outDir, name)
const result = {
  base, scanHome: opts.scanHome, plugin: opts.plugin, target: opts.target,
  startedAt: new Date().toISOString(),
  steps: [], screenshots: [], consoleErrors: [], pageErrors: [], assertions: [],
  matrix: {},
}
const record = (name, ok, detail = '') => {
  result.assertions.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`)
}
const wait = (ms) => page.waitForTimeout(ms)
const browser = await chromium.launch({ executablePath: CHROMIUM_BIN, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
const page = await context.newPage()
page.on('console', (msg) => {
  if (msg.type() !== 'error') return
  const text = msg.text()
  if (/favicon\.ico/i.test(text)) return
  result.consoleErrors.push(text)
})
page.on('pageerror', (error) => result.pageErrors.push(String(error)))

async function snap(name) {
  const path = shot(name)
  await page.screenshot({ path, fullPage: true })
  result.screenshots.push(path)
  console.log(`      screenshot: ${path}`)
}
async function clickFirstLabelled(labels, timeout = 4000) {
  for (const label of labels) {
    const loc = page.getByText(label, { exact: false }).first()
    try { if ((await loc.count()) > 0) { await loc.click({ timeout }); return label } } catch { /* next */ }
  }
  return ''
}
async function matrixState() {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="offline-packer-matrix-row"]')]
      .map((el) => ({ version: el.getAttribute('data-version') ?? '', compatible: el.getAttribute('data-compatible') ?? '' }))
    const note = document.querySelector('[data-testid="offline-packer-matrix-filter-note"]')
    const select = document.querySelector('[data-testid="offline-packer-version-select"]')
    const targetInput = document.querySelector('[data-testid="offline-packer-target-dsh"]')
    const chips = [...document.querySelectorAll('[data-testid="offline-packer-selected-dsh-version"]')].map((el) => (el.innerText || '').trim())
    const toggle = document.querySelector('[data-testid="offline-packer-matrix-filter-toggle"]')
    return {
      rows,
      note: note ? (note.innerText || '').trim() : null,
      selected: select ? select.value : null,
      target: targetInput ? targetInput.value : null,
      chips,
      toggleLabel: toggle ? (toggle.innerText || '').trim() : null,
    }
  })
}
async function dismissOverlays() {
  // Preview Notice / Get started modals appear with a delay and block clicks.
  for (let i = 0; i < 15; i += 1) {
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /Preview Notice|Get started|Sign in to your DeepSeek/ }).first()
    if ((await dialog.count()) === 0) return true
    const btn = dialog.getByRole('button', { name: /^(Continue|Close)$/ }).first()
    if ((await btn.count()) > 0) await btn.click({ timeout: 2500 }).catch(() => {})
    else await page.keyboard.press('Escape').catch(() => {})
    await wait(700)
  }
  return false
}
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await wait(200)
  }
  console.log(`WARN  timeout waiting for ${label}`)
  return false
}

try {
  console.log(`[version-binding] base=${base} scanHome=${opts.scanHome} plugin=${opts.plugin}`)
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs })
  await page.waitForLoadState('networkidle', { timeout: opts.timeoutMs }).catch(() => {})
  await wait(2500)
  await snap('01-landing.png')
  record('page loaded', (await page.title()).includes('DeepSeek'))

  // dismiss onboarding / preview-notice overlays (may appear with a delay)
  await dismissOverlays()
  await wait(500)
  await dismissOverlays()

  // Settings -> Offline Packager
  const menu = page.getByRole('button', { name: 'Account menu' }).first()
  if ((await menu.count()) > 0) { await menu.click().catch(() => {}); await wait(800) }
  await clickFirstLabelled(['Settings', '设置'], 4000)
  await wait(1500)
  await snap('02-settings.png')
  await clickFirstLabelled(['Offline Packager', '离线打包'], 4000)
  await wait(1500)

  // scan the requested home
  const homeInput = page.locator('[data-testid="offline-packer-home-input"]').first()
  if ((await homeInput.count()) > 0) {
    await homeInput.click(); await homeInput.fill(opts.scanHome)
    const profileInput = page.locator('[data-testid="offline-packer-profile-input"]').first()
    if ((await profileInput.count()) > 0) await profileInput.fill('web')
    const refresh = page.locator('[data-testid="offline-packer-refresh"]').first()
    if ((await refresh.count()) > 0) await refresh.click()
    await waitFor(async () => (await page.locator('[data-testid="offline-packer-row"]').count()) > 0, 25000, 'plugin rows')
  }
  await wait(1000)
  await snap('03-offline-packer.png')
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="offline-packer-row"]')].map((el) => el.getAttribute('data-plugin-name')))
  record('plugin list loaded', rows.includes(opts.plugin), `rows=${rows.length} hasPlugin=${rows.includes(opts.plugin)}`)

  // open history for the plugin
  const card = page.locator(`[data-testid="offline-packer-row"][data-plugin-name="${opts.plugin}"]`).first()
  const historyBtn = card.locator('[data-testid="offline-packer-history-toggle"]').first()
  record('history toggle present', (await historyBtn.count()) > 0)
  await historyBtn.click({ timeout: 5000 })
  const loaded = await waitFor(async () => (await page.locator('[data-testid="offline-packer-matrix-row"]').count()) > 0, 60000, 'matrix rows (registry)')
  await wait(800)
  record('matrix loaded from registry', loaded, `rows=${await page.locator('[data-testid="offline-packer-matrix-row"]').count()}`)
  await snap('04-history-default.png')

  // host version from the app's own API
  const hostVersion = await page.evaluate(async () => {
    const res = await fetch('/dsh-offline-packer/api/state')
    const body = await res.json()
    return body?.value?.host?.dshVersion ?? ''
  }).catch(() => '')
  result.matrix.hostVersion = hostVersion

  const initial = await matrixState()
  result.matrix.initial = initial
  record('default target == host DSH version', initial.target === hostVersion && hostVersion !== '', `target=${initial.target} host=${hostVersion}`)
  const m0 = (initial.note ?? '').match(/(\d+)\/(\d+)/)
  record('default filter note present (n/total)', initial.note !== null && m0 !== null, `note=${initial.note}`)
  record('default visible rows are all compatible', initial.rows.length > 0 && initial.rows.every((r) => r.compatible === 'yes'), `rows=${initial.rows.length} compat=${[...new Set(initial.rows.map((r) => r.compatible))].join(',')}`)
  record('default filter numerator == visible row count', m0 !== null && Number(m0[1]) === initial.rows.length, `note=${m0 ? `${m0[1]}/${m0[2]}` : 'n/a'} rows=${initial.rows.length}`)
  result.matrix.defaultCompatible = m0 ? { n: Number(m0[1]), total: Number(m0[2]) } : null
  record('default selected version == newest compatible', initial.selected !== null && initial.selected === (initial.rows[0]?.version ?? ''), `selected=${initial.selected} newest=${initial.rows[0]?.version}`)
  result.matrix.defaultSelected = initial.selected

  // change target -> 0.1.0-rc.7
  const targetInput = page.locator('[data-testid="offline-packer-target-dsh"]').first()
  await targetInput.click(); await targetInput.fill(opts.target)
  await waitFor(async () => {
    const s = await matrixState()
    return s.note !== null && s.note.includes(opts.target)
  }, 15000, 'target filter note update')
  await wait(1200)
  await snap('05-history-target-rc7.png')
  const afterTarget = await matrixState()
  result.matrix.afterTarget = afterTarget
  const m1 = (afterTarget.note ?? '').match(/(\d+)\/(\d+)/)
  record('target filter note reflects new target', afterTarget.note !== null && afterTarget.note.includes(opts.target), `note=${afterTarget.note}`)
  record('target = 0.1.0-rc.7 filters to 11/36', m1 !== null && Number(m1[1]) === 11 && Number(m1[2]) === 36, `note=${afterTarget.note}`)
  record('filtered rows are all compatible', afterTarget.rows.length === 11 && afterTarget.rows.every((r) => r.compatible === 'yes'), `rows=${afterTarget.rows.length}`)
  record('selected version becomes 0.13.1', afterTarget.selected === '0.13.1', `selected=${afterTarget.selected}`)
  record('selected-version DSH chips contain target', afterTarget.chips.includes(opts.target), `chips=${JSON.stringify(afterTarget.chips)}`)
  record('selected-version DSH chips contain 0.1.0-rc.8 (multi-value range)', afterTarget.chips.includes('0.1.0-rc.8'), `chips=${JSON.stringify(afterTarget.chips)}`)

  // show all versions
  const toggle = page.locator('[data-testid="offline-packer-matrix-filter-toggle"]').first()
  await toggle.click({ timeout: 5000 })
  await waitFor(async () => (await page.locator('[data-testid="offline-packer-matrix-row"]').count()) === 36, 15000, 'all 36 rows')
  await wait(600)
  await snap('06-history-all.png')
  const all = await matrixState()
  result.matrix.all = { rows: all.rows.length, incompatible: all.rows.filter((r) => r.compatible === 'no').length, note: all.note, toggleLabel: all.toggleLabel }
  record('show-all lists all 36 versions', all.rows.length === 36, `rows=${all.rows.length}`)
  record('show-all includes data-compatible=no rows', all.rows.some((r) => r.compatible === 'no'), `no=${all.rows.filter((r) => r.compatible === 'no').length} unknown=${all.rows.filter((r) => r.compatible === 'unknown').length}`)
  record('show-all hides the compatible filter note', all.note === null, `note=${all.note}`)
  record('show-all toggle label flips to "Show compatible only"', /compatible only|只看兼容/i.test(all.toggleLabel ?? ''), `label=${all.toggleLabel}`)

  // back to compatible-only
  await toggle.click({ timeout: 5000 })
  await waitFor(async () => (await page.locator('[data-testid="offline-packer-matrix-row"]').count()) === 11, 15000, '11 compatible rows again')
  await wait(500)
  await snap('07-history-compatible-only.png')
  const back = await matrixState()
  result.matrix.back = { rows: back.rows.length, note: back.note }
  record('toggle back restores compatible-only rows', back.rows.length === 11 && back.rows.every((r) => r.compatible === 'yes'), `rows=${back.rows.length} note=${back.note}`)

  record('no page errors', result.pageErrors.length === 0, result.pageErrors.slice(0, 3).join(' | '))
  record('no console errors', result.consoleErrors.length === 0, result.consoleErrors.slice(0, 3).join(' | '))
} catch (error) {
  result.error = String(error?.stack ?? error)
  result.verdict = 'ERROR'
  console.error(`[fatal] ${error?.stack ?? error}`)
  try { await page.screenshot({ path: shot('99-error.png'), fullPage: true }) } catch {}
} finally {
  await browser.close().catch(() => {})
}

const failed = result.assertions.filter((a) => !a.ok)
result.verdict = failed.length === 0 ? 'PASS' : 'FAIL'
result.finishedAt = new Date().toISOString()
if (opts.jsonOut) writeFileSync(opts.jsonOut, `${JSON.stringify(result, null, 2)}\n`)
console.log('')
console.log(`VERSION_BINDING=${result.verdict} assertions=${result.assertions.length} failed=${failed.length}`)
console.log(`screenshots: ${result.screenshots.join(', ')}`)
process.exit(result.verdict === 'PASS' ? 0 : 1)
