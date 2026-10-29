import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const HOST = join(REPO, 'lib', 'host.mjs')
const REAL = '/home/fc/.local/lib/node_modules/@deepseek-ai/dsh'
const PINNED = '/home/fc/dsh-plugin-build/host-pinned/node_modules/@deepseek-ai/dsh'
const scratch = await mkdtemp(join(tmpdir(), 'host-matrix-'))
function child(env, code) {
  const e = { ...process.env, ...env }
  delete e.DSH_INSTALL_DIR
  if (env.DSH_INSTALL_DIR !== undefined) e.DSH_INSTALL_DIR = env.DSH_INSTALL_DIR
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: e })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}
const inline = (overrides) => `const { getHostInfo } = await import(${JSON.stringify(HOST)})\nprocess.stdout.write(JSON.stringify(getHostInfo(${JSON.stringify(overrides)})))`
const rows = []
const push = (label, h, extra = {}) => rows.push({ case: label, source: h.source, version: h.dshVersion, dir: h.dshInstallDir, hostProvided: h.hostProvided.length, overridden: h.overridden, warnings: h.warnings.length, ...extra })

try {
  // argv
  const hook = join(scratch, 'hook.mjs')
  await writeFile(hook, `const { getHostInfo } = await import(${JSON.stringify(HOST)})\nprocess.stdout.write(JSON.stringify(getHostInfo()))\nprocess.exit(0)`)
  const envArgv = { ...process.env, DSH_HOME: '/home/fc/.dsh' }; delete envArgv.DSH_INSTALL_DIR
  const rArgv = spawnSync(process.execPath, ['--import', hook, join(REAL, 'lib', 'bin.js'), '--version', '--profile', 'web'], { encoding: 'utf8', env: envArgv })
  push('argv[1]（真实宿主进程上下文）', JSON.parse(rArgv.stdout))
  push('DSH_INSTALL_DIR env', child({ DSH_HOME: '/home/fc/.dsh', DSH_INSTALL_DIR: REAL }, inline()))
  const fallbackHome = join(scratch, 'home-fallback')
  await mkdir(join(fallbackHome, 'profiles', 'node_modules', '@deepseek-ai'), { recursive: true })
  await symlink(REAL, join(fallbackHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'))
  push('profile-fallback（临时 home 符号链接 → 0.2.1 安装）', child({ DSH_HOME: fallbackHome }, inline()))
  push('profile-fallback（当前 /home/fc/.dsh heal 链接 → host-pinned）', child({ DSH_HOME: '/home/fc/.dsh' }, inline()))
  const emptyHome = join(scratch, 'home-empty'); await mkdir(emptyHome, { recursive: true })
  push('PATH 上的 dsh', child({ DSH_HOME: emptyHome, PATH: process.env.PATH }, inline()))
  push('UI override（host-pinned rc.7）', child({ DSH_HOME: emptyHome }, inline({ dshInstallDir: PINNED, dshVersion: '0.1.0-rc.7' })))
  push('UI override（无效目录 → 自动回退）', child({ DSH_HOME: '/home/fc/.dsh' }, inline({ dshInstallDir: join(scratch, 'nope') })))
  const fake = join(scratch, 'fake-install'); await mkdir(fake, { recursive: true })
  await writeFile(join(fake, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  const unknownHome = join(scratch, 'home-unknown'); await mkdir(unknownHome, { recursive: true })
  push('version 未知（fake install 无 version）', child({ DSH_HOME: unknownHome }, inline({ dshInstallDir: fake })))
  console.log(JSON.stringify(rows, null, 2))
} finally {
  await rm(scratch, { recursive: true, force: true })
}
