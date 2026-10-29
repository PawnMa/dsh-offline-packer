#!/usr/bin/env node
/**
 * v0.1.5 UI verification (delta6):
 *   A) 「高级打包选项」: expand, extraPackages=yaml, custom output dir, build
 *      dsh-unlag, progress, result panel with offline-packer-result-vendored.
 *   B) 「手动指定宿主」override: fill install dir + version, apply, host info
 *      switches to source=override; persists across a page reload; clear restores
 *      auto detection.
 *   C) no console/page errors.
 *
 *   node verify/v15-ui.mjs --port 3084 --scan-home /home/fc/.dsh \
 *        --plugin dsh-unlag --output-dir /home/fc/dsh-offline-packer/verify/tmp/delta6-ui-out \
 *        --out verify/artifacts/delta6 --json verify/artifacts/delta6/ui-v15.json
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
  plugin: 'dsh-unlag',
  outputDir: join(HERE, 'tmp', 'delta6-ui-out'),
  outDir: join(HERE, 'artifacts', 'delta6'),
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
    case '--output-dir': opts.outputDir = next(); break
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
if (!base) { console.error(`[fatal] no base URL for port ${opts.port}`); process.exit(2) }
if (!existsSync(CHROMIUM_BIN)) { console.error(`[fatal] chromium not found: ${CHROMIUM_BIN}`); process.exit(2) }
let chromium
try {
  const require = createRequire(join(PW_DIR, 'package.json'))
  ;({ chromium } = require('playwright-core'))
} catch (error) { console.error(`[fatal] playwright-core: ${error.message}`); process.exit(2) }

mkdirSync(opts.outDir, { recursive: true })
const shot = (name) => join(opts.outDir, name)
const result = {
  base, scanHome: opts.scanHome, plugin: opts.plugin, outputDir: opts.outputDir,
  startedAt: new Date().toISOString(), steps: [], screenshots: [], consoleErrors: [], pageErrors: [], assertions: [],
  embed: {}, override: {},
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
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await wait(200)
  }
  console.log(`WARN  timeout waiting for ${label}`)
  return false
}
async function dismissOverlays() {
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
async function openPacker() {
  await dismissOverlays()
  await wait(400)
  await dismissOverlays()
  const menu = page.getByRole('button', { name: 'Account menu' }).first()
  if ((await menu.count()) > 0) { await menu.click().catch(() => {}); await wait(800) }
  const settings = page.getByText('Settings', { exact: true }).first()
  if ((await settings.count()) > 0) { await settings.click().catch(() => {}); await wait(1500) }
  const nav = page.getByText(/Offline Packager|离线打包/, { exact: false }).first()
  if ((await nav.count()) > 0) { await nav.click().catch(() => {}); await wait(1800) }
}
async function scanHome() {
  const homeInput = page.locator('[data-testid="offline-packer-home-input"]').first()
  if ((await homeInput.count()) === 0) return false
  await homeInput.click(); await homeInput.fill(opts.scanHome)
  const refresh = page.locator('[data-testid="offline-packer-refresh"]').first()
  if ((await refresh.count()) > 0) await refresh.click()
  return waitFor(async () => (await page.locator('[data-testid="offline-packer-row"]').count()) > 0, 25000, 'plugin rows')
}
async function hostSnapshot() {
  return page.evaluate(() => {
    const source = document.querySelector('[data-testid="offline-packer-host-source"]')
    const version = document.querySelector('[data-testid="offline-packer-host-version"]')
    return {
      sourceText: source ? (source.innerText || '').trim() : null,
      sourceData: source ? source.getAttribute('data-host-source') : null,
      versionText: version ? (version.innerText || '').trim() : null,
    }
  })
}

try {
  console.log(`[v15-ui] base=${base} scanHome=${opts.scanHome}`)
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs })
  await page.waitForLoadState('networkidle', { timeout: opts.timeoutMs }).catch(() => {})
  await wait(2500)
  await snap('01-landing.png')
  record('page loaded', (await page.title()).includes('DeepSeek'))

  await openPacker()
  await snap('02-settings.png')
  const rowsOk = await scanHome()
  await wait(1000)
  await snap('03-packer-scanned.png')
  record('plugin list loaded', rowsOk, `rows=${await page.locator('[data-testid="offline-packer-row"]').count()}`)

  // ---------- A) advanced embed options + packaging ----------
  const advanced = page.locator('[data-testid="offline-packer-advanced"]').first()
  const advToggle = page.locator('[data-testid="offline-packer-advanced-toggle"]').first()
  record('advanced block present', (await advanced.count()) > 0)
  if ((await advanced.getAttribute('data-advanced-open')) !== '1') await advToggle.click({ timeout: 5000 }).catch(() => {})
  await wait(600)
  const openFlag = await advanced.getAttribute('data-advanced-open').catch(() => null)
  record('advanced options expand', openFlag === '1', `open=${openFlag}`)
  const embedHost = page.locator('[data-testid="offline-packer-embed-host"]').first()
  const embedDeclared = page.locator('[data-testid="offline-packer-embed-declared"]').first()
  const extraInput = page.locator('[data-testid="offline-packer-extra-packages"]').first()
  record('embed option controls present', (await embedHost.count()) > 0 && (await embedDeclared.count()) > 0 && (await extraInput.count()) > 0,
    `host=${await embedHost.count()} declared=${await embedDeclared.count()} extra=${await extraInput.count()}`)
  await extraInput.click(); await extraInput.fill('yaml')
  await wait(400)
  const summary = await page.locator('[data-testid="offline-packer-advanced-summary"]').first().innerText().catch(() => '')
  record('advanced summary reflects extra package', /extra|额外|yaml/i.test(summary), `summary=${summary}`)

  const outInput = page.locator('[data-testid="offline-packer-output-input"]').first()
  if ((await outInput.count()) > 0) { await outInput.click(); await outInput.fill(opts.outputDir) }
  await snap('04-advanced-options.png')

  const card = page.locator(`[data-testid="offline-packer-row"][data-plugin-name="${opts.plugin}"]`).first()
  record('plugin card found for packaging', (await card.count()) > 0, opts.plugin)
  await card.getByRole('button', { name: /Build offline package|打包/ }).first().click({ timeout: 5000 })
  const job = page.locator('[data-testid="offline-packer-job"]').first()
  await job.waitFor({ state: 'visible', timeout: 15000 })
  const progress = page.locator('[data-testid="offline-packer-progress"]').first()
  const deadline = Date.now() + 180000
  let status = ''
  let sawProgress = false
  const progressSeq = []
  while (Date.now() < deadline) {
    status = (await job.getAttribute('data-job-status').catch(() => null)) ?? ''
    if ((await progress.count()) > 0) {
      sawProgress = true
      const pct = await progress.getAttribute('data-progress-percent').catch(() => null)
      const text = ((await progress.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 100)
      const key = text + '|' + String(pct)
      if (progressSeq.length === 0 || progressSeq[progressSeq.length - 1].key !== key) progressSeq.push({ key, pct, text })
    }
    if (status === 'done' || status === 'error') break
    await wait(300)
  }
  result.embed = { status, sawProgress, progressSeq }
  await job.scrollIntoViewIfNeeded().catch(() => {})
  await wait(300)
  await job.screenshot({ path: shot('05-embed-job-panel.png') }).catch(() => {})
  await snap('05-embed-result.png')
  record('embed packaging job done', status === 'done', `status=${status} progress=${JSON.stringify(progressSeq.map((p) => p.pct))}`)
  const vendored = await page.locator('[data-testid="offline-packer-result-vendored"]').first().innerText().catch(() => '')
  result.embed.vendoredText = vendored.trim()
  record('result vendored panel shows yaml@2.9.1', /yaml@2\.9\.1/.test(vendored) && /embed|内嵌/i.test(vendored), `vendored=${vendored.trim().slice(0, 200)}`)
  const resultText = await page.locator('[data-testid="offline-packer-result"]').first().innerText().catch(() => '')
  result.embed.resultText = resultText.slice(0, 600)
  record('result text contains custom output dir', resultText.includes(opts.outputDir), `dir=${opts.outputDir}`)
  let href = ''
  const download = page.locator('[data-testid="offline-packer-download"]').first()
  if ((await download.count()) > 0) href = (await download.getAttribute('href')) ?? ''
  result.embed.downloadHref = href
  record('download href carries outputRoot', decodeURIComponent(href).includes('outputRoot=' + opts.outputDir), href.slice(0, 180))

  // ---------- B) manual host override + persistence ----------
  const overrideBlock = page.locator('[data-testid="offline-packer-host-override"]').first()
  if ((await overrideBlock.getAttribute('data-host-override-open')) !== '1') {
    await page.locator('[data-testid="offline-packer-host-override-toggle"]').first().click({ timeout: 5000 }).catch(() => {})
  }
  await wait(500)
  const installInput = page.locator('[data-testid="offline-packer-host-install-input"]').first()
  const versionInput = page.locator('[data-testid="offline-packer-host-version-input"]').first()
  record('host override inputs present', (await installInput.count()) > 0 && (await versionInput.count()) > 0)
  await installInput.click(); await installInput.fill('/home/fc/.local/lib/node_modules/@deepseek-ai/dsh')
  await versionInput.click(); await versionInput.fill('9.9.9-ui-override')
  await snap('06-host-override-form.png')
  await page.locator('[data-testid="offline-packer-host-override-apply"]').first().click({ timeout: 5000 })
  const applied = await waitFor(async () => {
    const h = await hostSnapshot()
    return h.sourceData === 'override'
  }, 20000, 'host source=override')
  const afterApply = await hostSnapshot()
  result.override.afterApply = afterApply
  await snap('07-host-override-applied.png')
  record('host source becomes override', applied, `sourceText=${afterApply.sourceText} sourceData=${afterApply.sourceData}`)
  record('host version display shows override value', (afterApply.versionText ?? '').includes('9.9.9-ui-override'), `versionText=${afterApply.versionText}`)

  // persistence: reload and re-open
  await page.reload({ waitUntil: 'domcontentloaded', timeout: opts.timeoutMs })
  await page.waitForLoadState('networkidle', { timeout: opts.timeoutMs }).catch(() => {})
  await wait(2000)
  await openPacker()
  await wait(1500)
  const afterReload = await hostSnapshot()
  result.override.afterReload = afterReload
  await snap('08-host-override-persisted.png')
  record('override persists across reload', afterReload.sourceData === 'override' && (afterReload.versionText ?? '').includes('9.9.9-ui-override'), `source=${afterReload.sourceData} version=${afterReload.versionText}`)

  // clear override -> auto detection returns
  const overrideBlock2 = page.locator('[data-testid="offline-packer-host-override"]').first()
  if ((await overrideBlock2.getAttribute('data-host-override-open')) !== '1') {
    await page.locator('[data-testid="offline-packer-host-override-toggle"]').first().click({ timeout: 5000 }).catch(() => {})
  }
  await wait(400)
  const installInput2 = page.locator('[data-testid="offline-packer-host-install-input"]').first()
  const versionInput2 = page.locator('[data-testid="offline-packer-host-version-input"]').first()
  await installInput2.click(); await installInput2.fill('')
  await versionInput2.click(); await versionInput2.fill('')
  await page.locator('[data-testid="offline-packer-host-override-apply"]').first().click({ timeout: 5000 })
  const cleared = await waitFor(async () => {
    const h = await hostSnapshot()
    return h.sourceData !== 'override'
  }, 20000, 'override cleared')
  await snap('09-host-override-cleared.png')
  record('clearing override restores auto detection', cleared, JSON.stringify(await hostSnapshot()))

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
result.verdict = result.verdict === 'ERROR' ? 'ERROR' : failed.length === 0 ? 'PASS' : 'FAIL'
result.finishedAt = new Date().toISOString()
if (opts.jsonOut) writeFileSync(opts.jsonOut, `${JSON.stringify(result, null, 2)}\n`)
console.log('')
console.log(`V15_UI=${result.verdict} assertions=${result.assertions.length} failed=${failed.length}`)
console.log(`screenshots: ${result.screenshots.join(', ')}`)
process.exit(result.verdict === 'PASS' ? 0 : result.verdict === 'ERROR' ? 2 : 1)
