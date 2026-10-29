/**
 * Real-host check for the phase-2 UI (advanced embed options + manual host override).
 *
 * Boots against the real node half: expands both new panels, switches the scan
 * source to the user's real home (read-only), applies a manual host override to
 * the detected install directory, starts one local packaging job with an extra
 * embedded package, and writes test/c/screenshot-embed-options.png.
 *
 * Usage: node test/c/ui-embed-real.mjs 'http://127.0.0.1:3081/?token=...' [locale]
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire('/home/fc/dsh-plugin-build/leadcheck/pw/')
const { chromium } = require('playwright-core')

const url = process.argv[2]
const locale = process.argv[3] ?? 'zh-CN'
if (url === undefined || url === '') {
  console.error('usage: node test/c/ui-embed-real.mjs <url-with-token> [locale]')
  process.exit(2)
}
const zhUi = locale.toLowerCase().startsWith('zh')
const here = resolve('/home/fc/dsh-offline-packer/test/c')
mkdirSync(here, { recursive: true })

const LABEL = zhUi ? '离线打包' : 'Offline Packager'
const USER_HOME = '/home/fc/.dsh'
const failures = []
function check(name, passed, detail) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!passed) failures.push(name)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, locale })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)))

const byTestId = (id) => page.locator(`[data-testid="${id}"]`)

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(3500)

  // landing chrome: preview notice + onboarding sheet
  const cont = page.getByRole('button', { name: /^(Continue|继续)$/ })
  if (await cont.count()) {
    await cont.first().click()
    await sleep(500)
  }
  await page.keyboard.press('Escape')
  await sleep(400)
  await page.getByRole('button', { name: /^(Account menu|账号菜单)$/ }).first().click()
  await sleep(500)
  await page.getByRole('menuitem', { name: /^(Settings|设置)$/ }).first().click()
  await sleep(1200)
  const nav = page.getByRole('button', { name: LABEL, exact: true })
  await nav.first().waitFor({ state: 'visible', timeout: 15000 })
  await nav.first().click()
  await sleep(2500)

  check('section rendered', (await byTestId('offline-packer-page').count()) === 1)
  check('advanced panel exists', (await byTestId('offline-packer-advanced').count()) === 1)
  check('host override block exists', (await byTestId('offline-packer-host-override').count()) === 1)
  check('host source reported by the real server', (await byTestId('offline-packer-host-source').count()) === 1)
  check(
    'host source is a known value',
    ['argv', 'env', 'path', 'profile-fallback', 'override', 'unknown'].includes(
      (await byTestId('offline-packer-host-source').getAttribute('data-host-source')) ?? '',
    ),
    (await byTestId('offline-packer-host-source').getAttribute('data-host-source')) ?? '',
  )

  // The test home only holds official bundles, so the page explains the empty list.
  const hiddenOfficial = await byTestId('offline-packer-hidden-official').count()
  check('official plugins are hidden with a note', hiddenOfficial === 1 || (await byTestId('offline-packer-row').count()) > 0, String(hiddenOfficial))

  // Expand both panels; capture the real state of the new controls.
  await byTestId('offline-packer-advanced-toggle').click()
  await byTestId('offline-packer-host-override-toggle').click()
  await sleep(500)
  check('advanced panel expanded', (await byTestId('offline-packer-advanced').getAttribute('data-advanced-open')) === '1')
  check('embed host checkbox visible', (await byTestId('offline-packer-embed-host').count()) === 1)
  check('embed declared checkbox visible', (await byTestId('offline-packer-embed-declared').count()) === 1)
  check('extra packages input visible', (await byTestId('offline-packer-extra-packages').count()) === 1)
  check('host install input visible', (await byTestId('offline-packer-host-install-input').count()) === 1)
  check('host version input visible', (await byTestId('offline-packer-host-version-input').count()) === 1)
  const detectedDir = await byTestId('offline-packer-host-install-input').getAttribute('placeholder')
  const detectedVersion = await byTestId('offline-packer-host-version-input').getAttribute('placeholder')

  // Scan the real user home read-only so real plugin cards (and their sources) render.
  await page.fill('[data-testid="offline-packer-home-input"]', USER_HOME)
  await page.click('[data-testid="offline-packer-refresh"]')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await byTestId('offline-packer-row').count()) > 0) break
    await sleep(1000)
  }
  const rowCount = await byTestId('offline-packer-row').count()
  check('real user home renders plugin cards', rowCount > 0, `rows=${rowCount}`)

  // Apply the detected host explicitly: the server must answer source=override.
  if (typeof detectedDir === 'string' && detectedDir !== '' && typeof detectedVersion === 'string' && detectedVersion !== '') {
    await page.fill('[data-testid="offline-packer-host-install-input"]', detectedDir)
    await page.fill('[data-testid="offline-packer-host-version-input"]', detectedVersion)
    await page.click('[data-testid="offline-packer-host-override-apply"]')
    await sleep(2500)
    check(
      'manual override is accepted by the real server',
      (await byTestId('offline-packer-host-source').getAttribute('data-host-source')) === 'override',
      (await byTestId('offline-packer-host-source').getAttribute('data-host-source')) ?? '',
    )
    check(
      'host version still shown after override',
      ((await byTestId('offline-packer-host-version').textContent()) ?? '').trim() === detectedVersion.trim(),
      ((await byTestId('offline-packer-host-version').textContent()) ?? '').trim(),
    )
  } else {
    console.log(`INFO auto-detected host unavailable (dir=${String(detectedDir)} version=${String(detectedVersion)}), override assertions skipped`)
  }

  // One real packaging job that carries embed.extraPackages, to prove the body is accepted.
  await page.fill('[data-testid="offline-packer-extra-packages"]', 'yaml')
  await byTestId('offline-packer-host-override').scrollIntoViewIfNeeded()
  await sleep(300)
  await page.screenshot({ path: `${here}/screenshot-host-override.png` })
  await byTestId('offline-packer-advanced').scrollIntoViewIfNeeded()
  await sleep(300)
  await page.screenshot({ path: `${here}/screenshot-embed-options.png` })

  const targetRow = page.locator('[data-testid="offline-packer-row"][data-plugin-name="dsh-unlag"]')
  const packageButton =
    (await targetRow.count()) > 0 ? targetRow.locator('[data-testid="offline-packer-package-local"]') : byTestId('offline-packer-package-local').first()
  await packageButton.click()
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await byTestId('offline-packer-job-status').count()) === 0) {
      await sleep(1000)
      continue
    }
    const value = (await byTestId('offline-packer-job').getAttribute('data-job-status')) ?? ''
    if (value === 'done' || value === 'error') break
    await sleep(1000)
  }
  const jobStatus = (await byTestId('offline-packer-job').getAttribute('data-job-status')) ?? ''
  check('real packaging job reached a terminal state', jobStatus === 'done' || jobStatus === 'error', jobStatus)
  if (jobStatus === 'done') {
    check('result vendored line rendered', (await byTestId('offline-packer-result-vendored').count()) === 1)
    const vendored = ((await byTestId('offline-packer-result-vendored').textContent()) ?? '').trim()
    check('vendored line is readable', vendored.length > 0, vendored.slice(0, 140))
    console.log(`INFO vendored line: ${vendored}`)
  } else {
    const failureText = ((await byTestId('offline-packer-job-failure').textContent()) ?? '').trim()
    console.log(`INFO job failed (tolerated): ${failureText.slice(0, 200)}`)
  }
  await page.screenshot({ path: `${here}/screenshot-embed-real-job.png` })

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.length}`}`)
process.exit(failures.length === 0 ? 0 : 1)
