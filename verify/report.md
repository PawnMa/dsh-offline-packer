# 独立验证报告：`dsh-offline-packer` 0.1.0（宿主 @deepseek-ai/dsh 0.2.1-rc.2）

- 验证员：`qa-verifier`（独立 fresh context；本报告所有结论均为本人亲手复现，命令与输出见下）
- 日期：2026-10-29（Asia/Shanghai）
- 被验证对象：`/home/fc/dsh-offline-packer/`（工作树最终版；`client.js` 最终 mtime 11:42，`lib/**` 最终交付 11:31-11:32）
- 宿主：dev host `@deepseek-ai/dsh 0.2.1-rc.2`（`/home/fc/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`）；历史宿主 `0.1.0-rc.7`（`/home/fc/dsh-plugin-build/host-pinned/.../lib/bin.js`）
- 验证工作区：`/home/fc/dsh-offline-packer/verify/`（脚本、日志、截图、证据全部在内）；本报告 `verify/report.md`
- 只读数据源：`/home/fc/.dsh`（真实用户 home；**未被写入**，见 §10）；用户 GUI 3080（**未被触碰**）
- 端口：仅用 3084/3085/3086；全部测试宿主已停止，端口已释放

## 0. 结论摘要

| # | 验证项 | 结论 |
|---|---|---|
| 1 | 插件能加载（boot 日志干净 + `/api/state` 结构/版本 + 扫描 `/home/fc/.dsh` ≥10） | **PASS** |
| 2 | 图形化 UI（Settings→离线打包；扫描 home=/home/fc/.dsh 17 项；刷新；无 console/page error） | **PASS** |
| 3 | 一键本地打包 `dsh-unlag`：UI 触发→job done→zip 校验→**断网**装入全新 home→3085 启动含插件→卸载→再启动 | **PASS** |
| 4 | 大插件压力 `dsh-better-sidebar@0.28.1`：1.56s 完成、5.28MB/482 文件、校验通过（+装全新 home 启动含插件） | **PASS** |
| 5 | 历史适配版本：matrix 36 版本且 `0.13.1` peers 含 `^0.1.0-rc.7`；registry 打包→rc.7 宿主 3086 启动→`terminal.deps` ok | **PASS** |
| 6 | 错误路径（matrix 未知包 / download 非法 name / package-local 缺失插件）均结构化错误、服务不崩 | **PASS** |
| 7 | 安全/边界（fence 伪造 Origin 403；`../` 穿越 400；相对 home 行为合理） | **PASS**（附 1 条语义小建议） |
| 8 | 无回归（测试宿主停止后 3080 正常；`/home/fc/.dsh` 前后快照仅时间标签不同） | **PASS** |
| A | Lead 附加项：`npm pack` 产物走官方通道 `dsh plugin --profile web add <tgz>` 装全新 home → 启动无 warning、state 200、UI 正常 | **PASS**（但项目根目录现存 tgz 已过期，见 §11-A） |
| B | Lead 附加项：本地打包产物的 `install-offline.sh` 在「全新 home + 断网」安装/启动/卸载 | **PASS**（并入项 3 证据） |

**总体判断：可交付（PASS）。** 未发现必须修复的功能缺陷；无需 `verify/suggested-fixes.md`。交付前需做两件非代码动作：(a) **重新 `npm pack`** 覆盖 `/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.0.tgz`（现存 tgz 早于最终 `client.js`）；(b) 接受历史 registry 包 46.9MB 的已知体积限制（§11-R1）。

---

## 1. 环境与方法

### 1.1 环境事实（实测）

```text
$ node -v        -> v24.14.0        $ npm -v  -> 11.21.1        $ pnpm -v -> 11.21.0
$ node /home/fc/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --version   -> 0.2.1-rc.2
$ node /home/fc/dsh-plugin-build/host-pinned/node_modules/@deepseek-ai/dsh/lib/bin.js --version -> 0.1.0-rc.7
playwright-core 1.64.1 (/home/fc/dsh-plugin-build/leadcheck/pw) + chromium-1234/chrome-linux64/chrome (278MB)
registry.npmjs.org -> 200（打包历史版本时需要网络；离线安装/启动不需要）
端口 3084/3085/3086 空闲；3080 用户 GUI -> HTTP 401（token gate，未触碰）
unshare -rn 可用（新 netns 内 DNS/外网不可达，用于「断网安装」证明）
```

完整自检脚本与输出：`verify/check-env.sh` → `verify/logs/check-env.log`。

### 1.2 验证脚本（`verify/**`，均为本次编写并实跑）

| 脚本 | 作用 |
|---|---|
| `env.sh` | 公共常量/守卫（禁止写 `/home/fc/.dsh`、禁止 3080）、token/cookie 鉴权 curl、host 状态文件 |
| `check-env.sh` | 只读环境自检（node/pnpm/两套宿主/浏览器/registry/端口/用户 profile） |
| `setup-host.sh` | 用 `test/install-dev-plugin.sh` 装开发树到隔离 home 并启动 `dsh web`（3084-3086）；处理 0.2.x token、rc.7 无 token/无 `--no-open`；`--no-plugin/--dsh-bin/--home/--fresh/--stop` |
| `teardown-host.sh` | 清理 host 状态文件并报告端口 |
| `probe-api.sh` | API 封装+断言：`state/plugins/matrix/package-local/package-registry/job/poll/download/fence/raw`，含 `--home` 只读扫描、`--expect-error`（用于错误路径断言） |
| `validate-zip.sh` | 离线 zip 校验：`unzip -t`、单一顶层目录与命名、结构（package/ + 两个 installer + README + CHECKSUMS + VERSIONS）、manifest（dependencies {}、peers 全 optional、name/version、dsh.client）、`sha256sum -c`、`bash -n`、可执行位、穿越成员、`--dryrun` 预演 |
| `ui-smoke.mjs` | Playwright 冒烟：加载页→关闭 onboarding→Settings→「离线打包」→可切换到 `--scan-home` 扫描源→刷新→`--package-plugin` 一键打包（轮询 job/结果/下载链接）→截图→console/page error 断言→data-testid/行数断言 |
| `boot-evidence.sh` | 启动证据：日志硬失败扫描、`GET /`、boot manifest（含/不含插件）、client bundle 200、`--dump-config`、任意 `--probe "METHOD /path"` |
| `offline-install.sh` | 解包 + 用产物里的 `install-offline.sh` 装入全新 home（`--dry-run/--uninstall`），断言目录与 bundles；**取消 DSH_HOME 兜底**，防止误写真实 home |
| `snapshot-user-home.sh` | `/home/fc/.dsh` 只读快照（package.json hash/mtime、node_modules 顶层条目与版本清单），用于项 8 前后对比 |

### 1.3 关键环境事实（已固化进脚本）

- **0.2.x 有 token 认证**：启动日志打印 `dsh web: http://127.0.0.1:<port>/?token=<43 chars>`。未带 token 的 `GET /` 是 401；`curl -c jar "…?token=…"`（303 种 cookie）后所有请求需带 `-b jar`。Playwright 直接 `page.goto(url?token=…)`。
- **rc.7 (0.1.0-rc.7) 无 token、无 `--no-open` 参数**：就绪判定为无鉴权 `GET /` 200。
- 每次 bash 调用是独立 bwrap（PID namespace 隔离）；同端口重启必须先 `job_kill` 旧后台 job。`setup-host.sh` 会检测端口占用并明确报错。
- 插件加载失败在 0.2.1 是 **warning**（`dsh: warning: 1 entry did not activate` + `failed to import`），此时路由 404；本报告「插件已加载」的判定=**日志无该 warning 且 `GET /dsh-offline-packer/api/state` 200**。
- 0.2.1 的 onboarding 弹窗是「Get started + Close」（不是 Continue）；`ui-smoke.mjs` 两种路径都兼容。
- `test/install-dev-plugin.sh` 已被 Lead 修复（staging 拷贝），DSH_HOME 位于项目目录内也能安全安装；本次所有测试宿主都走该脚本安装。

---

## 2. 项 1：插件能加载 —— PASS

安装（`verify/setup-host.sh` → 内部调用 `bash test/install-dev-plugin.sh verify/home web`）：

```text
[dev-install] dsh-offline-packer -> /home/fc/dsh-offline-packer/verify/home/profiles/web/node_modules/dsh-offline-packer
[dev-install] bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-offline-packer"]
```

启动（端口 3084，`--no-open`）：

```text
$ DSH_HOME=…/verify/home node …/dsh/lib/bin.js --profile web --port 3084 --no-open
===== boot log =====
dsh web: http://127.0.0.1:3084/?token=<redacted>
```

日志硬失败扫描（`entry apply failed|duplicate prefix route|FAILED|Cannot resolve|ERR_MODULE|uncaught`）：

```text
$ grep -niE 'warning|entry apply failed|duplicate prefix route|FAILED|Cannot resolve|ERR_MODULE|uncaught' verify/logs/host-3084.log
(none)
```

`/api/state`（测试 home；测试宿主 profile 只有本插件，但 `/api/state` 会把 in-box bundles 一并列出）：

```text
$ bash verify/probe-api.sh state
ok=true host.dshVersion=0.2.1-rc.2 dshHome=/home/fc/dsh-offline-packer/verify/home profile=web plugins=19
STATE_CHECK=PASS plugins=19 dshVersion=0.2.1-rc.2
```

只读扫描用户真实 profile：

```text
$ bash verify/probe-api.sh state --home /home/fc/.dsh --min-plugins 10
ok=true host.dshVersion=0.2.1-rc.2 dshHome=/home/fc/.dsh profile=web plugins=17
STATE_CHECK=PASS plugins=17 dshVersion=0.2.1-rc.2

$ bash verify/probe-api.sh plugins --home /home/fc/.dsh
dshHome=/home/fc/.dsh profile=web plugins=17
  - @deepseek-ai/dsh-base@0.1.0-rc.7 (bundle)
  - @deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.2 (bundle)
  - @deepseek-ai/dsh-web-app@0.1.0-rc.7 (bundle)
  - @linxin666/dsh-pet@0.4.8 (bundle)
  - dsh-better-sidebar@0.28.1 (bundle)
  - dsh-unlag@1.12.3 (bundle)
  - dshmarket@1.70.2 (bundle)
  …（共 17 项）
```

字段完整性抽查（真实返回节选，`Plugin` 结构符合 ARCHITECTURE §1）：

```json
{"name":"dsh-offline-packer","version":"0.1.0","kind":"bundle","installed":true,"enabled":true,
 "dir":"…/verify/home/profiles/web/node_modules/dsh-offline-packer",
 "realDir":"…","sizeBytes":252904,"fileCount":18,"peerDsh":null,
 "client":{"platform":"web","inject":[]},"bundlePatch":"./cordis.patch.yml",
 "serverEntry":"index.js","warnings":[],"description":"Offline packaging for DSH plugins: …","removable":true}
```

**判读**：boot 日志仅一行 URL、无任何 warning/import 失败；state 200 且结构/字段/版本正确；扫描用户 home 得到 17 项（≥10，满足项 2 数据前提）。**PASS**。

---

## 3. 项 2：图形化 UI —— PASS

命令（Playwright headless Chromium，locale en-US，1600×1000，token 由 host 状态文件提供）：

```bash
node verify/ui-smoke.mjs --port 3084 --scan-home /home/fc/.dsh --min-plugins 10 \
  --require-testids "offline-packer-page,offline-packer-list,offline-packer-row,offline-packer-refresh,offline-packer-home-input,offline-packer-package-local,offline-packer-job" \
  --package-plugin dsh-unlag --out verify/artifacts/main --json verify/artifacts/main/ui-smoke.json
```

输出（15 项断言全部 PASS）：

```text
PASS  page loaded (title) :: title="DeepSeek Harness"
PASS  authenticated app shell rendered :: bodyLen=374
PASS  onboarding modal dismissed
PASS  settings panel opened
PASS  scan home lists plugins :: home=/home/fc/.dsh rows=17
PASS  「离线打包」settings section visible
PASS  core data-testid present :: offline-packer-page,offline-packer-list,offline-packer-refresh,offline-packer-home-input
PASS  plugin rows >= 10 :: heuristic=data-testid=offline-packer-row count=17
PASS  plugin list rendered (>=1 row heuristic) :: {"heuristic":"data-testid=offline-packer-row","count":17}
PASS  refresh control usable :: clicked=true
PASS  UI one-click packaging job done :: {"plugin":"dsh-unlag","status":"done","resultText":"Package / Download zip · dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip / Size 101 KB / …","zipName":"dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip","downloadHref":"/dsh-offline-packer/api/download?name=dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip"}
PASS  UI result shows a zip name :: dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip
PASS  required data-testid present :: found=7
PASS  no page errors
PASS  no console errors
UI_SMOKE=PASS assertions=15 failed=0
```

截图（`verify/artifacts/main/`，均为实拍）：
- `01-landing.png` 落地页（已过认证、onboarding 已关闭）
- `02-settings.png` Settings 面板
- `03-offline-packer.png` / `03b-scan-home.png` 「Offline Packager」页，顶部宿主信息（0.2.1-rc.2、node v24.14.0、profile web、outputRoot、profile dir、install dir）+ 可编辑 DSH_HOME/profile + Refresh；列表区搜索框与「17 plugins」计数，每行卡片有名字@版本、bundle/Enabled 徽标、描述、DSH peer range、大小、Client/Server、`Build offline package`/`Version history…` 按钮
- `04-after-refresh.png` 刷新后
- `05-job-done.png` / `05b-job-panel.png` 任务面板：`Packaging job [Done] local plugin · dsh-unlag`、Package/Download zip 链接、Size 101 KB、Plugin version 1.12.3、Target DSH 0.2.1-rc.2、zip name/path、日志尾部（含 `job … finished in 181 ms`）

**判读**：Settings 导航出现「Offline Packager」页；切到只读 `home=/home/fc/.dsh` 后列表 17 项（≥10）；刷新可用；UI 一键打包走通并展示下载链接；**0 console error / 0 page error**。**PASS**。

---

## 4. 项 3：一键本地打包（UI 触发）+ 产物校验 + 断网安装/启动/卸载 —— PASS

### 4.1 UI 打包 job

见 §3 `05b-job-panel.png`：status=done，`dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip`，101 KB，`job … finished in 181 ms`。经 API 复核最近 job 列表：

```text
$ bash verify/probe-api.sh raw GET '/dsh-offline-packer/api/job'
HTTP 200
{"ok":true,"value":{"jobs":[{"id":"mvt02i8k-2-dur2","kind":"local","status":"done","startedAt":…,"finishedAt":…}, …]}}
```

下载（经 `/api/download`）：

```text
$ bash verify/probe-api.sh download dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip
GET /api/download?name=dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip -> HTTP 200 size=102944
sha256=51b219eb3597169bf90fa9bfde1c2ea40e85e1459a18e7dcd5d86bc0e151567e file=…/verify/tmp/downloads/dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip
DOWNLOAD_CHECK=PASS
```

### 4.2 zip 校验（`validate-zip.sh`，含 dry-run）

```text
$ bash verify/validate-zip.sh verify/tmp/downloads/dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip \
    --expect-plugin dsh-unlag --expect-version 1.12.3 --expect-target 0.2.1-rc.2 --dryrun
size=102944 bytes sha256=51b219eb3597169bf90fa9bfde1c2ea40e85e1459a18e7dcd5d86bc0e151567e
PASS  file non-empty (102944 bytes)
PASS  zip magic PK\x03\x04
PASS  extracted to …/verify/tmp/validate/dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2-37
PASS  unzip -t: archive coherent (16 entries tested)
PASS  single top-level directory: dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2
PASS  top-level dir name == dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2
PASS  layout: package/package.json present
PASS  layout: install-offline.sh present
PASS  layout: install-offline.ps1 present
PASS  layout: README.md present
PASS  layout: CHECKSUMS.txt present
PASS  layout: VERSIONS.txt present
PASS  install-offline.sh executable after extraction
PASS  bash -n install-offline.sh
PASS  zip external attrs keep install-offline.sh executable (0o755)
PASS  manifest assertions (9 checks)   # dependencies {} / peers 19 全 optional / name+version / dsh.client.platform=web
PASS  sha256sum -c CHECKSUMS.txt: 15/15 OK
PASS  README.md mentions version 1.12.3
PASS  README.md mentions target DSH 0.2.1-rc.2
PASS  VERSIONS.txt mentions version 1.12.3
PASS  VERSIONS.txt mentions target DSH 0.2.1-rc.2
PASS  no absolute or ../ members in archive
PASS  install-offline.sh --dry-run: exit 0, wrote nothing
files=16 dir_size=368K
RESULT=PASS checks=23 failures=0
```

manifest 关键断言原文（`--expect-…` 明细节选）：

```text
{"name":"dependencies is an empty object","ok":true,"detail":"dependencies={}"}
{"name":"every peerDependenciesMeta entry is optional:true","ok":true,"detail":"peers=19 meta=19 notOptional=[]"}
{"name":"main or exports[.] present","ok":true,"detail":"main=undefined exportsDot=./index.js"}
{"name":"dsh.client.platform == web","ok":true,"detail":"platform=web"}
{"name":"engines.dsh optional","ok":true,"detail":"engines.dsh=>=0.2.0-rc.1"}
```

### 4.3 断网安装进全新 home（Lead 附加项 B）

```bash
unshare -rn bash -c 'ip link set lo up; unset DSH_HOME;
  bash verify/offline-install.sh verify/tmp/downloads/dsh-unlag-offline-…zip \
    --home /home/fc/dsh-offline-packer/verify/home-installed'
```

```text
=== netns network check ===
registry.npmjs.org -> 000        # Could not resolve host（确认断网）

== 初始化 profile（若缺失） ==
[安装] 已初始化 profile，新建文件：package.json,cordis.patch.yml,pnpm-workspace.yaml
== 复制插件文件 ==
[安装] 已安装：…/home-installed/profiles/web/node_modules/dsh-unlag
== 挂载到 profile bundles ==
[安装] 已追加 "dsh-unlag" 到 dsh.profile.bundles
[信息] 当前 bundles：["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-unlag"]
installer_exit=0
installed plugin dir: …/node_modules/dsh-unlag (11 files)
bundles now contains dsh-unlag
installed version: 1.12.3
INSTALL_RESULT=PASS
```

### 4.4 启动新 home（3085）+ 证据

```text
$ bash verify/boot-evidence.sh 3085 --expect-plugin dsh-unlag
PASS  startup log: no hard failures
PASS  GET / 200
      manifest contains "dsh-unlag": YES
GET client bundle /plugins/??dsh-unlag/client.js&rev=a40461a37cc4 -> HTTP 200 size=74955
PASS  plugin client bundle served
PASS  dump-config mentions dsh-unlag (4 lines)
EVIDENCE_RESULT=PASS
```

（`--dump-config` 命中：`# == dsh-unlag` / `- id: dsh-unlag` / `name: dsh-unlag` 与 base patch 行。）

### 4.5 卸载 + 再启动

```text
$ bash verify/offline-install.sh <zip> --home …/home-installed --uninstall
[安装] 已从 dsh.profile.bundles 移除 dsh-unlag
[信息] 当前 bundles：["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]
[安装] 已删除插件目录：…/node_modules/dsh-unlag
uninstall: bundles no longer contains dsh-unlag
INSTALL_RESULT=PASS (uninstall)

$ bash verify/boot-evidence.sh 3085 --absent-plugin dsh-unlag
PASS  startup log: no hard failures
PASS  GET / 200
      manifest contains "dsh-unlag" (must be absent): NO -> PASS
PASS  dump-config has no dsh-unlag line (hits=0)
EVIDENCE_RESULT=PASS
```

**判读**：UI 一键打包→job done→下载→zip 全部结构/manifest/checksum/语法/权限断言通过；产物在**真实网络命名空间断网**下可安装；全新 home 启动后 boot manifest/client bundle/dump-config 均证明插件已加载；卸载干净且可再启动。**PASS**。

---

## 5. 项 4：大插件压力（dsh-better-sidebar@0.28.1 本地打包）—— PASS

```text
$ bash verify/probe-api.sh package-local dsh-better-sidebar --home /home/fc/.dsh
PACKAGE_LOCAL_CHECK=PASS jobId=mvt03f8x-3-hzfv
$ bash verify/probe-api.sh poll mvt03f8x-3-hzfv
POLL_CHECK=PASS status=done
  "zipName": "dsh-better-sidebar-offline-0.28.1-dsh-0.2.1-rc.2.zip",
  "sizeBytes": 5276915, "version": "0.28.1", "mode": "local", "warnings": [],
job mvt03f8x-3-hzfv finished in 1558 ms
扫描 7 个文件；静态依赖 9 个，动态依赖 3 个
依赖处理完成：内嵌 0 个，宿主提供 9 个
完成：…（5276915 B，482 个文件，0 个内嵌依赖，校验和 481 条）
```

zip 校验：

```text
$ bash verify/validate-zip.sh …/dsh-better-sidebar-offline-0.28.1-dsh-0.2.1-rc.2.zip \
    --expect-plugin dsh-better-sidebar --expect-version 0.28.1 --expect-target 0.2.1-rc.2
size=5276915 bytes sha256=598ff44ee6e11a70e06241c0d817b9d50f13f40ea3fbfd487370ec3be9abdb1f
PASS  unzip -t: archive coherent (482 entries tested)
PASS  manifest assertions (9 checks)
PASS  sha256sum -c CHECKSUMS.txt: 481/481 OK
PASS  bash -n install-offline.sh
PASS  …（结构/命名/权限/README/VERSIONS/穿越 全部 PASS）
RESULT=PASS checks=22 failures=0
files=482 dir_size=20M
```

附加（超出必做项）：装进全新 home 并启动 3085：

```text
$ bash verify/offline-install.sh …sidebar-0.28.1….zip --home …/home-sidebar
installed plugin dir: …/node_modules/dsh-better-sidebar (477 files)
installed version: 0.28.1
INSTALL_RESULT=PASS
$ bash verify/boot-evidence.sh 3085 --expect-plugin dsh-better-sidebar
PASS  startup log: no hard failures
PASS  GET / 200
      manifest contains "dsh-better-sidebar": YES
GET client bundle /plugins/??dsh-better-sidebar/client.js&rev=3f5900b8f388 -> HTTP 200 size=1567039
PASS  plugin client bundle served
PASS  dump-config mentions dsh-better-sidebar (3 lines)
EVIDENCE_RESULT=PASS
```

**判读**：47MB 级插件目录打包 1.56s 完成，未超时、无崩溃；zip 结构完整、481/481 校验通过；装进全新 home 可启动并加载。**PASS**。

---

## 6. 项 5：历史适配版本（0.13.1 → rc.7）—— PASS

### 6.1 版本矩阵

```text
$ bash verify/probe-api.sh matrix dsh-better-sidebar --min-versions 30 --expect-version 0.13.1 --expect-peer '^0.1.0-rc.7'
plugin=dsh-better-sidebar versions=36 dshVersions=39
dshVersions: 0.2.2-alpha.2, 0.2.1-rc.4, 0.2.1-rc.3, 0.2.1-rc.2, 0.2.1-rc.1, …, 0.1.0-rc.7, …
peer check: 0.13.1 dshPeers=["^0.1.0-rc.7"] contains "^0.1.0-rc.7": true
MATRIX_CHECK=PASS
```

### 6.2 registry 打包（需要网络 + npm）

```text
$ bash verify/probe-api.sh package-registry dsh-better-sidebar 0.13.1 0.1.0-rc.7
PACKAGE_REGISTRY_CHECK=PASS jobId=mvt042dn-4-5toh
$ bash verify/probe-api.sh poll mvt042dn-4-5toh --timeout 570
POLL_CHECK=PASS status=done
  "zipName": "dsh-better-sidebar-offline-0.13.1-dsh-0.1.0-rc.7.zip",
  "sizeBytes": 46940272, "version": "0.13.1", "targetDshVersion": "0.1.0-rc.7", "mode": "registry",
  "warnings": ["已从 vendor 依赖中剔除需要安装脚本的包：node-pty@1.1.0（…依赖目标 DSH 宿主提供…）"]
正在从 https://registry.npmjs.org 下载 dsh-better-sidebar@0.13.1 …（2.39 MiB）
正在用 npm 安装运行时依赖（--omit=dev --omit=peer --ignore-scripts）…
完成：…（46940272 B，12864 个文件，157 个内嵌依赖，校验和 12863 条）
job … finished in 49746 ms
```

### 6.3 zip 校验

```text
$ bash verify/probe-api.sh download dsh-better-sidebar-offline-0.13.1-dsh-0.1.0-rc.7.zip
GET /api/download?name=… -> HTTP 200 size=46940272
sha256=2bf34c436545172eb061588abf9149928e6902c6155139ca74de9cd3a758587d
$ bash verify/validate-zip.sh … --expect-plugin dsh-better-sidebar --expect-version 0.13.1 --expect-target 0.1.0-rc.7
PASS  unzip -t: archive coherent (12864 entries tested)
PASS  layout: package/package.json / install-offline.sh / .ps1 / README.md / CHECKSUMS.txt / VERSIONS.txt 全部 present
PASS  manifest assertions (9 checks)
PASS  sha256sum -c CHECKSUMS.txt: 12863/12863 OK
PASS  bash -n install-offline.sh
PASS  no absolute or ../ members in archive
RESULT=PASS checks=22 failures=0
files=12864 dir_size=193M
```

### 6.4 全新 home 安装 + rc.7 宿主启动（3086）

```text
$ bash verify/offline-install.sh …0.13.1….zip --home …/home-hist
installed plugin dir: …/node_modules/dsh-better-sidebar (12859 files)
installed version: 0.13.1
INSTALL_RESULT=PASS
$ bash verify/setup-host.sh --no-plugin --port 3086 --home …/home-hist \
    --dsh-bin /home/fc/dsh-plugin-build/host-pinned/node_modules/@deepseek-ai/dsh/lib/bin.js
HOST_READY port=3086 … dsh=0.1.0-rc.7

$ bash verify/boot-evidence.sh 3086 --expect-plugin dsh-better-sidebar \
    --probe 'GET /' --probe 'POST /sidebar/api/terminal.deps' --probe 'POST /sidebar/api/settings.get'
dsh=…/host-pinned/…/bin.js (0.1.0-rc.7) plugin-expected=dsh-better-sidebar
PASS  startup log: no hard failures
PASS  GET / 200
      manifest contains "dsh-better-sidebar": YES
GET client bundle /plugins/dsh-better-sidebar/client.js?rev=e8d89fb112f6 -> HTTP 200 size=458844
PASS  plugin client bundle served
PASS  dump-config mentions dsh-better-sidebar (3 lines)
PROBE GET / -> 200 <!doctype html>
PASS  probe GET /
PROBE POST /sidebar/api/terminal.deps -> 200 {"ok":true,"value":{"ok":true}}
PASS  probe POST /sidebar/api/terminal.deps
PROBE POST /sidebar/api/settings.get -> 200 {"ok":true,"value":{"value":{"openByDefault":false,…}}}
PASS  probe POST /sidebar/api/settings.get
EVIDENCE_RESULT=PASS
```

**判读**：矩阵 ≥30（36）；0.13.1 的 dshPeers 确含 `^0.1.0-rc.7`；registry 打包成功（49.7s < 10min npm 超时）；产物校验 12863/12863；在**纯 rc.7 宿主**上全新 home 安装并启动，boot manifest/client bundle/dump-config 证明插件加载，`terminal.deps` 返回 `ok:true`（node-pty 可用），页面 `/` 200。**PASS**。

> 已知限制（Lead 已确认，不算 FAIL）：registry 模式按契约内嵌完整声明依赖树，因此该产物 46.9MB / 12864 文件（远大于上一轮手工 7.9MB/321 文件）。见 §11-R1。

---

## 7. 项 6：错误路径 —— PASS

```text
$ bash verify/probe-api.sh matrix definitely-not-a-real-plugin-xyz --expect-error
structured error envelope: {"code":"REGISTRY_HTTP","message":"npm registry 返回 HTTP 404（definitely-not-a-real-plugin-xyz）：{\"error\":\"Not found\"}"}
MATRIX_CHECK=PASS (expected error code=REGISTRY_HTTP)

$ bash verify/probe-api.sh download '../../etc/passwd.zip' --expect-error
GET /api/download?name=../../etc/passwd.zip -> HTTP 400 size=109
error body: {"ok":false,"error":{"code":"BAD_NAME","message":"只允许下载 offline-packages 目录下的 zip 文件"}}
DOWNLOAD_CHECK=PASS (expected structured error, http=400)

$ bash verify/probe-api.sh download '/home/fc/.dsh/profiles/web/package.json' --expect-error
error body: {"ok":false,"error":{"code":"BAD_NAME",…}}   DOWNLOAD_CHECK=PASS
$ bash verify/probe-api.sh download 'not-a-zip.txt' --expect-error
error body: {"ok":false,"error":{"code":"BAD_NAME",…}}   DOWNLOAD_CHECK=PASS
$ bash verify/probe-api.sh raw GET '/dsh-offline-packer/api/download?name='
HTTP 400
{"ok":false,"error":{"code":"BAD_NAME","message":"只允许下载 offline-packages 目录下的 zip 文件"}}

$ bash verify/probe-api.sh package-local no-such-plugin-xyz
PACKAGE_LOCAL_CHECK=PASS jobId=mvt06b06-6-q90o
$ bash verify/probe-api.sh poll mvt06b06-6-q90o --expect-error
POLL_CHECK=PASS (expected job error) error={"code":"PLUGIN_NOT_FOUND","message":"当前 home/profile 里没有找到插件 no-such-plugin-xyz（…/verify/home / web）"}

$ bash verify/probe-api.sh state          # 服务未崩
STATE_CHECK=PASS plugins=19 dshVersion=0.2.1-rc.2
```

**判读**：三类错误均返回结构化 `{ok:false,error:{code,message}}`，job 错误也以 job 状态 + error 信封呈现，服务继续可用。**PASS**。

---

## 8. 项 7：安全/边界 —— PASS（附 1 条语义小建议）

### 8.1 fence（伪造 Origin）

```text
$ bash verify/probe-api.sh fence GET /dsh-offline-packer/api/state
cross-origin (http://evil.example) -> HTTP 403 (expect 403)
same-origin  (http://127.0.0.1:3084) -> HTTP 200 (expect not 403)
FENCE_CHECK=PASS

# 写操作同样受 fence 保护
POST /api/package-local  evil-origin   -> 403
POST /api/package-local  same-origin   -> 200
```

### 8.2 download 只允许 outputRoot 下 zip

```text
GET /api/download?name=..%2F..%2Fetc%2Fpasswd.zip  -> 400 BAD_NAME
GET /api/download?name=%2Fetc%2Fpasswd             -> 400 BAD_NAME
GET /api/download?name=                            -> 400 BAD_NAME
GET /api/download?name=<合法 zip>                  -> 200（正控，见 §4.1）
```

### 8.3 home/profile 参数边界

```text
$ GET /api/state?home=relative/does-not-exist
HTTP 200
{"ok":true,"value":{"host":{"dshVersion":"0.2.1-rc.2",…},
 "dshHome":"/home/fc/dsh-offline-packer/verify/tmp/run-cwd/relative/does-not-exist",
 "profile":"web","profileDir":"…/relative/does-not-exist/profiles/web", …,"plugins":[]}}

$ GET /api/state?profile=..%2Fevil
HTTP 500
{"ok":false,"error":{"code":"BAD_REQUEST","message":"profile 名不合法：../evil"}}

$ GET /api/state?home=&profile=
HTTP 200  # 空值回落到当前进程 home/profile（正控）
```

**判读**：fence 正确拒绝跨源（读/写均 403），同源正常；download 的 `../`、绝对路径、空名、非 zip 一律 400 BAD_NAME，且只能下载 outputRoot 下 zip；相对 home 被 `resolve()` 成绝对路径并按空列表返回（不崩、不写），空参数回落默认；非法 profile 返回结构化 BAD_REQUEST。**PASS**。

> 观察（非 FAIL，见 §11-R3/R4）：(a) 契约写 home 仅允许绝对路径，实现会接受相对路径并相对**进程 cwd** 解析——行为安全但建议显式校验或文档化；(b) 非法 profile 的 HTTP 状态是 500 而 code 是 BAD_REQUEST，建议 catch 里把 BAD_REQUEST/BAD_NAME 映射 4xx。

---

## 9. 项 8：无回归 —— PASS

```text
# 停止全部测试宿主
$ bash verify/teardown-host.sh
port 3084: free   port 3085: free   port 3086: free

# 用户 3080 GUI（未触碰，仅 curl）
$ curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
401        # 仍在服务（token gate 正常）

# /home/fc/.dsh 前后快照（profile package.json + node_modules 顶层条目/版本清单；共 583 行）
$ bash verify/snapshot-user-home.sh formal-before   # 03:44:00Z
profile package.json sha256: 50a955b5ad0b722b0bd335d5841c6de8c5e4a315927fc5f10422f2ec67f62cd8
plugin count: count=328
$ bash verify/snapshot-user-home.sh formal-after    # 03:50:10Z
profile package.json sha256: 50a955b5ad0b722b0bd335d5841c6de8c5e4a315927fc5f10422f2ec67f62cd8
plugin count: count=328
$ diff -u run/user-home-formal-before.txt run/user-home-formal-after.txt
-# snapshot 'formal-before' 2026-10-29T03:44:00Z
+# snapshot 'formal-after' 2026-10-29T03:50:10Z
  ## profile package.json
  50a955b5… /home/fc/.dsh/profiles/web/package.json
  /home/fc/.dsh/profiles/web/package.json mtime=2026-10-28 11:26:30 size=1068
# 唯一差异 = 快照时间标签行；package.json hash/mtime、328 个包、node_modules 顶层条目全部一致

$ find /home/fc/.dsh -maxdepth 2 \( -name 'offline-packages' -o -name '*.zip' \)
(none)
```

**判读**：测试宿主已停止、3084-3086 释放；3080 仍正常；用户 home 未被写入（无 `offline-packages`/zip，package.json 与 328 个包清单逐项一致）。**PASS**。

---

## 10. Lead 附加项 A：官方安装通道验证插件自身可分发 —— PASS（但项目根 tgz 已过期）

### 10.1 用最新源码重新 `npm pack`（发现根目录产物过期）

```text
$ npm pack --pack-destination verify/tmp/npm-pack
npm notice total files: 18
dsh-offline-packer-0.1.0.tgz          # 72,782 B

# 内容与工作树一致性
$ tar -xzOf verify/tmp/npm-pack/dsh-offline-packer-0.1.0.tgz package/client.js | sha256sum
1f160c426d9f3c11da0cd0731d0727b97572b785de4a7e59db4765998c3a18ed
$ sha256sum client.js
1f160c426d9f3c11da0cd0731d0727b97572b785de4a7e59db4765998c3a18ed   # SAME

# 项目根目录现存的 dsh-offline-packer-0.1.0.tgz（Lead 早前打的）：
$ tar -xzOf /home/fc/dsh-offline-packer/dsh-offline-packer-0.1.0.tgz package/client.js | sha256sum
33abcb6959986b1cbae34acbe8634b2ec426dbb2f52033888305b86124249e99
# => 与最终 client.js 不同：该 tgz 早于 11:42 的 UI 收尾修改，交付前需重新 npm pack
```

### 10.2 官方通道装进全新 home

```text
$ DSH_HOME=…/verify/home-npm node …/dsh/lib/bin.js plugin --profile web add \
    /home/fc/dsh-offline-packer/verify/tmp/npm-pack/dsh-offline-packer-0.1.0.tgz
dsh: initialized profile web at …/home-npm/profiles/web
dependencies:
+ dsh-offline-packer file:…/verify/tmp/npm-pack/dsh-offline-packer-0.1.0.tgz
Packages: +1
Done in 989ms using pnpm v11.21.0
```

profile 结果（dependencies + bundles 自动追加 + 插件目录完整）：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": { "dsh-offline-packer": "file:…/verify/tmp/npm-pack/dsh-offline-packer-0.1.0.tgz" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-offline-packer"] } }
}
```

插件目录 18 文件（package.json/index.js/client.js/cordis.patch.yml/lib 13 个 mjs/README/ARCHITECTURE）：

```text
profiles/web/node_modules/dsh-offline-packer/lib/{analyze,historical,host,inventory,jobs,local,pack,registry,scripts,tar,vendor,zip}.mjs
```

`--dump-config`：exit 0、1232 行，末尾出现 `# == dsh-offline-packer` / `- id: offline-packer` / `name: dsh-offline-packer`。

### 10.3 启动该 home（3085）验证

```text
boot log: dsh web: http://127.0.0.1:3085/?token=<redacted>    # 无 warning / 无 failed to import
$ bash verify/probe-api.sh --port 3085 state
STATE_CHECK=PASS plugins=19 dshVersion=0.2.1-rc.2
$ node verify/ui-smoke.mjs --port 3085 --min-plugins 5
… PASS ×11 …  UI_SMOKE=PASS assertions=11 failed=0（无 console/page error）
```

**判读**：最新源码的 npm tgz 走官方 `dsh plugin add` 通道可安装（profile 依赖/bundles/目录正确）、启动日志干净、state 200、UI 正常。**PASS**。注意：项目根目录现存的 `dsh-offline-packer-0.1.0.tgz` 是旧版 client.js 打的，**交付前必须重新 `npm pack`**（建议用本次 `verify/tmp/npm-pack/dsh-offline-packer-0.1.0.tgz` 覆盖或重打）。

---

## 11. 遗留风险 / 已知限制与建议

| ID | 风险/限制 | 等级 | 说明与建议 |
|---|---|---|---|
| R1 | **历史 registry 包体积大**（46.9MB / 12864 文件，上一轮手工包 7.9MB/321 文件） | 已知限制（Lead 确认不算 FAIL） | registry 模式按契约内嵌完整声明依赖树（安全超集），把浏览器侧依赖（@codemirror/*、mermaid、d3-* 等）也打进了 `package/node_modules`，尽管它们已内联进 client.js。功能完全正常（rc.7 boot + terminal.deps 已证）。建议未来在 registry 路径引入 analyze 裁剪开关（如 `--trim-browser-deps`/白名单），或对 bundle 插件跳过仅客户端依赖。 |
| R2 | 历史包剔除 `node-pty@1.1.0`（`--ignore-scripts`，原生绑定无法构建） | 设计内 | 打包日志明确给出 warning；目标宿主（rc.7）经 `profiles/node_modules` 回退提供 node-pty，实测 `terminal.deps -> {"ok":true}`。若离线机器宿主未提供 node-pty，终端功能降级（README 应已说明）。 |
| R3 | `home` 参数允许相对路径（契约写"仅绝对路径"） | 低 | 实测 `home=relative/x` 被 `resolve()` 到进程 cwd 并返回空列表（不崩、不写、输出仍写 outputRoot），行为安全；建议显式校验绝对路径或文档化该行为。 |
| R4 | 非法 `profile` 返回 HTTP 500（code=BAD_REQUEST） | 低 | 结构化信封正确，但状态码语义应为 400；建议 index.js catch 中把 BAD_REQUEST/BAD_NAME/JOB_* 等映射到 4xx。不影响功能。 |
| R5 | 项目根 `dsh-offline-packer-0.1.0.tgz` 过期 | 交付前动作 | 该 tgz 内 client.js sha 与最终工作树不同（`33abcb…` vs `1f160c…`）。交付前重新 `npm pack`。 |
| R6 | 浏览器验证范围 | 低 | headless Chromium 1600×1000、locale=en-US、浅色主题、无会话落地页；深色主题/窄屏/真实会话内交互未覆盖。UI 断言含无 console/page error、核心 testid、行数、刷新、一键打包与结果下载链接。 |
| R7 | PowerShell installer 未实机执行 | 低 | 本轮只校验 `.ps1` 存在与 zip 结构；`bash -n` 只适用于 `.sh`。上一轮对同源 ps1 做过 AST+Linux pwsh DryRun；本插件生成的 ps1 建议在 Windows PowerShell 5.1 做一次人工冒烟。 |
| R8 | 历史打包依赖 npm + 网络 | 设计内 | 已验证 npm 可用、49.7s 完成；离线机器不需要该步骤（只用产物）。npm 缺失时契约报 NPM_MISSING。 |
| R9 | 大插件本地包内嵌依赖为 0（全部宿主提供） | 低 | 本宿主 rc.2 的安装闭包提供 ws/yaml/@deepseek-ai/* 等，因此 sidebar 0.28.1 本地包无内嵌；若目标宿主闭包不同，需以目标宿主重新打包。属"按当前宿主打包"的正常语义。 |

未发现需要修改 A/B/C/Lead 代码的缺陷，因此未生成 `verify/suggested-fixes.md`；R1/R3/R4/R5 为建议/交付动作。

---

## 12. 证据文件索引

- 脚本：`verify/{env,check-env,setup-host,teardown-host,probe-api,validate-zip,boot-evidence,offline-install,snapshot-user-home}.sh`、`verify/ui-smoke.mjs`、说明 `verify/README.md`、准备笔记 `verify/notes-prep.md`
- 环境自检：`verify/logs/check-env.log`
- 宿主启动日志（最终：3084 dev host / 3085 产物 home / 3086 rc.7 历史包）：
  - `verify/logs/host-3084.log`（仅一行 `dsh web: http://127.0.0.1:3084/?token=…`）
  - `verify/logs/host-3085.log`（官方通道 home、无 warning）
  - `verify/logs/host-3086.log`（rc.7，`dsh web: http://127.0.0.1:3086`）
- 安装/卸载脚本输出：`verify/logs/offline-install-*.log`（unlag install/uninstall、sidebar 0.28.1、sidebar 0.13.1→rc.7）
- UI 截图（最终版）：`verify/artifacts/main/{01-landing,02-settings,03-offline-packer,03b-scan-home,04-after-refresh,05-job-done,05b-job-panel}.png` + `verify/artifacts/main/ui-smoke.json`（15 断言）
- 启动证据：`verify/artifacts/evidence-3085-034520.*`（unlag 安装后 3085）、`evidence-3085-034537.*`（卸载后再启动）、`evidence-3085-034605.*`（sidebar 0.28.1 本地包 3085）、`evidence-3086-034729.*`（rc.7 历史包 3086，含 probe JSON）
- 官方通道：`verify/artifacts/npm-add-dump-config.txt`（1232 行）、`verify/artifacts/ui-smoke-npm.json`（11 断言）
- 产物与校验：`verify/tmp/downloads/{dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip, dsh-better-sidebar-offline-0.28.1-dsh-0.2.1-rc.2.zip, dsh-better-sidebar-offline-0.13.1-dsh-0.1.0-rc.7.zip}`
- 无回归：`verify/run/user-home-formal-before.txt`、`user-home-formal-after.txt`、`user-home-formal.diff`
- 隔离 home：`verify/home/`（dev 宿主）、`verify/home-installed/`（unlag 产物，已卸载）、`verify/home-sidebar/`（sidebar 0.28.1 本地包）、`verify/home-hist/`（rc.7 历史包）、`verify/home-npm/`（官方 npm pack 通道）

## 13. 最终判断

**可交付（PASS）。**

- 插件在 dsh 0.2.1-rc.2 上 boot 干净、`/api/state` 结构/版本正确、只读扫描用户 home 17 项。
- 设置面板「离线打包」页完整可用：列表/搜索/刷新/一键打包/任务面板/结果下载链接，无 console/page error。
- 本地一键打包（unlag 小插件、sidebar 28.1 大插件）产物全部通过结构/manifest/checksum/语法/权限断言；小插件产物在**真实断网**下安装、启动、卸载、再启动全部通过。
- 历史版本矩阵与 registry 打包可用，0.13.1→rc.7 产物在**纯 rc.7 宿主**上启动成功且侧边栏 API（terminal.deps）ok。
- 错误路径结构化、fence 与路径穿越防护正确、用户环境零回归。
- 仅需交付前动作：重新 `npm pack` 覆盖过期 tgz；接受/记录历史包体积已知限制（建议后续加裁剪开关）。
