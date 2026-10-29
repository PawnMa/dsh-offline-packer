/**
 * dsh-offline-packer — node half.
 *
 * HTTP surface for the browser half:
 *   GET  /dsh-offline-packer/api/state      host facts + installed plugin list
 *   GET  /dsh-offline-packer/api/plugins    plugin list only
 *   POST /dsh-offline-packer/api/package-local    build an offline package from an installed plugin
 *   GET  /dsh-offline-packer/api/matrix     npm version matrix for a plugin
 *   POST /dsh-offline-packer/api/package-registry build an offline package from a published version
 *   GET  /dsh-offline-packer/api/job        poll one job
 *   GET  /dsh-offline-packer/api/download   stream a produced zip
 *
 * Every route answers a JSON envelope `{ ok: true, value }` or
 * `{ ok: false, error: { code, message } }`; downloads are the one binary route.
 * The fence keeps cross-site pages from driving filesystem writes: a browser
 * Origin must match the request Host, and origin-less clients must be local.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

import { getHostInfo } from './lib/host.mjs'
import { listPlugins } from './lib/inventory.mjs'
import { buildLocalPackage } from './lib/local.mjs'
import { listPluginVersions } from './lib/registry.mjs'
import { buildRegistryPackage } from './lib/historical.mjs'
import { createJob, getJob, listJobs } from './lib/jobs.mjs'

export const name = 'dsh-offline-packer'
export const inject = ['webServer']

const BASE = '/dsh-offline-packer'
const PROFILE_RE = /^[A-Za-z0-9._-]+$/
const ZIP_RE = /^[A-Za-z0-9._@+~ -]+\.zip$/
const BODY_LIMIT = 1 << 20

/**
 * Build the HTTP handler bound to one host context.
 *
 * @param ctx - cordis context with the webServer service.
 * @returns prefix route handler.
 */
function createHandler(ctx) {
  const log = (message) => {
    try {
      ctx.logger?.info?.('[offline-packer]', message)
    } catch {
      // Logging must never break a request.
    }
  }

  /** Reject cross-site and non-local callers. */
  const fence = (req) => {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      try {
        return new URL(origin).host === req.headers.host
      } catch {
        return false
      }
    }
    const remote = req.socket?.remoteAddress ?? ''
    return remote === '' || remote === '::1' || /^127\./.test(remote) || /^::ffff:127\./.test(remote)
  }

  const send = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  const ok = (res, value) => send(res, 200, { ok: true, value })
  const fail = (res, status, code, message) => send(res, status, { ok: false, error: { code, message } })

  const readJson = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > BODY_LIMIT) throw Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' })
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_BODY' })
    }
  }

  const stringField = (value, field) => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw Object.assign(new Error(`缺少字段 ${field}`), { code: 'BAD_REQUEST' })
    }
    return value.trim()
  }

  /** Resolve the user-selected scan source; defaults to this process's home/profile. */
  const scanTarget = (query) => {
    const host = getHostInfo()
    const homeRaw = query.get('home')
    const profileRaw = query.get('profile')
    const dshHome = homeRaw !== null && homeRaw.trim() !== '' ? resolve(homeRaw.trim()) : host.dshHome
    const profile = profileRaw !== null && profileRaw.trim() !== '' ? profileRaw.trim() : host.profile
    if (!PROFILE_RE.test(profile)) throw Object.assign(new Error(`profile 名不合法：${profile}`), { code: 'BAD_REQUEST' })
    return { dshHome, profile }
  }

  const defaultOutputRoot = () => join(getHostInfo().dshHome, 'offline-packages')

  /**
   * Resolve the per-request output directory. The UI lets the user type one so
   * packages can land on a shared drive or the workspace instead of the DSH
   * home; absent/blank keeps the default. Only absolute paths are accepted
   * (`~/...` is expanded), and an existing non-directory is refused instead of
   * failing deep inside the staging step.
   */
  const resolveOutputRoot = (body) => {
    const request = typeof body?.outputRoot === 'string' ? body.outputRoot.trim() : ''
    if (request === '') return defaultOutputRoot()
    const expanded = request === '~' || request.startsWith('~/') ? join(homedir(), request.slice(1)) : request
    if (!isAbsolute(expanded)) {
      throw Object.assign(new Error(`输出目录必须是绝对路径：${request}`), { code: 'BAD_OUTPUT_DIR' })
    }
    const target = resolve(expanded)
    if (existsSync(target) && !statSync(target).isDirectory()) {
      throw Object.assign(new Error(`输出目录已存在但不是目录：${target}`), { code: 'BAD_OUTPUT_DIR' })
    }
    return target
  }

  /**
   * The packager carries third-party plugins; in-box/official bundles are part
   * of every DSH installation and are hidden unless the caller asks for them.
   * `includeOfficial=1` (or `official=all`) surfaces them, mostly for
   * diagnostics; local packaging refuses them by default.
   */
  const splitPlugins = (plugins, url) => {
    const includeOfficial = url.searchParams.get('includeOfficial') === '1' || url.searchParams.get('official') === 'all'
    const own = []
    const official = []
    for (const plugin of plugins) (plugin.official === true ? official : own).push(plugin)
    return {
      plugins: includeOfficial ? [...own, ...official] : own,
      hiddenOfficial: includeOfficial ? 0 : official.length,
      officialCount: official.length,
    }
  }

  const routes = {
    'GET /api/state': async (req, res, url) => {
      const target = scanTarget(url.searchParams)
      const inventory = await listPlugins(ctx, target)
      const host = getHostInfo()
      const split = splitPlugins(inventory.plugins, url)
      ok(res, {
        host: {
          dshVersion: host.dshVersion,
          dshInstallDir: host.dshInstallDir,
          nodeVersion: host.nodeVersion,
        },
        dshHome: inventory.dshHome,
        profile: inventory.profile,
        profileDir: inventory.profileDir,
        outputRoot: defaultOutputRoot(),
        plugins: split.plugins,
        hiddenOfficial: split.hiddenOfficial,
        officialCount: split.officialCount,
      })
    },

    'GET /api/plugins': async (req, res, url) => {
      const target = scanTarget(url.searchParams)
      const inventory = await listPlugins(ctx, target)
      const split = splitPlugins(inventory.plugins, url)
      ok(res, {
        dshHome: inventory.dshHome,
        profile: inventory.profile,
        plugins: split.plugins,
        hiddenOfficial: split.hiddenOfficial,
        officialCount: split.officialCount,
      })
    },

    'POST /api/package-local': async (req, res) => {
      const body = await readJson(req)
      const pluginName = stringField(body.pluginName, 'pluginName')
      const targetDshVersion =
        typeof body.targetDshVersion === 'string' && body.targetDshVersion.trim() !== ''
          ? body.targetDshVersion.trim()
          : getHostInfo().dshVersion
      const target = scanTarget(new URLSearchParams(
        typeof body.home === 'string' && body.home.trim() !== '' ? { home: body.home } : {},
      ))
      const profileRequested = typeof body.profile === 'string' && body.profile.trim() !== ''
      const scan = profileRequested ? { ...target, profile: body.profile.trim() } : target
      if (!PROFILE_RE.test(scan.profile)) return fail(res, 400, 'BAD_REQUEST', `profile 名不合法：${scan.profile}`)
      if (body.includeOfficial !== true) {
        const inventory = await listPlugins(ctx, scan)
        const plugin = inventory.plugins.find((entry) => entry.name === pluginName)
        if (plugin?.official === true) {
          return fail(
            res,
            400,
            'OFFICIAL_PLUGIN',
            `「${pluginName}」是 DSH 官方内置插件，离线打包页只处理非官方插件（如确需打包官方插件，请直接调用接口并传 includeOfficial:true）`,
          )
        }
      }
      const targetOutputRoot = resolveOutputRoot(body)
      const created = createJob('local', (jobLog, jobProgress) =>
        buildLocalPackage(
          { pluginName, targetDshVersion, ...scan },
          { ctx, outputRoot: targetOutputRoot, log: jobLog, progress: jobProgress },
        ),
      )
      if (created.error) return fail(res, 429, created.error.code, created.error.message)
      log(`local packaging job ${created.id} for ${pluginName}`)
      ok(res, { jobId: created.id })
    },

    'GET /api/matrix': async (req, res, url) => {
      const pluginName = url.searchParams.get('plugin')
      if (pluginName === null || pluginName.trim() === '') return fail(res, 400, 'BAD_REQUEST', '缺少参数 plugin')
      ok(res, await listPluginVersions(pluginName.trim()))
    },

    'POST /api/package-registry': async (req, res) => {
      const body = await readJson(req)
      const pluginName = stringField(body.pluginName, 'pluginName')
      const version = stringField(body.version, 'version')
      const targetDshVersion = stringField(body.targetDshVersion, 'targetDshVersion')
      const targetOutputRoot = resolveOutputRoot(body)
      const created = createJob('registry', (jobLog, jobProgress) =>
        buildRegistryPackage(
          { pluginName, version, targetDshVersion },
          { ctx, outputRoot: targetOutputRoot, log: jobLog, progress: jobProgress },
        ),
      )
      if (created.error) return fail(res, 429, created.error.code, created.error.message)
      log(`registry packaging job ${created.id} for ${pluginName}@${version} -> dsh ${targetDshVersion}`)
      ok(res, { jobId: created.id })
    },

    'GET /api/job': async (req, res, url) => {
      const id = url.searchParams.get('id')
      if (id === null || id.trim() === '') {
        return ok(res, { jobs: listJobs() })
      }
      const job = getJob(id.trim())
      if (job === null) return fail(res, 404, 'JOB_NOT_FOUND', `没有这个任务：${id}`)
      ok(res, job)
    },

    'GET /api/download': async (req, res, url) => {
      const requested = url.searchParams.get('name') ?? ''
      const fileName = basename(requested)
      if (fileName !== requested || !ZIP_RE.test(fileName)) {
        return fail(res, 400, 'BAD_NAME', '只允许下载 zip 文件')
      }
      const rootFromQuery = url.searchParams.get('outputRoot')
      let root = defaultOutputRoot()
      if (rootFromQuery !== null && rootFromQuery.trim() !== '') {
        try {
          root = resolveOutputRoot({ outputRoot: rootFromQuery })
        } catch (error) {
          return fail(res, 400, error.code ?? 'BAD_OUTPUT_DIR', error.message)
        }
      }
      const filePath = join(root, fileName)
      if (!filePath.startsWith(root + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        return fail(res, 404, 'NOT_FOUND', `找不到文件：${fileName}`)
      }
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${fileName}"`,
        'content-length': String(statSync(filePath).size),
        'cache-control': 'no-store',
      })
      createReadStream(filePath).pipe(res)
    },
  }

  return async (req, res) => {
    if (!fence(req)) return fail(res, 403, 'FORBIDDEN', 'forbidden')
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    let pathname = url.pathname
    if (pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/'
    const key = `${req.method ?? 'GET'} ${pathname}`
    const handler = routes[key]
    if (handler === undefined) {
      const known = Object.keys(routes).some((entry) => entry.endsWith(` ${pathname}`))
      return fail(res, known ? 405 : 404, known ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', `没有这个接口：${key}`)
    }
    try {
      await handler(req, res, url)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
      const message = error instanceof Error ? error.message : String(error)
      log(`request ${key} failed: ${code}: ${message}`)
      // Map engine error codes to meaningful HTTP statuses; anything unmapped is a server fault.
      const statusOf = {
        BAD_REQUEST: 400,
        BAD_BODY: 400,
        BAD_NAME: 400,
        BAD_OUTPUT_DIR: 400,
        BODY_TOO_LARGE: 413,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        JOB_NOT_FOUND: 404,
        METHOD_NOT_ALLOWED: 405,
        JOB_BUSY: 429,
      }
      if (!res.headersSent) fail(res, statusOf[code] ?? 500, code, message)
      else res.end()
    }
  }
}

/**
 * Cordis entry: register the prefix route with the host web server.
 *
 * @param ctx - cordis context.
 */
export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      handler: createHandler(ctx),
    }),
  )
}
