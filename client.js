/**
 * dsh-offline-packer — browser half.
 *
 * One settings section, `离线打包` / `Offline Packager`, that drives the node half
 * (`index.js`) over same-origin JSON envelopes:
 *
 *   GET  /dsh-offline-packer/api/state            host facts + installed plugin list
 *   GET  /dsh-offline-packer/api/plugins          plugin list only (unused here)
 *   POST /dsh-offline-packer/api/package-local    build from an installed plugin
 *   GET  /dsh-offline-packer/api/matrix           npm version matrix (needs network)
 *   POST /dsh-offline-packer/api/package-registry build one published version
 *   GET  /dsh-offline-packer/api/job?id=          poll one job
 *   GET  /dsh-offline-packer/api/download?name=   download the produced zip
 *
 * Everything is inline: no CSS file, no build step, no host module besides react.
 * The section owns its data, so it fetches on mount and never assumes a shape it
 * has not read; a failing node half renders as an error banner instead of a
 * broken page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-offline-packer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Same-origin HTTP prefix registered by the node half. */
    const BASE = '/dsh-offline-packer' // ui-copy-ignore

    /** The interface speaks the language the document was opened in. */
    const zh = /^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || '')

    const COPY = zh
      ? {
          title: '离线打包',
          subtitle: '列出当前宿主已安装的插件，一键生成零联网离线安装包；也可以按目标 DSH 版本从 npm 打包历史版本。',
          hostDsh: '宿主 DSH 版本',
          nodeVersion: 'Node 版本',
          dshHome: 'DSH_HOME',
          profile: 'profile',
          profileDir: '扫描源 profile 目录',
          outputRoot: '产物输出目录（当前宿主）',
          hostBlock: '当前宿主',
          scanBlock: '扫描源（可切换）',
          source: '来源',
          profileDirMismatch: '服务端返回的 profile 目录不在扫描 home 下（可能仍指向当前宿主），以扫描源为准。',
          matrixCount: (n) => `${n} 个版本`,
          dshInstallDir: 'DSH 安装目录',
          refresh: '刷新',
          loading: '读取中…',
          scanHint: '改动 home / profile 后点「刷新」重新扫描；打包只写入产物目录，不修改被扫描的 home。',
          searchPlaceholder: '搜索插件名、版本、类型或说明',
          pluginCount: (n) => `共 ${n} 个非官方插件`,
          hiddenOfficial: (n) => `已隐藏 ${n} 个官方内置插件（离线打包页只显示非官方插件）`,
          listEmpty: '没有扫描到非官方插件：确认 DSH_HOME 与 profile 是否正确，或该 profile 只装了官方内置插件。',
          listLoading: '正在读取插件清单…',
          listHint: '数据来自宿主的 pluginManager（存在时）或 profile 目录扫描。',
          notDeclared: '未声明',
          clientHalf: '客户端',
          serverHalf: '服务端',
          size: '大小',
          files: (n) => `${n} 个文件`,
          peer: 'DSH 兼容范围',
          warnings: '备注',
          kindBundle: 'bundle',
          kindPlugin: 'plugin',
          kindInstallation: 'installation',
          enabled: '已启用',
          disabled: '已停用',
          notInstalled: '未安装',
          packageLocal: '打包离线版',
          packagingLocal: '打包中…',
          history: '历史版本…',
          historyHide: '收起历史版本',
          jobBusy: '已有打包任务在运行，等它结束再开始新的任务。',
          jobTitle: '打包任务',
          jobStarting: '启动中…',
          jobRunning: '运行中',
          jobDone: '已完成',
          jobError: '失败',
          jobKindLocal: '本地插件',
          jobKindRegistry: 'npm 历史版本',
          jobDismiss: '关闭面板',
          jobDismissHint: '关闭面板不会中止服务端的打包任务。',
          logs: '日志',
          logsEmpty: '（还没有日志）',
          logClear: '清空',
          logZoom: '缩放',
          logCleared: '已清空，后续日志仍会显示',
          result: '打包结果',
          zipName: 'zip 文件名',
          zipPath: 'zip 路径',
          zipDir: '目录',
          zipTarget: '目标 DSH',
          zipPluginVersion: '插件版本',
          zipMode: '模式',
          zipModeLocal: '本地',
          download: '下载 zip',
          downloadHint: '下载走同源接口，只能取到产物目录下的 zip。',
          matrixNetwork: '历史版本矩阵需要联网：从 npm registry 读取版本号与 DSH 兼容范围。',
          matrixLoading: '正在读取 npm 版本矩阵…',
          matrixTitle: 'npm 版本矩阵',
          matrixVersions: '版本',
          matrixPublished: '发布时间',
          matrixPeers: 'DSH peer',
          matrixCompatible: (n) => `适配 ${n} 个 DSH 版本`,
          matrixEmpty: '这个插件在 npm 上没有可用版本。',
          matrixTruncated: (n) => `列表只显示最新 ${n} 个版本。`,
          targetDsh: '目标 DSH 版本',
          targetDshPlaceholder: '例如 0.1.0-rc.7',
          targetDshPick: '全部 DSH 版本（点选填入目标）',
          targetHint: '目标 DSH 版本 = 离线电脑上 dsh 的版本。插件版本与 DSH 版本不是一对一：每个插件版本声明一个 DSH 兼容范围，可覆盖多个 DSH 版本。',
          matrixBindingHint: '选定目标 DSH 版本后，下面只列出声明兼容该版本的插件版本（并自动选中最新兼容版）；没有声明范围的插件版本按“未知”保留。',
          matrixFilterNote: (n, total, target) => `目标 ${target} 的兼容版本：${n}/${total}`,
          matrixShowAll: '显示全部版本（含不兼容）',
          matrixShowCompatible: '只看兼容版本',
          matrixNoCompatible: (target) => `没有任何插件版本声明兼容 DSH ${target}；已临时显示全部版本，请谨慎选择（打包时会有 peer 警告）。`,
          matrixSelectedIncompatible: (version, target) => `所选插件版本 ${version} 声明的 DSH 范围不含 ${target}，产物可能无法在目标宿主上运行。`,
          matrixCompatibleDshTitle: (version) => `插件版本 ${version} 声明兼容的 DSH 版本（点选填入目标）`,
          matrixRowSupports: '声明兼容目标版本',
          matrixRowUnsupported: '声明的范围不含目标版本',
          matrixRowUnknown: '未声明 DSH 兼容范围',
          targetBest: '填入最新兼容 DSH',
          pluginVersion: '插件版本',
          downloadAndPackage: '下载并打包',
          retry: '重试',
          dismiss: '关闭',
          errorLabel: '出错了 ·',
          unknownError: '未知错误',
          networkError: '无法连接宿主服务（网络请求失败）。',
          badResponse: '宿主返回了无法解析的响应。',
          registryHint: '离线环境读不到 npm registry；请先连网再试。',
          versionRequired: '先选一个插件版本。',
          targetRequired: '先填目标 DSH 版本。',
          staleHint: '如果接口持续报错，可能是服务端模块尚未就绪（开发中属预期）。',
          loadHint: '点击「刷新」重试。',
          outputBlock: '产物输出目录',
          outputDir: '输出目录',
          outputDefault: '用默认',
          outputHint: '留空则用 $DSH_HOME/offline-packages；也可以填任意可写绝对路径（共享盘、工作区），zip 会落在那里。',
          progressLabel: '打包进度',
          elapsed: '耗时',
          packagingPercent: (n) => `打包中… ${n}%`,
          advancedBlock: '高级打包选项',
          advancedHint: '按需多内嵌依赖：只在目标机缺包时才打开，产物会变大。',
          advancedScopeNote: '仅影响「打包离线版」（本地通道）；「历史版本」通道（下载并打包）本身已内嵌该版本声明的完整依赖树，不使用这些选项。',
          embedNotApplicable: '历史版本通道：已内嵌该版本声明的完整依赖树（含前端库），高级打包选项不适用于此通道。',
          expandOptions: '展开',
          collapseOptions: '收起',
          advancedSummary: (parts) => (parts.length === 0 ? '默认（只内嵌运行时必需的缺失依赖）' : `已启用：${parts.join(' · ')}`),
          advancedSummaryHost: '内嵌宿主运行时依赖',
          advancedSummaryDeclared: '内嵌全部声明依赖',
          advancedSummaryExtra: (n) => `额外 ${n} 个包`,
          embedHost: '内嵌宿主运行时依赖（ws / schemastery / node-pty / @deepseek-ai/* 等）',
          embedHostHint: '体积变大，可能让宿主服务出现两份实例，仅在目标机缺包时用。',
          embedDeclared: '内嵌插件声明的全部依赖（dependencies + optionalDependencies 完整树）',
          embedDeclaredHint: '会显著增大产物，通常只在目标机完全没有 node_modules 时使用。',
          extraPackagesLabel: '额外内嵌包（逗号或空格分隔）',
          extraPackagesPlaceholder: 'ws, node-pty',
          extraPackagesHint: '本地通道按已装版本内嵌，不支持 name@version；解析不到的包会在结果 warnings 里列出。',
          hostOverride: '手动指定宿主（魔改/非标准 DSH）',
          hostOverrideHint: '自动探测不到宿主（dsh 命令非标准、node 版本异常等）时手动填写。默认扫描源仍是本机 DSH_HOME/profile，不受影响。',
          hostInstallDir: 'DSH 安装目录',
          hostInstallHint: '指向含 @deepseek-ai/dsh/package.json 的目录，留空自动探测。',
          hostVersionField: 'DSH 版本',
          hostVersionHint: '未知时可手填，如 0.2.1-rc.2。',
          hostOverrideApply: '应用并刷新',
          hostOverrideOpenHint: '这两个值随 /api/state 与打包请求一起发送；留空恢复自动探测。',
          hostSource: (source) => `宿主来源: ${source}`,
          hostSourceUnknown: '未能自动识别宿主，可手动指定或忽略。',
          vendoredNone: '无内嵌依赖（全部由宿主提供）',
          vendoredList: (n) => `内嵌 ${n} 个依赖`,
        }
      : {
          title: 'Offline Packager',
          subtitle: 'Lists the plugins installed in this host, builds a zero-network offline installer in one click, and can package a published version for a target DSH release.',
          hostDsh: 'Host DSH version',
          nodeVersion: 'Node version',
          dshHome: 'DSH_HOME',
          profile: 'profile',
          profileDir: 'Scanned profile directory',
          outputRoot: 'Output folder (this host)',
          hostBlock: 'This host',
          scanBlock: 'Scan source (switchable)',
          source: 'Source',
          profileDirMismatch: 'The server returned a profile directory outside the scanned home (it may still point at this host); treat the scan source as authoritative.',
          matrixCount: (n) => `${n} version${n === 1 ? '' : 's'}`,
          dshInstallDir: 'DSH install directory',
          refresh: 'Refresh',
          loading: 'Loading…',
          scanHint: 'Edit home / profile then press Refresh to rescan; packaging only writes to the output folder, never to the scanned home.',
          searchPlaceholder: 'Search name, version, kind or description',
          pluginCount: (n) => `${n} third-party plugin${n === 1 ? '' : 's'}`,
          hiddenOfficial: (n) => `${n} built-in official plugin${n === 1 ? '' : 's'} hidden (this page only packs third-party plugins)`,
          listEmpty: 'No third-party plugins found: check DSH_HOME and profile, or this profile only has built-in official plugins.',
          listLoading: 'Reading the plugin list…',
          listHint: 'Data comes from the host pluginManager when present, otherwise from a profile directory scan.',
          notDeclared: 'not declared',
          clientHalf: 'Client',
          serverHalf: 'Server',
          size: 'Size',
          files: (n) => `${n} file${n === 1 ? '' : 's'}`,
          peer: 'DSH peer range',
          warnings: 'Notes',
          kindBundle: 'bundle',
          kindPlugin: 'plugin',
          kindInstallation: 'installation',
          enabled: 'Enabled',
          disabled: 'Disabled',
          notInstalled: 'Not installed',
          packageLocal: 'Build offline package',
          packagingLocal: 'Building…',
          history: 'Version history…',
          historyHide: 'Hide version history',
          jobBusy: 'A packaging job is already running; wait for it before starting another.',
          jobTitle: 'Packaging job',
          jobStarting: 'Starting…',
          jobRunning: 'Running',
          jobDone: 'Done',
          jobError: 'Failed',
          jobKindLocal: 'local plugin',
          jobKindRegistry: 'npm historical version',
          jobDismiss: 'Close panel',
          jobDismissHint: 'Closing the panel does not stop the job on the server.',
          logs: 'Log',
          logsEmpty: '(no log lines yet)',
          logClear: 'Clear',
          logZoom: 'Zoom',
          logCleared: 'Cleared; new lines still show up',
          result: 'Package',
          zipName: 'zip name',
          zipPath: 'zip path',
          zipDir: 'Directory',
          zipTarget: 'Target DSH',
          zipPluginVersion: 'Plugin version',
          zipMode: 'Mode',
          zipModeLocal: 'local',
          download: 'Download zip',
          downloadHint: 'Downloads go through the same-origin endpoint and only see zips in the output folder.',
          matrixNetwork: 'The version matrix needs the network: it reads versions and DSH peer ranges from the npm registry.',
          matrixLoading: 'Reading the npm version matrix…',
          matrixTitle: 'npm version matrix',
          matrixVersions: 'Version',
          matrixPublished: 'Published',
          matrixPeers: 'DSH peer',
          matrixCompatible: (n) => `compatible with ${n} DSH version${n === 1 ? '' : 's'}`,
          matrixEmpty: 'No published version of this plugin on npm.',
          matrixTruncated: (n) => `Only the newest ${n} versions are listed.`,
          targetDsh: 'Target DSH version',
          targetDshPlaceholder: 'e.g. 0.1.0-rc.7',
          targetDshPick: 'All DSH versions (click to fill the target)',
          targetHint: 'The target is the dsh version on the offline machine. Plugin versions and DSH versions are not 1:1: each plugin version declares a DSH compatibility range covering several DSH releases.',
          matrixBindingHint: 'Once a target DSH version is set, only plugin versions whose declared range covers it are listed (the newest compatible one is selected automatically); versions without a declared range stay as “unknown”.',
          matrixFilterNote: (n, total, target) => `Versions compatible with ${target}: ${n}/${total}`,
          matrixShowAll: 'Show all versions (including incompatible)',
          matrixShowCompatible: 'Show compatible only',
          matrixNoCompatible: (target) => `No plugin version declares support for DSH ${target}; all versions are shown as a fallback — package with care (a peer warning will appear).`,
          matrixSelectedIncompatible: (version, target) => `Plugin version ${version} does not declare DSH ${target}; the package may not run on the target host.`,
          matrixCompatibleDshTitle: (version) => `DSH versions declared compatible by plugin ${version} (click to fill the target)`,
          matrixRowSupports: 'Declares support for the target',
          matrixRowUnsupported: 'Declared range misses the target',
          matrixRowUnknown: 'No declared DSH range',
          targetBest: 'Fill newest compatible DSH',
          pluginVersion: 'Plugin version',
          downloadAndPackage: 'Download and package',
          retry: 'Retry',
          dismiss: 'Dismiss',
          errorLabel: 'Error ·',
          unknownError: 'unknown error',
          networkError: 'Cannot reach the host service (network request failed).',
          badResponse: 'The host returned a response that cannot be read.',
          registryHint: 'An offline machine cannot read the npm registry; connect to the network and retry.',
          versionRequired: 'Pick a plugin version first.',
          targetRequired: 'Enter the target DSH version first.',
          staleHint: 'If errors persist, a server module may not be ready yet (expected while under development).',
          loadHint: 'Press Refresh to retry.',
          outputBlock: 'Package output directory',
          outputDir: 'Output directory',
          outputDefault: 'Use default',
          outputHint: 'Leave empty to use $DSH_HOME/offline-packages; any writable absolute path (shared drive, workspace) is accepted and the zip lands there.',
          outputInvalid: 'The output directory must be an absolute path.',
          progressLabel: 'Packaging progress',
          elapsed: 'Elapsed',
          packagingPercent: (n) => `Packing… ${n}%`,
          advancedBlock: 'Advanced packaging options',
          advancedHint: 'Embed more dependencies on demand: use it only when the target machine lacks packages; the package gets bigger.',
          advancedScopeNote: 'Applies to "Build offline package" (the local channel) only; version history already embeds that version\'s full declared dependency tree and ignores these options.',
          embedNotApplicable: 'Version history already embeds that version\'s full declared dependency tree (including browser libraries); advanced packaging options do not apply to this channel.',
          expandOptions: 'Show',
          collapseOptions: 'Hide',
          advancedSummary: (parts) => (parts.length === 0 ? 'Default (embed only the missing runtime dependencies)' : `Enabled: ${parts.join(' · ')}`),
          advancedSummaryHost: 'embed host runtime deps',
          advancedSummaryDeclared: 'embed all declared deps',
          advancedSummaryExtra: (n) => `+${n} extra package${n === 1 ? '' : 's'}`,
          embedHost: 'Embed host runtime dependencies (ws / schemastery / node-pty / @deepseek-ai/* …)',
          embedHostHint: 'Bigger package, and the host service may end up with two instances; use only when the target machine lacks the package.',
          embedDeclared: 'Embed every dependency the plugin declares (full dependencies + optionalDependencies tree)',
          embedDeclaredHint: 'Significantly larger package; usually only for a target machine with no node_modules at all.',
          extraPackagesLabel: 'Extra packages to embed (comma or space separated)',
          extraPackagesPlaceholder: 'ws, node-pty',
          extraPackagesHint: 'The local path embeds the installed version; name@version is not supported, and unresolvable names are reported in the result warnings.',
          hostOverride: 'Specify the host manually (modded / non-standard DSH)',
          hostOverrideHint: 'Fill these in when the host cannot be detected (non-standard dsh command, unusual node version, …). The default scan source stays this machine DSH_HOME/profile.',
          hostInstallDir: 'DSH install directory',
          hostInstallHint: 'A directory containing @deepseek-ai/dsh/package.json; leave empty to auto-detect.',
          hostVersionField: 'DSH version',
          hostVersionHint: 'Type it when unknown, e.g. 0.2.1-rc.2.',
          hostOverrideApply: 'Apply and refresh',
          hostOverrideOpenHint: 'These values ride along with /api/state and packaging requests; leave empty to fall back to auto-detection.',
          hostSource: (source) => `Host source: ${source}`,
          hostSourceUnknown: 'The host could not be detected automatically; specify it manually or ignore this.',
          vendoredNone: 'No dependencies embedded (all provided by the host)',
          vendoredList: (n) => `${n} dependenc${n === 1 ? 'y' : 'ies'} embedded`,
        }

    /** How many job log lines the panel keeps in view. */
    const MAX_LOG_LINES = 200
    /** Cycled by the zoom button: readable small type in a narrow settings column. */
    const LOG_FONT_SIZES = [11, 12, 13.5]
    /** One poll per second while a job is running, then stop. */
    const POLL_INTERVAL_MS = 1000
    /** Bounds a request so a stalled host cannot spin a button forever. */
    const DEFAULT_TIMEOUT_MS = 30000
    /** The first state scan can walk a large install; give it more room. */
    const STATE_TIMEOUT_MS = 120000
    /** Newest npm versions worth listing in the narrow panel. */
    const MAX_MATRIX_ROWS = 40
    /** DSH version chips offered as target shortcuts. */
    const MAX_DSH_CHIPS = 12
    /** Persisted per-browser choice of package output directory ('' = host default). */
    const OUTPUT_DIR_KEY = 'dsh-offline-packer:output-dir' // ui-copy-ignore
    /** Read the remembered output directory; storage may be denied, so never throw. */
    const readStoredOutputDir = () => {
      try {
        return String(window.localStorage.getItem(OUTPUT_DIR_KEY) ?? '')
      } catch {
        return ''
      }
    }
    /** Remember one output directory; a denied store costs persistence only. */
    const storeOutputDir = (value) => {
      try {
        window.localStorage.setItem(OUTPUT_DIR_KEY, String(value ?? ''))
      } catch {
        // Persistence is a convenience: the current page still uses the value.
      }
    }

    /** Persisted browser choices for the advanced embed options and the manual host override. */
    const ADVANCED_OPEN_KEY = 'dsh-offline-packer:advanced-open' // ui-copy-ignore
    const EMBED_OPTIONS_KEY = 'dsh-offline-packer:embed' // ui-copy-ignore
    const HOST_OVERRIDE_KEY = 'dsh-offline-packer:host-override' // ui-copy-ignore
    const HOST_OVERRIDE_OPEN_KEY = 'dsh-offline-packer:host-override-open' // ui-copy-ignore

    /** Storage is denied in some profiles: a read that fails reads as "nothing remembered". */
    const readStoredText = (key) => {
      try {
        return String(window.localStorage.getItem(key) ?? '')
      } catch {
        return ''
      }
    }
    const storeText = (key, value) => {
      try {
        window.localStorage.setItem(key, String(value ?? ''))
      } catch {
        // Persistence is a convenience: this page keeps the live value.
      }
    }
    const readStoredFlag = (key) => readStoredText(key) === '1'
    const storeFlag = (key, value) => storeText(key, value === true ? '1' : '0')
    const readStoredJson = (key) => {
      const raw = readStoredText(key)
      if (raw === '') return null
      try {
        const value = JSON.parse(raw)
        return value !== null && typeof value === 'object' ? value : null
      } catch {
        return null
      }
    }
    const storeJson = (key, value) => storeText(key, JSON.stringify(value ?? {}))

    /** The remembered advanced embed options; anything unreadable falls back to defaults. */
    const readStoredEmbed = () => {
      const stored = readStoredJson(EMBED_OPTIONS_KEY)
      return {
        includeHostProvided: stored?.includeHostProvided === true,
        includeAllDeclared: stored?.includeAllDeclared === true,
        extraPackages: typeof stored?.extraPackages === 'string' ? stored.extraPackages : '',
      }
    }
    /** The remembered manual host override (empty = auto-detect). */
    const readStoredHostOverride = () => {
      const stored = readStoredJson(HOST_OVERRIDE_KEY)
      return {
        dshInstallDir: typeof stored?.dshInstallDir === 'string' ? stored.dshInstallDir : '',
        dshVersion: typeof stored?.dshVersion === 'string' ? stored.dshVersion : '',
      }
    }

    /** Split a free-form package list ("ws, node-pty") into unique package names. */
    function parsePackageList(text) {
      if (typeof text !== 'string') return []
      const names = []
      const seen = new Set()
      for (const part of text.split(/[\s,，;；]+/u)) {
        const name = part.trim()
        if (name === '' || seen.has(name)) continue
        seen.add(name)
        names.push(name)
      }
      return names
    }

    // ------------------------------------------------------------------
    // HTTP envelope helpers
    // ------------------------------------------------------------------

    /** Build an Error carrying the envelope's `code`, so callers can show both halves. */
    function fail(code, message, status) {
      const error = new Error(message)
      error.code = code
      if (typeof status === 'number') error.status = status
      return error
    }

    /** Read one JSON envelope; `{ok:false,error}` becomes a thrown Error. */
    async function request(path, options) {
      const { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = options ?? {}
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
      const init = { method, cache: 'no-store', credentials: 'same-origin' }
      if (controller !== null) init.signal = controller.signal
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' } // ui-copy-ignore
        init.body = JSON.stringify(body)
      }
      let response
      try {
        response = await fetch(`${BASE}${path}`, init)
      } catch (error) {
        const aborted = controller !== null && controller.signal.aborted === true
        throw fail(
          aborted ? 'TIMEOUT' : 'NETWORK',
          `${COPY.networkError}${error instanceof Error && error.message !== '' ? ` (${error.message})` : ''}`,
        )
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null || typeof payload !== 'object') {
        throw fail('BAD_RESPONSE', `${COPY.badResponse} (HTTP ${response.status})`, response.status)
      }
      if (payload.ok === true) return payload.value
      const envelope = payload.error !== null && typeof payload.error === 'object' ? payload.error : {}
      throw fail(
        typeof envelope.code === 'string' && envelope.code !== '' ? envelope.code : `HTTP_${response.status}`,
        typeof envelope.message === 'string' && envelope.message !== '' ? envelope.message : COPY.unknownError,
        response.status,
      )
    }

    // ------------------------------------------------------------------
    // Small formatting helpers
    // ------------------------------------------------------------------

    /** Human-readable byte size; `—` for anything that is not a real size. */
    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || Number.isFinite(bytes) === false || bytes < 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      const units = ['KB', 'MB', 'GB']
      let value = bytes / 1024
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
    }

    /** `2026-10-29` from an ISO stamp; anything unreadable is shown as it came. */
    function fmtDate(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** Show `—` for an absent value, never `undefined`/`null`. */
    function shown(value) {
      if (value === null || value === undefined || value === '') return '—'
      return String(value)
    }

    /** Stable newest-first ordering for published version rows. */
    function newestFirst(rows) {
      return rows.slice().sort((a, b) => String(b?.published ?? '').localeCompare(String(a?.published ?? '')))
    }

    // ------------------------------------------------------------------
    // Styles — inline only, neutral palette that reads on light and dark themes
    // ------------------------------------------------------------------

    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        color: 'currentColor',
        font: 'inherit',
        fontSize: 13,
        lineHeight: 1.5,
        paddingBottom: 8,
      },
      titleBlock: { display: 'flex', flexDirection: 'column', gap: 2 },
      title: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.35 },
      subtitle: { margin: 0, fontSize: 12, opacity: 0.72 },
      panel: {
        border: '1px solid rgba(128,128,128,0.28)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'rgba(128,128,128,0.05)',
      },
      card: {
        border: '1px solid rgba(128,128,128,0.28)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'rgba(128,128,128,0.03)',
      },
      metaGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: '6px 12px',
      },
      metaCell: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
      metaLabel: { fontSize: 11, opacity: 0.62, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      metaValue: { fontSize: 12, wordBreak: 'break-word' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 120 },
      label: { fontSize: 12, opacity: 0.75, whiteSpace: 'nowrap' },
      input: {
        font: 'inherit',
        fontSize: 12.5,
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.36)',
        background: 'rgba(128,128,128,0.06)',
        color: 'currentColor',
        outline: 'none',
        minWidth: 0,
        boxSizing: 'border-box',
      },
      inputWide: { flex: 1, minWidth: 140 },
      inputNarrow: { width: 120 },
      buttonBase: {
        font: 'inherit',
        fontSize: 12.5,
        lineHeight: '18px',
        padding: '5px 10px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.36)',
        background: 'rgba(128,128,128,0.10)',
        color: 'currentColor',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        border: '1px solid rgba(128,128,128,0.55)',
        background: 'rgba(128,128,128,0.22)',
        fontWeight: 600,
      },
      buttonSubtle: {},
      buttonHover: { background: 'rgba(128,128,128,0.30)' },
      buttonDisabled: { opacity: 0.45, cursor: 'default' },
      buttonSmall: { fontSize: 11.5, padding: '3px 8px' },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 6px',
        borderRadius: 999,
        fontSize: 11,
        lineHeight: '18px',
        border: '1px solid rgba(128,128,128,0.30)',
        background: 'rgba(128,128,128,0.12)',
        whiteSpace: 'nowrap',
      },
      badgeOk: { background: 'rgba(76,175,110,0.18)' },
      badgeWarn: { background: 'rgba(226,168,60,0.20)' },
      badgeError: { background: 'rgba(226,92,92,0.20)' },
      badgeMuted: { opacity: 0.7 },
      chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      chip: {
        font: 'inherit',
        fontSize: 11,
        lineHeight: '16px',
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,0.32)',
        background: 'rgba(128,128,128,0.08)',
        color: 'currentColor',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      chipActive: { background: 'rgba(128,128,128,0.30)', fontWeight: 600 },
      list: { display: 'flex', flexDirection: 'column', gap: 8 },
      matrixPanel: {
        border: '1px dashed rgba(128,128,128,0.38)',
        borderRadius: 8,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'rgba(128,128,128,0.04)',
      },
      table: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 190, overflowY: 'auto' },
      tableHead: {
        display: 'grid',
        gridTemplateColumns: '104px 82px 1fr',
        gap: 8,
        fontSize: 10.5,
        opacity: 0.62,
        padding: '0 4px',
      },
      tableRow: {
        display: 'grid',
        gridTemplateColumns: '104px 82px 1fr',
        gap: 8,
        alignItems: 'baseline',
        textAlign: 'left',
        font: 'inherit',
        fontSize: 11.5,
        color: 'currentColor',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: 6,
        padding: '3px 4px',
        cursor: 'pointer',
        minWidth: 0,
      },
      tableRowSelected: {
        border: '1px solid rgba(128,128,128,0.45)',
        background: 'rgba(128,128,128,0.18)',
      },
      note: { fontSize: 11.5, opacity: 0.75 },
      optionHint: { fontSize: 11, opacity: 0.62, lineHeight: 1.45 },
      checkRow: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, lineHeight: 1.5, cursor: 'pointer' },
      subPanel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        border: '1px dashed rgba(128,128,128,0.35)',
        borderRadius: 8,
        padding: '8px 10px',
      },
      blockTitle: { fontSize: 11, fontWeight: 600, opacity: 0.66, letterSpacing: '0.02em', marginTop: 2 },
      warnBox: {
        border: '1px solid rgba(226,168,60,0.42)',
        background: 'rgba(226,168,60,0.12)',
        borderRadius: 6,
        padding: '5px 8px',
        fontSize: 11.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      },
      errorBox: {
        border: '1px solid rgba(226,92,92,0.46)',
        background: 'rgba(226,92,92,0.10)',
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      notice: {
        border: '1px solid rgba(128,128,128,0.34)',
        background: 'rgba(128,128,128,0.10)',
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 12,
      },
      logBox: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        background: 'rgba(128,128,128,0.10)',
        border: '1px solid rgba(128,128,128,0.24)',
        borderRadius: 6,
        padding: '6px 8px',
        maxHeight: 200,
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      link: { color: 'inherit', textDecoration: 'underline', fontWeight: 600 },
      footer: { fontSize: 11, opacity: 0.6 },
    }

    // ------------------------------------------------------------------
    // Tiny presentational pieces
    // ------------------------------------------------------------------

    /** A button with an inline hover tint (no stylesheet, both themes). */
    function Btn(props) {
      const [hover, setHover] = useState(false)
      const disabled = props.disabled === true
      const style = Object.assign(
        {},
        S.buttonBase,
        props.primary === true ? S.buttonPrimary : S.buttonSubtle,
        props.small === true ? S.buttonSmall : null,
        disabled ? S.buttonDisabled : null,
        hover && disabled === false ? S.buttonHover : null,
        props.style ?? null,
      )
      return h(
        'button',
        {
          type: 'button', // ui-copy-ignore
          disabled,
          title: props.title,
          'data-testid': props.testid,
          style,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        props.children,
      )
    }

    /** One small state pill. */
    function Badge(props) {
      const toneStyle =
        props.tone === 'ok'
          ? S.badgeOk
          : props.tone === 'warn'
            ? S.badgeWarn
            : props.tone === 'error'
              ? S.badgeError
              : props.tone === 'muted'
                ? S.badgeMuted
                : null
      return h('span', { style: Object.assign({}, S.badge, toneStyle), 'data-testid': props.testid }, props.children)
    }

    /** One labelled value cell in a meta grid. */
    function Meta(props) {
      return h(
        'div',
        { style: S.metaCell },
        h('span', { style: S.metaLabel }, props.label),
        h(
          'span',
          {
            style: props.mono === true ? Object.assign({}, S.metaValue, S.mono) : S.metaValue,
            title: typeof props.title === 'string' ? props.title : undefined,
            'data-testid': props.testid,
          },
          props.children,
        ),
      )
    }

    /** One long path on its own line: label, then a single-line mono value with a full tooltip. */
    function PathLine(props) {
      return h(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 } },
        h('span', { style: Object.assign({}, S.metaLabel, { flex: 'none', width: 150 }) }, props.label),
        h(
          'span',
          {
            style: Object.assign({}, S.mono, {
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }),
            title: props.value,
            'data-testid': props.testid,
          },
          props.value,
        ),
      )
    }

    /** Envelope error, in both halves: the code says what the server decided, the message why. */
    function ErrorBanner(props) {
      const error = props.error
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'ERROR'
      const message = typeof error?.message === 'string' && error.message !== '' ? error.message : COPY.unknownError
      return h(
        'div',
        { style: S.errorBox, role: 'alert', 'data-testid': props.testid ?? 'offline-packer-error' },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 12 } }, `${COPY.errorLabel} ${code}`),
          h('span', { style: { fontSize: 12, opacity: 0.85, wordBreak: 'break-word' } }, message),
        ),
        typeof error?.hint === 'string' && error.hint !== ''
          ? h('div', { style: S.note }, error.hint)
          : null,
        props.onRetry !== undefined || props.onDismiss !== undefined
          ? h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              props.onRetry !== undefined
                ? h(Btn, { small: true, testid: 'offline-packer-retry', onClick: props.onRetry }, COPY.retry)
                : null,
              props.onDismiss !== undefined
                ? h(Btn, { small: true, testid: 'offline-packer-error-dismiss', onClick: props.onDismiss }, COPY.dismiss)
                : null,
            )
          : null,
      )
    }

    // ------------------------------------------------------------------
    // Job panel: one polled job at a time, log tail, download link
    // ------------------------------------------------------------------

    function JobPanel(props) {
      const job = props.job
      const data = props.data
      const [zoom, setZoom] = useState(0)
      const [floor, setFloor] = useState(0)
      const logRef = useRef(null)

      const status =
        typeof data?.status === 'string' ? data.status : props.fetchError !== null ? 'unknown' : 'running'
      const running = status === 'running'
      const statusLabel =
        status === 'done' ? COPY.jobDone : status === 'error' ? COPY.jobError : running ? COPY.jobRunning : COPY.jobStarting
      const tone = status === 'done' ? 'ok' : status === 'error' ? 'error' : 'warn'
      const logs = Array.isArray(data?.logs) ? data.logs : []
      const start = Math.max(floor, Math.max(0, logs.length - MAX_LOG_LINES))
      const shownLines = logs.slice(start)
      const result = status === 'done' && data?.result !== null && typeof data?.result === 'object' ? data.result : null
      const jobError = data?.error !== null && typeof data?.error === 'object' ? data.error : null

      // Follow the tail as lines arrive; the box stays its own scroll container.
      useEffect(() => {
        const node = logRef.current
        if (node !== null && node !== undefined) node.scrollTop = node.scrollHeight
      }, [shownLines.length, zoom])

      const zipName = typeof result?.zipName === 'string' ? result.zipName : ''
      /** A custom output directory lives outside the host default, so downloads name it. */
      const customRoot = typeof props.outputDir === 'string' ? props.outputDir.trim() : ''
      const downloadRootQuery = customRoot === '' ? '' : `&outputRoot=${encodeURIComponent(customRoot)}`
      const downloadHref = zipName === '' ? '' : `${BASE}/api/download?name=${encodeURIComponent(zipName)}${downloadRootQuery}`

      // Progress comes from the node half's phase/percent sink; the elapsed clock is
      // derived locally so it keeps ticking between one-second polls.
      const progressPhase = typeof data?.progress?.phase === 'string' ? data.progress.phase : ''
      const progressPercent =
        typeof data?.progress?.percent === 'number' && Number.isFinite(data.progress.percent)
          ? Math.max(0, Math.min(100, Math.round(data.progress.percent)))
          : null
      const progressStartedAt = typeof data?.startedAt === 'number' ? data.startedAt : null
      const progressFinishedAt = typeof data?.finishedAt === 'number' ? data.finishedAt : null
      const elapsedMs =
        progressStartedAt === null ? null : Math.max(0, (progressFinishedAt ?? Date.now()) - progressStartedAt)
      const warnings = Array.isArray(result?.warnings) ? result.warnings.filter((row) => typeof row === 'string') : []
      const vendored = Array.isArray(result?.vendored) ? result.vendored : []

      return h(
        'section',
        { style: S.panel, 'data-testid': 'offline-packer-job', 'data-job-id': job.id, 'data-job-status': status },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 13 } }, COPY.jobTitle),
          h(Badge, { tone, testid: 'offline-packer-job-status' }, statusLabel),
          h(
            'span',
            { style: Object.assign({}, S.mono, { opacity: 0.68 }) },
            `${job.kind === 'registry' ? COPY.jobKindRegistry : COPY.jobKindLocal} · ${job.pluginName ?? ''}`,
          ),
          h('span', { style: { flex: 1 } }),
          h(
            Btn,
            { small: true, testid: 'offline-packer-job-zoom', onClick: () => setZoom((current) => (current + 1) % LOG_FONT_SIZES.length) },
            `${COPY.logZoom} ${LOG_FONT_SIZES[zoom]}px`,
          ),
          h(
            Btn,
            { small: true, testid: 'offline-packer-job-clear', onClick: () => setFloor(logs.length) },
            COPY.logClear,
          ),
          h(
            Btn,
            { small: true, testid: 'offline-packer-job-dismiss', onClick: props.onDismiss, title: COPY.jobDismissHint },
            COPY.jobDismiss,
          ),
        ),

        h(
          'div',
          {
            style: { display: 'flex', flexDirection: 'column', gap: 4 },
            'data-testid': 'offline-packer-progress',
            'data-progress-percent': progressPercent === null ? '' : String(progressPercent),
          },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, opacity: 0.75 } }, COPY.progressLabel),
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, progressPhase === '' ? COPY.jobStarting : progressPhase),
            progressPercent === null
              ? null
              : h('span', { style: { fontSize: 12, opacity: 0.7 } }, `${progressPercent}%`),
            elapsedMs === null
              ? null
              : h('span', { style: { fontSize: 11, opacity: 0.55 } }, `${COPY.elapsed} ${(elapsedMs / 1000).toFixed(1)}s`),
          ),
          h(
            'div',
            {
              style: { height: 6, borderRadius: 3, background: 'rgba(128,128,128,0.22)', overflow: 'hidden' },
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': progressPercent === null ? undefined : progressPercent,
              'aria-label': COPY.progressLabel,
            },
            h('div', {
              style: {
                height: '100%',
                width: `${progressPercent === null ? 20 : progressPercent}%`,
                borderRadius: 3,
                background: 'currentColor',
                opacity: progressPercent === null ? 0.3 : 0.7,
                transition: 'width 400ms ease',
              },
            }),
          ),
        ),

        props.fetchError !== null
          ? h(ErrorBanner, { error: props.fetchError, testid: 'offline-packer-job-error' })
          : null,

        job.kind === 'registry'
          ? h(
              'div',
              { style: S.note, 'data-testid': 'offline-packer-embed-not-applicable' },
              COPY.embedNotApplicable,
            )
          : null,

        status === 'error' || jobError !== null
          ? h(
              'div',
              { style: S.errorBox, role: 'alert', 'data-testid': 'offline-packer-job-failure' },
              h('strong', { style: { fontSize: 12 } }, `${COPY.errorLabel} ${shown(jobError?.code)}`),
              h('span', { style: { fontSize: 12, opacity: 0.85, wordBreak: 'break-word' } }, shown(jobError?.message)),
            )
          : null,

        result !== null && zipName !== ''
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 }, 'data-testid': 'offline-packer-result' },
              h(
                'div',
                { style: S.row },
                h('strong', { style: { fontSize: 13 } }, COPY.result),
                h(Badge, { tone: 'ok' }, COPY.jobDone),
                elapsedMs === null
                  ? null
                  : h('span', { style: { fontSize: 11, opacity: 0.55 } }, `${COPY.elapsed} ${(elapsedMs / 1000).toFixed(1)}s`),
                h('span', { style: { flex: 1 } }),
                h(
                  'a',
                  {
                    href: downloadHref,
                    download: zipName,
                    style: Object.assign({}, S.link, { fontWeight: 600 }),
                    'data-testid': 'offline-packer-download',
                  },
                  `${COPY.download} · ${zipName}`,
                ),
              ),
              h(
                'div',
                { style: S.metaGrid },
                h(Meta, { label: COPY.size }, fmtBytes(result.sizeBytes)),
                h(Meta, { label: COPY.zipPluginVersion, mono: true }, shown(result.version)),
                h(Meta, { label: COPY.zipTarget, mono: true, testid: 'offline-packer-result-target' }, shown(result.targetDshVersion)),
                h(Meta, { label: COPY.zipMode }, result.mode === 'registry' ? COPY.jobKindRegistry : COPY.zipModeLocal),
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
                h(PathLine, { label: COPY.zipName, value: zipName, testid: 'offline-packer-result-zipname' }),
                h(PathLine, { label: COPY.zipPath, value: shown(result.zipPath) }),
                h(PathLine, { label: COPY.zipDir, value: shown(result.dir) }),
              ),
              h(
                'div',
                {
                  style: S.note,
                  'data-testid': 'offline-packer-result-vendored',
                  'data-vendored-count': vendored.length,
                },
                vendored.length === 0
                  ? COPY.vendoredNone
                  : `${COPY.vendoredList(vendored.length)}: ${vendored.map((entry) => shown(entry)).join(', ')}`,
              ),
              warnings.length > 0
                ? h(
                    'div',
                    { style: S.warnBox },
                    ...warnings.map((line, index) => h('div', { key: `job-warning-${index}` }, line)),
                  )
                : null,
            )
          : null,

        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
            h('span', { style: { fontSize: 12, opacity: 0.75 } }, COPY.logs),
            h('span', { style: { fontSize: 11, opacity: 0.55 } }, `${shownLines.length}/${logs.length}`),
            floor > 0 ? h('span', { style: { fontSize: 11, opacity: 0.55 } }, COPY.logCleared) : null,
          ),
          h(
            'div',
            {
              ref: logRef,
              style: Object.assign({}, S.logBox, { fontSize: LOG_FONT_SIZES[zoom] }),
              'data-testid': 'offline-packer-job-logs',
              'data-log-count': shownLines.length,
              role: 'log',
            },
            shownLines.length === 0
              ? h('span', { style: { opacity: 0.6 } }, COPY.logsEmpty)
              : shownLines.map((line, index) => h('div', { key: `job-log-${start + index}` }, line)),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // Version matrix panel: npm versions + target DSH, per plugin
    // ------------------------------------------------------------------

    /**
     * Whether one published plugin version declares support for a target DSH version.
     * A version that declares no DSH peer range is "unknown": it stays visible so a
     * plugin that never pinned the host is still packable, but it is never auto-picked
     * on the strength of a range it does not have.
     */
    function versionSupportsTarget(row, target) {
      const peers = Array.isArray(row?.dshPeers) ? row.dshPeers.filter((entry) => typeof entry === 'string') : []
      if (peers.length === 0) return true
      const compatible = Array.isArray(row?.compatibleDsh) ? row.compatibleDsh : []
      return compatible.includes(target)
    }

    /** Whether a row declares a DSH range at all (false = unknown, not "supports everything"). */
    function versionDeclaresRange(row) {
      return Array.isArray(row?.dshPeers) && row.dshPeers.filter((entry) => typeof entry === 'string').length > 0
    }

    function HistoryPanel(props) {
      const plugin = props.plugin
      const [matrix, setMatrix] = useState({ status: 'loading', value: null, error: null })
      const [selected, setSelected] = useState('')
      const [target, setTarget] = useState(props.defaultTarget ?? '')
      /** Reveal every published version, including ones whose range misses the target. */
      const [showAll, setShowAll] = useState(false)

      const load = useCallback(async () => {
        setMatrix({ status: 'loading', value: null, error: null })
        try {
          const value = await request(`/api/matrix?plugin=${encodeURIComponent(plugin.name)}`, { timeoutMs: 45000 })
          setMatrix({ status: 'ready', value: value !== null && typeof value === 'object' ? value : {}, error: null })
        } catch (error) {
          setMatrix({
            status: 'error',
            value: null,
            error: {
              code: typeof error?.code === 'string' ? error.code : 'ERROR',
              message: error?.message !== undefined ? String(error.message) : COPY.unknownError,
              hint: COPY.registryHint,
            },
          })
        }
      }, [plugin.name])

      useEffect(() => {
        void load()
      }, [load])

      /** Every published version, newest first (the matrix API already sorts, but not by contract). */
      const rowsAll = useMemo(() => {
        const rows = Array.isArray(matrix.value?.versions) ? matrix.value.versions : []
        return newestFirst(rows)
      }, [matrix])

      const targetTrim = target.trim()
      /** Rows whose declared range covers the target (unknown-range rows count as visible). */
      const compatibleRows = useMemo(
        () => (targetTrim === '' ? rowsAll : rowsAll.filter((row) => versionSupportsTarget(row, targetTrim))),
        [rowsAll, targetTrim],
      )
      const noneCompatible = targetTrim !== '' && rowsAll.length > 0 && compatibleRows.length === 0
      const filtering = showAll === false && targetTrim !== '' && noneCompatible === false && compatibleRows.length !== rowsAll.length
      /** What the table shows: filtered unless the user asked for everything or nothing matched. */
      const visibleRows = showAll || noneCompatible || targetTrim === '' ? rowsAll : compatibleRows
      const versions = visibleRows.slice(0, MAX_MATRIX_ROWS)

      const dshVersions = useMemo(() => {
        const rows = Array.isArray(matrix.value?.dshVersions) ? matrix.value.dshVersions : []
        return newestFirst(rows).slice(0, MAX_DSH_CHIPS)
      }, [matrix])

      // A target is the primary choice, so the selected version follows it: keep the
      // current version only while it still declares support, otherwise take the newest
      // compatible one. With no target yet, default to the newest published version.
      useEffect(() => {
        if (matrix.status !== 'ready' || rowsAll.length === 0) return
        setSelected((current) => {
          const currentRow = rowsAll.find((row) => row?.version === current)
          if (targetTrim !== '' && currentRow !== undefined && versionSupportsTarget(currentRow, targetTrim)) return current
          if (targetTrim !== '' && compatibleRows.length > 0) return compatibleRows[0].version ?? current
          if (current !== '') return current
          return rowsAll[0].version ?? ''
        })
      }, [matrix.status, rowsAll, compatibleRows, targetTrim])

      const selectedRow = rowsAll.find((row) => row?.version === selected)
      /** DSH versions the selected plugin version itself declares (its full range, not the 12 newest). */
      const selectedCompatible = Array.isArray(selectedRow?.compatibleDsh)
        ? selectedRow.compatibleDsh.filter((entry) => typeof entry === 'string')
        : []
      const selectedIncompatible =
        targetTrim !== '' && selectedRow !== undefined && versionDeclaresRange(selectedRow) && versionSupportsTarget(selectedRow, targetTrim) === false

      const busy = props.busy === true
      const canPackage = busy === false && selected !== '' && targetTrim !== ''
      const selectVersion = (version) => {
        setSelected(version)
        // One click on a version with a declared range can fill an empty target.
        if (targetTrim !== '') return
        const row = rowsAll.find((entry) => entry?.version === version)
        const compatible = Array.isArray(row?.compatibleDsh) ? row.compatibleDsh : []
        if (compatible.length > 0 && typeof compatible[0] === 'string') setTarget(compatible[0])
      }

      return h(
        'div',
        { style: S.matrixPanel, 'data-testid': 'offline-packer-history', 'data-plugin-name': plugin.name },
        h('div', { style: S.note }, COPY.matrixNetwork),

        matrix.status === 'loading'
          ? h('div', { style: S.note, 'data-testid': 'offline-packer-matrix-loading' }, COPY.matrixLoading)
          : null,

        matrix.status === 'error' ? h(ErrorBanner, { error: matrix.error, onRetry: () => void load() }) : null,

        matrix.status === 'ready' && rowsAll.length === 0
          ? h('div', { style: S.note, 'data-testid': 'offline-packer-matrix-empty' }, COPY.matrixEmpty)
          : null,

        // 1) The target DSH version comes first: it is the constraint the version list follows.
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 }, 'data-testid': 'offline-packer-target-block' },
          h(
            'div',
            { style: S.row },
            h('span', { style: S.label }, COPY.targetDsh),
            h('input', {
              type: 'text', // ui-copy-ignore
              style: Object.assign({}, S.input, S.inputNarrow),
              placeholder: COPY.targetDshPlaceholder,
              value: target,
              'data-testid': 'offline-packer-target-dsh',
              onChange: (event) => setTarget(event.target.value),
              spellCheck: false,
            }),
            selectedCompatible.length > 0
              ? h(
                  Btn,
                  {
                    small: true,
                    testid: 'offline-packer-target-best',
                    onClick: () => {
                      if (typeof selectedCompatible[0] === 'string') setTarget(selectedCompatible[0])
                    },
                  },
                  COPY.targetBest,
                )
              : null,
          ),
          h('div', { style: S.note }, COPY.targetHint),
          dshVersions.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                h('span', { style: S.label }, COPY.targetDshPick),
                h(
                  'div',
                  { style: S.chips },
                  ...dshVersions.map((row, index) => {
                    const version = typeof row?.version === 'string' ? row.version : ''
                    const active = version !== '' && version === targetTrim
                    return h(
                      'button',
                      {
                        key: `dsh-chip-${version}-${index}`,
                        type: 'button', // ui-copy-ignore
                        style: Object.assign({}, S.chip, active ? S.chipActive : null),
                        'data-testid': 'offline-packer-dsh-version',
                        title: fmtDate(row?.published),
                        onClick: () => setTarget(version),
                      },
                      version,
                    )
                  }),
                ),
              )
            : null,
        ),

        // 2) The version table follows the target.
        matrix.status === 'ready' && rowsAll.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: S.note }, COPY.matrixBindingHint),
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                h('strong', { style: { fontSize: 12 } }, COPY.matrixTitle),
                h('span', { style: { fontSize: 11, opacity: 0.6 } }, COPY.matrixCount(rowsAll.length)),
                filtering
                  ? h(
                      'span',
                      { style: { fontSize: 11, opacity: 0.7 }, 'data-testid': 'offline-packer-matrix-filter-note' },
                      COPY.matrixFilterNote(compatibleRows.length, rowsAll.length, targetTrim),
                    )
                  : null,
                h('span', { style: { flex: 1 } }),
                targetTrim !== ''
                  ? h(
                      Btn,
                      {
                        small: true,
                        testid: 'offline-packer-matrix-filter-toggle',
                        onClick: () => setShowAll((current) => current === false),
                      },
                      showAll ? COPY.matrixShowCompatible : COPY.matrixShowAll,
                    )
                  : null,
              ),
              noneCompatible
                ? h('div', { style: S.warnBox, 'data-testid': 'offline-packer-matrix-no-compatible' }, COPY.matrixNoCompatible(targetTrim))
                : null,
              selectedIncompatible
                ? h(
                    'div',
                    { style: S.warnBox, 'data-testid': 'offline-packer-matrix-selected-incompatible' },
                    COPY.matrixSelectedIncompatible(selected, targetTrim),
                  )
                : null,
              h(
                'div',
                { style: S.table, 'data-testid': 'offline-packer-matrix-list' },
                h(
                  'div',
                  { style: S.tableHead },
                  h('span', null, COPY.matrixVersions),
                  h('span', null, COPY.matrixPublished),
                  h('span', null, COPY.matrixPeers),
                ),
                ...versions.map((row) => {
                  const version = typeof row?.version === 'string' ? row.version : ''
                  const peers = Array.isArray(row?.dshPeers) ? row.dshPeers.filter((entry) => typeof entry === 'string') : []
                  const compatible = Array.isArray(row?.compatibleDsh) ? row.compatibleDsh : []
                  const isSelected = version !== '' && version === selected
                  const rowSupported = versionSupportsTarget(row, targetTrim)
                  const rowDeclares = versionDeclaresRange(row)
                  const rowMark = rowDeclares === false ? '?' : rowSupported ? '✓' : '⚠'
                  const rowTitle =
                    rowDeclares === false
                      ? COPY.matrixRowUnknown
                      : rowSupported
                        ? COPY.matrixRowSupports
                        : COPY.matrixRowUnsupported
                  return h(
                    'button',
                    {
                      key: `matrix-${version}`,
                      type: 'button', // ui-copy-ignore
                      style: Object.assign({}, S.tableRow, isSelected ? S.tableRowSelected : null),
                      'data-testid': 'offline-packer-matrix-row',
                      'data-version': version,
                      'data-compatible': rowDeclares === false ? 'unknown' : rowSupported ? 'yes' : 'no',
                      'aria-pressed': isSelected,
                      onClick: () => selectVersion(version),
                      title: `${rowTitle}${compatible.length > 0 ? ` · ${COPY.matrixCompatible(compatible.length)}` : ''}`,
                    },
                    h('span', { style: S.mono }, version === '' ? '—' : version),
                    h('span', { style: { opacity: 0.75 } }, fmtDate(row?.published)),
                    h(
                      'span',
                      { style: { opacity: peers.length === 0 ? 0.6 : 1, wordBreak: 'break-word' } },
                      peers.length === 0 ? COPY.notDeclared : peers.join(', '),
                      h('span', { style: { marginLeft: 6, opacity: 0.8 }, 'data-testid': 'offline-packer-matrix-mark' }, rowMark),
                    ),
                  )
                }),
              ),
              rowsAll.length > versions.length
                ? h('div', { style: { fontSize: 11, opacity: 0.6 } }, COPY.matrixTruncated(versions.length))
                : null,

              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                h('span', { style: S.label }, COPY.pluginVersion),
                h(
                  'select',
                  {
                    style: Object.assign({}, S.input, S.inputWide),
                    'data-testid': 'offline-packer-version-select',
                    value: selected,
                    onChange: (event) => selectVersion(event.target.value),
                  },
                  ...versions.map((row) => {
                    const version = typeof row?.version === 'string' ? row.version : ''
                    return h('option', { key: `select-${version}`, value: version }, version)
                  }),
                ),
              ),

              // 3) What the selected version itself promises, so the pairing is visible.
              selectedCompatible.length > 0
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                    h('span', { style: S.label }, COPY.matrixCompatibleDshTitle(selected)),
                    h(
                      'div',
                      { style: S.chips },
                      ...selectedCompatible.slice(0, MAX_DSH_CHIPS).map((version, index) => {
                        const active = version === targetTrim
                        return h(
                          'button',
                          {
                            key: `sel-dsh-${version}-${index}`,
                            type: 'button', // ui-copy-ignore
                            style: Object.assign({}, S.chip, active ? S.chipActive : null),
                            'data-testid': 'offline-packer-selected-dsh-version',
                            onClick: () => setTarget(version),
                          },
                          version,
                        )
                      }),
                    ),
                  )
                : null,
            )
          : null,

        // 4) Package the pair (target + plugin version).
        h(
          'div',
          { style: S.row },
          h(
            Btn,
            {
              primary: true,
              small: true,
              disabled: canPackage === false,
              testid: 'offline-packer-package-registry',
              title: canPackage === false ? (selected === '' ? COPY.versionRequired : COPY.targetRequired) : undefined,
              onClick: () =>
                props.onPackage({
                  pluginName: plugin.name,
                  version: selected,
                  targetDshVersion: targetTrim,
                }),
            },
            COPY.downloadAndPackage,
          ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // One plugin row
    // ------------------------------------------------------------------

    function PluginCard(props) {
      const plugin = props.plugin
      const expanded = props.expanded === true
      const busy = props.busy === true
      const name = typeof plugin?.name === 'string' ? plugin.name : ''
      const version = shown(plugin?.version)
      const kind = plugin?.kind === 'bundle' ? COPY.kindBundle : plugin?.kind === 'installation' ? COPY.kindInstallation : COPY.kindPlugin
      const warnings = Array.isArray(plugin?.warnings) ? plugin.warnings.filter((entry) => typeof entry === 'string' && entry !== '') : []
      const kindTone = plugin?.kind === 'bundle' ? 'ok' : plugin?.kind === 'installation' ? 'muted' : 'warn'
      const enabled = plugin?.enabled === false ? false : true
      const installed = plugin?.installed !== false
      const client = plugin?.client !== null && typeof plugin?.client === 'object' ? plugin.client : null
      const clientText =
        client === null ? '—' : typeof client.platform === 'string' && client.platform !== '' ? client.platform : '✓'
      const clientInject = client !== null && Array.isArray(client.inject) && client.inject.length > 0 ? ` · inject ${client.inject.length}` : ''
      const sizeText =
        typeof plugin?.sizeBytes === 'number'
          ? `${fmtBytes(plugin.sizeBytes)} · ${COPY.files(typeof plugin?.fileCount === 'number' ? plugin.fileCount : 0)}`
          : '—'

      return h(
        'section',
        { style: S.card, 'data-testid': 'offline-packer-row', 'data-plugin-name': name },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 13.5, wordBreak: 'break-word' } }, name),
          h('span', { style: Object.assign({}, S.mono, { opacity: 0.7 }) }, version),
          h(Badge, { tone: kindTone, testid: 'offline-packer-kind' }, kind),
          h(Badge, { tone: enabled ? 'ok' : 'muted', testid: 'offline-packer-enabled' }, enabled ? COPY.enabled : COPY.disabled),
          installed ? null : h(Badge, { tone: 'warn' }, COPY.notInstalled),
        ),

        typeof plugin?.description === 'string' && plugin.description !== ''
          ? h('p', { style: { margin: 0, fontSize: 12, opacity: 0.75 } }, plugin.description)
          : null,

        h(
          'div',
          { style: S.metaGrid },
          h(Meta, { label: COPY.peer, testid: 'offline-packer-peer', mono: true, title: shown(plugin?.peerDsh) }, shown(plugin?.peerDsh)),
          h(Meta, { label: COPY.size }, sizeText),
          h(Meta, { label: COPY.clientHalf, testid: 'offline-packer-client' }, `${shown(clientText)}${clientInject}`),
          h(Meta, { label: COPY.serverHalf, testid: 'offline-packer-server', mono: true, title: shown(plugin?.serverEntry) }, plugin?.serverEntry ? '✓' : '—'),
        ),

        typeof plugin?.source === 'string' && plugin.source !== ''
          ? h(PathLine, { label: COPY.source, value: plugin.source, testid: 'offline-packer-source' })
          : null,

        warnings.length > 0
          ? h(
              'div',
              { style: S.warnBox, 'data-testid': 'offline-packer-warnings' },
              h('strong', { style: { fontSize: 11, opacity: 0.8 } }, COPY.warnings),
              ...warnings.map((line, index) => h('div', { key: `warning-${index}` }, line)),
            )
          : null,

        h(
          'div',
          { style: S.row },
          h(
            Btn,
            {
              primary: true,
              disabled: busy || name === '',
              testid: 'offline-packer-package-local',
              title: busy ? COPY.jobBusy : undefined,
              onClick: () => props.onPackageLocal(plugin),
            },
            props.busyPluginName === name ? COPY.packagingLocal : COPY.packageLocal,
          ),
          h(
            Btn,
            {
              testid: 'offline-packer-history-toggle',
              onClick: () => props.onToggleHistory(expanded ? '' : name),
            },
            expanded ? COPY.historyHide : COPY.history,
          ),
        ),

        expanded
          ? h(HistoryPanel, {
              plugin,
              defaultTarget: props.defaultTarget ?? '',
              busy: busy,
              onPackage: props.onPackageRegistry,
            })
          : null,
      )
    }

    // ------------------------------------------------------------------
    // The settings section
    // ------------------------------------------------------------------

    function OfflinePackerSection() {
      const [state, setState] = useState(null)
      const [loading, setLoading] = useState(true)
      const [stateError, setStateError] = useState(null)
      const [form, setForm] = useState({ home: '', profile: '' })
      const [search, setSearch] = useState('')
      const [expanded, setExpanded] = useState('')
      const [job, setJob] = useState(null)
      const [jobData, setJobData] = useState(null)
      const [jobFetchError, setJobFetchError] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [notice, setNotice] = useState('')
      /** Chosen output directory ('' = host default); remembered across page loads. */
      const [outputDir, setOutputDir] = useState(readStoredOutputDir)
      /** A POST that has not answered yet: a second press must not start a second job. */
      const [starting, setStarting] = useState(false)
      /** Advanced embed options, remembered per browser (extra packages stay as typed text). */
      const [advancedOpen, setAdvancedOpen] = useState(() => readStoredFlag(ADVANCED_OPEN_KEY))
      const [embed, setEmbed] = useState(readStoredEmbed)
      /** Manual host override for modded/non-standard DSH installs, remembered per browser. */
      const [hostOverride, setHostOverride] = useState(readStoredHostOverride)
      const [hostOverrideOpen, setHostOverrideOpen] = useState(() => readStoredFlag(HOST_OVERRIDE_OPEN_KEY))
      /** The override read at mount decides what the first state scan asks for. */
      const initialHostOverride = useRef(hostOverride)
      /** The job panel is scrolled into view as soon as a job starts. */
      const jobAnchor = useRef(null)

      /** Read host facts + plugin inventory for the given scan source. */
      const loadState = useCallback(async (query) => {
        setLoading(true)
        setStateError(null)
        try {
          const params = new URLSearchParams()
          const home = typeof query?.home === 'string' ? query.home.trim() : ''
          const profile = typeof query?.profile === 'string' ? query.profile.trim() : ''
          if (home !== '') params.set('home', home)
          if (profile !== '') params.set('profile', profile)
          const dshInstallDir = typeof query?.dshInstallDir === 'string' ? query.dshInstallDir.trim() : ''
          const dshVersion = typeof query?.dshVersion === 'string' ? query.dshVersion.trim() : ''
          if (dshInstallDir !== '') params.set('dshInstallDir', dshInstallDir)
          if (dshVersion !== '') params.set('dshVersion', dshVersion)
          const suffix = params.toString() === '' ? '' : `?${params.toString()}`
          const value = await request(`/api/state${suffix}`, { timeoutMs: STATE_TIMEOUT_MS })
          const safe = value !== null && typeof value === 'object' ? value : { plugins: [] }
          setState(safe)
          setForm({
            home: typeof safe.dshHome === 'string' ? safe.dshHome : '',
            profile: typeof safe.profile === 'string' ? safe.profile : '',
          })
          setOutputDir((current) => {
            if (current !== '') return current
            return typeof safe.outputRoot === 'string' ? safe.outputRoot : ''
          })
        } catch (error) {
          setStateError(error)
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void loadState({
          dshInstallDir: initialHostOverride.current.dshInstallDir,
          dshVersion: initialHostOverride.current.dshVersion,
        })
      }, [loadState])

      // Remember both option sets and both fold states; a denied store only costs persistence.
      useEffect(() => {
        storeJson(EMBED_OPTIONS_KEY, embed)
      }, [embed])
      useEffect(() => {
        storeJson(HOST_OVERRIDE_KEY, hostOverride)
      }, [hostOverride])
      useEffect(() => {
        storeFlag(ADVANCED_OPEN_KEY, advancedOpen)
      }, [advancedOpen])
      useEffect(() => {
        storeFlag(HOST_OVERRIDE_OPEN_KEY, hostOverrideOpen)
      }, [hostOverrideOpen])

      /**
       * Poll the single active job once a second until it settles. The effect is
       * keyed on the job id, so starting a second job (or unmounting the section)
       * tears the previous poller down: exactly one poller can ever be alive.
       */
      useEffect(() => {
        if (job === null) return undefined
        let cancelled = false
        let timer = null
        let misses = 0
        const tick = async () => {
          try {
            const value = await request(`/api/job?id=${encodeURIComponent(job.id)}`, { timeoutMs: 15000 })
            if (cancelled) return
            misses = 0
            setJobFetchError(null)
            setJobData(value !== null && typeof value === 'object' ? value : null)
            if (value?.status === 'running') timer = setTimeout(tick, POLL_INTERVAL_MS)
          } catch (error) {
            if (cancelled) return
            misses += 1
            setJobFetchError(error)
            const fatal = error?.code === 'JOB_NOT_FOUND' || error?.code === 'BAD_RESPONSE'
            if (misses < 3 && fatal === false) timer = setTimeout(tick, POLL_INTERVAL_MS)
          }
        }
        void tick()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [job])

      useEffect(() => {
        if (job === null) return
        const node = jobAnchor.current
        if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      }, [job?.id])

      const jobRunning = job !== null && (jobData === null ? true : jobData.status === 'running')
      const busy = jobRunning || starting

      /** POST one packaging request and attach its job to the poller. */
      const startJob = useCallback(
        async (path, body, kind) => {
          setActionError(null)
          setNotice('')
          if (starting === true || (job !== null && (jobData === null || jobData.status === 'running'))) {
            setNotice(COPY.jobBusy)
            return
          }
          setStarting(true)
          try {
            const value = await request(path, { method: 'POST', body })
            const jobId = value !== null && typeof value === 'object' && typeof value.jobId === 'string' ? value.jobId : ''
            if (jobId === '') throw fail('BAD_RESPONSE', COPY.badResponse)
            setJob({ id: jobId, kind, pluginName: typeof body?.pluginName === 'string' ? body.pluginName : '' })
            setJobData(null)
            setJobFetchError(null)
          } catch (error) {
            setActionError(error)
          } finally {
            setStarting(false)
          }
        },
        [job, jobData, starting],
      )

      const hostVersion = useMemo(() => {
        const version = state?.host?.dshVersion
        return typeof version === 'string' && version !== '' && version !== 'unknown' ? version : ''
      }, [state])

      /** The manual host override as request fields; empty values are never sent. */
      const hostOverridePayload = useMemo(
        () => ({
          dshInstallDir: hostOverride.dshInstallDir.trim(),
          dshVersion: hostOverride.dshVersion.trim(),
        }),
        [hostOverride],
      )

      /** Advanced embed request: both booleans always travel, an empty extra list does not. */
      const embedRequest = useMemo(() => {
        const request = {
          includeHostProvided: embed.includeHostProvided === true,
          includeAllDeclared: embed.includeAllDeclared === true,
        }
        const extra = parsePackageList(embed.extraPackages)
        if (extra.length > 0) request.extraPackages = extra
        return request
      }, [embed])

      /** What the collapsed advanced panel says it has switched on. */
      const advancedParts = useMemo(() => {
        const parts = []
        if (embed.includeHostProvided === true) parts.push(COPY.advancedSummaryHost)
        if (embed.includeAllDeclared === true) parts.push(COPY.advancedSummaryDeclared)
        const extra = parsePackageList(embed.extraPackages)
        if (extra.length > 0) parts.push(COPY.advancedSummaryExtra(extra.length))
        return parts
      }, [embed])

      /** How the node half says it found (or was told) the DSH install. */
      const hostSource = typeof state?.host?.source === 'string' ? state.host.source : ''

      /** Build from the installed copy; the scan source is the one this page shows. */
      const packageLocal = useCallback(
        (plugin) => {
          const body = { pluginName: plugin.name }
          if (hostVersion !== '') body.targetDshVersion = hostVersion
          if (typeof state?.dshHome === 'string' && state.dshHome.startsWith('/')) body.home = state.dshHome
          if (typeof state?.profile === 'string' && state.profile !== '') body.profile = state.profile
          if (outputDir.trim() !== '') body.outputRoot = outputDir.trim()
          body.embed = embedRequest
          if (hostOverridePayload.dshInstallDir !== '') body.dshInstallDir = hostOverridePayload.dshInstallDir
          if (hostOverridePayload.dshVersion !== '') body.dshVersion = hostOverridePayload.dshVersion
          void startJob('/api/package-local', body, 'local')
        },
        [embedRequest, hostOverridePayload, hostVersion, outputDir, startJob, state],
      )

      /** Build one published version for a target DSH release (needs network). */
      const packageRegistry = useCallback(
        (payload) => {
          const body = Object.assign({}, payload)
          if (outputDir.trim() !== '') body.outputRoot = outputDir.trim()
          if (hostOverridePayload.dshInstallDir !== '') body.dshInstallDir = hostOverridePayload.dshInstallDir
          if (hostOverridePayload.dshVersion !== '') body.dshVersion = hostOverridePayload.dshVersion
          void startJob('/api/package-registry', body, 'registry')
        },
        [hostOverridePayload, outputDir, startJob],
      )

      const plugins = Array.isArray(state?.plugins) ? state.plugins : []
      const filtered = useMemo(() => {
        const query = search.trim().toLowerCase()
        const list = plugins.slice().sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')))
        if (query === '') return list
        return list.filter((plugin) => {
          const fields = [plugin?.name, plugin?.version, plugin?.description, plugin?.kind, plugin?.peerDsh]
          if (Array.isArray(plugin?.warnings)) for (const warning of plugin.warnings) fields.push(warning)
          return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(query))
        })
      }, [plugins, search])

      const outputRoot = typeof state?.outputRoot === 'string' ? state.outputRoot : ''
      /**
       * The scanned profile directory must live under the scanned home. A server that answers
       * with this host's directory instead would make the info bar look like it describes the
       * current profile, so a mismatch is named rather than silently shown.
       */
      const profileDirMismatch = useMemo(() => {
        const home = typeof state?.dshHome === 'string' ? state.dshHome.replace(/\\/gu, '/').replace(/\/+$/gu, '') : ''
        const dir = typeof state?.profileDir === 'string' ? state.profileDir.replace(/\\/gu, '/').replace(/\/+$/gu, '') : ''
        if (home === '' || dir === '') return false
        return dir !== home && dir.startsWith(`${home}/`) === false
      }, [state])
      const refresh = () => {
        void loadState({
          home: form.home,
          profile: form.profile,
          dshInstallDir: hostOverridePayload.dshInstallDir,
          dshVersion: hostOverridePayload.dshVersion,
        })
      }

      /**
       * Commit the typed host override and rescan immediately. Both values ride along with
       * `/api/state` and every packaging request; leaving them empty keeps auto-detection.
       */
      const applyHostOverride = () => {
        storeJson(HOST_OVERRIDE_KEY, hostOverride)
        setHostOverrideOpen(true)
        void loadState({
          home: form.home,
          profile: form.profile,
          dshInstallDir: hostOverridePayload.dshInstallDir,
          dshVersion: hostOverridePayload.dshVersion,
        })
      }

      return h(
        'div',
        { style: S.page, 'data-testid': 'offline-packer-page', 'data-plugin-count': plugins.length },

        h(
          'div',
          { style: S.titleBlock },
          h('h2', { style: S.title }, COPY.title),
          h('p', { style: S.subtitle }, COPY.subtitle),
        ),

        stateError !== null
          ? h(ErrorBanner, {
              error: {
                code: typeof stateError?.code === 'string' ? stateError.code : 'ERROR',
                message: stateError?.message !== undefined ? String(stateError.message) : COPY.unknownError,
                hint: COPY.staleHint,
              },
              onRetry: refresh,
              testid: 'offline-packer-state-error',
            })
          : null,

        // This host's facts, then the scan source the user may switch.
        h(
          'section',
          { style: S.panel, 'data-testid': 'offline-packer-host-info' },
          h('div', { style: S.blockTitle }, COPY.hostBlock),
          h(
            'div',
            { style: S.metaGrid },
            h(Meta, { label: COPY.hostDsh, mono: true, testid: 'offline-packer-host-version' }, shown(state?.host?.dshVersion)),
            h(Meta, { label: COPY.nodeVersion, mono: true }, shown(state?.host?.nodeVersion)),
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
            h(PathLine, { label: COPY.outputRoot, value: shown(outputRoot), testid: 'offline-packer-output-root' }),
            h(PathLine, { label: COPY.dshInstallDir, value: shown(state?.host?.dshInstallDir) }),
          ),
          // Manual host override for modded/non-standard DSH installs where detection fails.
          h(
            'div',
            {
              style: { display: 'flex', flexDirection: 'column', gap: 6 },
              'data-testid': 'offline-packer-host-override',
              'data-host-override-open': hostOverrideOpen ? '1' : '0',
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h(
                'div',
                { style: Object.assign({}, S.blockTitle, { marginTop: 0, flex: 1, minWidth: 140 }) },
                COPY.hostOverride,
              ),
              hostSource === ''
                ? null
                : h(
                    'span',
                    {
                      style: { fontSize: 11, opacity: 0.62 },
                      'data-testid': 'offline-packer-host-source',
                      'data-host-source': hostSource,
                    },
                    COPY.hostSource(hostSource),
                  ),
              h(
                Btn,
                {
                  small: true,
                  testid: 'offline-packer-host-override-toggle',
                  onClick: () => setHostOverrideOpen((current) => current === false),
                },
                hostOverrideOpen ? COPY.collapseOptions : COPY.expandOptions,
              ),
            ),
            hostSource === 'unknown'
              ? h(
                  'div',
                  { style: S.warnBox, 'data-testid': 'offline-packer-host-source-unknown' },
                  COPY.hostSourceUnknown,
                )
              : null,
            hostOverrideOpen
              ? h(
                  'div',
                  { style: S.subPanel },
                  h(
                    'div',
                    { style: S.row },
                    h('label', { style: S.label, htmlFor: 'offline-packer-host-install-input' }, COPY.hostInstallDir),
                    h('input', {
                      id: 'offline-packer-host-install-input', // ui-copy-ignore
                      type: 'text', // ui-copy-ignore
                      style: Object.assign({}, S.input, S.inputWide),
                      value: hostOverride.dshInstallDir,
                      placeholder: shown(state?.host?.dshInstallDir),
                      'data-testid': 'offline-packer-host-install-input',
                      onChange: (event) =>
                        setHostOverride((current) => Object.assign({}, current, { dshInstallDir: event.target.value })),
                      spellCheck: false,
                    }),
                  ),
                  h('div', { style: S.optionHint, 'data-testid': 'offline-packer-host-install-hint' }, COPY.hostInstallHint),
                  h(
                    'div',
                    { style: S.row },
                    h('label', { style: S.label, htmlFor: 'offline-packer-host-version-input' }, COPY.hostVersionField),
                    h('input', {
                      id: 'offline-packer-host-version-input', // ui-copy-ignore
                      type: 'text', // ui-copy-ignore
                      style: Object.assign({}, S.input, S.inputNarrow),
                      value: hostOverride.dshVersion,
                      placeholder: shown(state?.host?.dshVersion),
                      'data-testid': 'offline-packer-host-version-input',
                      onChange: (event) =>
                        setHostOverride((current) => Object.assign({}, current, { dshVersion: event.target.value })),
                      spellCheck: false,
                    }),
                    h(
                      Btn,
                      {
                        primary: true,
                        small: true,
                        testid: 'offline-packer-host-override-apply',
                        disabled: loading,
                        onClick: applyHostOverride,
                      },
                      COPY.hostOverrideApply,
                    ),
                  ),
                  h('div', { style: S.optionHint, 'data-testid': 'offline-packer-host-version-hint' }, COPY.hostVersionHint),
                  h('div', { style: S.optionHint, 'data-testid': 'offline-packer-host-override-hint' }, COPY.hostOverrideOpenHint),
                )
              : h('div', { style: S.note }, COPY.hostOverrideHint),
          ),
          h('div', { style: S.blockTitle }, COPY.scanBlock),
          h(
            'div',
            { style: S.row },
            h('label', { style: S.label, htmlFor: 'offline-packer-home-input' }, COPY.dshHome),
            h('input', {
              id: 'offline-packer-home-input', // ui-copy-ignore
              type: 'text', // ui-copy-ignore
              style: Object.assign({}, S.input, S.inputWide),
              value: form.home,
              placeholder: '/home/<user>/.dsh',
              'data-testid': 'offline-packer-home-input',
              onChange: (event) => setForm((current) => Object.assign({}, current, { home: event.target.value })),
              onKeyDown: (event) => {
                if (event.key === 'Enter') refresh()
              },
              spellCheck: false,
            }),
            h('label', { style: S.label, htmlFor: 'offline-packer-profile-input' }, COPY.profile),
            h('input', {
              id: 'offline-packer-profile-input', // ui-copy-ignore
              type: 'text', // ui-copy-ignore
              style: Object.assign({}, S.input, S.inputNarrow),
              value: form.profile,
              placeholder: 'web',
              'data-testid': 'offline-packer-profile-input',
              onChange: (event) => setForm((current) => Object.assign({}, current, { profile: event.target.value })),
              onKeyDown: (event) => {
                if (event.key === 'Enter') refresh()
              },
              spellCheck: false,
            }),
            h(
              Btn,
              { primary: true, testid: 'offline-packer-refresh', disabled: loading, onClick: refresh },
              loading ? COPY.loading : COPY.refresh,
            ),
          ),
          h(PathLine, { label: COPY.profileDir, value: shown(state?.profileDir), testid: 'offline-packer-profile-dir' }),
          profileDirMismatch
            ? h(
                'div',
                { style: S.warnBox, 'data-testid': 'offline-packer-profile-dir-mismatch' },
                COPY.profileDirMismatch,
              )
            : null,
          h('div', { style: S.note }, COPY.scanHint),
        ),

        // Where the zip lands. Blank keeps the host default; a typed absolute path is
        // sent with every packaging request and remembered by this browser.
        h(
          'section',
          { style: S.panel, 'data-testid': 'offline-packer-output' },
          h('div', { style: S.blockTitle }, COPY.outputBlock),
          h(
            'div',
            { style: S.row },
            h('label', { style: S.label, htmlFor: 'offline-packer-output-input' }, COPY.outputDir),
            h('input', {
              id: 'offline-packer-output-input', // ui-copy-ignore
              type: 'text', // ui-copy-ignore
              style: Object.assign({}, S.input, S.inputWide),
              value: outputDir,
              placeholder: shown(state?.outputRoot),
              'data-testid': 'offline-packer-output-input',
              onChange: (event) => {
                setOutputDir(event.target.value)
                storeOutputDir(event.target.value)
              },
              spellCheck: false,
            }),
            h(
              Btn,
              {
                small: true,
                testid: 'offline-packer-output-default',
                onClick: () => {
                  const fallback = typeof state?.outputRoot === 'string' ? state.outputRoot : ''
                  setOutputDir(fallback)
                  storeOutputDir(fallback)
                },
              },
              COPY.outputDefault,
            ),
          ),
          h('div', { style: S.note }, COPY.outputHint),
        ),

        // On-demand embedding: the local path normally trims to what the plugin really needs,
        // so these switches are opt-in, remembered per browser, and echoed in the result.
        h(
          'section',
          {
            style: S.panel,
            'data-testid': 'offline-packer-advanced',
            'data-advanced-open': advancedOpen ? '1' : '0',
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h(
              'div',
              { style: Object.assign({}, S.blockTitle, { marginTop: 0, flex: 1, minWidth: 120 }) },
              COPY.advancedBlock,
            ),
            h(
              'span',
              { style: { fontSize: 11, opacity: 0.62 }, 'data-testid': 'offline-packer-advanced-summary' },
              COPY.advancedSummary(advancedParts),
            ),
            h(
              Btn,
              {
                small: true,
                testid: 'offline-packer-advanced-toggle',
                onClick: () => setAdvancedOpen((current) => current === false),
              },
              advancedOpen ? COPY.collapseOptions : COPY.expandOptions,
            ),
          ),
          advancedOpen
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h(
                  'label',
                  { style: S.checkRow, htmlFor: 'offline-packer-embed-host' },
                  h('input', {
                    id: 'offline-packer-embed-host', // ui-copy-ignore
                    type: 'checkbox', // ui-copy-ignore
                    checked: embed.includeHostProvided === true,
                    'data-testid': 'offline-packer-embed-host',
                    onChange: (event) =>
                      setEmbed((current) => Object.assign({}, current, { includeHostProvided: event.target.checked })),
                  }),
                  h(
                    'span',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                    h('span', null, COPY.embedHost),
                    h(
                      'span',
                      { style: S.optionHint, 'data-testid': 'offline-packer-embed-host-hint' },
                      COPY.embedHostHint,
                    ),
                  ),
                ),
                h(
                  'label',
                  { style: S.checkRow, htmlFor: 'offline-packer-embed-declared' },
                  h('input', {
                    id: 'offline-packer-embed-declared', // ui-copy-ignore
                    type: 'checkbox', // ui-copy-ignore
                    checked: embed.includeAllDeclared === true,
                    'data-testid': 'offline-packer-embed-declared',
                    onChange: (event) =>
                      setEmbed((current) => Object.assign({}, current, { includeAllDeclared: event.target.checked })),
                  }),
                  h(
                    'span',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                    h('span', null, COPY.embedDeclared),
                    h(
                      'span',
                      { style: S.optionHint, 'data-testid': 'offline-packer-embed-declared-hint' },
                      COPY.embedDeclaredHint,
                    ),
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                  h('label', { style: S.label, htmlFor: 'offline-packer-extra-packages' }, COPY.extraPackagesLabel),
                  h('input', {
                    id: 'offline-packer-extra-packages', // ui-copy-ignore
                    type: 'text', // ui-copy-ignore
                    style: Object.assign({}, S.input, S.inputWide),
                    value: embed.extraPackages,
                    placeholder: COPY.extraPackagesPlaceholder,
                    'data-testid': 'offline-packer-extra-packages',
                    onChange: (event) =>
                      setEmbed((current) => Object.assign({}, current, { extraPackages: event.target.value })),
                    spellCheck: false,
                  }),
                  h(
                    'div',
                    { style: S.optionHint, 'data-testid': 'offline-packer-extra-packages-hint' },
                    COPY.extraPackagesHint,
                  ),
                ),
              )
            : h('div', { style: S.note }, COPY.advancedHint),
          h('div', { style: S.optionHint, 'data-testid': 'offline-packer-advanced-scope' }, COPY.advancedScopeNote),
        ),

        h(
          'div',
          { ref: jobAnchor },
          job !== null
            ? h(JobPanel, {
                key: job.id,
                job,
                data: jobData,
                outputDir,
                fetchError: jobFetchError,
                onDismiss: () => {
                  setJob(null)
                  setJobData(null)
                  setJobFetchError(null)
                },
              })
            : null,
        ),

        actionError !== null
          ? h(ErrorBanner, {
              error: actionError,
              onDismiss: () => setActionError(null),
              testid: 'offline-packer-action-error',
            })
          : null,

        notice !== ''
          ? h('div', { style: S.notice, role: 'status', 'data-testid': 'offline-packer-notice' }, notice)
          : null,

        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            type: 'search', // ui-copy-ignore
            style: Object.assign({}, S.input, S.inputWide),
            value: search,
            placeholder: COPY.searchPlaceholder,
            'data-testid': 'offline-packer-search',
            onChange: (event) => setSearch(event.target.value),
            'aria-label': COPY.searchPlaceholder,
          }),
          h('span', { style: { fontSize: 12, opacity: 0.7 } }, COPY.pluginCount(filtered.length)),
          typeof state?.hiddenOfficial === 'number' && state.hiddenOfficial > 0
            ? h(
                'span',
                { style: { fontSize: 12, opacity: 0.6 }, 'data-testid': 'offline-packer-hidden-official' },
                COPY.hiddenOfficial(state.hiddenOfficial),
              )
            : null,
        ),

        h(
          'div',
          { style: S.list, 'data-testid': 'offline-packer-list' },
          loading && state === null
            ? h('div', { style: S.note, 'data-testid': 'offline-packer-list-loading' }, COPY.listLoading)
            : null,
          state !== null && plugins.length === 0
            ? h(
                'div',
                { style: S.panel, 'data-testid': 'offline-packer-empty' },
                h('div', { style: { fontSize: 12.5 } }, COPY.listEmpty),
                h('div', { style: S.note }, COPY.loadHint),
              )
            : null,
          state !== null && plugins.length > 0 && filtered.length === 0
            ? h('div', { style: S.note, 'data-testid': 'offline-packer-no-match' }, `${COPY.searchPlaceholder}: 0`)
            : null,
          ...filtered.map((plugin) =>
            h(PluginCard, {
              key: `plugin-${plugin.name}`,
              plugin,
              expanded: expanded === plugin.name,
              busy,
              busyPluginName: jobRunning && job.pluginName === plugin.name ? plugin.name : '',
              busyPercent:
                jobRunning && job.pluginName === plugin.name && typeof jobData?.progress?.percent === 'number'
                  ? jobData.progress.percent
                  : null,
              defaultTarget: hostVersion,
              onPackageLocal: packageLocal,
              onPackageRegistry: packageRegistry,
              onToggleHistory: setExpanded,
            }),
          ),
        ),

        h('div', { style: S.footer }, COPY.listHint),
        h('div', { style: S.footer }, COPY.downloadHint),
      )
    }

    // The context this plugin already registered its section in. The host can replay an
    // injection (a remount, or a reload that keeps the context), and registering twice puts
    // the section in the nav rail twice.
    let appliedCtx = null

    return {
      inject: ['slots'], // ui-copy-ignore
      apply(ctx) {
        if (ctx === appliedCtx) return
        appliedCtx = ctx
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'offline-packer', // ui-copy-ignore
              order: 60, // ui-copy-ignore
              label: () => (zh ? '离线打包' : 'Offline Packager'), // ui-copy-ignore
            },
            OfflinePackerSection,
          ),
        )
      },
    }
  },
})
