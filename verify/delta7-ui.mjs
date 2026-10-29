#!/usr/bin/env node
/**
 * delta7 (v0.1.6) UI verification:
 *   A) advanced panel shows the always-visible scope note
 *      `offline-packer-advanced-scope` ("only affects the local channel ...").
 *   B) local no-op packaging: dsh-unlag + includeHostProvided -> result.warnings
 *      contains the "no external imports" explanation.
 *   C) version-history (registry) job panel shows
 *      `offline-packer-embed-not-applicable`.
 *   D) no console/page errors.
 *
 *   node verify/delta7-ui.mjs --port 3084 --scan-home /home/fc/.dsh \
 *        --out verify/artifacts/delta7 --json verify/artifacts/delta7/ui-delta7.json
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PW_DIR = process.env.PLAYWRIGHT_DIR ?? '/home/fc/dsh-plugin-build/leadcheck/pw'
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`
const opts = { port: 3084, base: '', scanHome: '/home/fc/.dsh', outDir: join(HERE, 'artifacts', 'delta7'), jsonOut: '', timeoutMs: 60000, navigatorLang: '' }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  const next = () => argv[++i]
  switch (a) {
    case '--port': opts.port = Number(next()); break
    case '--base': opts.base = next(); break
    case '--scan-home': opts.scanHome = next(); break
    case '--out': opts.outDir = resolve(next()); break
    case '--json': opts.jsonOut = resolve(next()); break
    case '--timeout': opts.timeoutMs = Number(next()); break
    case '--navigator-lang': opts.navigatorLang = next() ?? ''; break
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
if (!existsSync(CHROMIUM_BIN)) { console.error(`[fatal] chromium not found`); process.exit(2) }
let chromium
try {
  const require = createRequire(join(PW_DIR, 'package.json'))
  ;({ chromium } = require('playwright-core'))
} catch (error) { console.error(`[fatal] playwright-core: ${error.message}`); process.exit(2) }

mkdirSync(opts.outDir, { recursive: true })
const shot = (name) => join(opts.outDir, name)
const result = { base, startedAt: new Date().toISOString(), screenshots: [], consoleErrors: [], pageErrors: [], assertions: [], local: {}, registry: {} }
const record = (name, ok, detail = '') => {
  result.assertions.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`)
}
const wait = (ms) => page.waitForTimeout(ms)
const browser = await chromium.launch({ executablePath: CHROMIUM_BIN, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
if (opts.navigatorLang) {
  // Force the plugin's locale picker (navigator.language) without changing the host UI language.
  await context.addInitScript((lang) => {
    Object.defineProperty(navigator, 'language', { get: () => lang })
    Object.defineProperty(navigator, 'languages', { get: () => [lang] })
  }, opts.navigatorLang)
  console.log(`[delta7-ui] navigator.language forced to ${opts.navigatorLang}`)
}
const page = await context.newPage()
page.on('console', (msg) => {
  if (msg.type() !== 'error') return
  const text = msg.text()
  if (/favicon\.ico/i.test(text)) return
  result.consoleErrors.push(text)
})
page.on('pageerror', (error) => result.pageErrors.push(String(error)))

async function snap(name) {
  const path = shot(name); await page.screenshot({ path, fullPage: true }); result.screenshots.push(path)
  console.log(`      screenshot: ${path}`)
}
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await fn()) return true; await wait(200) }
  console.log(`WARN  timeout waiting for ${label}`)
  return false
}
async function dismissOverlays() {
  for (let i = 0; i < 15; i += 1) {
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /Preview Notice|Get started|Sign in to your DeepSeek|开始使用|登录 DeepSeek|预览/ }).first()
    if ((await dialog.count()) === 0) return true
    const btn = dialog.getByRole('button', { name: /^(Continue|Close|继续|关闭)$/ }).first()
    if ((await btn.count()) > 0) await btn.click({ timeout: 2500 }).catch(() => {})
    else await page.keyboard.press('Escape').catch(() => {})
    await wait(700)
  }
  return false
}
async function openPacker() {
  await dismissOverlays(); await wait(400); await dismissOverlays()
  let menu = page.getByRole('button', { name: /Account menu|账户菜单/ }).first()
  if ((await menu.count()) === 0) menu = page.locator('button[aria-haspopup="menu"]').first()
  if ((await menu.count()) === 0) menu = page.getByText(/More|更多/).first()
  if ((await menu.count()) > 0) { await menu.click().catch(() => {}); await wait(800) }
  const settings = page.getByText(/^(Settings|设置)$/).first()
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
async function readText(locator, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await locator.count()) > 0) {
      const text = ((await locator.first().textContent().catch(() => '')) || '').trim()
      if (text !== '') return text
    }
    await wait(200)
  }
  return ''
}
async function jobStatus() {
  const job = page.locator('[data-testid="offline-packer-job"]').first()
  if ((await job.count()) === 0) return { visible: false, status: '' }
  return { visible: true, status: (await job.getAttribute('data-job-status').catch(() => null)) ?? '' }
}

try {
  console.log(`[delta7-ui] base=${base}`)
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs })
  await page.waitForLoadState('networkidle', { timeout: opts.timeoutMs }).catch(() => {})
  await wait(2500)
  await snap('01-landing.png')
  record('page loaded', (await page.title()).includes('DeepSeek'))

  await openPacker()
  const scanned = await scanHome()
  await wait(1000)
  await snap('02-packer-scanned.png')
  record('plugin list loaded', scanned, `rows=${await page.locator('[data-testid="offline-packer-row"]').count()}`)

  // ---------- A) advanced scope note ----------
  const scope = page.locator('[data-testid="offline-packer-advanced-scope"]').first()
  const scopeCount = await scope.count()
  const scopeText = scopeCount > 0 ? ((await scope.innerText().catch(() => '')) || '').trim() : ''
  result.scopeText = scopeText
  record('advanced scope note present (always rendered)', scopeCount > 0, scopeText.slice(0, 160))
  record('scope note says local-only / history ignores options', /local channel|本地通道/i.test(scopeText) && /history|历史版本/i.test(scopeText), scopeText.slice(0, 200))

  const advanced = page.locator('[data-testid="offline-packer-advanced"]').first()
  if ((await advanced.getAttribute('data-advanced-open')) !== '1') {
    await page.locator('[data-testid="offline-packer-advanced-toggle"]').first().click({ timeout: 5000 }).catch(() => {})
  }
  await wait(600)
  await snap('03-advanced-scope.png')

  // ---------- B) local no-op packaging (unlag + includeHostProvided) ----------
  const embedHost = page.locator('[data-testid="offline-packer-embed-host"]').first()
  record('embed host checkbox present', (await embedHost.count()) > 0)
  if ((await embedHost.count()) > 0) {
    const checked = await embedHost.isChecked().catch(() => false)
    if (!checked) await embedHost.check({ timeout: 3000 }).catch(async () => { await embedHost.click() })
  }
  const card = page.locator('[data-testid="offline-packer-row"][data-plugin-name="dsh-unlag"]').first()
  record('unlag card present', (await card.count()) > 0)
  await card.getByRole('button', { name: /Build offline package|打包/ }).first().click({ timeout: 5000 })
  await waitFor(async () => (await page.locator('[data-testid="offline-packer-job"]').count()) > 0, 15000, 'job panel')
  const localDone = await waitFor(async () => (await jobStatus()).status === 'done', 180000, 'local job done')
  await wait(500)
  result.local = { done: localDone, status: (await jobStatus()).status }
  // NOTE: the job panel renders its result warnings without a data-testid
  // (only plugin cards use offline-packer-warnings), so assert on the visible
  // job-panel text instead.
  const jobPanel = page.locator('[data-testid="offline-packer-job"]').first()
  const jobText = await readText(jobPanel, 20000)
  result.local.jobText = jobText.slice(0, 800)
  const warnText = /没有静态\/动态 import/.test(jobText) ? jobText : ''
  result.local.warningsText = warnText
  record('local no-op warnings visible', warnText.length > 0, warnText.slice(0, 220))
  record('warnings explain no external imports', /没有静态\/动态 import/.test(warnText), warnText.slice(0, 220))
  const notApplicableOnLocal = await page.locator('[data-testid="offline-packer-embed-not-applicable"]').count()
  record('embed-not-applicable NOT shown for local job', notApplicableOnLocal === 0, `count=${notApplicableOnLocal}`)
  await page.locator('[data-testid="offline-packer-job"]').first().scrollIntoViewIfNeeded().catch(() => {})
  await wait(300)
  await page.locator('[data-testid="offline-packer-job"]').first().screenshot({ path: shot('04-local-noop-job-panel.png') }).catch(() => {})
  await snap('04-local-noop-warnings.png')

  // ---------- C) registry job panel hint ----------
  // Open version history on dsh-unlag (small plugin, fast npm install).
  const unlagCard = page.locator('[data-testid="offline-packer-row"][data-plugin-name="dsh-unlag"]').first()
  await unlagCard.scrollIntoViewIfNeeded().catch(() => {})
  const historyBtn = unlagCard.locator('[data-testid="offline-packer-history-toggle"]').first()
  if ((await historyBtn.count()) > 0) await historyBtn.click({ timeout: 5000 }).catch(() => {})
  const matrixLoaded = await waitFor(async () => (await page.locator('[data-testid="offline-packer-matrix-row"]').count()) > 0, 60000, 'matrix rows')
  record('registry matrix loaded for dsh-unlag', matrixLoaded, `rows=${await page.locator('[data-testid="offline-packer-matrix-row"]').count()}`)
  await wait(500)
  // pick the first (newest) version row to make sure a version is selected
  const firstRow = page.locator('[data-testid="offline-packer-matrix-row"]').first()
  if ((await firstRow.count()) > 0) await firstRow.click({ timeout: 5000 }).catch(() => {})
  await wait(500)
  await snap('05-history-panel.png')
  const pkgBtn = page.locator('[data-testid="offline-packer-package-registry"]').first()
  record('registry package button present', (await pkgBtn.count()) > 0)
  await pkgBtn.click({ timeout: 5000 })
  await waitFor(async () => (await page.locator('[data-testid="offline-packer-job"]').count()) > 0, 15000, 'registry job panel')
  const hint = page.locator('[data-testid="offline-packer-embed-not-applicable"]').first()
  const hintText = await readText(hint, 20000)
  const hintCount = await hint.count()
  result.registry = { hintText, jobKind: await page.locator('[data-testid="offline-packer-job"]').first().getAttribute('data-job-id').catch(() => '') }
  record('registry job panel shows embed-not-applicable', hintCount > 0, hintText.slice(0, 200))
  record('hint explains history ignores advanced options', /history|历史版本/i.test(hintText) && /full declared dependency tree|完整依赖树|do(es)? not apply|不适用/i.test(hintText), hintText.slice(0, 220))
  await page.locator('[data-testid="offline-packer-job"]').first().scrollIntoViewIfNeeded().catch(() => {})
  await wait(300)
  await page.locator('[data-testid="offline-packer-job"]').first().screenshot({ path: shot('06-registry-job-panel.png') }).catch(() => {})
  await snap('06-registry-not-applicable.png')
  // wait for the registry job to finish (or timeout) so screenshots are stable
  const regDone = await waitFor(async () => {
    const st = (await jobStatus()).status
    return st === 'done' || st === 'error'
  }, 300000, 'registry job settle')
  record('registry job settled', regDone, `status=${(await jobStatus()).status}`)
  await snap('07-registry-job-done.png')

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
console.log(`DELTA7_UI=${result.verdict} assertions=${result.assertions.length} failed=${failed.length}`)
console.log(`screenshots: ${result.screenshots.join(', ')}`)
process.exit(result.verdict === 'PASS' ? 0 : result.verdict === 'ERROR' ? 2 : 1)
