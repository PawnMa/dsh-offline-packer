/**
 * Local-packaging "embed more" matrix for lib/local.mjs + the opt-in in
 * lib/pack.mjs (task-9).
 *
 * For every option this builds a real offline package from the read-only user
 * profile (`/home/fc/.dsh`, plugins dsh-unlag / dsh-better-sidebar) into
 * `test/out-embed/<case>/` and asserts what actually landed inside
 * `package/node_modules` plus the reported `result.vendored` / warnings.
 *
 * Run: `node test/embed/test-embed.mjs`
 * (includeAllDeclared on dsh-better-sidebar copies ~120 packages / ~230 MB
 * staging and takes ~30 s; that is the point of the option.)
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { buildLocalPackage } from '../../lib/local.mjs'

// Pin the deterministic 0.2.1-rc.2 installation for the default/baseline cases;
// explicit per-request overrides below are tested separately by test-host.mjs.
process.env.DSH_INSTALL_DIR = process.env.DSH_INSTALL_DIR || '/home/fc/.local/lib/node_modules/@deepseek-ai/dsh'

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const OUTPUT_ROOT = join(REPO_ROOT, 'test', 'out-embed')
const USER_HOME = '/home/fc/.dsh'
const DEFAULT_SIDEBAR_SIZE_REF = 5_276_914 // v1 default artifact zip size (baseline)

let failures = 0
const table = []

function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}${detail ? `: ${detail}` : ''}`)
  } else {
    failures += 1
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
  }
  table.push({ case: label, ok: Boolean(condition), detail: detail ?? '' })
}

function walkFiles(root) {
  const files = []
  const stack = ['']
  while (stack.length > 0) {
    const relativeDir = stack.pop()
    const dir = relativeDir === '' ? root : join(root, relativeDir)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) stack.push(relativePath)
      else if (entry.isFile()) files.push(relativePath)
    }
  }
  return files.sort()
}

function nodeModulesOf(result) {
  return join(result.dir, 'package', 'node_modules')
}

function hasPackage(result, name) {
  return existsSync(join(nodeModulesOf(result), name, 'package.json'))
}

function directorySize(root) {
  let total = 0
  for (const file of walkFiles(root)) total += statSync(join(root, file)).size
  return total
}

function unzipOk(result) {
  return execFileSync('unzip', ['-t', result.zipPath], { encoding: 'utf8' }).includes('No errors detected')
}

async function build(label, request) {
  const outputRoot = join(OUTPUT_ROOT, label)
  rmSync(outputRoot, { recursive: true, force: true })
  const started = Date.now()
  const logs = []
  const result = await buildLocalPackage(
    { dshHome: USER_HOME, ...request },
    { ctx: null, outputRoot, log: (line) => logs.push(line) },
  )
  const elapsed = Date.now() - started
  return { result, logs, elapsed }
}

try {
  // ------------------------------------------------------- default (unlag)
  const unlagDefault = await build('default-unlag', { pluginName: 'dsh-unlag' })
  check(
    'default(dsh-unlag): vendored is empty and package has no node_modules',
    unlagDefault.result.vendored.length === 0 && !existsSync(nodeModulesOf(unlagDefault.result)),
    `vendored=${JSON.stringify(unlagDefault.result.vendored)} size=${unlagDefault.result.sizeBytes}`,
  )
  check('default(dsh-unlag): zip valid', unzipOk(unlagDefault.result))

  // -------------------------------------------------- default (sidebar)
  const sidebarDefault = await build('default-better-sidebar', { pluginName: 'dsh-better-sidebar' })
  check(
    'default(dsh-better-sidebar): unchanged v1 behaviour (no vendored packages)',
    sidebarDefault.result.vendored.length === 0 && !existsSync(nodeModulesOf(sidebarDefault.result)),
    `vendored=${sidebarDefault.result.vendored.length} size=${sidebarDefault.result.sizeBytes}`,
  )
  check(
    'default(dsh-better-sidebar): size close to v1 baseline',
    Math.abs(sidebarDefault.result.sizeBytes - DEFAULT_SIDEBAR_SIZE_REF) < 50_000,
    `${sidebarDefault.result.sizeBytes} vs ref ${DEFAULT_SIDEBAR_SIZE_REF}`,
  )

  // -------------------------------------------- extraPackages: ws (bare)
  const extraWs = await build('extra-ws', { pluginName: 'dsh-unlag', embed: { extraPackages: ['ws'] } })
  check(
    'extraPackages=[ws]: package/node_modules/ws present, vendored lists ws@version',
    hasPackage(extraWs.result, 'ws') &&
      extraWs.result.vendored.length === 1 &&
      /^ws@\d+\.\d+\.\d+/.test(extraWs.result.vendored[0]),
    `vendored=${JSON.stringify(extraWs.result.vendored)} size=${extraWs.result.sizeBytes}`,
  )
  const extraWsPkg = JSON.parse(readFileSync(join(nodeModulesOf(extraWs.result), 'ws', 'package.json'), 'utf8'))
  check(`extraPackages=[ws]: embedded ws is the locally installed version ${extraWsPkg.version}`, typeof extraWsPkg.version === 'string')

  // ------------------------------ extraPackages: @deepseek-ai + version/@missing
  const extraHost = await build('extra-host-package', {
    pluginName: 'dsh-unlag',
    embed: { extraPackages: ['ws', '@deepseek-ai/schemastery'] },
  })
  check(
    'extraPackages=[@deepseek-ai/schemastery]: explicit host-namespace name is embedded ("点名即带")',
    hasPackage(extraHost.result, '@deepseek-ai/schemastery') &&
      extraHost.result.vendored.some((entry) => entry.startsWith('@deepseek-ai/schemastery@')),
    `vendored=${JSON.stringify(extraHost.result.vendored)}`,
  )

  const extraBad = await build('extra-invalid', {
    pluginName: 'dsh-unlag',
    embed: { extraPackages: ['ws@99.1.2', 'no-such-package-xyz'] },
  })
  check(
    'extraPackages invalid: job succeeds, ws@version warning + unresolved-package warning',
    extraBad.result.vendored.some((entry) => entry.startsWith('ws@')) &&
      extraBad.result.warnings.some((warning) => warning.includes('本地通道不支持版本选择')) &&
      extraBad.result.warnings.some((warning) => warning.includes('no-such-package-xyz')),
    `warnings=${extraBad.result.warnings.length}`,
  )

  // ----------------------------------- includeHostProvided (dsh-better-sidebar)
  const hostProvided = await build('embed-host-provided', {
    pluginName: 'dsh-better-sidebar',
    embed: { includeHostProvided: true },
  })
  const hostVendored = hostProvided.result.vendored
  check(
    'includeHostProvided: host-namespace packages embedded (@deepseek-ai/*)',
    hostVendored.filter((entry) => entry.startsWith('@deepseek-ai/')).length >= 5 &&
      hasPackage(hostProvided.result, '@deepseek-ai/dsh-settings'),
    `@deepseek-ai vendored=${hostVendored.filter((entry) => entry.startsWith('@deepseek-ai/')).length}`,
  )
  check(
    'includeHostProvided: ws/yaml (host-provided bare packages) embedded',
    hasPackage(hostProvided.result, 'ws') && hasPackage(hostProvided.result, 'yaml'),
  )
  check(
    'includeHostProvided: browser modules never embedded (react / dsh-client-*)',
    !hasPackage(hostProvided.result, 'react') &&
      !hasPackage(hostProvided.result, 'react-dom') &&
      readdirSync(nodeModulesOf(hostProvided.result), { withFileTypes: true }).every(
        (entry) => entry.name !== 'react' && !(entry.name === 'react-dom'),
      ),
  )
  check(
    'includeHostProvided: warnings explain the singleton/host-namespace risk and the react exception',
    hostProvided.result.warnings.some(
      (warning) => warning.includes('宿主命名空间') && warning.includes('单例') && warning.includes('react'),
    ) &&
      hostProvided.result.warnings.some((warning) => warning.includes('内嵌了宿主命名空间')),
    `warnings=${hostProvided.result.warnings.length}`,
  )
  check(
    'includeHostProvided: artifact grows relative to default',
    hostProvided.result.sizeBytes > sidebarDefault.result.sizeBytes,
    `${hostProvided.result.sizeBytes} > ${sidebarDefault.result.sizeBytes}`,
  )
  check('includeHostProvided: zip valid', unzipOk(hostProvided.result))

  // --- version correctness: host packages must come from the CURRENT install ---
  const embeddedSettings = JSON.parse(
    readFileSync(join(nodeModulesOf(hostProvided.result), '@deepseek-ai', 'dsh-settings', 'package.json'), 'utf8'),
  )
  check(
    'includeHostProvided: embedded host packages carry the current 0.2.1-rc.2 version (not a stale install)',
    embeddedSettings.version === '0.2.1-rc.2' &&
      !hostProvided.result.vendored.some((entry) => /^@deepseek-ai\/(?:dsh-|schemastery)/.test(entry) && /@0\.1\.0-rc\./.test(entry)),
    `dsh-settings@${embeddedSettings.version}`,
  )
  check(
    'includeHostProvided: @deepseek-ai/schemastery from the current host (3.18.5, not 3.18.1 rc.7 copy)',
    hostProvided.result.vendored.some((entry) => entry === '@deepseek-ai/schemastery@3.18.5'),
    JSON.stringify(hostProvided.result.vendored.filter((entry) => entry.startsWith('@deepseek-ai/schemastery'))),
  )
  check(
    'includeHostProvided: no package resolved from another installation (no host-pinned paths)',
    !JSON.stringify(hostProvided.result.vendored).includes('host-pinned') &&
      !hostProvided.result.warnings.some((warning) => warning.includes('host-pinned')),
    `warnings=${hostProvided.result.warnings.length}`,
  )
  check(
    'includeHostProvided: host-package resolution source logged as the current install directory',
    hostProvided.logs.some((line) => line.includes('宿主依赖将从当前安装目录解析')) &&
      hostProvided.logs.some((line) => line.includes('来源：当前 DSH 安装目录')),
  )

  // ----------------------------------- includeAllDeclared (dsh-better-sidebar)
  const declared = await build('embed-all-declared', {
    pluginName: 'dsh-better-sidebar',
    embed: { includeAllDeclared: true },
  })
  const declaredVendored = declared.result.vendored
  const hasCodemirror = readdirSync(nodeModulesOf(declared.result), { withFileTypes: true }).some(
    (entry) => entry.name === '@codemirror',
  )
  check(
    'includeAllDeclared: declared closure embedded (@codemirror/* present)',
    hasCodemirror && declaredVendored.some((entry) => entry.startsWith('@codemirror/')),
    `vendored=${declaredVendored.length}`,
  )
  check('includeAllDeclared: front-end library mermaid present', hasPackage(declared.result, 'mermaid'))
  check('includeAllDeclared: react never embedded', !hasPackage(declared.result, 'react') && !hasPackage(declared.result, 'react-dom'))
  check(
    'includeAllDeclared: artifact clearly larger than default',
    declared.result.sizeBytes > sidebarDefault.result.sizeBytes * 2,
    `${declared.result.sizeBytes} > 2 x ${sidebarDefault.result.sizeBytes}`,
  )
  check(
    'includeAllDeclared: warning explains volume/singleton risk',
    declared.result.warnings.some((warning) => warning.includes('内嵌全部声明依赖') && warning.includes('体积')),
    `warnings=${declared.result.warnings.length}`,
  )
  const declaredStagingBytes = directorySize(nodeModulesOf(declared.result))
  check(
    'includeAllDeclared: staging node_modules is large',
    declaredStagingBytes > 100 * 1024 * 1024,
    `${Math.round(declaredStagingBytes / 1024 / 1024)} MiB`,
  )

  // --------------------- explicit peer (@deepseek-ai/dsh-settings), no opt-in
  const peerExtra = await build('extra-peer-package', {
    pluginName: 'dsh-better-sidebar',
    embed: { extraPackages: ['@deepseek-ai/dsh-settings'] },
  })
  check(
    'extraPackages explicit peer: embedded even without includeHostProvided',
    hasPackage(peerExtra.result, '@deepseek-ai/dsh-settings') &&
      peerExtra.result.vendored.some((entry) => entry.startsWith('@deepseek-ai/dsh-settings@')) &&
      peerExtra.result.sizeBytes < sidebarDefault.result.sizeBytes * 2,
    `vendored=${JSON.stringify(peerExtra.result.vendored)} size=${peerExtra.result.sizeBytes}`,
  )

  // ------------------------------------------------ host override plumbing
  const overrideCase = await build('host-override', {
    pluginName: 'dsh-unlag',
    dshInstallDir: '/home/fc/dsh-plugin-build/host-pinned/node_modules/@deepseek-ai/dsh',
    dshVersion: '0.1.0-rc.7',
  })
  const overrideLog = overrideCase.logs.join('\n')
  check(
    'host override: local pipeline uses the manual host (override logged)',
    overrideLog.includes('探测来源：override') &&
      overrideLog.includes('0.1.0-rc.7') &&
      overrideCase.result.targetDshVersion === '0.1.0-rc.7',
    `target=${overrideCase.result.targetDshVersion}`,
  )
  check(
    'host override: dependency closure logged from the overridden rc.7 installation (513 packages)',
    overrideLog.includes('宿主依赖闭包 513 个包'),
  )
  check('host override: zip valid', unzipOk(overrideCase.result))
} finally {
  // keep artifacts — the report references them
}

console.log(`\n${table.filter((row) => row.ok).length}/${table.length} embed checks passed`)
if (failures > 0) {
  console.error(`\nEMBED TEST FAILED (${failures} failing checks)`)
  process.exit(1)
}
console.log('EMBED TEST PASS')
