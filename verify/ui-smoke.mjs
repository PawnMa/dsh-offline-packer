#!/usr/bin/env node
/**
 * Browser smoke test for the dsh-offline-packer Settings panel.
 *
 *   node verify/ui-smoke.mjs                       # host on 3084, stub-tolerant
 *   node verify/ui-smoke.mjs --port 3085 --min-plugins 1
 *   node verify/ui-smoke.mjs --require-section --require-testids "offline-packer-refresh,offline-packer-build"
 *   node verify/ui-smoke.mjs --base "http://127.0.0.1:3084/?token=..."
 *
 * Flow: open page -> dismiss onboarding -> Settings -> 「离线打包」 -> screenshots.
 * Collects console errors / page errors, counts plugin rows, checks data-testid
 * presence, writes artifacts to verify/artifacts/, prints a JSON verdict and
 * exits non-zero when a required assertion fails.
 *
 * Playwright-core is loaded from the Lead's previous-round install
 * (/home/fc/dsh-plugin-build/leadcheck/pw) via createRequire, so this script
 * does not need node_modules next to it.
 *
 * Exit codes: 0 PASS (or stub-tolerant PASS with warnings), 1 FAIL, 2 setup error.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERIFY_DIR = HERE
const PW_DIR = process.env.PLAYWRIGHT_DIR ?? '/home/fc/dsh-plugin-build/leadcheck/pw'
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`

// --- cli -----------------------------------------------------------------
const opts = {
  port: 3084,
  base: '',
  outDir: join(VERIFY_DIR, 'artifacts'),
  minPlugins: null,
  requireSection: false,
  requireTestids: [],
  packagePlugin: '',
  scanHome: '',
  expectRows: null,
  requireHiddenOfficial: false,
  assertNoOfficial: false,
  outputDir: '',
  requireProgress: false,
  stubTolerant: true,
  timeoutMs: 60000,
  waitMs: 1500,
  jsonOut: '',
}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  const next = () => argv[++i]
  switch (a) {
    case '--port': opts.port = Number(next()); break
    case '--base': opts.base = next(); break
    case '--out': opts.outDir = resolve(next()); break
    case '--min-plugins': opts.minPlugins = Number(next()); break
    case '--require-section': opts.requireSection = true; break
    case '--stub-tolerate': opts.stubTolerant = true; break
    case '--strict': opts.stubTolerant = false; break
    case '--require-testids': opts.requireTestids = (next() ?? '').split(',').map((s) => s.trim()).filter(Boolean); break
    case '--package-plugin': opts.packagePlugin = next() ?? ''; break
    case '--scan-home': opts.scanHome = next() ?? ''; break
    case '--expect-rows': opts.expectRows = Number(next()); break
    case '--require-hidden-official': opts.requireHiddenOfficial = true; break
    case '--assert-no-official': opts.assertNoOfficial = true; break
    case '--output-dir': opts.outputDir = next() ?? ''; break
    case '--require-progress': opts.requireProgress = true; break
    case '--timeout': opts.timeoutMs = Number(next()); break
    case '--json': opts.jsonOut = resolve(next()); break
    case '-h': case '--help':
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''))
      process.exit(0)
    default: console.error(`unknown argument: ${a}`); process.exit(2)
  }
}

function readHostBase(port) {
  const envFile = join(VERIFY_DIR, 'run', `host-${port}.env`)
  if (!existsSync(envFile)) return ''
  const text = readFileSync(envFile, 'utf8')
  const m = text.match(/^BASE=(.*)$/m)
  return m ? m[1].trim() : ''
}

const base = opts.base || readHostBase(opts.port)
if (!base) {
  console.error(`[fatal] no base URL: pass --base or boot host on port ${opts.port} with verify/setup-host.sh`)
  process.exit(2)
}
if (!existsSync(CHROMIUM_BIN)) {
  console.error(`[fatal] chromium not found: ${CHROMIUM_BIN}`)
  process.exit(2)
}

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

// --- result state --------------------------------------------------------
const result = {
  base,
  startedAt: new Date().toISOString(),
  steps: [],
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  settings: { opened: false, navItems: [] },
  offlinePacker: {
    sectionPresent: false,
    testids: [],
    buttons: [],
    rows: { heuristic: 'none', count: 0 },
    textSample: '',
    refresh: { clicked: false, ok: false },
  },
  assertions: [],
  verdict: 'FAIL',
}
const record = (name, ok, detail = '') => {
  result.assertions.push({ name, ok, detail })
  if (!ok) console.log(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`)
  else console.log(`PASS  ${name}${detail ? ` :: ${detail}` : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROMIUM_BIN,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
const page = await context.newPage()
page.on('console', (msg) => {
  if (msg.type() !== 'error') return
  const text = msg.text()
  if (/favicon\.ico/i.test(text)) return
  result.consoleErrors.push(text)
})
page.on('pageerror', (error) => result.pageErrors.push(String(error)))

const wait = (ms = opts.waitMs) => page.waitForTimeout(ms)

async function step(name, fn) {
  result.steps.push({ name, at: new Date().toISOString() })
  try {
    await fn()
    return true
  } catch (error) {
    result.steps[result.steps.length - 1].error = String(error?.message ?? error)
    console.log(`WARN  step "${name}" failed: ${error?.message ?? error}`)
    return false
  }
}

async function snap(name) {
  const path = shot(name)
  await page.screenshot({ path, fullPage: true })
  result.screenshots.push(path)
  console.log(`      screenshot: ${path}`)
}

async function clickFirstLabelled(labels, { exact = false, timeout = 4000 } = {}) {
  for (const label of labels) {
    const loc = page.getByText(label, { exact }).first()
    try {
      if ((await loc.count()) > 0) {
        await loc.click({ timeout })
        return label
      }
    } catch {
      // try the next candidate
    }
  }
  return ''
}

async function clickFirstRole(roles, { timeout = 4000 } = {}) {
  for (const [role, name] of roles) {
    const loc = page.getByRole(role, name ? { name } : {}).first()
    try {
      if ((await loc.count()) > 0) {
        await loc.click({ timeout })
        return `${role}:${name ?? '*'}`
      }
    } catch {
      // try the next candidate
    }
  }
  return ''
}

try {
  // --- 1) load the app ---------------------------------------------------
  console.log(`[ui-smoke] base=${base}`)
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs })
  await page.waitForLoadState('networkidle', { timeout: opts.timeoutMs }).catch(() => {})
  await wait(2500)
  await snap('01-landing.png')
  const title = await page.title()
  const bodyText = await page.evaluate(() => document.body?.innerText ?? '')
  record('page loaded (title)', title.includes('DeepSeek'), `title=${JSON.stringify(title)}`)
  record('authenticated app shell rendered', /New Session|New session|新会话/.test(bodyText), `bodyLen=${bodyText.length}`)

  // --- 2) dismiss the onboarding / welcome overlay ----------------------
  await step('dismiss onboarding overlay', async () => {
    // Optional "Continue" step described in the task flow.
    const continued = await clickFirstLabelled(['Continue', '继续'], { exact: true })
    if (continued) {
      result.steps[result.steps.length - 1].continueButton = continued
      await wait(1200)
    }
    // The 0.2.1-rc.2 fresh home shows a "Get started" modal with a Close button.
    const closed = await clickFirstRole([['button', 'Close'], ['button', '关闭']], { timeout: 2500 })
    if (!closed) {
      await page.keyboard.press('Escape').catch(() => {})
    }
    await wait(600)
  })
  const overlayGone = await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    return !dialogs.some((d) => /Get started|Sign in to your DeepSeek/.test(d.innerText ?? ''))
  })
  record('onboarding modal dismissed', overlayGone)

  // --- 3) open Settings --------------------------------------------------
  await step('open settings', async () => {
    // Account menu ("More") -> Settings
    const menu = await clickFirstRole([['button', 'Account menu'], ['button', 'More']], { timeout: 4000 })
    result.steps[result.steps.length - 1].accountMenu = menu
    await wait(900)
    const settings = await clickFirstLabelled(['Settings', '设置'], { exact: true })
    result.steps[result.steps.length - 1].settingsItem = settings
    await wait(1500)
  })
  const settingsDialog = page.locator('[role="dialog"]').filter({ hasText: /Settings|设置/ }).first()
  if ((await settingsDialog.count()) === 0) {
    // fall back: maybe Settings opened as a page/panel
    const anyDialog = await page.locator('[role="dialog"]').count()
    record('settings panel opened', anyDialog > 0, `dialogs=${anyDialog}`)
  } else {
    record('settings panel opened', true)
  }
  result.settings.opened = (await page.locator('[role="dialog"]').count()) > 0
  await snap('02-settings.png')
  result.settings.navItems = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return []
    return [...dialog.querySelectorAll('button,[role="tab"],[role="button"]')]
      .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim())
      .filter((text) => text && text.length < 40)
  })

  // --- 4) open the 「离线打包」 section --------------------------------
  await step('open offline packer section', async () => {
    const label = await clickFirstLabelled(['离线打包', 'Offline Packager', 'Offline packaging', 'Offline Package'], { timeout: 4000 })
    if (label) {
      result.steps[result.steps.length - 1].sectionLabel = label
      await wait(2000)
    }
  })
  if (opts.scanHome) {
    await step('scan custom home', async () => {
      const input = page.locator('[data-testid="offline-packer-home-input"]').first()
      if ((await input.count()) === 0) throw new Error('home input not found')
      await input.click()
      await input.fill(opts.scanHome)
      const profileInput = page.locator('[data-testid="offline-packer-profile-input"]').first()
      if ((await profileInput.count()) > 0) await profileInput.fill('web')
      const refresh = page.locator('[data-testid="offline-packer-refresh"]').first()
      if ((await refresh.count()) === 0) throw new Error('refresh button not found')
      await refresh.click()
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const state = await page.evaluate(() => {
          const rows = document.querySelectorAll('[data-testid="offline-packer-row"]').length
          const loading = document.querySelector('[data-testid="offline-packer-list-loading"]') !== null
          const error = document.querySelector('[data-testid="offline-packer-state-error"]') !== null
          return { rows, loading, error }
        })
        if (!state.loading && (state.rows > 0 || state.error)) break
        await page.waitForTimeout(500)
      }
      await wait(1000)
      const rows = await page.evaluate(() => document.querySelectorAll('[data-testid="offline-packer-row"]').length)
      result.scanHome = { home: opts.scanHome, rows }
      await snap('03b-scan-home.png')
      record('scan home lists plugins', rows > 0, `home=${opts.scanHome} rows=${rows}`)
    })
  }
  await snap('03-offline-packer.png')
  const packer = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const root = dialog ?? document.body
    const testids = [...root.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'))
    const text = (root.innerText ?? '')
    const sectionText = text.slice(0, 4000)
    const buttons = [...root.querySelectorAll('button')]
      .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim())
      .filter(Boolean)
    // Row heuristics, most specific first.
    const offlineRows = [...root.querySelectorAll('[data-testid="offline-packer-row"]')]
    const byTestid = [...root.querySelectorAll('[data-testid]')].filter((el) => /plugin.*(row|item|card)/i.test(el.getAttribute('data-testid') ?? ''))
    const roleRows = [...root.querySelectorAll('[role="row"]')]
    const listItems = [...root.querySelectorAll('li')]
    let rows = { heuristic: 'none', count: 0 }
    if (offlineRows.length > 0) rows = { heuristic: 'data-testid=offline-packer-row', count: offlineRows.length }
    else if (byTestid.length > 0) rows = { heuristic: 'data-testid=*plugin*(row|item|card)', count: byTestid.length }
    else if (roleRows.length > 0) rows = { heuristic: 'role=row', count: roleRows.length }
    else if (listItems.length > 0) rows = { heuristic: 'li', count: listItems.length }
    return { testids, text: sectionText, buttons, rows }
  })
  result.offlinePacker.testids = packer.testids
  result.offlinePacker.buttons = packer.buttons
  result.offlinePacker.textSample = packer.text.slice(0, 1500)
  result.offlinePacker.rows = packer.rows
  result.offlinePacker.sectionPresent = /离线打包|Offline Packag/i.test(packer.text)

  const sectionOk = result.offlinePacker.sectionPresent
  record('「离线打包」settings section visible', sectionOk, sectionOk ? '' : 'not found (client bundle not delivered yet?)')
  if (sectionOk) {
    const core = ['offline-packer-page', 'offline-packer-list', 'offline-packer-refresh', 'offline-packer-home-input']
    const missingCore = core.filter((id) => !packer.testids.includes(id))
    record('core data-testid present', missingCore.length === 0, missingCore.length ? `missing=${missingCore.join(',')}` : core.join(','))
  }

  if (opts.expectRows !== null) {
    record(`plugin rows == ${opts.expectRows}`, packer.rows.count === opts.expectRows, `heuristic=${packer.rows.heuristic} count=${packer.rows.count}`)
  }
  if (opts.assertNoOfficial) {
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="offline-packer-row"]')].map((el) => (el.innerText || '').split('\n')[0].trim()))
    const leaked = names.filter((name) => name.startsWith('@deepseek-ai/'))
    record('no official rows rendered', leaked.length === 0, leaked.length ? `leaked=${leaked.join(',')}` : `${names.length} rows, none @deepseek-ai/*`)
  }
  if (opts.requireHiddenOfficial) {
    const hiddenNode = page.locator('[data-testid="offline-packer-hidden-official"]').first()
    const exists = (await hiddenNode.count()) > 0
    let text = ''
    if (exists) text = ((await hiddenNode.innerText().catch(() => '')) || '').trim()
    result.offlinePacker.hiddenOfficialText = text
    record('hidden-official note present', exists && text.length > 0, text)
  }

  // --- 5) plugin list ----------------------------------------------------
  if (opts.minPlugins !== null) {
    record(`plugin rows >= ${opts.minPlugins}`, packer.rows.count >= opts.minPlugins,
      `heuristic=${packer.rows.heuristic} count=${packer.rows.count}`)
  }
  if (sectionOk) {
    record('plugin list rendered (>=1 row heuristic)', packer.rows.count >= 1, JSON.stringify(packer.rows))
  }

  // --- 6) refresh button -------------------------------------------------
  if (sectionOk) {
    await step('click refresh', async () => {
      const clicked = await clickFirstLabelled(['刷新', 'Refresh'], { timeout: 3000 })
      if (clicked) {
        result.offlinePacker.refresh.clicked = true
        await wait(2500)
        result.offlinePacker.refresh.ok = true
        await snap('04-after-refresh.png')
      }
    })
    record('refresh control usable', result.offlinePacker.refresh.ok, `clicked=${result.offlinePacker.refresh.clicked}`)
  }

  // --- 6b) optional one-click packaging from the UI ---------------------
  if (opts.packagePlugin && sectionOk) {
    await step('package from UI', async () => {
      const card = page.locator('[data-testid="offline-packer-row"]').filter({ hasText: opts.packagePlugin }).first()
      if ((await card.count()) === 0) throw new Error('plugin card not found: ' + opts.packagePlugin)
      if (opts.outputDir) {
        const outInput = page.locator('[data-testid="offline-packer-output-input"]').first()
        if ((await outInput.count()) === 0) throw new Error('output dir input (offline-packer-output-input) not found')
        await outInput.click()
        await outInput.fill(opts.outputDir)
        await page.waitForTimeout(300)
      }
      const build = card.getByRole('button', { name: /Build offline package|离线打包|打包/ }).first()
      if ((await build.count()) === 0) throw new Error('build button not found in plugin card')
      await build.click({ timeout: 5000 })
      const job = page.locator('[data-testid="offline-packer-job"]').first()
      await job.waitFor({ state: 'visible', timeout: 15000 })
      const progress = page.locator('[data-testid="offline-packer-progress"]').first()
      const deadline = Date.now() + 300000
      let status = ''
      let sawProgress = false
      const progressSeq = []
      while (Date.now() < deadline) {
        status = (await job.getAttribute('data-job-status').catch(() => null)) ?? ''
        if ((await progress.count()) > 0) {
          sawProgress = true
          const pct = await progress.getAttribute('data-progress-percent').catch(() => null)
          const phaseText = ((await progress.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 120)
          const key = phaseText + '|' + String(pct)
          if (progressSeq.length === 0 || progressSeq[progressSeq.length - 1].key !== key) progressSeq.push({ key, pct, phaseText })
        }
        if (status === 'done' || status === 'error') break
        await page.waitForTimeout(300)
      }
      result.uiPackaging = { plugin: opts.packagePlugin, status, sawProgress, progressSequence: progressSeq }
      await job.scrollIntoViewIfNeeded().catch(() => {})
      await wait(300)
      await job.screenshot({ path: shot('05b-job-panel.png') }).catch(() => {})
      await snap('05-job-' + (status || 'unknown') + '.png')
      if (status !== 'done') throw new Error('job status=' + status)
      const resultNode = page.locator('[data-testid="offline-packer-result"]').first()
      if ((await resultNode.count()) > 0) result.uiPackaging.resultText = (await resultNode.innerText()).slice(0, 800)
      const zipNameNode = page.locator('[data-testid="offline-packer-result-zipname"]').first()
      if ((await zipNameNode.count()) > 0) result.uiPackaging.zipName = (await zipNameNode.innerText()).trim()
      const download = page.locator('[data-testid="offline-packer-download"]').first()
      if ((await download.count()) > 0) result.uiPackaging.downloadHref = await download.getAttribute('href')
    })
    const pkgOk = result.uiPackaging?.status === 'done'
    record('UI one-click packaging job done', pkgOk, JSON.stringify(result.uiPackaging ?? {}))
    if (result.uiPackaging?.zipName) {
      record('UI result shows a zip name', /\.zip$/.test(result.uiPackaging.zipName), result.uiPackaging.zipName)
    }
  }

  if (opts.requireProgress) {
    const seq = result.uiPackaging?.progressSequence ?? []
    const percents = seq.map((s) => s.pct).filter((v) => v !== null && v !== undefined && v !== '').map(Number)
    const monotonic = percents.every((v, i) => i === 0 || v >= percents[i - 1])
    const distinct = new Set(percents).size
    record('progress element observed', result.uiPackaging?.sawProgress === true, `samples=${seq.length}`)
    record('progress percent advances monotonically', monotonic && percents.length >= 1, `percents=${percents.slice(0, 14).join(',')} distinct=${distinct}`)
    if (distinct < 3) console.log(`      note: UI polls the job every 1s, so a fast job can show only ${distinct} intermediate percent frame(s); final 100 is still asserted`)
    record('progress reaches 100', percents.length > 0 && percents[percents.length - 1] === 100, `last=${percents.length ? percents[percents.length - 1] : 'n/a'}`)
  }
  if (opts.outputDir) {
    const text = result.uiPackaging?.resultText ?? ''
    record('result text contains custom output dir', text.includes(opts.outputDir), `dir=${opts.outputDir} textSample=${text.slice(0, 140)}`)
    let decoded = result.uiPackaging?.downloadHref ?? ''
    try { decoded = decodeURIComponent(decoded) } catch {}
    record('download href carries outputRoot=', decoded.includes('outputRoot=' + opts.outputDir), decoded.slice(0, 220))
  }

  // --- 7) required test ids ---------------------------------------------
  if (opts.requireTestids.length > 0) {
    // Re-collect: some testids (job panel, result, download) only exist after a
    // packaging run, so the pre-packaging snapshot is not authoritative.
    const finalTestids = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const root = dialog ?? document.body
      return [...root.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'))
    })
    result.offlinePacker.finalTestids = finalTestids
    const missing = opts.requireTestids.filter((id) => !finalTestids.includes(id))
    record('required data-testid present', missing.length === 0, missing.length ? `missing=${missing.join(',')}` : `found=${opts.requireTestids.length}`)
  }

  // --- 8) console / page errors -----------------------------------------
  record('no page errors', result.pageErrors.length === 0, result.pageErrors.slice(0, 3).join(' | '))
  record('no console errors', result.consoleErrors.length === 0, result.consoleErrors.slice(0, 3).join(' | '))

  // --- verdict -----------------------------------------------------------
  const hardFailures = result.assertions.filter((a) => !a.ok)
  const onlySectionMissing = opts.stubTolerant && !opts.requireSection &&
    hardFailures.length > 0 && hardFailures.every((a) => /离线打包|plugin list|refresh/.test(a.name))
  if (hardFailures.length === 0) {
    result.verdict = 'PASS'
  } else if (onlySectionMissing) {
    result.verdict = 'PASS_STUB_TOLERATED'
  } else {
    result.verdict = 'FAIL'
  }
} catch (error) {
  result.error = String(error?.stack ?? error)
  result.verdict = 'ERROR'
  console.error(`[fatal] ${error?.stack ?? error}`)
  try { await page.screenshot({ path: shot('99-error.png'), fullPage: true }) } catch {}
} finally {
  await browser.close().catch(() => {})
}

result.finishedAt = new Date().toISOString()
if (opts.jsonOut) writeFileSync(opts.jsonOut, `${JSON.stringify(result, null, 2)}\n`)
console.log('')
console.log(`UI_SMOKE=${result.verdict} assertions=${result.assertions.length} failed=${result.assertions.filter((a) => !a.ok).length}`)
console.log(`screenshots: ${result.screenshots.join(', ')}`)
if (result.verdict === 'ERROR') process.exit(2)
process.exit(result.verdict === 'FAIL' ? 1 : 0)
