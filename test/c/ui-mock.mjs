/**
 * Mocked-API check for the dsh-offline-packer settings section.
 *
 * The real node half may still be incomplete, so this script intercepts only
 * `/dsh-offline-packer/api/**` with faithful envelopes (ARCHITECTURE §1) and
 * proves the UI renders plugin rows, the version-matrix panel, a running job
 * with growing logs, a finished job with its download link, and a readable
 * envelope error. Host endpoints are untouched.
 *
 * Usage: node test/c/ui-mock.mjs 'http://127.0.0.1:3081/?token=...' [locale]
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire('/home/fc/dsh-plugin-build/leadcheck/pw/')
const { chromium } = require('playwright-core')

const url = process.argv[2]
const locale = process.argv[3] ?? 'zh-CN'
if (url === undefined || url === '') {
  console.error('usage: node test/c/ui-mock.mjs <url-with-token>')
  process.exit(2)
}
const zhUi = locale.toLowerCase().startsWith('zh')
const here = resolve('/home/fc/dsh-offline-packer/test/c')
mkdirSync(here, { recursive: true })

const LABEL = zhUi ? '离线打包' : 'Offline Packager'
const fail = []
const lines = []
function check(name, passed, detail) {
  lines.push({ name, passed, detail: detail ?? '' })
  if (!passed) fail.push(name)
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------- fixtures
const DSH_VERSION = '0.2.1-rc.2'
const OUTPUT_ROOT = '/home/fc/dsh-offline-packer/test/home-c/offline-packages'
const PLUGINS = [
  {
    name: 'dsh-better-sidebar',
    version: '0.13.1',
    description: '翻页侧边栏：终端 / 文件 / 预览分页显示',
    kind: 'bundle',
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
  },
  {
    name: 'dsh-unlag',
    version: '0.3.0',
    description: '卡顿时换掉插件代码并重建界面',
    kind: 'plugin',
    installed: true,
    enabled: false,
    removable: true,
    dir: '/home/fc/.dsh/profiles/web/node_modules/dsh-unlag',
    realDir: '/home/fc/.dsh/profiles/web/node_modules/dsh-unlag',
    sizeBytes: 234567,
    fileCount: 12,
    peerDsh: '^0.2.0-rc.1',
    client: { platform: 'web', inject: [] },
    bundlePatch: null,
    serverEntry: null,
    warnings: ['没有服务端入口，仅客户端 bundle'],
  },
  {
    name: '@deepseek-ai/dsh-web-app',
    version: DSH_VERSION,
    description: '内置 web 应用',
    kind: 'installation',
    installed: true,
    enabled: true,
    removable: false,
    sizeBytes: 5678901,
    fileCount: 301,
    peerDsh: null,
    client: { platform: 'web', inject: [] },
    bundlePatch: null,
    serverEntry: 'lib/index.js',
    warnings: [],
  },
]
const MATRIX = {
  plugin: 'dsh-better-sidebar',
  versions: [
    { version: '0.13.1', published: '2026-09-01T08:00:00.000Z', dshPeers: ['^0.2.1-rc.1'], compatibleDsh: ['0.2.1-rc.1', DSH_VERSION] },
    { version: '0.12.0', published: '2026-08-01T08:00:00.000Z', dshPeers: ['^0.2.1-rc.1'], compatibleDsh: [DSH_VERSION] },
    { version: '0.11.0', published: '2026-07-01T08:00:00.000Z', dshPeers: [], compatibleDsh: [] },
  ],
  dshVersions: [
    { version: DSH_VERSION, published: '2026-10-01T08:00:00.000Z' },
    { version: '0.1.0-rc.8', published: '2026-09-10T08:00:00.000Z' },
    { version: '0.1.0-rc.7', published: '2026-08-20T08:00:00.000Z' },
  ],
}
const RESULT = {
  dir: `${OUTPUT_ROOT}/dsh-better-sidebar-offline-0.13.1-dsh-${DSH_VERSION}`,
  zipPath: `${OUTPUT_ROOT}/dsh-better-sidebar-offline-0.13.1-dsh-${DSH_VERSION}.zip`,
  zipName: `dsh-better-sidebar-offline-0.13.1-dsh-${DSH_VERSION}.zip`,
  sizeBytes: 3456789,
  pluginName: 'dsh-better-sidebar',
  version: '0.13.1',
  targetDshVersion: DSH_VERSION,
  mode: 'local',
  vendored: ['schemastery', 'yaml'],
  warnings: ['宿主未提供 schemastery，已内嵌'],
}

// ------------------------------------------------------------ mutable mock
let stateMode = 'ok'
let jobPolls = 0
const jobLogs = []
let jobRequests = 0
let registryBody = null

function envelope(value) {
  return JSON.stringify({ ok: true, value })
}
function errorEnvelope(code, message) {
  return JSON.stringify({ ok: false, error: { code, message } })
}

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)))

await page.route('**/dsh-offline-packer/api/**', async (route) => {
  const request = route.request()
  const target = new URL(request.url())
  const path = target.pathname.replace('/dsh-offline-packer/api/', '')
  const method = request.method()

  if (path === 'state') {
    if (stateMode === 'error') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: errorEnvelope('INVENTORY_FAILED', '插件清单读取失败：模拟错误') })
      return
    }
    if (stateMode === 'mismatch') {
      // A server that answers with this host's profile directory while scanning another home.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope({
          host: { dshVersion: DSH_VERSION, dshInstallDir: '/home/fc/.local/lib/node_modules/@deepseek-ai/dsh', nodeVersion: 'v24.14.0' },
          dshHome: '/home/fc/dsh-offline-packer/test/home-c',
          profile: 'web',
          profileDir: '/home/fc/.dsh/profiles/web',
          outputRoot: OUTPUT_ROOT,
          plugins: PLUGINS,
        }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({
        host: { dshVersion: DSH_VERSION, dshInstallDir: '/home/fc/.local/lib/node_modules/@deepseek-ai/dsh', nodeVersion: 'v24.14.0' },
        dshHome: '/home/fc/dsh-offline-packer/test/home-c',
        profile: 'web',
        profileDir: '/home/fc/dsh-offline-packer/test/home-c/profiles/web',
        outputRoot: OUTPUT_ROOT,
        plugins: PLUGINS,
      }),
    })
    return
  }

  if (path === 'package-local' && method === 'POST') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: envelope({ jobId: 'job-local-1' }) })
    return
  }

  if (path === 'package-registry' && method === 'POST') {
    registryBody = request.postDataJSON()
    await route.fulfill({ status: 200, contentType: 'application/json', body: envelope({ jobId: 'job-registry-2' }) })
    return
  }

  if (path === 'job') {
    jobRequests += 1
    const id = target.searchParams.get('id') ?? ''
    jobPolls += 1
    jobLogs.push(`[${jobPolls}] scanning plugin directory`)
    if (jobPolls < 3) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope({ id, kind: id === 'job-registry-2' ? 'registry' : 'local', status: 'running', logs: jobLogs.slice(), startedAt: Date.now() - 1000 }),
      })
      return
    }
    jobLogs.push('assembled package', 'wrote zip')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({
        id,
        kind: id === 'job-registry-2' ? 'registry' : 'local',
        status: 'done',
        logs: jobLogs.slice(),
        result: id === 'job-registry-2' ? Object.assign({}, RESULT, { mode: 'registry' }) : RESULT,
        startedAt: Date.now() - 3000,
        finishedAt: Date.now(),
      }),
    })
    return
  }

  if (path === 'matrix') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: envelope(MATRIX) })
    return
  }

  if (path === 'download') {
    await route.fulfill({ status: 200, contentType: 'application/zip', body: 'PK not really a zip' })
    return
  }

  await route.fulfill({ status: 404, contentType: 'application/json', body: errorEnvelope('NOT_FOUND', `mock: no route for ${path}`) })
})

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(3500)
  const candidate = page.getByRole('button', { name: /^(Continue|继续)$/ })
  if (await candidate.count()) await candidate.first().click()
  await sleep(500)
  await page.keyboard.press('Escape')
  await sleep(500)
  await page.getByRole('button', { name: /^(Account menu|账号菜单)$/ }).first().click()
  await sleep(500)
  await page.getByRole('menuitem', { name: /^(Settings|设置)$/ }).first().click()
  await sleep(1200)
  const nav = page.getByRole('button', { name: LABEL, exact: true })
  await nav.first().waitFor({ state: 'visible', timeout: 15000 })
  await nav.first().click()
  await sleep(2000)

  // ---- host info + rows
  check('rows rendered for every plugin', (await page.locator('[data-testid="offline-packer-row"]').count()) === PLUGINS.length)
  check('host version shown', (await page.textContent('[data-testid="offline-packer-host-version"]'))?.trim() === DSH_VERSION)
  check('output root shown', (await page.textContent('[data-testid="offline-packer-output-root"]'))?.trim() === OUTPUT_ROOT)
  const rowOf = (name) => `[data-testid="offline-packer-row"][data-plugin-name="${name}"]`
  check(
    'peer range shown',
    (await page.locator(`${rowOf('dsh-better-sidebar')} [data-testid="offline-packer-peer"]`).textContent())?.includes('^0.1.0-rc.7') === true,
  )
  check('disabled badge shown', (await page.locator(`${rowOf('dsh-unlag')} [data-testid="offline-packer-enabled"]`).textContent())?.trim() === '已停用')
  check('enabled badge shown', (await page.locator(`${rowOf('dsh-better-sidebar')} [data-testid="offline-packer-enabled"]`).textContent())?.trim() === '已启用')
  check('client/server halves shown', (await page.locator(`${rowOf('dsh-better-sidebar')} [data-testid="offline-packer-server"]`).textContent())?.trim() === '✓')
  check('warnings rendered', (await page.locator('[data-testid="offline-packer-warnings"]').count()) === 1)
  check('plugin source is labelled, not a bare spec', (await page.textContent(`${rowOf('dsh-better-sidebar')} [data-testid="offline-packer-source"]`))?.trim() === 'file:../../pkgs/dsh-better-sidebar')
  check('kind badges rendered', (await page.locator('[data-testid="offline-packer-kind"]').count()) === PLUGINS.length)
  await page.screenshot({ path: `${here}/screenshot-mock-list.png` })

  // ---- search
  await page.fill('[data-testid="offline-packer-search"]', 'unlag')
  await sleep(400)
  check('search filters to one row', (await page.locator('[data-testid="offline-packer-row"]').count()) === 1)
  await page.fill('[data-testid="offline-packer-search"]', '')
  await sleep(400)

  // ---- version matrix for the first plugin
  await page.locator(`${rowOf('dsh-better-sidebar')} [data-testid="offline-packer-history-toggle"]`).click()
  await sleep(1500)
  check('history panel opened', (await page.locator('[data-testid="offline-packer-history"]').count()) === 1)
  check('matrix rows rendered', (await page.locator('[data-testid="offline-packer-matrix-row"]').count()) === MATRIX.versions.length)
  check('target prefilled with host version', (await page.inputValue('[data-testid="offline-packer-target-dsh"]')) === DSH_VERSION)
  check('version select rendered', (await page.locator('[data-testid="offline-packer-version-select"] option').count()) === MATRIX.versions.length)
  check('dsh version chips rendered', (await page.locator('[data-testid="offline-packer-dsh-version"]').count()) === MATRIX.dshVersions.length)
  await page.locator('[data-testid="offline-packer-history"]').scrollIntoViewIfNeeded()
  await sleep(400)
  await page.screenshot({ path: `${here}/screenshot-mock-matrix.png` })
  await page.locator('[data-testid="offline-packer-history"]').screenshot({ path: `${here}/screenshot-mock-history-panel.png` })

  // pick an older version then package it from the registry
  await page.selectOption('[data-testid="offline-packer-version-select"]', '0.12.0')
  await page.click('[data-testid="offline-packer-package-registry"]')
  await sleep(1200)
  check('registry POST body is complete', registryBody?.pluginName === 'dsh-better-sidebar' && registryBody?.version === '0.12.0' && registryBody?.targetDshVersion === DSH_VERSION, JSON.stringify(registryBody))
  check('job panel appears for registry job', (await page.locator('[data-testid="offline-packer-job"]').count()) === 1)
  await page.locator('[data-testid="offline-packer-job-dismiss"]').click()
  await sleep(400)

  // ---- local package job: running logs -> done -> download link
  await page.locator(`${rowOf('dsh-better-sidebar')} [data-testid="offline-packer-history-toggle"]`).click()
  await sleep(400)
  jobPolls = 0
  jobLogs.length = 0
  await page.locator(`${rowOf('dsh-better-sidebar')} [data-testid="offline-packer-package-local"]`).click()
  await sleep(1200)
  check('job panel shows running state', (await page.textContent('[data-testid="offline-packer-job-status"]'))?.trim() === '运行中')
  const firstLogCount = Number(await page.getAttribute('[data-testid="offline-packer-job-logs"]', 'data-log-count'))
  await sleep(2500)
  check('log tail grows while running', Number(await page.getAttribute('[data-testid="offline-packer-job-logs"]', 'data-log-count')) > firstLogCount)
  await page.locator('[data-testid="offline-packer-job"]').scrollIntoViewIfNeeded()
  await sleep(300)
  await page.screenshot({ path: `${here}/screenshot-mock-job.png` })

  await sleep(3500)
  check('job reaches done state', (await page.textContent('[data-testid="offline-packer-job-status"]'))?.trim() === '已完成')
  check('result panel rendered', (await page.locator('[data-testid="offline-packer-result"]').count()) === 1)
  const href = await page.getAttribute('[data-testid="offline-packer-download"]', 'href')
  const expectedName = `/dsh-offline-packer/api/download?name=${encodeURIComponent(RESULT.zipName)}`
  // The newer job panel appends `&outputRoot=` when a custom output directory is in play.
  check('download link points at the produced zip', typeof href === 'string' && href.startsWith(expectedName), String(href))
  check('result target shown', (await page.textContent('[data-testid="offline-packer-result-target"]'))?.trim() === DSH_VERSION)
  check('result zip name shown', (await page.textContent('[data-testid="offline-packer-result-zipname"]'))?.trim() === RESULT.zipName)
  await page.locator('[data-testid="offline-packer-result"]').scrollIntoViewIfNeeded()
  await sleep(300)
  await page.screenshot({ path: `${here}/screenshot-mock-result.png` })
  await page.locator('[data-testid="offline-packer-job"]').screenshot({ path: `${here}/screenshot-mock-job-panel.png` })

  // polling stops once the job settled
  const settledRequests = jobRequests
  await sleep(2600)
  check('polling stops after the job settles', jobRequests - settledRequests <= 1, `extra=${jobRequests - settledRequests}`)

  // font zoom and log clear control the panel without touching the job
  await page.click('[data-testid="offline-packer-job-zoom"]')
  await sleep(200)
  const fontSize = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="offline-packer-job-logs"]')).fontSize)
  check('zoom changes log font size', fontSize !== '11px', fontSize)
  await page.click('[data-testid="offline-packer-job-clear"]')
  await sleep(300)
  check('clear empties the visible log tail', Number(await page.getAttribute('[data-testid="offline-packer-job-logs"]', 'data-log-count')) === 0)

  // ---- envelope error rendered with code + message, page stays usable
  stateMode = 'error'
  await page.click('[data-testid="offline-packer-refresh"]')
  await sleep(1500)
  const errorText = (await page.textContent('[data-testid="offline-packer-state-error"]')) ?? ''
  check('error banner shows the server code', errorText.includes('INVENTORY_FAILED'), errorText.slice(0, 120))
  check('error banner shows the server message', errorText.includes('插件清单读取失败'), errorText.slice(0, 160))
  check('page survives the API failure', (await page.locator('[data-testid="offline-packer-page"]').count()) === 1)
  await page.screenshot({ path: `${here}/screenshot-mock-error.png` })

  stateMode = 'ok'
  await page.click('[data-testid="offline-packer-refresh"]')
  await sleep(1500)
  check('recovery after retry clears the error', (await page.locator('[data-testid="offline-packer-state-error"]').count()) === 0)
  check('consistent scan source shows no mismatch note', (await page.locator('[data-testid="offline-packer-profile-dir-mismatch"]').count()) === 0)

  // A profile directory outside the scanned home is named, not silently shown as current.
  stateMode = 'mismatch'
  await page.click('[data-testid="offline-packer-refresh"]')
  await sleep(1500)
  check('profile-dir mismatch is called out', (await page.locator('[data-testid="offline-packer-profile-dir-mismatch"]').count()) === 1)
  await page.screenshot({ path: `${here}/screenshot-mock-mismatch.png` })
  stateMode = 'ok'
  await page.click('[data-testid="offline-packer-refresh"]')
  await sleep(1200)
  check('rows come back after recovery', (await page.locator('[data-testid="offline-packer-row"]').count()) === PLUGINS.length)

  check('no page errors under mocks', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

console.log(`\n${fail.length === 0 ? 'ALL PASS' : `FAILURES: ${fail.length}`}`)
process.exit(fail.length === 0 ? 0 : 1)
