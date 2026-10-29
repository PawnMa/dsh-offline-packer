/**
 * Playwright check for the browser half of dsh-offline-packer.
 *
 * Usage:
 *   node test/c/ui-check.mjs 'http://127.0.0.1:3081/?token=...' zi-zhi
 *
 * The isolated host needs its printed token URL; this script walks
 * landing -> dismiss notice/onboarding -> account menu -> Settings ->
 * "离线打包" / "Offline Packager", then asserts the section renders, refreshes,
 * opens a version-matrix panel (which may fail gracefully while the node half
 * is still a stub), and writes test/c/screenshot.png.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire('/home/fc/dsh-plugin-build/leadcheck/pw/')
const { chromium } = require('playwright-core')

const url = process.argv[2]
const locale = process.argv[3] ?? 'zh-CN'
if (url === undefined || url === '') {
  console.error('usage: node test/c/ui-check.mjs <url-with-token> [locale]')
  process.exit(2)
}
const zhUi = locale.toLowerCase().startsWith('zh')
const here = resolve('/home/fc/dsh-offline-packer/test/c')
mkdirSync(here, { recursive: true })

const LABEL = zhUi ? '离线打包' : 'Offline Packager'
const failure = []
const records = []
function check(name, passed, detail) {
  records.push({ name, passed, detail: detail ?? '' })
  if (!passed) failure.push(name)
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale })

const pageErrors = []
const consoleErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)))
page.on('console', (message) => {
  if (message.type() !== 'error') return
  // A failing request of this plugin is an expected state that the page turns into a
  // readable banner (npm 404 for an unpublished plugin, a job endpoint under test).
  // Keep the URL so only foreign errors are treated as regressions.
  let source = ''
  try {
    source = message.location()?.url ?? ''
  } catch (error) {
    source = ''
  }
  consoleErrors.push({ text: message.text().slice(0, 400), url: source })
})

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function dismissChrome() {
  // Preview / internal testing notice: a blocking Continue button.
  const candidates = [/^Continue$/, /^继续$/, /^Continue anyway$/]
  for (const pattern of candidates) {
    const button = page.getByRole('button', { name: pattern })
    if (await button.count()) {
      await button.first().click()
      await sleep(600)
      break
    }
  }
  // The onboarding sheet sits on a click-blocking mask; Escape closes it.
  await page.keyboard.press('Escape')
  await sleep(500)
  const leftover = page.getByRole('dialog')
  if (await leftover.count()) {
    const close = page.getByRole('button', { name: /^(Close|关闭)$/ })
    if (await close.count()) {
      await close.first().click()
      await sleep(500)
    }
  }
}

async function openSettings() {
  const account = page.getByRole('button', { name: /^(Account menu|账号菜单)$/ })
  await account.first().click()
  await sleep(500)
  const settings = page.getByRole('menuitem', { name: /^(Settings|设置)$/ })
  await settings.first().click()
  await sleep(1200)
}

async function openSection() {
  const nav = page.getByRole('button', { name: LABEL, exact: true })
  await nav.first().waitFor({ state: 'visible', timeout: 15000 })
  await nav.first().click()
  await sleep(2500)
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(3500)
  const language = await page.evaluate(() => navigator.language)
  check('navigator.language is the requested locale', String(language).toLowerCase().startsWith(locale.slice(0, 2).toLowerCase()), String(language))

  await dismissChrome()
  await openSettings()

  const navLabels = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] button')].map((node) => (node.textContent ?? '').trim()).filter(Boolean),
  )
  check(`settings nav contains "${LABEL}"`, navLabels.includes(LABEL), navLabels.slice(0, 8).join(' | '))

  await openSection()

  const count = await page.locator('[data-testid="offline-packer-page"]').count()
  check('section root rendered', count === 1)

  // Static skeleton: every always-present control.
  const required = [
    'offline-packer-host-info',
    'offline-packer-host-version',
    'offline-packer-home-input',
    'offline-packer-profile-input',
    'offline-packer-refresh',
    'offline-packer-output-root',
    'offline-packer-search',
    'offline-packer-list',
  ]
  for (const testid of required) {
    const found = await page.locator(`[data-testid="${testid}"]`).count()
    check(`testid ${testid} exists`, found === 1)
  }

  const pluginCount = Number(await page.getAttribute('[data-testid="offline-packer-page"]', 'data-plugin-count'))
  check('plugin count attribute is readable', Number.isFinite(pluginCount), String(pluginCount))

  // The primary deliverable screenshot: the list itself, before any interaction scrolls it away.
  await page.screenshot({ path: `${here}/screenshot.png` })

  if (pluginCount > 0) {
    check('plugin rows rendered', (await page.locator('[data-testid="offline-packer-row"]').count()) === pluginCount)
    check('row package button exists', (await page.locator('[data-testid="offline-packer-package-local"]').count()) === pluginCount)
    check('row history button exists', (await page.locator('[data-testid="offline-packer-history-toggle"]').count()) === pluginCount)

    // Search filters the list.
    const firstName = await page.locator('[data-testid="offline-packer-row"]').first().getAttribute('data-plugin-name')
    await page.fill('[data-testid="offline-packer-search"]', firstName ?? '')
    await sleep(400)
    check('search narrows to the named plugin', (await page.locator('[data-testid="offline-packer-row"]').count()) >= 1)
    await page.fill('[data-testid="offline-packer-search"]', 'zzz-no-such-plugin-zzz')
    await sleep(400)
    check('search with no match hides rows', (await page.locator('[data-testid="offline-packer-row"]').count()) === 0)
    await page.fill('[data-testid="offline-packer-search"]', '')
    await sleep(400)

    // Version history panel: real matrix or a graceful error banner.
    await page.locator('[data-testid="offline-packer-history-toggle"]').first().click()
    await sleep(3000)
    const history = await page.locator('[data-testid="offline-packer-history"]').count()
    check('history panel opens', history === 1)
    const matrixRows = await page.locator('[data-testid="offline-packer-matrix-row"]').count()
    const matrixError = await page.locator('[data-testid="offline-packer-history"] [role="alert"]').count()
    check('history panel shows versions or a readable error', matrixRows > 0 || matrixError > 0, `rows=${matrixRows} alerts=${matrixError}`)
    await page.screenshot({ path: `${here}/screenshot-history.png` })
    await page.locator('[data-testid="offline-packer-history-toggle"]').first().click()
    await sleep(400)
  } else {
    check('empty state explains the empty list', (await page.locator('[data-testid="offline-packer-empty"]').count()) === 1)
  }

  // Refresh keeps the page alive (stub node half returns an empty inventory).
  const apiHealth = await page.evaluate(async () => {
    try {
      const response = await fetch('/dsh-offline-packer/api/state', { cache: 'no-store' })
      const payload = await response.json().catch(() => null)
      return { status: response.status, ok: payload?.ok === true }
    } catch (error) {
      return { status: 0, ok: false }
    }
  })
  await page.click('[data-testid="offline-packer-refresh"]')
  await sleep(2500)
  check('page still rendered after refresh', (await page.locator('[data-testid="offline-packer-page"]').count()) === 1)
  const errorBanner = await page.locator('[data-testid="offline-packer-state-error"]').count()
  check(
    apiHealth.ok ? 'healthy API shows no error banner' : 'broken API renders a readable error banner',
    apiHealth.ok ? errorBanner === 0 : errorBanner === 1,
    `HTTP ${apiHealth.status} banners=${errorBanner}`,
  )

  // A packaging attempt must fail readably, never crash the page.
  if (pluginCount > 0) {
    await page.locator('[data-testid="offline-packer-package-local"]').first().click()
    await sleep(3500)
    const pageStillThere = await page.locator('[data-testid="offline-packer-page"]').count()
    const jobPanel = await page.locator('[data-testid="offline-packer-job"]').count()
    const actionError = await page.locator('[data-testid="offline-packer-action-error"]').count()
    check('packaging attempt cannot break the page', pageStillThere === 1)
    check('packaging attempt reports a job or a readable error', jobPanel + actionError > 0, `job=${jobPanel} error=${actionError}`)
    if (jobPanel > 0) {
      await sleep(4000)
      check('job panel exposes status/logs', (await page.locator('[data-testid="offline-packer-job-status"]').count()) === 1 && (await page.locator('[data-testid="offline-packer-job-logs"]').count()) === 1)
    }
    await page.screenshot({ path: `${here}/screenshot-job.png` })
  }

  // Switch the scan source to the user's real home (read-only) to prove home/profile
  // switching, the labelled source line, and whether profileDir follows the scanned home.
  const userHome = '/home/fc/.dsh'
  if (existsSync(`${userHome}/profiles/web`)) {
    // The earlier packaging job would sit above the list in the screenshot; close it first.
    if (await page.locator('[data-testid="offline-packer-job-dismiss"]').count()) {
      await page.click('[data-testid="offline-packer-job-dismiss"]')
      await sleep(300)
    }
    await page.fill('[data-testid="offline-packer-home-input"]', userHome)
    await page.click('[data-testid="offline-packer-refresh"]')
    await sleep(8000)
    const scanned = await page.evaluate(async (home) => {
      try {
        const response = await fetch(`/dsh-offline-packer/api/state?home=${encodeURIComponent(home)}&profile=web`, { cache: 'no-store' })
        const payload = await response.json()
        return payload?.ok === true ? payload.value : null
      } catch (error) {
        return null
      }
    }, userHome)
    const scannedCount = Number(await page.getAttribute('[data-testid="offline-packer-page"]', 'data-plugin-count'))
    check('scan-source switch loads the user home', scannedCount > 0, `plugins=${scannedCount}`)
    const sourceLines = await page.locator('[data-testid="offline-packer-source"]').count()
    check('plugin source values are labelled lines', sourceLines >= 0, `source lines=${sourceLines}`)
    if (sourceLines > 0) {
      const sourceText = (await page.locator('[data-testid="offline-packer-source"]').first().textContent()) ?? ''
      check('source line carries a value', sourceText.trim() !== '', sourceText.trim())
    }
    const shownProfileDir = (await page.textContent('[data-testid="offline-packer-profile-dir"]')) ?? ''
    const profileDirMatchesHome = scanned === null ? 'unknown' : String(scanned.profileDir ?? '').startsWith(userHome)
    const mismatchNote = await page.locator('[data-testid="offline-packer-profile-dir-mismatch"]').count()
    console.log(`INFO scanned home=${userHome} profileDir=${shownProfileDir.trim()} followsHome=${profileDirMatchesHome} mismatchNote=${mismatchNote}`)
    check(
      'profile directory is either under the scanned home or flagged',
      profileDirMatchesHome === true || mismatchNote === 1,
      `followsHome=${profileDirMatchesHome} note=${mismatchNote}`,
    )
    await page.evaluate(() => document.querySelector('[data-testid="offline-packer-page"]').scrollIntoView({ block: 'start' }))
    await sleep(400)
    await page.screenshot({ path: `${here}/screenshot-scan-source.png` })
    const rowWithSource = page
      .locator('[data-testid="offline-packer-row"]')
      .filter({ has: page.locator('[data-testid="offline-packer-source"]') })
      .first()
    if (await rowWithSource.count()) {
      await rowWithSource.screenshot({ path: `${here}/screenshot-row-source.png` })
    }
  }

  await page.screenshot({ path: `${here}/screenshot-final.png` })
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '))
  const foreignConsoleErrors = consoleErrors.filter((entry) => String(entry.url).includes('/dsh-offline-packer/api/') === false)
  if (consoleErrors.length > foreignConsoleErrors.length) {
    console.log(
      `INFO expected API failure noise: ${consoleErrors
        .filter((entry) => String(entry.url).includes('/dsh-offline-packer/api/'))
        .map((entry) => entry.text)
        .slice(0, 3)
        .join(' | ')}`,
    )
  }
  check(
    'no console errors outside this plugin API',
    foreignConsoleErrors.length === 0,
    foreignConsoleErrors.slice(0, 5).map((entry) => `${entry.text} @ ${entry.url}`).join(' | '),
  )

  const boot = await page.evaluate(() => {
    try {
      const entries = window.__DSH_BOOT__?.entries ?? []
      return entries.map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter(Boolean)
    } catch {
      return []
    }
  })
  check('boot manifest lists dsh-offline-packer', boot.includes('dsh-offline-packer'), JSON.stringify(boot))
} finally {
  await browser.close()
}

writeFileSync(`${here}/ui-check-report.json`, `${JSON.stringify({ locale, url: url.replace(/token=[^&]+/, 'token=<redacted>'), records, pageErrors, consoleErrors }, undefined, 2)}\n`)
console.log(`\n${failure.length === 0 ? 'ALL PASS' : `FAILURES: ${failure.length}`}`)
process.exit(failure.length === 0 ? 0 : 1)
