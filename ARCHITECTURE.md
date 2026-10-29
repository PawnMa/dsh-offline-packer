# dsh-offline-packer — 架构与接口契约（唯一事实源）

目标：一个可装在 **DSH 0.2.1-rc.2**（开发宿主）上的 web 插件 `dsh-offline-packer`，三个能力：

1. **图形化列出当前宿主（可切换 DSH_HOME/profile）已安装的插件**；
2. **一键生成离线安装包**（zip：插件文件 + 内嵌服务端依赖 + 零联网 install 脚本 + README + CHECKSUMS）；
3. **按历史 DSH 适配版本打包**（从 npm registry 读版本矩阵，选与目标 DSH 版本 peer 兼容的插件版本，下载后做成离线包）。

目录：`/home/fc/dsh-offline-packer/`。全程纯 JS（无构建步骤）：服务端 ESM，客户端为 DSH 模块加载器 factory bundle。

## 0. 插件形态（宿主 0.2.1-rc.2 事实）

- `package.json`：
  ```json
  {
    "name": "dsh-offline-packer", "version": "0.1.0", "type": "module",
    "main": "./index.js",
    "exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
    "engines": { "dsh": ">=0.2.0-rc.1" },
    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },
      "client": { "platform": "web", "immediately": true, "inject": [] }
    }
  }
  ```
  client 入口 = `exports["./client"]`（host `dsh-client-modules` 的解析规则）；`dsh.client.inject` 只放客户端 bundle 运行时确实 `require` 的宿主模块——本插件只用 `react`（平台模块，无需注入）。
- `cordis.patch.yml`：`- insert:` 一行 `id: offline-packer / name: 'dsh-offline-packer'`。
- 服务端 `index.js` 导出：`export const name = 'dsh-offline-packer'`、`export const inject = ['webServer']`、`export function apply(ctx)`。
  - 运行期用 `ctx.get('pluginManager')`（存在时）读权威插件清单，不存在时降级为文件系统扫描；`ctx.get('logger')` 记日志。
- 客户端 `client.js` 形状（与宿主 `dsh-unlag` 相同）：
  ```js
  window.__ModuleLoader__.load({ id: 'dsh-offline-packer', factory(require) {
    const React = require('react')
    return { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'offline-packer', order: 60,
        label: () => (zh ? '离线打包' : 'Offline Packager'),
      }, OfflinePackerSection))
    } }
  } })
  ```
  `settings.section` 的 owner props 只有 `{ close }`；组件自行 fetch 服务端 API。文本中英文按 `navigator.language` 选择。

## 1. 服务端 HTTP API（index.js 负责路由，全部 JSON 信封 `{ok:true,value}` / `{ok:false,error:{code,message}}`）

前缀 `BASE = '/dsh-offline-packer'`。所有 handler 先过 **fence**：`Origin` 存在时必须与请求 `Host` 同源（等价 better-sidebar 做法）；写操作只允许 POST。

| 方法 | 路径 | 入参 | 返回 value |
|---|---|---|---|
| GET | `/api/state?home=<abs>&profile=<name>&includeOfficial=1&dshInstallDir=<abs>&dshVersion=<ver>` | 可选（后两个用于「魔改/非标准 dsh」手动指定宿主） | `{ host:{dshVersion,dshInstallDir,nodeVersion}, dshHome, profile, profileDir, outputRoot, plugins:[Plugin] }` |
| GET | `/api/plugins?home=&profile=&includeOfficial=1` | 可选 | `{ dshHome, profile, plugins:[Plugin] }` |
| POST | `/api/package-local` | `{pluginName, targetDshVersion?, home?, profile?, outputRoot?, dshInstallDir?, dshVersion?, embed?}` | `{ jobId }` |
| GET | `/api/matrix?plugin=<name>` | — | `{ plugin, versions:[VersionRow], dshVersions:[{version,published}] }` |
| POST | `/api/package-registry` | `{pluginName, version, targetDshVersion, outputRoot?}` | `{ jobId }` |
| GET | `/api/job?id=<jobId>` | — | `{ id, status:'running'\|'done'\|'error', progress:{phase,percent}, logs:[string], result?, error?, startedAt, finishedAt }` |
| GET | `/api/download?name=<zip 文件名>&outputRoot=<绝对目录>` | — | 二进制 zip（`Content-Disposition: attachment`；自定义输出目录时必须带 outputRoot） |

**embed 选项（本地通道按需多内嵌）**：`POST /api/package-local` 的 `embed` 字段：
```js
{ includeHostProvided?: boolean,   // 连宿主会提供的包（ws/schemastery/node-pty/@deepseek-ai/*）一起内嵌
  includeAllDeclared?: boolean,    // 内嵌插件 package.json 声明的全部 dependencies/optionalDependencies
  extraPackages?: string[] }       // 额外指定要内嵌的包名（本地解析；不支持 name@version）
```
`includeHostProvided`/`includeAllDeclared` 会增加体积并可能让宿主单例服务出现两份实例，结果 `warnings` 必须写明；`extraPackages` 里无法解析的包记 warning 不中断。

**官方内置插件默认隐藏**：`state/plugins` 只返回 `official === false` 的第三方插件，并附带 `hiddenOfficial`（被隐藏数量）与 `officialCount`；传 `includeOfficial=1`（或 `official=all`）才返回全部。`package-local` 对官方插件默认拒绝（错误码 `OFFICIAL_PLUGIN`），传 `includeOfficial:true` 可放行。

`Plugin`（`lib/inventory.mjs` 产出）：
```ts
{
  name: string, version: string|null, description?: string,
  kind: 'bundle'|'plugin'|'installation',   // 有 dsh.bundle.patch= bundle；profile 依赖无 patch=plugin；in-box=installation
  official: boolean,                          // 官方内置：@deepseek-ai/* 或解析目录在 dsh 安装目录内 / availability=installation
  installed: boolean, enabled: boolean, removable?: boolean,
  source?: string,                            // profile 里声明的 spec（file: 等）
  dir: string|null, realDir: string|null,     // 包目录（可能为符号链接）
  sizeBytes: number, fileCount: number,
  peerDsh: string|null,                       // 声明的 DSH 兼容范围（优先 @deepseek-ai/dsh，否则汇总 @deepseek-ai/dsh-* 范围）
  client: { platform?: string, inject?: string[] } | null,
  bundlePatch: string|null, serverEntry: string|null,
  warnings: string[]
}
```
`VersionRow`（`lib/registry.mjs`）：`{ version, published, dshPeers: string[], compatibleDsh: string[] }`。
关系模型：**插件版本 ↔ DSH 版本是「一对多 / 多对多」**——每个插件版本用 `peerDependencies` 声明一个 DSH 兼容范围（如 `^0.1.0-rc.7` 覆盖 rc.7、rc.8），一个 DSH 版本通常被多个插件版本覆盖。UI 以「目标 DSH 版本」为主选择：只列出声明兼容的插件版本并自动选最新兼容版（可切「显示全部版本」），同时展示所选插件版本声明的兼容 DSH 版本以便反查。

`result`（两种打包 job 相同）：
```ts
{ dir: string, zipPath: string, zipName: string, sizeBytes: number,
  pluginName: string, version: string, targetDshVersion: string,
  mode: 'local'|'registry', vendored: string[], warnings: string[] }
```

## 2. 模块接口（谁实现谁负责，签名冻结）

### lib/host.mjs（A）
```js
getHostInfo(overrides = {}) -> { dshHome, profile, dshInstallDir, dshVersion, nodeVersion,
                                 hostProvided: string[], source: string, overridden: {installDir:boolean, version:boolean} }
```
- `overrides = { dshInstallDir?, dshVersion? }`：UI 手动指定（魔改/非标准 dsh 场景）。指定后优先使用并跳过对应自动探测；`dshVersion` 未知时可为 `'unknown'`。
- 自动探测顺序：`DSH_INSTALL_DIR` env → argv[1] realpath 向上找 → **`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` 符号链接 realpath**（heal fallback 目录，魔改宿主常用）→ PATH 上 `dsh` 命令 → 常见全局目录。
- `dshInstallDir`：从 `process.argv[1]` realpath 向上找含 `package.json` 的 `@deepseek-ai/dsh` 目录；失败再试 `ctx` 无关的常见全局路径。
- `hostProvided`：BFS `dshInstallDir/package.json` 的 `dependencies`+`peerDependencies`（名字集合，像 healProfilesModuleFallback）。额外并入 `'react' | 'react-dom' | 'cordis'` 与否由 pack 决定，这里只返回安装闭包名字。
- `dshHome`：`process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')`；`profile`：`process.argv` 里 `--profile X` 或首个位置参数为 `web`/`headless`，否则 `'web'`。

### lib/inventory.mjs（A）
```js
listPlugins(ctx, { dshHome, profile } = {}) -> { dshHome, profile, profileDir, plugins: Plugin[] }
resolvePluginDir(dshHome, profile, name) -> { dir, realDir } | null   // profile/node_modules 与 installation node_modules
```
- 优先 `ctx?.get?.('pluginManager')?.listBundles()`（权威：version/installed/enabled/rows/source/removable/availability），拿到 name/version/description；目录用 `resolvePluginDir`。
- 无 service 时：读 `profile/package.json` 的 `dependencies` + `dsh.profile.bundles`，扫描 `node_modules` 顶层包（含 scoped），按清单产出。
- size/fileCount：递归 stat（跳过 `node_modules` 内部？**不跳过**：统计整目录，但 `realDir` 为符号链接时统计 realDir；上限 200k 文件防爆）。
- `peerDsh`：manifest.peerDependencies；取 `@deepseek-ai/dsh`，否则取所有 `@deepseek-ai/dsh-*` 值的并集（去重，逗号连接）。
- `warnings`：目录缺失 / version 缺失 / 无 server entry 等。

### lib/analyze.mjs（A）
```js
analyzeRuntimeExternals({ dir, manifest }) -> { externals: string[], scanned: string[], dynamicOptional: string[] }
```
- 扫描 `dir` 下 `manifest.main`/`exports['.']`/`lib/**/*.js`/`index.js`（存在者；跳过 node_modules/.git/types），正则找 `from "x"`、`import "x"`、`import("x")`、`require("x")`、`createRequire(...)("x")`。
- 过滤 `node:` 内建、相对/绝对路径、URL；归一化到包名（`@scope/name` 或 `name`，去掉子路径）。
- `event` 出现在 try/catch 的懒加载也算必需（失败会降级而非崩溃）→ 放 `dynamicOptional`，但包装时默认仍 vendor（宁多勿缺）；`externals` 只含静态必需，`dynamicOptional` 单独返回。

### lib/vendor.mjs（A）
```js
vendorExternals({ pluginDir, packages, hostProvided, destNodeModules, log }) -> { vendored:[{name,version,from}], skipped:[{name,reason}], warnings:[] }
```
- 对每个包名：`createRequire(join(pluginDir,'package.json')).resolve(name)` → realpath 包目录；命中 `hostProvided` 则 skip(reason 'host')；否则递归：读该包 `dependencies`，从它自己的位置 resolve，复制到 `destNodeModules/<name>`（扁平首见优先，撞版本记 warning）；`node_modules/.bin` 不复制；符号链接 unref 用 realpath 拷贝实体。
- 防环：`visited` set；深度上限 30。
- 注意：`schemastery`（裸包名）这类宿主不提供的包必须 vendor——A 用 `hostProvided` 判断，不做包名白名单特判。

### lib/zip.mjs（A）
```js
zipDirectory(zipPath, { rootName, files: [{ path, mode? }] , baseDir }) -> Promise<{ sizeBytes }>
```
- 纯 Node 实现（无第三方依赖）：本地文件头 + deflate（`zlib.deflateRaw`）+ 中央目录 + EOCD；CRC32 查表；目录项可省略；`install-offline.sh` 用 external attrs 存 0o100755（unix mode << 16）。生成后需能通过 `unzip -t`。

### lib/scripts.mjs（A）
```js
renderInstallers({ pluginName, version, targetDshVersion, hasVendoredDeps, mode }) -> { 'install-offline.sh': string, 'install-offline.ps1': string }
renderReadme({...}) -> string
renderVersionsText({...}) -> string
```
生成的安装器额外契约（v0.1.8 起）：
- **适配性校验**：读取插件 `peerDependencies` 中所有 `@deepseek-ai/dsh*` 范围，用 ES5 semver 匹配器对比探测到的宿主版本；不匹配默认中止（exit 2，`--force`/`-Force` 跳过并 warning）；宿主未知仅 warning；无 DSH peer 跳过；`--dry-run` 展示校验结果。
生成的安装器额外契约（v0.1.5 起）：
- bash 参数 `--dsh-home/--profile/--profile-dir/--node/--dsh-install/--plugin-src/--uninstall/--dry-run`，环境变量 `DSH_PROFILE_DIR`/`NODE_BIN`/`DSH_INSTALL_DIR`；ps1 对应 `-ProfileDir/-Node/-DshInstall`。
- profile 定位优先级（**显式 CLI 优先于环境变量**）：`--profile-dir > --dsh-home+--profile > DSH_PROFILE_DIR > $DSH_HOME+--profile > ~/.dsh/profiles/web`；PS 同款 `-ProfileDir > -DshHome+-Profile > $env:DSH_PROFILE_DIR > $env:DSH_HOME+Profile > ~/.dsh/profiles/<profile>`。环境变量推导目标与最终目标不一致时必须打印醒目 `[警告]`（含 unset 建议），一致时不告警。
- 内嵌 JSON 帮助脚本为 **ES5/Node 4+**（`require('fs')`，不用 `node:`/递归 mkdir/可选链/模板串），递归建目录由 shell 完成；Node major<10 仅 info。
- dsh 探测为**可选 info**：`--dsh-install`/`DSH_INSTALL_DIR` → 启动脚本安装目录 → `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh`（realpath）→ PATH `dsh`；探测不到不得报错/告警级，措辞避免「未安装 dsh 环境」。
- 行为与 `/home/fc/dsh-plugin-build/dist/dsh-better-sidebar-offline-0.13.1/install-offline.sh` 同款（可裁剪）：零联网、幂等、`--dsh-home/--profile/--plugin-src/--uninstall/--dry-run`、profile 缺失时按 rc.7/0.2 模板初始化（package.json+`dsh.profile.bundles`（web: base+web-app）/cordis.patch.yml/pnpm-workspace.yaml）、复制 `package/` 到 `$DSH_HOME/profiles/<p>/node_modules/<plugin>`、追加 bundles、旧手写挂载行告警、打印重启/验证提示。ps1 为 5.1 兼容、UTF-8 BOM + CRLF。
- 生成脚本必须按**目标 DSH 版本**写说明；模板常量放本文件，不做运行期网络。

### lib/pack.mjs（A，核心；B 复用）
```js
assembleOfflinePackage(opts) -> Promise<result>
// opts: {
//   srcDir,              // 插件包目录（已就绪，含需要的 node_modules 由 vendor 阶段写入 srcDir/node_modules 或 extraVendorDir）
//   pluginName, version, description?, peerDsh?,
//   targetDshVersion, mode: 'local'|'registry',
//   extraVendorDir?,     // 已解析好的 node_modules（registry 模式由 npm 产出），复制进 package/node_modules
//   outputRoot, log, progress,
//   includeHostPackages?,    // opt-in：允许把 @deepseek-ai/* 与 manifest peer 名写进产物（仅 local 的 includeHostProvided 传 true）
//   keepVendoredPackages?,   // 点名要内嵌的包（includeAllDeclared/extraPackages），覆盖命名空间/peer 过滤
//   vendoredVersions?,       // 让 result.vendored 取产物里的实际 name@version
//   warnings: string[]
// }
```
步骤：staging=`<outputRoot>/<plugin>-offline-<version>-dsh-<target>/`（先删）→ 复制 `srcDir` 到 `staging/package`（跳过 `node_modules`、`.git`、`package-lock.json`、`*.tgz`、`*.log`；`*.map` 保留）→ 若 `extraVendorDir` 存在则把其中非宿主/非 peer 的包复制进 `staging/package/node_modules/`（扁平 + 保留嵌套，跳过 `@deepseek-ai/*`、`react*`、`cordis`）→ 重写 `package/package.json`：`dependencies:{}`、`peerDependenciesMeta` 全 `{optional:true}`（保留 peerDependencies 列表）、保留 `dsh`/`exports`/`files` 等 → 生成 `install-offline.*`、`README.md`、`VERSIONS.txt`、`CHECKSUMS.txt` → `zip.mjs` 打 `staging` 为 `<outputRoot>/<plugin>-offline-<version>-dsh-<target>.zip`（zip 内顶层目录同名）→ 返回 `result`。

### lib/local.mjs（A，本地流水线，index.js 调用）
```js
buildLocalPackage({ pluginName, targetDshVersion, dshHome, profile, dshInstallDir, dshVersion, embed }, runtime) -> Promise<result>
// runtime: { ctx, outputRoot, log, progress }
// embed = { includeHostProvided?: boolean, includeAllDeclared?: boolean, extraPackages?: string[] }
```
= inventory 找插件 → `getHostInfo({dshInstallDir, dshVersion})` → analyze → 合并 embed 追加依赖 → vendor 到临时目录 → `assembleOfflinePackage`。若插件 `dir` 为 null 报 `PLUGIN_NOT_FOUND`。`result.vendored` 列出实际内嵌包名@版本，供 UI 展示。

`includeHostProvided` 的解析来源（v0.1.5 起）：宿主包（depth=0 且命中 hostProvided）**优先从当前 `dshInstallDir` 的依赖闭包解析**（`preferResolveFrom`），解析不到则记 warning 跳过、**不回落**到插件位置；传递依赖从其声明者位置解析，因此整棵内嵌树与当前宿主版本一致（不会误用 `$DSH_HOME/profiles/node_modules` 里的过期 heal 链接）。

### lib/registry.mjs（B）
```js
fetchPackument(name, { registry } = {}) -> object
listPluginVersions(name) -> { plugin, versions:[{version, published, dshPeers:string[]}], dshVersions:[{version,published}], registry }
downloadTarball(name, version, destFile) -> Promise<{ file, integrity? }>   // registry tarball URL
```
- registry 默认 `https://registry.npmjs.org`，可用 `process.env.DSH_OFFLINE_PACKER_REGISTRY` 覆盖；scoped 名称 URL 编码 `@scope%2fname`。
- DSH 版本列表来自 `@deepseek-ai/dsh` packument 的 `versions`；`dshPeers` 取该插件版本 `peerDependencies` 里 `@deepseek-ai/dsh*` 的范围。
- 提供 `satisfiesDsh(version, range)` 支持 caret/tilde/精确 + 预发布比较（`0.1.0-rc.8` 满足 `^0.1.0-rc.7`，`0.2.0-rc.1` 不满足；`^0.2.1-rc.1` 满足 `0.2.1-rc.2`）。

### lib/tar.mjs（B）
```js
extractTgz(tgzBuffer, destDir) -> Promise<void>   // 解析 gzip（zlib.gunzip）+ ustar 头；剥顶层 package/；支持 0x55 typeflag 长名 PaxHeader 可忽略；防路径穿越（拒绝 .. / 绝对路径）
```

### lib/historical.mjs（B）
```js
buildRegistryPackage({ pluginName, version, targetDshVersion }, runtime) -> Promise<result>
// runtime: { ctx, outputRoot, log }
```
步骤：`downloadTarball` → `extractTgz` 到 tmp → peer 兼容性检查（不支持只记 warning 不中止）→ 用 npm 安装运行时依赖：`npm install --omit=dev --ignore-scripts --no-save --no-audit --no-fund --prefix <tmp>` 安装 `<tmp>/package` 的 tarball 副本（等价 `npm install <tgz> --prefix`），把 `<tmp>/node_modules/<name>` 当作 srcDir、`<tmp>/node_modules` 当作 `extraVendorDir` → `assembleOfflinePackage`（mode registry）→ 清理临时目录（失败保留并日志给出路径）。
- npm 不存在时报错 `NPM_MISSING`（附提示：可先在有网机器打包）。npm 超时 10 分钟。

### lib/jobs.mjs（Lead）
```js
createJob(kind, runner) -> { id, kind }     // runner(log, progress) => Promise<result>
// progress(phase, percent|null) 写入 job.progress，UI 每秒轮询显示进度条
getJob(id) -> job | null                    // { id, kind, status, logs, result, error, startedAt, finishedAt }
listJobs() -> [{id, kind, status, startedAt, finishedAt}]
maxConcurrent = 2；超出返回错误码 JOB_BUSY。
```

### index.js（Lead）
- 路由实现上表；`home`/`profile` 入参仅允许绝对路径（`home`）与 `[A-Za-z0-9._-]+`（profile）；`download` 只允许 `<outputRoot>` 下的 `*.zip` 且 basename 无路径分隔符。
- `outputRoot` 默认 `join(dshHome, 'offline-packages')`（`dshHome` = 当前进程的 DSH_HOME），可在 `state` 中返回；写操作永远写 `outputRoot`，**绝不**写扫描来源 home。

## 3. 交付与验证

- 插件包 = 本项目目录（含 `package.json`/`index.js`/`client.js`/`lib/**`/`README.md`）。
- Lead 最后：`dsh plugin --profile web add <本地 tgz>` 装进用户当前 profile（`DSH_HOME=/home/fc/.dsh`，pnpm 本地 tgz 零联网），提示用户重启 dsh web 后，设置面板出现「离线打包」页。
- 验证（D + Lead）：
  1. 隔离宿主：`DSH_HOME=/home/fc/dsh-offline-packer/test/home node /home/fc/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 3081`；插件手动装进该 home（A/Lead 提供 `test/install-dev-plugin.sh`）。
  2. Playwright（`/home/fc/dsh-plugin-build/leadcheck/pw/node_modules/playwright-core`，chromium 在 `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`）：打开设置 → 离线打包页 → 看到插件列表 → 触发 local 打包 → 进度 → 结果下载链接；截图存 `test/artifacts/`。
  3. 产物校验：`unzip -t`、目录结构、manifest `dependencies:{}`/peers optional、`sha256sum -c CHECKSUMS.txt`、install-offline.sh 幂等与卸载。
  4. 产物可用性：local 模式产物装进全新 test home 后 `--dump-config`/boot manifest 含插件；registry 模式产物：打包 `dsh-better-sidebar@0.13.1` 目标 `0.1.0-rc.7`，装进 `/home/fc/dsh-plugin-build/host-pinned`（已有纯 rc.7 宿主）的全新 home，验证 boot manifest + `/sidebar/api/terminal.deps`。
  5. 历史矩阵 API：`/api/matrix?plugin=dsh-better-sidebar` 返回版本与 DSH 兼容列表，`0.13.1` 的 dshPeers 含 `^0.1.0-rc.7`。

## 4. 文件归属（写入范围）

| 负责 | 文件 |
|---|---|
| Lead | `package.json` `cordis.patch.yml` `index.js` `lib/jobs.mjs` `ARCHITECTURE.md` `README.md` `test/install-dev-plugin.sh` |
| A（server-core） | `lib/host.mjs` `lib/inventory.mjs` `lib/analyze.mjs` `lib/vendor.mjs` `lib/zip.mjs` `lib/scripts.mjs` `lib/pack.mjs` `lib/local.mjs` |
| B（registry） | `lib/registry.mjs` `lib/tar.mjs` `lib/historical.mjs` |
| C（client） | `client.js` |
| D（verifier） | `test/**`（自己的脚本与报告，除 `test/install-dev-plugin.sh`） |

约定：所有模块 ESM、纯 JS（不引入第三方 runtime 依赖）、只用 Node 内建；`console` 仅作兜底，日志经 `log(msg)` 回调。写文件后自测语法：`node --check <file>`（ESM 用 `node --input-type=module -e "import('./file')"` 或 `node --check` 支持 ESM? 对 .mjs 用 `node --check` 可用）。
