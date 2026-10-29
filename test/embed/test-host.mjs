/**
 * Host-detection matrix for lib/host.mjs (task-9).
 *
 * Covers the layered probe order (env -> argv -> profile-heal fallback -> PATH
 * -> global prefixes), the UI override path, invalid overrides, dangling heal
 * links, version fallback and the `unknown` return shape. Child processes are
 * used where `process.argv`/`PATH` must differ from this test's own.
 *
 * Run: `node test/embed/test-host.mjs`
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { getHostInfo } from '../../lib/host.mjs'

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const HOST_MJS = join(REPO_ROOT, 'lib', 'host.mjs')
const REAL_HOST_DIR = '/home/fc/.local/lib/node_modules/@deepseek-ai/dsh'
const REAL_HOST_BIN = join(REAL_HOST_DIR, 'lib', 'bin.js')
const HOST_PINNED_ROOT = '/home/fc/dsh-plugin-build/host-pinned'
const HOST_PINNED_DIR = join(HOST_PINNED_ROOT, 'node_modules', '@deepseek-ai', 'dsh')
const USER_HOME = '/home/fc/.dsh'

const scratch = await mkdtemp(join(tmpdir(), 'offline-packer-host-test-'))
const rows = []
let failures = 0

function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}${detail ? `: ${detail}` : ''}`)
    rows.push({ case: label, ok: true, detail })
  } else {
    failures += 1
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
    rows.push({ case: label, ok: false, detail })
  }
}

/** Run one child that prints `getHostInfo(overrides)` as JSON. */
function childHostInfo({ env = {}, overrides = undefined, extraArgs = [], script = 'inline' } = {}) {
  const childEnv = { ...process.env, ...env }
  delete childEnv.DSH_INSTALL_DIR
  if (env.DSH_INSTALL_DIR !== undefined) childEnv.DSH_INSTALL_DIR = env.DSH_INSTALL_DIR
  if (script === 'inline') {
    const code = `const { getHostInfo } = await import(${JSON.stringify(HOST_MJS)})\nprocess.stdout.write(JSON.stringify(getHostInfo(${JSON.stringify(overrides)})))`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: childEnv,
    })
    if (result.status !== 0) throw new Error(`child failed: ${result.stderr}`)
    return JSON.parse(result.stdout)
  }
  // argv script: a preload hook runs before the DSH CLI entry point.
  const hookPath = join(scratch, 'argv-hook.mjs')
  const code = `const { getHostInfo } = await import(${JSON.stringify(HOST_MJS)})\nprocess.stdout.write(JSON.stringify(getHostInfo()))\nprocess.exit(0)`
  writeFileSync(hookPath, code)
  const result = spawnSync(process.execPath, ['--import', hookPath, ...extraArgs], {
    encoding: 'utf8',
    env: childEnv,
  })
  if (result.status !== 0) throw new Error(`argv child failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

try {
  // ---------------------------------------------------------------- argv
  const argvCase = childHostInfo({
    env: { DSH_HOME: USER_HOME },
    script: 'argv',
    extraArgs: [REAL_HOST_BIN, '--version', '--profile', 'web'],
  })
  check(
    'argv: running CLI entry point identifies the host',
    argvCase.source === 'argv' && argvCase.dshVersion === '0.2.1-rc.2',
    `source=${argvCase.source} version=${argvCase.dshVersion} dir=${argvCase.dshInstallDir}`,
  )
  check('argv: hostProvided closure collected', argvCase.hostProvided.length > 500, `hostProvided=${argvCase.hostProvided.length}`)
  check('argv: overridden flags false', argvCase.overridden.installDir === false && argvCase.overridden.version === false)
  check('argv: warnings empty', Array.isArray(argvCase.warnings) && argvCase.warnings.length === 0)

  // -------------------------------------------- profile heal fallback (tmp)
  const fallbackHome = join(scratch, 'home-fallback')
  await mkdir(join(fallbackHome, 'profiles', 'node_modules', '@deepseek-ai'), { recursive: true })
  await symlink(REAL_HOST_DIR, join(fallbackHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'))
  const fallbackCase = childHostInfo({ env: { DSH_HOME: fallbackHome } })
  check(
    'profile-fallback: $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh symlink (heal fallback)',
    fallbackCase.source === 'profile-fallback' &&
      fallbackCase.dshVersion === '0.2.1-rc.2' &&
      realpathSync(join(fallbackHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')) === fallbackCase.dshInstallDir,
    `source=${fallbackCase.source} version=${fallbackCase.dshVersion} dir=${fallbackCase.dshInstallDir}`,
  )

  // ------------------------------------------------- profile-fallback (real)
  const realFallbackLink = join(USER_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  if (existsSync(realFallbackLink)) {
    const realFallbackCase = childHostInfo({ env: { DSH_HOME: USER_HOME } })
    const expectedVersion = JSON.parse(readFileSync(join(realpathSync(realFallbackLink), 'package.json'), 'utf8')).version
    check(
      'profile-fallback: current /home/fc/.dsh heal link is followed verbatim',
      realFallbackCase.source === 'profile-fallback' &&
        realFallbackCase.dshInstallDir === realpathSync(realFallbackLink) &&
        realFallbackCase.dshVersion === expectedVersion,
      `source=${realFallbackCase.source} version=${realFallbackCase.dshVersion} dir=${realFallbackCase.dshInstallDir}`,
    )
  }

  // ------------------------------------------------------------------ PATH
  const emptyHome = join(scratch, 'home-empty')
  await mkdir(emptyHome, { recursive: true })
  const pathCase = childHostInfo({ env: { DSH_HOME: emptyHome, PATH: process.env.PATH } })
  check(
    'path: `dsh` on PATH is realpathed into the installation',
    pathCase.source === 'path' && pathCase.dshVersion === '0.2.1-rc.2',
    `source=${pathCase.source} version=${pathCase.dshVersion} dir=${pathCase.dshInstallDir}`,
  )

  // ------------------------------------------------------------------- env
  const envCase = childHostInfo({ env: { DSH_HOME: emptyHome, DSH_INSTALL_DIR: REAL_HOST_DIR } })
  check(
    'env: DSH_INSTALL_DIR wins over auto detection',
    envCase.source === 'env' && envCase.dshVersion === '0.2.1-rc.2' && envCase.dshInstallDir === realpathSync(REAL_HOST_DIR),
    `source=${envCase.source} version=${envCase.dshVersion} dir=${envCase.dshInstallDir}`,
  )

  // -------------------------------------------------------- UI override API
  const overrideCase = getHostInfo({ dshInstallDir: HOST_PINNED_DIR, dshVersion: '0.1.0-rc.7' })
  check(
    'override: manual install dir + version win, source=override',
    overrideCase.source === 'override' &&
      overrideCase.dshVersion === '0.1.0-rc.7' &&
      overrideCase.dshInstallDir === realpathSync(HOST_PINNED_DIR) &&
      overrideCase.overridden.installDir === true &&
      overrideCase.overridden.version === true,
    `source=${overrideCase.source} version=${overrideCase.dshVersion} dir=${overrideCase.dshInstallDir}`,
  )
  check(
    'override: hostProvided closure comes from the overridden installation',
    overrideCase.hostProvided.length > 400,
    `hostProvided=${overrideCase.hostProvided.length}`,
  )

  // The override also accepts an install root (…/host-pinned) and a package.json.
  const rootOverride = getHostInfo({ dshInstallDir: HOST_PINNED_ROOT })
  check(
    'override: install-root path normalised to @deepseek-ai/dsh',
    rootOverride.source === 'override' &&
      rootOverride.dshInstallDir === realpathSync(HOST_PINNED_DIR) &&
      rootOverride.dshVersion === '0.1.0-rc.7',
    `dir=${rootOverride.dshInstallDir} version=${rootOverride.dshVersion}`,
  )
  const fileOverride = getHostInfo({ dshInstallDir: join(HOST_PINNED_DIR, 'package.json') })
  check(
    'override: package.json path normalised to its directory',
    fileOverride.source === 'override' && fileOverride.dshInstallDir === realpathSync(HOST_PINNED_DIR),
    `dir=${fileOverride.dshInstallDir}`,
  )

  // ------------------------------------------- invalid override falls back
  const invalidOverride = getHostInfo({ dshInstallDir: join(scratch, 'not-a-dsh-install') })
  check(
    'override(invalid): warning + automatic fallback instead of throwing',
    invalidOverride.source !== 'override' &&
      invalidOverride.warnings.some((warning) => warning.includes('回退自动探测')),
    `source=${invalidOverride.source} warnings=${invalidOverride.warnings.length}`,
  )

  // ---------------------------------------------- unknown version / dirs
  const fakeInstall = join(scratch, 'fake-install')
  await mkdir(fakeInstall, { recursive: true })
  await writeFile(join(fakeInstall, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  const unknownHome = join(scratch, 'home-unknown')
  await mkdir(unknownHome, { recursive: true })
  const previousHome = process.env.DSH_HOME
  const previousInstall = process.env.DSH_INSTALL_DIR
  process.env.DSH_HOME = unknownHome
  delete process.env.DSH_INSTALL_DIR
  const unknownCase = getHostInfo({ dshInstallDir: fakeInstall })
  process.env.DSH_HOME = previousHome
  if (previousInstall === undefined) delete process.env.DSH_INSTALL_DIR
  else process.env.DSH_INSTALL_DIR = previousInstall
  check(
    'unknown: unreadable version returns dshVersion=unknown without throwing',
    unknownCase.source === 'override' &&
      unknownCase.dshVersion === 'unknown' &&
      unknownCase.warnings.some((warning) => warning.includes('未能确定 DSH 版本')),
    `source=${unknownCase.source} version=${unknownCase.dshVersion} warnings=${unknownCase.warnings.length}`,
  )

  // ------------------------------------- dangling heal-fallback symlink
  const danglingHome = join(scratch, 'home-dangling')
  await mkdir(join(danglingHome, 'profiles', 'node_modules', '@deepseek-ai'), { recursive: true })
  await symlink(join(scratch, 'missing-target'), join(danglingHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'))
  process.env.DSH_HOME = danglingHome
  delete process.env.DSH_INSTALL_DIR
  const danglingCase = getHostInfo()
  process.env.DSH_HOME = previousHome
  check(
    'profile-fallback(dangling): warns and keeps probing',
    danglingCase.warnings.some((warning) => warning.includes('已失效')) && danglingCase.source !== 'unknown',
    `source=${danglingCase.source} version=${danglingCase.dshVersion}`,
  )

  // ---------------------------------------------------------- shape check
  const shapeCase = getHostInfo()
  for (const key of ['dshHome', 'profile', 'dshInstallDir', 'dshVersion', 'nodeVersion', 'hostProvided', 'source', 'overridden', 'warnings']) {
    check(`shape: ${key} present`, Object.hasOwn(shapeCase, key))
  }
  check(
    'shape: overridden is {installDir:boolean, version:boolean}',
    typeof shapeCase.overridden.installDir === 'boolean' && typeof shapeCase.overridden.version === 'boolean',
  )
  check('shape: source is a known value', ['env', 'argv', 'profile-fallback', 'path', 'override', 'unknown'].includes(shapeCase.source), shapeCase.source)
} finally {
  await rm(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nHOST DETECTION TEST FAILED (${failures} failing checks)`)
  process.exit(1)
}
console.log(`\nHOST DETECTION TEST PASS — ${rows.length} checks`)
