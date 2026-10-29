# 复验报告（delta5）：v0.1.4「目标驱动」历史版本面板（插件版本 × DSH 版本一对多绑定）—— a) PASS / b) PASS / c) PASS / d) PASS

- 验证员：`qa-verifier`（独立 fresh context）
- 日期：2026-10-29 13:20-13:25（Asia/Shanghai）
- 范围：只复验 v0.1.4 的目标驱动 UX（纯 client.js 改动）与升级/回归；不重跑全部 8 项与输出目录全量（v0.1.2 已 PASS）。
- 结论：**全部 PASS**。目标过滤/自动选中/芯片反填/显示全部切换/标记 全部符合 Lead 描述（22 项 Playwright 断言全过）；服务端零改动（逐字节验证）；registry/local 打包回归正常。未改任何代码。

## 0. 产物与改动范围（证明「纯 client.js 改动」）

```text
$ node -e 'console.log(require("./package.json").version)'   -> 0.1.4
$ sha256sum dsh-offline-packer-0.1.4.tgz
31fd6a3074894b12e85988a9d10ea0ecb5a2dd4272bb91ddfa9840979c22e0af   # == Lead 给定
$ sha256sum client.js                                                478585d6c1c4f533936a976acc8aac0fe134c0ae5f2b4a5463a230b159ebeb23
$ tar -xzOf dsh-offline-packer-0.1.4.tgz package/client.js | sha256sum 478585d6…（tgz == 工作树）

# 与上一版 v0.1.3 的安装副本逐字节对比（verify/home-delta4 里保留的 0.1.3 安装）：
$ diff -rq <v0.1.3>/ <v0.1.4>/
Files <v0.1.3>/ARCHITECTURE.md and <v0.1.4>/ARCHITECTURE.md differ
Files <v0.1.3>/README.md and <v0.1.4>/README.md differ
Files <v0.1.3>/client.js and <v0.1.4>/client.js differ
Files <v0.1.3>/package.json and <v0.1.4>/package.json differ

$ # 服务端文件逐字节比对：全部 SAME
SAME  index.js
SAME  lib/analyze.mjs   SAME  lib/historical.mjs  SAME  lib/host.mjs
SAME  lib/inventory.mjs SAME  lib/jobs.mjs         SAME  lib/local.mjs
SAME  lib/pack.mjs      SAME  lib/registry.mjs     SAME  lib/scripts.mjs
SAME  lib/tar.mjs       SAME  lib/vendor.mjs       SAME  lib/zip.mjs
# package.json 除 version 外完全一致
```

→ 与 Lead 的「纯 client.js 改动（+文档/版本号）」一致；server 逻辑零变化。

---

## 1. a) 最新 tgz → 全新 home → boot 无 warning、state 200 —— PASS

```text
$ DSH_HOME=…/verify/home-delta5 node …/dsh/lib/bin.js plugin --profile web add \
    /home/fc/dsh-offline-packer/dsh-offline-packer-0.1.4.tgz
Packages: +1
Done in 878ms using pnpm v11.21.0
installed: 0.1.4

boot log: dsh web: http://127.0.0.1:3084/?token=<redacted>
$ grep -niE 'warning|entry apply failed|duplicate prefix route|FAILED|Cannot resolve|ERR_MODULE|uncaught' verify/logs/host-3084.log
(no warning/failure lines)
$ bash verify/probe-api.sh --port 3084 state
ok=true host.dshVersion=0.2.1-rc.2 dshHome=…/verify/home-delta5 profile=web plugins=1
STATE_CHECK=PASS plugins=1 dshVersion=0.2.1-rc.2
```

**PASS**。

---

## 2. b) 目标驱动历史版本面板（Playwright）—— PASS（22 项断言全过）

新增脚本 `verify/version-binding.mjs`（Playwright：打开应用→关闭 Preview Notice/onboarding→Settings→Offline Packager→扫 home=/home/fc/.dsh→dsh-better-sidebar 的「Version history…」→断言/截图）。

```bash
node verify/version-binding.mjs --port 3084 --scan-home /home/fc/.dsh \
  --plugin dsh-better-sidebar --target 0.1.0-rc.7 \
  --out verify/artifacts/delta5 --json verify/artifacts/delta5/history.json
```

### 2.1 默认（目标 = 宿主版本 0.2.1-rc.2）

```text
PASS  plugin list loaded :: rows=14 hasPlugin=true
PASS  history toggle present
PASS  matrix loaded from registry :: rows=4
PASS  default target == host DSH version :: target=0.2.1-rc.2 host=0.2.1-rc.2
PASS  default filter note present (n/total) :: note=Versions compatible with 0.2.1-rc.2: 4/36
PASS  default visible rows are all compatible :: rows=4 compat=yes
PASS  default filter numerator == visible row count :: note=4/36 rows=4
PASS  default selected version == newest compatible :: selected=0.28.2 newest=0.28.2
```

→ 默认目标=宿主版本；列表只含 `data-compatible="yes"` 行；filter note「目标 0.2.1-rc.2 的兼容版本：4/36」；自动选中最新兼容版 0.28.2。与 Lead 自测一致。

### 2.2 改目标为 0.1.0-rc.7

```text
PASS  target filter note reflects new target :: note=Versions compatible with 0.1.0-rc.7: 11/36
PASS  target = 0.1.0-rc.7 filters to 11/36 :: note=Versions compatible with 0.1.0-rc.7: 11/36
PASS  filtered rows are all compatible :: rows=11
PASS  selected version becomes 0.13.1 :: selected=0.13.1
PASS  selected-version DSH chips contain target :: chips=["0.1.0-rc.8","0.1.0-rc.7"]
PASS  selected-version DSH chips contain 0.1.0-rc.8 (multi-value range) :: 同上
```

→ 列表变 11/36、全部兼容行、自动选中 **0.13.1**；「插件版本 0.13.1 声明兼容的 DSH 版本」芯片 = **[0.1.0-rc.8, 0.1.0-rc.7]**（恰好体现一对多关系）。与 Lead 自测一致。

### 2.3 显示全部 / 切回只看兼容

```text
PASS  show-all lists all 36 versions :: rows=36
PASS  show-all includes data-compatible=no rows :: no=25 unknown=0
PASS  show-all hides the compatible filter note :: note=null
PASS  show-all toggle label flips to "Show compatible only" :: label=Show compatible only
PASS  toggle back restores compatible-only rows :: rows=11 note=Versions compatible with 0.1.0-rc.7: 11/36
PASS  no page errors
PASS  no console errors
VERSION_BINDING=PASS assertions=22 failed=0
```

→ 「显示全部」= 36 行（25 行 `data-compatible="no"`，其余 yes，unknown=0），filter note 隐藏、按钮文案翻转为「Show compatible only」；再点回恢复 11 行兼容列表；**0 console/page error**。

截图（`verify/artifacts/delta5/`，实拍）：
- `01-landing.png`、`02-settings.png`、`03-offline-packer.png`（14 第三方插件）
- `04-history-default.png`：默认目标 0.2.1-rc.2、4/36、选中 0.28.2
- `05-history-target-rc7.png`：目标框 `0.1.0-rc.7`、`npm version matrix 36 versions`、`Versions compatible with 0.1.0-rc.7: 11/36`、表格首行 `0.13.1 2026-08-18 ^0.1.0-rc.7 ✓`、按钮「Show all versions (including incompatible)」
- `06-history-all.png`：36 行 + ⚠/✓ 标记
- `07-history-compatible-only.png`：切回 11 行

> 说明：脚本首次运行时被延迟出现的「Preview Notice」弹窗遮挡导致未进入面板（非产品缺陷）；增强遮罩处理（循环点 Continue/Close 并等待）后重跑，结果如上全 PASS。

**PASS**。

---

## 3. c) 打包回归 —— PASS

### 3.1 registry：dsh-better-sidebar@0.13.1 → 目标 0.1.0-rc.7（与 UI 选中的组合一致）

```text
$ bash verify/probe-api.sh --port 3084 package-registry dsh-better-sidebar 0.13.1 0.1.0-rc.7
PACKAGE_REGISTRY_CHECK=PASS jobId=mvt3kovw-1-jwvx
$ … poll
POLL_CHECK=PASS status=done   progress={"phase":"完成","percent":100}
  "zipName": "dsh-better-sidebar-offline-0.13.1-dsh-0.1.0-rc.7.zip",
  "sizeBytes": 46940280, "version": "0.13.1", "targetDshVersion": "0.1.0-rc.7", "mode": "registry"
完成：…（46940280 B，12864 个文件，157 个内嵌依赖，校验和 12863 条）
job … finished in 50633 ms

$ … download（默认 outputRoot）-> HTTP 200
sha256=a9df2b05511ff166fa96e3ac258532f8a6860afd6d4ca98c2bc4dbd8ac6af5bc
$ bash verify/validate-zip.sh … --expect-plugin dsh-better-sidebar --expect-version 0.13.1 --expect-target 0.1.0-rc.7
PASS  unzip -t: archive coherent (12864 entries tested)
PASS  sha256sum -c CHECKSUMS.txt: 12863/12863 OK
RESULT=PASS checks=22 failures=0
```

与之前 delta3 结果一致（字节大小因 zip 时间戳略有差异，结构/校验和一致）。

### 3.2 local 通道抽查（state → package-local → progress → download）

```text
$ bash verify/probe-api.sh --port 3084 state
STATE_CHECK=PASS plugins=1 dshVersion=0.2.1-rc.2

$ bash verify/probe-api.sh --port 3084 package-local dsh-unlag --home /home/fc/.dsh \
    --output-root /home/fc/dsh-offline-packer/verify/tmp/delta5-local
PACKAGE_LOCAL_CHECK=PASS jobId=mvt3m1ia-2-r43l
  progress: status=running phase=读取插件清单 percent=12
  progress: status=done phase=完成 percent=100
ASSERT_OK progress percent monotonically non-decreasing
PROGRESS_CHECK=PASS transitions=1 final=完成/100   (duration 422ms)

$ … download … --output-root /home/fc/dsh-offline-packer/verify/tmp/delta5-local -> HTTP 200
$ bash verify/validate-zip.sh … --expect-plugin dsh-unlag …
PASS  sha256sum -c CHECKSUMS.txt: 15/15 OK
RESULT=PASS checks=22 failures=0
```

→ 输出目录/进度/下载链路未受 v0.1.4 影响。**PASS**。

---

## 4. d) 用户 profile / 用户 home —— PASS

```text
installed: 0.1.4
dep: file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.4.tgz
deps: 13   bundles: 16（contains dsh-offline-packer = true）

# 版本清单 diff vs delta4-after（v0.1.3）：
-dsh-offline-packer@0.1.3
+dsh-offline-packer@0.1.4        # 唯一版本变化；其余 328 个包版本未变（count=329）

$ DSH_HOME=/home/fc/.dsh node …/dsh/lib/bin.js --profile web --dump-config
exit 0，1408 行
1406:# == dsh-offline-packer
1407:- id: offline-packer
1408:  name: dsh-offline-packer
执行前后 profile package.json sha256 均为 4f65514b…（未变）

# 用户 home 快照 pre/after（本次验证窗口）：
diff 仅 2 类差异：时间标签行 + cordis.yml 的 mtime（dump-config 由宿主 compose 刷新；内容 sha 不变、223B）
其余 package.json hash/mtime、node_modules 顶层、329 包版本清单全部一致
# 顶层 /home/fc/.dsh：13:20 之后仅 packages/（Lead 升级安装），无其它新写入
```

补充观察（**非本次验证造成**，与之前 delta 报告一致）：`/home/fc/.dsh/offline-packages/` 里存在 `dsh-session-manager…（12:04:10）` 与 `dsh-rewind-plugin-offline-0.14.0-beta.1-dsh-0.1.7-rc.1（12:05:25）` 两个历史包，是用户 GUI（3080）上正在使用本插件的人为操作产物，时间早于本次验证窗口（13:20+）；本次验证所有打包输出均在 `verify/**`（`verify/home-delta5/offline-packages`、`verify/tmp/delta5-*`），未写用户 home。

**PASS**。

---

## 5. 清理与证据

```text
端口 3084/3085/3086: free（复测三端口均 BIND OK）
3080 用户 GUI: HTTP 401（未触碰）
无遗留测试宿主进程
```

- 本报告：`verify/report-delta5.md`
- 脚本：`verify/version-binding.mjs`（新增，可复跑）；进度采样 `verify/artifacts/delta5/progress-local.{txt,log}`
- 截图/JSON：`verify/artifacts/delta5/{01-landing,02-settings,03-offline-packer,04-history-default,05-history-target-rc7,06-history-all,07-history-compatible-only}.png`、`history.json`（22 断言）
- dump-config：`verify/artifacts/delta5/dump-config-user-home.txt`（1408 行）
- 快照：`verify/run/user-home-delta5-{pre,after}.txt`、`user-home-delta5.diff`
- 测试宿主：`verify/home-delta5/`（官方通道安装 v0.1.4）、`verify/logs/host-3084.log`
- 产物：`/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.4.tgz`（sha256 `31fd6a30…`）、`/home/fc/.dsh/packages/` 同 sha

## 6. 最终判断

**delta5 全部 PASS，可交付。**

- 「目标驱动」UX 与 Lead 描述逐项一致：默认目标=宿主版本、只显示兼容行（4/36）并自动选中 0.28.2；目标改 0.1.0-rc.7 后 11/36、自动选中 0.13.1、兼容 DSH 芯片 [0.1.0-rc.8, 0.1.0-rc.7]；显示全部 36 行（25 行不兼容 ⚠，unknown=0）并可切回；0 console/page error。
- 「纯 client.js 改动」经逐字节验证（server 13 个文件全部 SAME，仅 client.js/文档/版本号变化）。
- 打包回归：registry（0.13.1→rc.7）与 local 通道均正常，产物校验通过。
- 用户 profile 升级 0.1.4、其它 328 个包版本未变；本验证对用户 home 零写入（仅 dump-config 引起 cordis.yml mtime，内容不变）。
