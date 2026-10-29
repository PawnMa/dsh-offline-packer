# task-9 报告：魔改/非标准宿主探测增强 + 本地打包「按需多内嵌」选项

> 负责人：server-core（A） ｜ 日期：2026-10-29 ｜ 项目：`/home/fc/dsh-offline-packer`
> 关联：ARCHITECTURE.md §1「embed 选项」/ §2 `host.mjs`、`local.mjs`；Lead 批准将 scope 扩大到 `lib/pack.mjs`（opt-in）与 `lib/vendor.mjs`（版本解析修复）。

## 0. 结论 / TL;DR

1. **宿主探测**重写为「override → `DSH_INSTALL_DIR` → argv[1] → profile heal fallback（`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` realpath）→ PATH 上的 `dsh` → 常见全局目录」六层，返回 `source` / `overridden` / `warnings`；版本未知返回 `'unknown'` 不抛错。26 项探测矩阵断言全部 PASS（`test/embed/logs/test-host.log`）。
2. **本地打包 embed** 三个选项全部实现：`includeHostProvided`（强制内嵌宿主包）、`includeAllDeclared`（内嵌 manifest 声明的全部 dependencies/optionalDependencies）、`extraPackages`（额外点名包，支持 `@scope/name`，带 `@version` 只 warning 不失败）。`result.vendored` 现在是「产物里实际存在的包名@版本」。
3. **pack.mjs opt-in**：新增 `includeHostPackages` / `keepVendoredPackages` / `vendoredVersions` 三个**向后兼容**参数；缺省（都不传）路径产物与 v1 **逐文件一致**（0.2.1-rc.2 的 2 个 local 包 + historical 0.13.1 包，package/ 树 aggregate SHA-256 全部相同）。
4. **版本正确性修复（Lead 联调反馈）**：`includeHostProvided` 的宿主包改为**优先从当前 `getHostInfo().dshInstallDir` 的依赖闭包解析**，解析不到则跳过 + warning，不再回落插件位置（避免命中过期的 heal fallback 符号链接）。修复后内嵌 `@deepseek-ai/dsh-*` 全部为 **0.2.1-rc.2**、`@deepseek-ai/schemastery@3.18.5`、`ws@8.22.0`，产物中不再出现 `host-pinned` 路径与 `0.1.0-rc.*` 版本。
5. 全部自测：`node --check` OK；`test-host` 26/26 PASS；`test-embed` **28/28** PASS；默认路径回归 2/2 PASS；historical 回归 PASS（12,859 文件 aggregate 一致、157 vendored、12,864 zip entries）；phase-1 selftest + verify-artifacts **47/47** PASS；单元测试 vendor / pack-filter / local-e2e PASS。
6. 过程中发生一次**测试环境变量导致安装器写入真实用户 profile** 的事故：根因是当前 agent shell 自带 `DSH_PROFILE_DIR`/`DSH_HOME`（安装器优先级正确，非 task-8 bug）；已用官方 npm tarball 恢复并由 Lead 独立复核干净；测试脚本已加固为剥离 `DSH_*`、沙盒 `HOME`、并在结尾校验真实 profile 指纹不变。

---

## 1. 变更文件（md5 / 说明）

| 文件 | md5（最终） | 变更 |
|---|---|---|
| `lib/host.mjs` | `babef71d4baa1de838a22233e505a5f8` | 重写：`getHostInfo(overrides={})`，六层探测 + `source/overridden/warnings` + override 归一化（包目录 / package.json / 安装根 / lib 目录）+ 版本回退（profile fallback dsh / dsh-base）+ hostProvided 闭包按最终 installDir 计算且缓存 |
| `lib/local.mjs` | `a3d3e1d96ef09422480d234b84e7a975` | request 增加 `dshInstallDir/dshVersion/embed`；embed 语义实现；新增依赖走同一 `vendorExternals`；`result.vendored` 由 pack 实际产物生成；progress/log 全链路 |
| `lib/pack.mjs` | `892dc25b374d8b823d3fbfcdedcfceda` | **opt-in**：`includeHostPackages`（默认 false）、`keepVendoredPackages`（点名即带，覆盖命名空间/peer 过滤）、`vendoredVersions`（decorate 实际 vendored 列表）；宿主命名空间内嵌 warning；默认路径语义/输出不变 |
| `lib/vendor.mjs` | `9b43f70cef2f7ff97c0f04f816e73302` | 新增 `includeHostProvided` / `preferResolveFrom`：宿主包优先从当前安装目录解析（realpath 后拷贝），解析不到记 warning 跳过、**不回落插件位置**；版本冲突 warning 标注来源（当前安装目录 / 插件位置 / 传递依赖）；默认（includeHostProvided=false）行为不变 |
| `test/embed/**`、`test/out-embed/**` | — | 本次新增的探测矩阵/embed 矩阵/回归脚本、日志、产物、baseline JSON |
| `test/a/verify-artifacts.sh` | — | 加固：installer 调用剥离 `DSH_*` 环境 + `HOME` 沙盒 + 优先 `--profile-dir`；结尾校验 `/home/fc/.dsh` 指纹不变（47 项检查） |
| `test/a/selftest.mjs`、`test/a/test-local-e2e.mjs`、`test/a/test-pack-filter.mjs` | — | 固定 `DSH_INSTALL_DIR=真实 0.2.1-rc.2 安装`，避免本沙盒 heal fallback 指向 host-pinned 导致基线漂移 |

> 未改 `index.js` / `client.js` / `package.json` / `ARCHITECTURE.md` / `lib/jobs.mjs` / `lib/registry.mjs` / `lib/tar.mjs` / `lib/historical.mjs` / `lib/inventory.mjs` / `lib/analyze.mjs` / `lib/zip.mjs` / `lib/scripts.mjs`。

---

## 2. A) 宿主探测矩阵（`node test/embed/test-host.mjs` → 26/26 PASS）

脚本用子进程覆盖 argv/PATH 场景、用临时 home 构造 heal fallback，全部断言见 `test/embed/logs/test-host.log`；matrix 数据 `test/embed/host-matrix.json`。

| # | 场景 | source | dshVersion | dshInstallDir | hostProvided | warnings |
|---|---|---|---|---|---|---|
| 1 | 真实宿主进程上下文（argv[1]=bin.js） | `argv` | 0.2.1-rc.2 | `/home/fc/.local/lib/node_modules/@deepseek-ai/dsh` | 545 | 0 |
| 2 | `DSH_INSTALL_DIR` 环境变量 | `env` | 0.2.1-rc.2 | 同上 | 545 | 0 |
| 3 | 临时 home 的 heal fallback 符号链接 → 0.2.1 安装 | `profile-fallback` | 0.2.1-rc.2 | 同 realpath 目标 | 545 | 0 |
| 4 | 当前 `/home/fc/.dsh` heal 链接（本沙盒该链接指向 host-pinned） | `profile-fallback` | 0.1.0-rc.7 | `/home/fc/dsh-plugin-build/host-pinned/node_modules/@deepseek-ai/dsh` | 513 | 0 |
| 5 | PATH 上的 `dsh`（nvm 安装，realpath 后向上找） | `path` | 0.2.1-rc.2 | `/home/fc/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh` | 545 | 0 |
| 6 | UI override：`{dshInstallDir: host-pinned, dshVersion:'0.1.0-rc.7'}` | `override` | 0.1.0-rc.7 | host-pinned realpath | 513 | 0 |
| 7 | UI override 无效目录（自动回退 + 告警） | 自动探测源 | 自动值 | 自动值 | 对应闭包 | 1（含「已回退自动探测」） |
| 8 | version 未知（fake install 无 version） | `override` | `unknown`（不抛错） | fake 安装目录 | 0 | 2（含「未能确定 DSH 版本」） |
| 9 | heal fallback 悬空符号链接 | 继续探测到 `path` | 0.2.1-rc.2 | nvm 安装 | 545 | 含「链接已失效」 |
| 10 | 返回结构 | 必含 `dshHome/profile/dshInstallDir/dshVersion/nodeVersion/hostProvided/source/overridden/warnings`，`overridden` 为 `{installDir:boolean,version:boolean}` | | | | |

额外覆盖：override 接受「安装根目录」（`/home/fc/dsh-plugin-build/host-pinned`）与「package.json 文件路径」两种写法并归一化；hostProvided 闭包随 override 切换（545 ↔ 513），证明闭包基于最终 installDir。

---

## 3. B) 本地打包 embed 前后对比（`node test/embed/test-embed.mjs` → 28/28 PASS）

输入：只读扫描 `/home/fc/.dsh`（profile `web`，插件 `dsh-unlag@1.12.3` / `dsh-better-sidebar@0.28.1`）；宿主固定为当前 0.2.1-rc.2；产物在 `test/out-embed/<case>/`（脚本日志 `test/embed/logs/test-embed.log`）。

| case | embed 选项 | zip 大小 | result.vendored | `package/node_modules` 实际内容 | 备注（warnings） |
|---|---|---|---|---|---|
| `default-unlag` | 无 | 109,809 B | `[]` | 不存在 | 与 v1 一致 |
| `default-better-sidebar` | 无 | 5,283,766 B | `[]` | 不存在 | 与 v1 一致（见 §5 回归） |
| `extra-ws` | `extraPackages:['ws']` | 154,928 B | `ws@8.22.0` | `ws/` | 本地已装版本 |
| `extra-host-package` | `extraPackages:['ws','@deepseek-ai/schemastery']` | 187,973 B | `@deepseek-ai/schemastery@3.18.5`, `ws@8.22.0` | `@deepseek-ai/schemastery/`, `ws/` | 「点名即带」：显式点名的宿主命名空间包直接进产物 |
| `extra-invalid` | `extraPackages:['ws@99.1.2','no-such-package-xyz']` | 155,098 B | `ws@8.22.0` | `ws/` | warning：本地通道不支持版本选择 + 无法解析 `no-such-package-xyz`；**job 仍成功** |
| `embed-host-provided` | `includeHostProvided:true` | **8,079,488 B** | 23 个（含 17 个 `@deepseek-ai/*` + `ws@8.22.0` + `yaml@2.9.1` + 传递依赖） | `@deepseek-ai/*`（dsh-agent/settings/tools/session/llm/subagent/timeout/…）、`ws`, `yaml`, `zod`, `js-yaml`, `argparse` | 5 条 warning：宿主命名空间/单例风险、react/客户端模块永不内嵌、宿主包从当前安装目录解析 |
| `embed-all-declared` | `includeAllDeclared:true` | **47,342,005 B**（≈9×） | 120 个包 | `@codemirror/*`（23 个包）、`mermaid`、`d3-*`、`katex`、`dompurify` 等（staging node_modules 约 128 MiB） | 8 条 warning：体积/单例提示 + 少量版本冲突（扁平首见优先）；`react` 不在产物中 |
| `extra-peer-package` | `extraPackages:['@deepseek-ai/dsh-settings']`（该包同时是 better-sidebar 的 peer） | 5,328,223 B | `@deepseek-ai/dsh-settings@0.1.0-rc.7`（插件位置解析的本地已装版本） | `@deepseek-ai/dsh-settings/` | 无 includeHostProvided 时也「点名即带」（peer 名不再被过滤） |
| `host-override` | `dshInstallDir=host-pinned rc.7, dshVersion=0.1.0-rc.7` | 109,828 B | `[]` | 不存在 | 日志：`探测来源：override`、`宿主依赖闭包 513 个包`、target=0.1.0-rc.7 |

`includeHostProvided` 的产物中**永远没有** `react` / `react-dom` / `@deepseek-ai/dsh-client-*`（由 pack 的浏览器平台模块硬规则保证，见 §4）。

---

## 4. C) `lib/pack.mjs` opt-in 契约与实现（Lead 批准的 scope 扩大）

新增的三个参数都是**向后兼容 opt-in**：

```js
assembleOfflinePackage({
  ..., // 原有参数不变
  includeHostPackages: boolean,      // 默认 false；local 仅在 embed.includeHostProvided===true 时传 true
  keepVendoredPackages: string[],    // 默认 []；local 传「declared + extra」点名包
  vendoredVersions: {[name]: string} // 默认 null；local 传解析到的版本，用于 result.vendored = name@version
})
```

复制 `extraVendorDir` 到 `package/node_modules` 时的三级规则（`shouldSkipVendoredPackage`）：

1. **永远跳过**：插件自身、`react`/`react-dom`/`react-*`、`@deepseek-ai/dsh-client-*`（浏览器平台模块，无论任何选项）；
2. `keepVendoredPackages` 命中 → **保留**（覆盖命名空间/peer 过滤；即 `includeAllDeclared`/`extraPackages` 的「点名即带」）；
3. `includeHostPackages === true` → 保留（含 `@deepseek-ai/*` 与 manifest peer）；
4. 否则（默认）：跳过 `manifest.peerDependencies` 名、`cordis`/`@deepseek-ai/cordis`、`@deepseek-ai/*`。
   默认分支与 v1 的 `isHostProvidedPackage` 跳过集合**完全等价**（旧 `@deepseek-ai/*` 规则已覆盖 `@deepseek-ai/dsh-client-*`/`cordis`）。

`result.vendored` 语义（Lead 约束 3）：
- 默认 / includeHostProvided / keep 路径下都**只列出实际复制进产物的顶层包**；local 不再传旧的 `vendored` 覆盖值，而是通过 `vendoredVersions` 让 pack 在真实 copied 列表上补版本号（`name@version`）；
- 含宿主命名空间包时 pack 自动追加 warning：`产物内嵌了宿主命名空间/peer 包（…），可能与宿主各持一份，造成服务实例重复或单例状态不一致；仅在目标机缺少这些包时使用。react/react-dom/@deepseek-ai/dsh-client-* 等浏览器模块始终不会内嵌。`
- `includeHostProvided`/`includeAllDeclared` 的用户级风险提示由 `lib/local.mjs` 写入 `warnings` 并进入产物 README（体积、单例、react 例外）。

---

## 5. D) `includeHostProvided` 版本正确性修复（Lead 联调反馈）

### 5.1 问题（修复前实测）

在 3095（0.2.1-rc.2 宿主）用旧实现请求 `includeHostProvided:true` 时：

```
vendored 12:
  @deepseek-ai/dsh-agent@0.1.0-rc.7, dsh-llm@0.1.0-rc.7, dsh-session@0.1.0-rc.7,
  dsh-settings@0.1.0-rc.7, dsh-subagent@0.1.0-rc.7, dsh-tools@0.1.0-rc.7,
  @deepseek-ai/schemastery@3.18.1, @deepseek-ai/cosmokit@1.8.2, ws@8.22.0, yaml@2.9.1, zod, @standard-schema/spec
warning: 依赖 @deepseek-ai/schemastery 版本冲突：已内嵌 3.18.1（/home/fc/dsh-plugin-build/host-pinned/...）…
```

根因：宿主包仍用「从插件目录 `createRequire` 解析」→ 命中 `$DSH_HOME/profiles/node_modules` 里**过期的 heal fallback 符号链接**（本沙盒指向 host-pinned rc.7），而不是当前 0.2.1-rc.2 安装。

### 5.2 修复

- `lib/local.mjs`：`includeHostProvided=true` 时计算 `preferResolveFrom = join(host.dshInstallDir,'package.json')` 传给 vendor；不再把 `hostProvided` 传空集合，而是让 vendor 显式知道哪些是宿主包。
- `lib/vendor.mjs`：
  - 新增 `includeHostProvided` / `preferResolveFrom`；宿主包（`hostProvided` 命中）在 depth=0 时**优先用 `createRequire(当前安装 package.json).resolve(name)` 解析**，realpath 后拷贝；
  - 解析不到 → `skipped(reason:'host-install-unknown'|'not-found')` + warning **跳过，不回落插件位置**（符合 Lead 允许的更安全限制）；
  - 传递依赖仍从声明者自身位置解析（一旦顶层宿主包来自安装目录，其依赖树自然来自同一安装）；
  - 版本冲突 warning 现在标明两份来源：`来源：当前 DSH 安装目录 / 插件位置 / 传递依赖`。
  - `includeHostProvided=false`（默认）时行为与旧版逐分支等价。

### 5.3 修复后验证（fresh test host：`test/home-embed`，端口 3081，工作树最新代码）

请求与 Lead 给的一致：
```
POST /dsh-offline-packer/api/package-local
{"pluginName":"dsh-better-sidebar","home":"/home/fc/.dsh","profile":"web",
 "targetDshVersion":"0.2.1-rc.2","embed":{"includeHostProvided":true}}
```
结果（完整记录 `test/embed/logs/api-includehostfix.log`）：
- job `done`，`progress={"phase":"完成","percent":100}`，zip `dsh-better-sidebar-offline-0.28.1-dsh-0.2.1-rc.2.zip` 8,079,490 B；
- `vendored` 23 个；`@deepseek-ai/dsh-*` **全部 `0.2.1-rc.2`**，`@deepseek-ai/schemastery@3.18.5`，`ws@8.22.0`，`yaml@2.9.1`；
- 产物 manifest 抽查：`@deepseek-ai/dsh-settings 0.2.1-rc.2`、`schemastery 3.18.5`、`ws 8.22.0`、`yaml 2.9.1`；
- warnings 5 条，**不含** `host-pinned`，vendored **不含** 任何 `0.1.0-rc.*`；
- 日志含 `宿主依赖将从当前安装目录解析：/home/fc/.local/lib/node_modules/@deepseek-ai/dsh` 与 `来源：当前 DSH 安装目录`；
- `/home/fc/.dsh` profile 指纹（package.json sha256 + node_modules 顶层列表 hash）前后 **UNCHANGED**。

> 注意：Lead 已启动的 3095（`DSH_HOME=/home/fc/dsh-pack-test/home-v15`）当前加载的是该 home 里**旧版已安装插件代码**，因此对 3095 直接调用仍会看到旧行为；需要把工作树重新装进该 home 并重启 3095（或安装最终 0.1.5 包）后再做 UI/API 联调。本报告的证据来自按同一方式新起的 fresh test host。

`test/embed/test-embed.mjs` 新增的版本断言（28/28 中含）：
- `includeHostProvided: embedded host packages carry the current 0.2.1-rc.2 version (not a stale install)` PASS；
- `@deepseek-ai/schemastery from the current host (3.18.5, not 3.18.1 rc.7 copy)` PASS；
- `no package resolved from another installation (no host-pinned paths)` PASS；
- `host-package resolution source logged as the current install directory` PASS。

---

## 6. 回归证据：默认路径（不加 embed / historical）保持不变

### 6.1 方法与基线

`test/embed/baseline-default-v1.json` 在改动前对 v1 产物做快照：
- 取 `package/` 目录树（**不包含** task-8 负责的 `install-offline.*` / `README.md` / `VERSIONS.txt` / `CHECKSUMS.txt` 模板；这些由 `lib/scripts.mjs` 在并行任务中修改，`VERSIONS.txt` 还含生成时间）；
- 计算 sorted `<sha256>  <relative-path>` 行的 aggregate SHA-256 + 文件数 + `result.vendored`；
- 基线来源：v1 生成的 `test/out-a`（0.2.1-rc.2 local）与 `test/out-b`（0.13.1→rc.7 historical，pack.mjs 冻结 md5 `9f863c23…`）。

`test/embed/regression-default.mjs`：用当前代码重跑两个默认 local 打包并比对：
```
PASS dsh-unlag: default package/ tree identical to v1 baseline (11 files, aggregate 0a80b81f9ef91929…), vendored=[]
PASS dsh-better-sidebar: default package/ tree identical to v1 baseline (477 files, aggregate 06d4b83057dc9d8c…), vendored=[]
DEFAULT REGRESSION PASS
```
（日志 `test/embed/logs/regression-default.log`）

### 6.2 historical/registry 路径（`regression-historical.mjs`）

用当前代码真实重跑 `dsh-better-sidebar@0.13.1 → 0.1.0-rc.7`（network+npm，92s，warm cache），与 v1 冻结产物在 `test/out-b` 比对：
```
PASS vendored count unchanged (157)
PASS target version unchanged (0.1.0-rc.7)
PASS package/ tree byte-identical to frozen v1 artifact: 12859 files, aggregate 3fee9b87da991802… (baseline 12859 files)
PASS zip entry count unchanged (12864)
PASS frozen artifact still present (46,940,272 B)
HISTORICAL REGRESSION PASS
```
本次 zip 46,946,157 B 与冻结版 46,940,272 B 的差值仅来自并行 task-8 对 `lib/scripts.mjs`（安装脚本/README/VERSIONS 模板）的修改；`package/` 内容逐文件一致（aggregate 相同）。historical 调用从不传 `includeHostPackages`/`keepVendoredPackages`/`vendoredVersions`。

### 6.3 phase-1 全量回归（task-4 自测脚本）

- `node test/a/selftest.mjs`：PASS（host 0.2.1-rc.2、18 plugins、unlag/better-sidebar 打包 0 vendored）；
- `bash test/a/verify-artifacts.sh`：**47 项检查 0 失败**（含 zip 完整性、manifest 重写、sha256sum -c、bash -n、0755、dry-run 零写入、安装/幂等/卸载、以及新增「未触碰用户真实 profile 指纹」检查）；
- `node test/a/test-vendor.mjs` / `test-pack-filter.mjs` / `test-local-e2e.mjs`：PASS（默认过滤规则、扁平/嵌套/符号链接/循环、registry 形态过滤、伪造 home 全链路）。

### 6.4 pack.mjs 默认分支等价性说明

- 旧的 `isHostProvidedPackage(name,{pluginName,peers})` 被 `shouldSkipVendoredPackage(name,{pluginName,peerNames,keepPackages,includeHostPackages})` 取代；默认（`keepPackages` 空、`includeHostPackages=false`）时跳过集合与旧函数**逐条等价**（self / react+react-dom+`react-*` / `cordis`+`@deepseek-ai/cordis` / `@deepseek-ai/*` / manifest peers；`@deepseek-ai/dsh-client-*` 原本也被 `@deepseek-ai/*` 覆盖，现在额外显式化）；
- `result.vendored`：旧默认路径 = copied 包名列表（无版本）→ 新默认路径在未传 `vendoredVersions` 时**同样**为 copied 包名列表；
- 新增的宿主命名空间 warning 仅在 `includeHostPackages===true` 且确实复制了宿主包时出现，默认路径不产生；
- 上述等价性由 §6.1 的逐文件 aggregate 相等与 §6.3 的单元测试共同佐证。

---

## 7. E) API / 真实宿主集成（fresh test host，端口 3081）

环境：`bash test/install-dev-plugin.sh test/home-embed web`（装入工作树当前代码）+
`env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_PROFILE DSH_HOME=test/home-embed node <dsh>/lib/bin.js --profile web --port 3081 --no-open`，token 登录后 curl。

| 验证 | 结果 |
|---|---|
| `GET /api/state`（默认 home/profile） | `host={dshVersion:'0.2.1-rc.2', source:'argv', overridden:{installDir:false,version:false}, warnings:[]}`；`plugins=1`，`hiddenOfficial=18`（官方内置默认隐藏生效） |
| `GET /api/state?dshInstallDir=host-pinned...&dshVersion=0.1.0-rc.7` | `source:'override'`, `overridden:{installDir:true,version:true}`, version `0.1.0-rc.7` |
| `POST /api/package-local` + `embed.extraPackages:['ws']` | job `done`，`progress 100%`，`vendored ['ws@8.22.0']`，zip 154 KB，产物 `package/node_modules/ws` |
| `POST` + `embed.includeHostProvided:true` | job `done`，23 vendored（17 个 `@deepseek-ai/*`，版本全部 0.2.1-rc.2），zip 8.08 MB，warnings 5 |
| `POST` + 非法 `extraPackages:['no-such-package-xyz']` | job `done`，warning「无法从插件位置解析依赖 no-such-package-xyz」，服务未失败 |
| 输出位置 | 全部落在测试宿主自己的 DSH_HOME（`test/home-embed/offline-packages`），扫描 `/home/fc/.dsh` 只读；用户 profile 指纹前后 UNCHANGED |

（更详细数据见 §5.3 与 `test/embed/logs/api-includehostfix.log`。）

---

## 8. F) 事故记录：安装器写入了真实用户 profile（已恢复 + 已加固）

- **现象**：在执行 phase-1 `test/a/verify-artifacts.sh` 时，产物里的 `install-offline.sh` 把插件装到了真实 `/home/fc/.dsh/profiles/web`（删除/替换了 `dsh-better-sidebar`、`dsh-unlag` 目录并改动 bundles）。
- **根因**：当前 agent shell 环境自带 `DSH_HOME=/home/fc/.dsh`、`DSH_PROFILE_DIR=/home/fc/.dsh/profiles/web`（DSH harness 注入）；task-8 的安装器优先级为 `--profile-dir > DSH_PROFILE_DIR > --dsh-home…`，因此环境变量覆盖了测试传入的 `--dsh-home`。这是**测试未清环境**，不是安装器 bug（已向 Lead 更正）。
- **恢复**：用 npm registry 官方 tarball 恢复两个插件目录，重建 bundles 顺序（含 Lead 安装的 `dsh-offline-packer`）。Lead 已独立复核：与官方 tarball `diff -rq` 逐文件 0 差异（better-sidebar 477/477、unlag 11/11），`pnpm why`/`import()` 正常，3080 GUI 存活。
- **加固**（已生效）：`test/a/verify-artifacts.sh` 所有 installer 调用 `env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_PROFILE HOME=<沙盒>`，优先 `--profile-dir <沙盒>`，结尾校验真实 profile 指纹不变；后续测试不再运行会写 `/home/fc/.dsh` 的命令。
- **残留差异**：恢复目录 mtime 变化、profile package.json 重新序列化（内容/顺序一致）；这一点 Lead 已知悉。

---

## 9. 复现命令 / 产物路径

```bash
cd /home/fc/dsh-offline-packer

# 语法
node --check lib/host.mjs && node --check lib/local.mjs && node --check lib/pack.mjs && node --check lib/vendor.mjs

# A) 宿主探测矩阵（26 checks）
node test/embed/test-host.mjs
node test/embed/print-host-matrix.mjs     # -> test/embed/host-matrix.json

# B) embed 矩阵（28 checks，包含 includeAllDeclared 的 ~230MB staging，约 30s）
node test/embed/test-embed.mjs

# C) 默认路径回归（逐文件 aggregate；2/2）
node test/embed/regression-default.mjs

# D) historical 回归（network + npm，约 60-90s；重建产物比对后自动清理临时 staging）
node test/embed/regression-historical.mjs

# E) phase-1 回归
node test/a/selftest.mjs && bash test/a/verify-artifacts.sh
node test/a/test-vendor.mjs && node test/a/test-pack-filter.mjs && node test/a/test-local-e2e.mjs
```

产物与证据：
- `test/out-embed/`：
  - `default-unlag/`、`default-better-sidebar/`（默认）
  - `extra-ws/`、`extra-host-package/`、`extra-invalid/`、`extra-peer-package/`（extraPackages）
  - `embed-host-provided/`（includeHostProvided，8.08 MB）
  - `embed-all-declared/`（includeAllDeclared，47.34 MB zip / 128 MiB node_modules）
  - `host-override/`（override 到 rc.7）
  - `regression-default/`（默认回归重建产物）
  - `historical-regression-summary.json`（historical 重建摘要；临时 47MB 产物比对后已清理，冻结产物仍在 `test/out-b`）
- `test/embed/baseline-default-v1.json`：默认路径/历史路径 v1 基线（package/ 树 aggregate）
- `test/embed/logs/`：`test-host.log`、`test-embed.log`、`regression-default.log`、`regression-historical.log`、`phase1-selftest.log`、`phase1-verify-artifacts.log`、`unit-*.log`、`api-includehostfix.log`、`host-matrix.json`

---

## 10. 已知限制 / 风险

1. **includeHostProvided 的体积与单例风险**：会内嵌宿主依赖闭包（本次 8.08 MB / 23 包），`@deepseek-ai/*` 可能与宿主各持一份，导致服务实例重复或单例状态失配；仅在目标机缺包时使用（warnings/README 已注明）。
2. **includeHostProvided 的解析边界**：宿主包只从「当前 `getHostInfo().dshInstallDir` 闭包」解析，解析不到就跳过并 warning（不回落插件位置）；若 UI 未指定/探测不到安装目录，该选项只内嵌能在插件位置解析到的非宿主包（宿主包会被跳过并提示）。
3. **includeAllDeclared 会内嵌全部声明依赖（含前端库）**：本次 better-sidebar 产生 47.3 MB zip / 128 MiB staging / 120 包；扁平首见优先会产生少量版本冲突 warning（本次 8 条，均为前端库）；仅按需使用。
4. **extraPackages 不支持版本选择**：`name@version` 只保留 name 并 warning；未找到的包 warning 且 job 继续（符合契约）。
5. **明确点名（extraPackages/includeAllDeclared）的宿主命名空间包仍用「本地已装版本」**（插件位置解析）；在本沙盒 heal fallback 指向 host-pinned 时可能拿到 rc.7 版本（如 `extra-peer-package` 案例的 `@deepseek-ai/dsh-settings@0.1.0-rc.7`）。需要版本与宿主严格一致时请用 `includeHostProvided`（已修复为安装目录解析）。
6. **`dshVersion` 未知时**：`getHostInfo` 返回 `'unknown'` 不抛错；`targetDshVersion` 默认可能是 `unknown`（产物命名含 unknown），UI 建议手填或指定 `dshInstallDir`。
7. **ZIP64 未实现**（v1 起如此）：>4GB 或 >65535 项时抛清晰错误；historical 12,864 项正常。
8. **跨平台/原生依赖**：`includeAllDeclared`/`extraPackages` 可能内嵌原生模块（node-pty 等），产物仅适用于打包机同 OS/arch；`includeHostProvided` 的宿主包同理。
9. **ZIP 内安装脚本仍属 task-8 范围**：本报告不覆盖安装器的 Node8/魔改兼容性（由 task-8 + task-11 验证）；本次仅保证 `install-offline.sh` 在沙盒下安装/卸载/幂等/0755 通过（§6.3）。
10. **3095 联调注意**：其 home 里加载的是旧版插件代码，直接对 3095 调用会看到修复前行为；需重装工作树/新版包并重启后回归。
