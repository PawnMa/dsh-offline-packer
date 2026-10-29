/**
 * Mocked-API check for the phase-2 UI: advanced embed options and the manual host
 * override for modded/non-standard DSH installs.
 *
 * Only `/dsh-offline-packer/api/**` is intercepted (faithful ARCHITECTURE §1
 * envelopes); the host UI is untouched. Proves: fold state, the three embed
 * controls, tooltips, localStorage persistence, the `/api/state` host-override
 * query, request bodies for both packaging routes, the improved vendored line,
 * and that a reload restores every remembered choice.
 *
 * Usage: node test/c/ui-embed-mock.mjs 'http://127.0.0.1:3081/?token=...' [locale]
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire('/home/fc/dsh-plugin-build/leadcheck/pw/')
const { chromium } = require('playwright-core')

const url = process.argv[2]
const locale = process.argv[3] ?? 'zh-CN'
if (url === undefined || url === '') {
  console.error('usage: node test/c/ui-embed-mock.mjs <url-with-token> [locale]')
  process.exit(2)
}
const zhUi = locale.toLowerCase().startsWith('zh')
const here = resolve('/home/fc/dsh-offline-packer/test/c')
mkdirSync(here, { recursive: true })

const LABEL = zhUi ? '离线打包' : 'Offline Packager'
const failures = []
const records = []
function check(name, passed, detail) {
  records.push({ name, passed, detail: detail ?? '' })
  if (!passed) failures.push(name)
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------- fixtures
const DSH_VERSION = '0.2.1-rc.2'
const AUTO_INSTALL = '/home/fc/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh'
const OUTPUT_ROOT = '/home/fc/dsh-offline-packer/test/home-c/offline-packages'
const VENDORED = ['ws@8.18.0', 'node-pty@1.0.0']
const PLUGIN = {
  name: 'dsh-better-sidebar',
  version: '0.13.1',
  description: '翻页侧边栏：终端 / 文件 / 预览分页显示',
  kind: 'bundle',
  official: false,
  installed: true,
  enabled: true,
  removable: true,
  source: 'file:../../pkgs/dsh-better-sidebar',
  dir: '/home/fc/dsh-plugin-build/dist/dsh-better-sidebar',
  realDir: '/home/fc/dsh-plugin-build/dist/dsh-better-sidebar',
  sizeBytes: 1234567,
  fileCount: 132,
  peerDsh: '^0.1.0-rc.7',
  client: { platform: 'web', inject: ['slots'] },
  bundlePatch: 'cordis.patch.yml',
  serverEntry: 'lib/index.js',
  warnings: [],
}
const LOCAL_RESULT = {
  dir: `${OUTPUT_ROOT}/dsh-better-sidebar-offline-0.13.1-dsh-${DSH_VERSION}`,
  zipPath: `${OUTPUT_ROOT}/dsh-better-sidebar-offline-0.13.1-dsh-${DSH_VERSION}.zip`,
  zipName: `dsh-better-sidebar-offline-0.13.1-dsh-${DSH_VERSION}.zip`,
  sizeBytes: 3456789,
  pluginName: PLUGIN.name,
  version: PLUGIN.version,
  targetDshVersion: DSH_VERSION,
  mode: 'local',
  vendored: VENDORED,
  warnings: [],
}
const REGISTRY_RESULT = Object.assign({}, LOCAL_RESULT, {
  version: '0.12.0',
  mode: 'registry',
  vendored: [],
})

// ------------------------------------------------------------ mutable mock
const stateUrls = []
let localBody = null
let registryBody = null
let jobPolls = 0
let jobKind = 'local'

function envelope(value) {
  return JSON.stringify({ ok: true, value })
}

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 1200 }, locale })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)))

await page.route('**/dsh-offline-packer/api/**', async (route) => {
  const request = route.request()
  const target = new URL(request.url())
  const path = target.pathname.replace('/dsh-offline-packer/api/', '')
  const method = request.method()

  if (path === 'state') {
    stateUrls.push(target.toString())
    const overridden = target.searchParams.get('dshInstallDir') !== null || target.searchParams.get('dshVersion') !== null
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({
        host: {
          dshVersion: overridden ? target.searchParams.get('dshVersion') ?? DSH_VERSION : DSH_VERSION,
          dshInstallDir: overridden ? target.searchParams.get('dshInstallDir') ?? AUTO_INSTALL : AUTO_INSTALL,
          nodeVersion: 'v24.14.0',
          // The mock reports "unknown" until a manual override arrives, which is exactly
          // the modded-host situation this panel exists for.
          source: overridden ? 'override' : 'unknown',
        },
        dshHome: '/home/fc/dsh-offline-packer/test/home-c',
        profile: 'web',
        profileDir: '/home/fc/dsh-offline-packer/test/home-c/profiles/web',
        outputRoot: OUTPUT_ROOT,
        plugins: [PLUGIN],
        hiddenOfficial: 19,
        officialCount: 19,
      }),
    })
    return
  }

  if (path === 'package-local' && method === 'POST') {
    localBody = request.postDataJSON()
    jobKind = 'local'
    jobPolls = 0
    await route.fulfill({ status: 200, contentType: 'application/json', body: envelope({ jobId: 'job-local-embed' }) })
    return
  }

  if (path === 'package-registry' && method === 'POST') {
    registryBody = request.postDataJSON()
    jobKind = 'registry'
    jobPolls = 0
    await route.fulfill({ status: 200, contentType: 'application/json', body: envelope({ jobId: 'job-registry-embed' }) })
    return
  }

  if (path === 'job') {
    jobPolls += 1
    const id = target.searchParams.get('id') ?? ''
    if (jobPolls < 3) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope({
          id,
          kind: jobKind,
          status: 'running',
          progress: { phase: 'vendoring', percent: 40 },
          logs: ['[1] reading plugin', '[2] resolving externals'],
          startedAt: Date.now() - 800,
        }),
      })
      return
    }
    const kind = jobKind
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({
        id,
        kind,
        status: 'done',
        progress: { phase: 'done', percent: 100 },
        logs: ['[3] assembling', '[4] zip written'],
        result: kind === 'registry' ? REGISTRY_RESULT : LOCAL_RESULT,
        startedAt: Date.now() - 2000,
        finishedAt: Date.now(),
      }),
    })
    return
  }

  if (path === 'matrix') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({
        plugin: PLUGIN.name,
        versions: [
          { version: '0.13.1', published: '2026-09-01T08:00:00.000Z', dshPeers: ['^0.1.0-rc.7'], compatibleDsh: ['0.1.0-rc.7', '0.1.0-rc.8'] },
        ],
        dshVersions: [{ version: DSH_VERSION, published: '2026-10-01T08:00:00.000Z' }],
      }),
    })
    return
  }

  await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: `mock: ${path}` } }) })
})

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Landing -> dismiss notice/onboarding -> settings -> the offline packager section. */
async function openSection() {
  await page.keyboard.press('Escape')
  await sleep(400)
  const candidate = page.getByRole('button', { name: /^(Continue|继续)$/ })
  if (await candidate.count()) {
    await candidate.first().click()
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
  await sleep(1800)
}

const byTestId = (id) => page.locator(`[data-testid="${id}"]`)
const stored = (key) =>
  page.evaluate((name) => {
    try {
      return window.localStorage.getItem(name)
    } catch (error) {
      return null
    }
  }, key)

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(3500)
  await openSection()

  // ---- advanced panel exists, collapsed by default
  check('advanced panel exists', (await byTestId('offline-packer-advanced').count()) === 1)
  check('advanced panel starts collapsed', (await byTestId('offline-packer-advanced').getAttribute('data-advanced-open')) === '0')
  check('embed controls hidden while collapsed', (await byTestId('offline-packer-embed-host').count()) === 0)
  check('advanced summary names the default', ((await byTestId('offline-packer-advanced-summary').textContent()) ?? '').trim().length > 0)

  // ---- expand: three controls + their hints
  await byTestId('offline-packer-advanced-toggle').click()
  await sleep(400)
  check('advanced panel expands', (await byTestId('offline-packer-advanced').getAttribute('data-advanced-open')) === '1')
  check('embed host checkbox rendered', (await byTestId('offline-packer-embed-host').count()) === 1)
  check('embed declared checkbox rendered', (await byTestId('offline-packer-embed-declared').count()) === 1)
  check('extra packages input rendered', (await byTestId('offline-packer-extra-packages').count()) === 1)
  const hostHint = ((await byTestId('offline-packer-embed-host-hint').textContent()) ?? '').trim()
  check('embed host risk hint is present', hostHint.length > 10, hostHint.slice(0, 40))
  const extraHint = ((await byTestId('offline-packer-extra-packages-hint').textContent()) ?? '').trim()
  check('extra packages hint mentions name@version', extraHint.includes('name@version'), extraHint.slice(0, 40))

  // ---- flip both switches and type extra packages
  await byTestId('offline-packer-embed-host').check()
  await byTestId('offline-packer-embed-declared').check()
  await byTestId('offline-packer-extra-packages').fill('ws, node-pty  ws')
  await sleep(500)
  const embedStored = JSON.parse((await stored('dsh-offline-packer:embed')) ?? '{}')
  check(
    'embed options persist to localStorage',
    embedStored.includeHostProvided === true && embedStored.includeAllDeclared === true && embedStored.extraPackages === 'ws, node-pty  ws',
    JSON.stringify(embedStored),
  )
  check('advanced open state persists', (await stored('dsh-offline-packer:advanced-open')) === '1')
  const summary = ((await byTestId('offline-packer-advanced-summary').textContent()) ?? '').trim()
  check('summary reflects the switches and the extra count', summary.includes('2'), summary)

  // ---- host override: collapsed, unknown source, warning visible
  check('host override block exists', (await byTestId('offline-packer-host-override').count()) === 1)
  check('host override starts collapsed', (await byTestId('offline-packer-host-override').getAttribute('data-host-override-open')) === '0')
  check('override inputs hidden while collapsed', (await byTestId('offline-packer-host-install-input').count()) === 0)
  const sourceText = ((await byTestId('offline-packer-host-source').textContent()) ?? '').trim()
  check('host source line is shown', sourceText.length > 0 && (await byTestId('offline-packer-host-source').getAttribute('data-host-source')) === 'unknown', sourceText)
  check('unknown host shows the manual hint', (await byTestId('offline-packer-host-source-unknown').count()) === 1)

  // ---- expand and apply manual host values
  await byTestId('offline-packer-host-override-toggle').click()
  await sleep(400)
  check('host override expands', (await byTestId('offline-packer-host-override').getAttribute('data-host-override-open')) === '1')
  check('install dir input rendered', (await byTestId('offline-packer-host-install-input').count()) === 1)
  check('version input rendered', (await byTestId('offline-packer-host-version-input').count()) === 1)
  const installPlaceholder = await byTestId('offline-packer-host-install-input').getAttribute('placeholder')
  const versionPlaceholder = await byTestId('offline-packer-host-version-input').getAttribute('placeholder')
  check('install input placeholder shows the detected dir', installPlaceholder === AUTO_INSTALL, String(installPlaceholder))
  check('version input placeholder shows the detected version', versionPlaceholder === DSH_VERSION, String(versionPlaceholder))

  await byTestId('offline-packer-host-install-input').fill('/opt/modded-dsh/node_modules/@deepseek-ai/dsh')
  await byTestId('offline-packer-host-version-input').fill('0.1.0-mod.3')
  await sleep(300)
  await byTestId('offline-packer-host-override-apply').click()
  await sleep(1200)

  const stateUrl = stateUrls[stateUrls.length - 1] ?? ''
  check(
    'apply sends the override to /api/state',
    stateUrl.includes('dshInstallDir=') && stateUrl.includes('dshVersion='),
    stateUrl.slice(0, 160),
  )
  check('host source flips to override', (await byTestId('offline-packer-host-source').getAttribute('data-host-source')) === 'override')
  check('unknown hint disappears once overridden', (await byTestId('offline-packer-host-source-unknown').count()) === 0)
  const overrideStored = JSON.parse((await stored('dsh-offline-packer:host-override')) ?? '{}')
  check(
    'host override persists to localStorage',
    overrideStored.dshInstallDir === '/opt/modded-dsh/node_modules/@deepseek-ai/dsh' && overrideStored.dshVersion === '0.1.0-mod.3',
    JSON.stringify(overrideStored),
  )

  // ---- local packaging carries embed + host override
  await byTestId('offline-packer-package-local').first().click()
  await sleep(2500)
  check('local POST happened', localBody !== null, JSON.stringify(localBody))
  check('local body carries embed.includeHostProvided', localBody?.embed?.includeHostProvided === true, JSON.stringify(localBody?.embed))
  check('local body carries embed.includeAllDeclared', localBody?.embed?.includeAllDeclared === true, JSON.stringify(localBody?.embed))
  check(
    'local body splits extra packages',
    JSON.stringify(localBody?.embed?.extraPackages) === JSON.stringify(['ws', 'node-pty']),
    JSON.stringify(localBody?.embed?.extraPackages),
  )
  check('local body carries the manual install dir', localBody?.dshInstallDir === '/opt/modded-dsh/node_modules/@deepseek-ai/dsh', String(localBody?.dshInstallDir))
  check('local body carries the manual version', localBody?.dshVersion === '0.1.0-mod.3', String(localBody?.dshVersion))

  await sleep(3500)
  check('job finishes', (await byTestId('offline-packer-job-status').textContent())?.trim() === (zhUi ? '已完成' : 'Done'))
  const vendoredText = ((await byTestId('offline-packer-result-vendored').textContent()) ?? '').trim()
  check(
    'result lists the embedded dependencies',
    vendoredText.includes('ws@8.18.0') && vendoredText.includes('node-pty@1.0.0') && (await byTestId('offline-packer-result-vendored').getAttribute('data-vendored-count')) === '2',
    vendoredText.slice(0, 120),
  )
  await page.screenshot({ path: `${here}/screenshot-embed-mock.png` })

  // ---- registry packaging carries the host override but no embed
  jobKind = 'local'
  registryBody = null
  await byTestId('offline-packer-job-dismiss').click()
  await sleep(400)
  await byTestId('offline-packer-history-toggle').first().click()
  await sleep(1500)
  await byTestId('offline-packer-package-registry').first().click()
  await sleep(2000)
  check('registry POST happened', registryBody !== null, JSON.stringify(registryBody))
  check('registry body carries the manual install dir', registryBody?.dshInstallDir === '/opt/modded-dsh/node_modules/@deepseek-ai/dsh', String(registryBody?.dshInstallDir))
  check('registry body carries the manual version', registryBody?.dshVersion === '0.1.0-mod.3', String(registryBody?.dshVersion))
  check('registry body does not send embed options', registryBody?.embed === undefined, JSON.stringify(registryBody?.embed))
  await sleep(3500)
  check(
    'empty vendored list says the host provides everything',
    ((await byTestId('offline-packer-result-vendored').textContent()) ?? '').trim() === (zhUi ? '无内嵌依赖（全部由宿主提供）' : 'No dependencies embedded (all provided by the host)'),
    ((await byTestId('offline-packer-result-vendored').textContent()) ?? '').trim(),
  )

  // ---- reload: every remembered choice survives, and the first state read uses the override
  const beforeReload = stateUrls.length
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(3500)
  await openSection()
  const firstAfterReload = stateUrls[beforeReload] ?? ''
  check(
    'first state read after reload uses the stored override',
    firstAfterReload.includes('dshInstallDir=') && firstAfterReload.includes('dshVersion='),
    firstAfterReload.slice(0, 160),
  )
  check('advanced panel reopens from storage', (await byTestId('offline-packer-advanced').getAttribute('data-advanced-open')) === '1')
  check('host override reopens from storage', (await byTestId('offline-packer-host-override').getAttribute('data-host-override-open')) === '1')
  check('embed host stays checked', await byTestId('offline-packer-embed-host').isChecked())
  check('embed declared stays checked', await byTestId('offline-packer-embed-declared').isChecked())
  check(
    'extra packages text restored',
    (await byTestId('offline-packer-extra-packages').inputValue()) === 'ws, node-pty  ws',
    await byTestId('offline-packer-extra-packages').inputValue(),
  )
  check(
    'host override inputs restored',
    (await byTestId('offline-packer-host-install-input').inputValue()) === '/opt/modded-dsh/node_modules/@deepseek-ai/dsh' &&
      (await byTestId('offline-packer-host-version-input').inputValue()) === '0.1.0-mod.3',
  )

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.length}`}`)
process.exit(failures.length === 0 ? 0 : 1)
