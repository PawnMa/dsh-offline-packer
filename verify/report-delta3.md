# 复验报告（delta3）：v0.1.2「打包进度 + 自定义输出目录」——a) PASS / b) PASS / c) PASS / d) PASS / e) PASS / f) PASS

- 验证员：`qa-verifier`（独立 fresh context）
- 日期：2026-10-29 12:31-12:36（Asia/Shanghai）
- 范围：仅复验 v0.1.2 delta（进度 + 输出目录 + 版本升级/重新打包），不重跑全部 8 项；基线见 `verify/report.md`，前序 delta 见 `verify/report-delta.md`、`verify/report-delta2.md`
- 结论：**全部 PASS**，未发现缺陷；仅有 1 条源码层面的低风险观察（§3.3）与 1 条环境 note（§8）。未改任何代码。

## 0. 被复验产物（版本/tgz 一致性）

```text
$ node -e 'console.log(require("./package.json").version)'   -> 0.1.2
$ sha256sum dsh-offline-packer-0.1.2.tgz
3512194bc676a62ffcf5ae3c4f34d4ee6b43593dd4367b5a2cc53c09251622d3   # == Lead 给定
$ tar -xzOf dsh-offline-packer-0.1.2.tgz package/client.js | sha256sum
e26dc4b656d58a7ebbe29a6f3405a8b5756e2ee520ae16e6a27814c48a8a3c0c
$ sha256sum client.js
e26dc4b656d58a7ebbe29a6f3405a8b5756e2ee520ae16e6a27814c48a8a3c0c   # tgz == 工作树

# 用户 home 中已安装的 0.1.2
installed: 0.1.2
dep: file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.2.tgz
deps: 13   bundles: 16
$ sha256sum /home/fc/.dsh/packages/dsh-offline-packer-0.1.2.tgz
3512194bc676a62ffcf5ae3c4f34d4ee6b43593dd4367b5a2cc53c09251622d3
```

代码确认：`index.js` 有 `resolveOutputRoot`（绝对路径校验/`~` 展开/已存在非目录拒绝 → `BAD_OUTPUT_DIR`）与 `progress` 参数；`lib/jobs.mjs` 维护 `{phase,percent}`（done→`完成/100`）；`lib/local.mjs`/`lib/pack.mjs`/`lib/historical.mjs` 在关键步骤调用 `progress(phase, percent)`；`client.js` 含 `offline-packer-output-input`、`offline-packer-progress`（`data-progress-percent`）、`offline-packer-result`、`offline-packer-download`。

---

## 1. a) 最新 tgz → 全新 home → boot 无 warning、state 200 —— PASS

```text
$ DSH_HOME=…/verify/home-delta3 node …/dsh/lib/bin.js plugin --profile web add \
    /home/fc/dsh-offline-packer/dsh-offline-packer-0.1.2.tgz
dependencies:
+ dsh-offline-packer file:/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.2.tgz
Packages: +1
Done in 968ms using pnpm v11.21.0
installed version: 0.1.2
bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-offline-packer"]
```

启动（端口 3084）：

```text
boot log: dsh web: http://127.0.0.1:3084/?token=<redacted>
$ grep -niE 'warning|entry apply failed|duplicate prefix route|FAILED|Cannot resolve|ERR_MODULE|uncaught' verify/logs/host-3084.log
(no warning/failure lines)

$ bash verify/probe-api.sh --port 3084 state
ok=true host.dshVersion=0.2.1-rc.2 dshHome=…/verify/home-delta3 profile=web plugins=1
hiddenOfficial=18 officialCount=18
STATE_CHECK=PASS plugins=1 dshVersion=0.2.1-rc.2
```

**PASS**。

---

## 2. b) 打包进度 —— PASS

服务端新增 `GET /api/job?id=` 返回 `{status, progress:{phase,percent}, startedAt, finishedAt, logs, result}`；用新增的 `verify/probe-api.sh progress <jobId>` 高频轮询（20ms）记录每次变化。

### 2.1 本地打包（`dsh-better-sidebar`，home=/home/fc/.dsh，自定义输出目录）

```text
$ bash verify/probe-api.sh --port 3084 package-local dsh-better-sidebar \
    --home /home/fc/.dsh --output-root /home/fc/dsh-offline-packer/verify/tmp/delta3-out-api2
POST … -> HTTP 200
PACKAGE_LOCAL_CHECK=PASS jobId=mvt1sd9i-2-j9zc

$ bash verify/probe-api.sh --port 3084 progress mvt1sd9i-2-j9zc --interval 0.02 --timeout 240 \
    --log verify/artifacts/delta3/progress-local.log
watching job mvt1sd9i-2-j9zc progress (timeout 240s interval 0.02s)
  progress: status=running phase=读取插件清单 percent=12 t=…
  progress: status=running phase=分析运行时依赖 percent=22 t=…
  progress: status=running phase=复制插件文件 percent=52 t=…
  progress: status=running phase=生成校验清单 percent=86 t=…
  progress: status=running phase=打包 zip percent=94 t=…
  progress: status=done phase=完成 percent=100 t=…
ASSERT_OK progress percent monotonically non-decreasing
final: status=done phase=完成 percent=100
startedAt=1793248384806 finishedAt=1793248386200 duration_ms=1394
PROGRESS_CHECK=PASS transitions=5 final=完成/100
```

job 最终 payload：

```json
{"id":"mvt1sd9i-2-j9zc","kind":"local","status":"done",
 "progress":{"phase":"完成","percent":100},
 "startedAt":1793248384806,"finishedAt":1793248386200,"duration":1394}
```

→ 阶段串 12→22→52→86→94→100 **单调不减**，与 Lead 描述的 12/52/86/94/100 一致（高频轮询额外捕获到 22）；done 时 `progress={phase:'完成',percent:100}`；`startedAt/finishedAt` 均返回。**PASS**。

### 2.2 registry 历史打包（附加项，`dsh-better-sidebar@0.13.1 → 0.1.0-rc.7`）

```text
$ bash verify/probe-api.sh --port 3084 package-registry dsh-better-sidebar 0.13.1 0.1.0-rc.7
PACKAGE_REGISTRY_CHECK=PASS jobId=mvt1sifl-3-pqu3
$ bash verify/probe-api.sh --port 3084 progress mvt1sifl-3-pqu3 --interval 0.2 --timeout 540
  progress: status=running phase=下载 tarball percent=15
  progress: status=running phase=解包 tarball percent=25
  progress: status=running phase=安装运行时依赖（npm） percent=35
  progress: status=running phase=内嵌运行时依赖 percent=60
  progress: status=running phase=生成校验清单 percent=86
  progress: status=running phase=打包 zip percent=94
  progress: status=done phase=完成 percent=100
ASSERT_OK progress percent monotonically non-decreasing
final: status=done phase=完成 percent=100
startedAt=1793248391505 finishedAt=1793248452256 duration_ms=60751
PROGRESS_CHECK=PASS transitions=6 final=完成/100
```

→ registry 阶段串 = 下载→解包→npm→内嵌依赖→校验清单→打包→完成，单调推进；总耗时 60.75s。**PASS**。

### 2.3 源码层观察（低风险，不影响本次判定）

`lib/historical.mjs` 在 npm 安装完成后调用 `progress('生成离线包', 55)`，随后进入 `lib/pack.mjs` 又从 `progress('准备输出目录', 45)` 开始——存在一个**瞬时 55→45**（毫秒级）。本次 0.2s 高频采样没有观察到该帧（采样到 60），UI 端 1s 轮询更不可能展示；只在极端时刻读取 job 才可能看到一次回退。如需绝对单调，可把 historical 的 55 改为 44（或去掉该步，让 pack 从 45 起）。属优化建议，不是 FAIL。

---

## 3. c) 自定义输出目录 —— PASS

服务端参数：POST body `outputRoot`；下载 `GET /api/download?name=…&outputRoot=…`。

### 3.1 自定义 outputRoot → result 落在该目录

```text
$ bash verify/probe-api.sh --port 3084 package-local dsh-unlag --home /home/fc/.dsh \
    --output-root /home/fc/dsh-offline-packer/verify/tmp/delta3-out-custom
POST … -> HTTP 200   PACKAGE_LOCAL_CHECK=PASS jobId=mvt1u0zn-4-iezo
$ … poll mvt1u0zn-4-iezo
POLL_CHECK=PASS status=done   progress={"phase":"完成","percent":100}
  "dir": "/home/fc/dsh-offline-packer/verify/tmp/delta3-out-custom/dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2",
  "zipPath": "/home/fc/dsh-offline-packer/verify/tmp/delta3-out-custom/dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip",
  "zipName": "dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip", "sizeBytes": 102943
```

磁盘核对：`verify/tmp/delta3-out-custom/…zip` 存在、102,943 B；`validate-zip.sh` 对下载副本 **22 项 PASS（CHECKSUMS 15/15）**。

### 3.2 带 outputRoot 下载 → 200 且字节数 = zip 大小

```text
$ bash verify/probe-api.sh --port 3084 download dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip \
    --output-root /home/fc/dsh-offline-packer/verify/tmp/delta3-out-custom
GET /api/download?name=… -> HTTP 200 size=102943
disk=102943  down=102943
sha256 两者相同：97efcabfb6de272b217a1a2ccea70168e1aaa147f0f07acf31cadc711a079719
```

### 3.3 不带 outputRoot（默认目录无此 zip）→ 404 合理

```text
$ bash verify/probe-api.sh --port 3084 download dsh-unlag-offline-…zip --expect-error
GET /api/download?name=… -> HTTP 404 size=115
error body: {"ok":false,"error":{"code":"NOT_FOUND","message":"找不到文件：dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip"}}
DOWNLOAD_CHECK=PASS (expected structured error, http=404)
```

（默认 outputRoot=`verify/home-delta3/offline-packages` 里只有此前 registry job 产生的 sidebar 历史包，没有 unlag 包，因此 404 正确。）

### 3.4 非法 outputRoot

```text
# 相对路径
$ … package-local dsh-unlag --output-root 'relative/out-dir' --expect-error
-> HTTP 400 {"ok":false,"error":{"code":"BAD_OUTPUT_DIR","message":"输出目录必须是绝对路径：relative/out-dir"}}
PACKAGE_LOCAL_CHECK=PASS (expected error HTTP 400 code=BAD_OUTPUT_DIR)

# 指向已存在文件
$ touch verify/tmp/delta3-not-a-dir
$ … package-local dsh-unlag --output-root /home/fc/dsh-offline-packer/verify/tmp/delta3-not-a-dir --expect-error
-> HTTP 400 {"ok":false,"error":{"code":"BAD_OUTPUT_DIR","message":"输出目录已存在但不是目录：/home/fc/dsh-offline-packer/verify/tmp/delta3-not-a-dir"}}
PACKAGE_LOCAL_CHECK=PASS (expected error HTTP 400 code=BAD_OUTPUT_DIR)
```

### 3.5 `~` 展开（可选）

```text
$ … package-local dsh-unlag --home /home/fc/.dsh --output-root '~/dsh-offline-packer/verify/tmp/delta3-tilde'
POST … -> HTTP 200   PACKAGE_LOCAL_CHECK=PASS jobId=mvt1u65q-5-556j
POLL_CHECK=PASS status=done
  "dir":     "/home/fc/dsh-offline-packer/verify/tmp/delta3-tilde/dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2"
  "zipPath": "/home/fc/dsh-offline-packer/verify/tmp/delta3-tilde/dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip"
磁盘：verify/tmp/delta3-tilde/…zip 102,945 B
```

（宿主 `homedir()=/home/fc`，所以 `~/dsh-offline-packer/verify/...` 落在 verify 内，未污染其它目录。）**PASS**。

---

## 4. d) UI（Playwright）进度 + 自定义输出目录 —— PASS（20 断言全过）

命令：

```bash
node verify/ui-smoke.mjs --port 3084 --scan-home /home/fc/.dsh --min-plugins 10 \
  --output-dir /home/fc/dsh-offline-packer/verify/tmp/delta3-custom-ui \
  --package-plugin dsh-better-sidebar --require-progress \
  --require-testids "offline-packer-output-input,offline-packer-progress,offline-packer-result,offline-packer-download" \
  --out verify/artifacts/delta3 --json verify/artifacts/delta3/ui-smoke.json
```

关键输出：

```text
PASS  scan home lists plugins :: home=/home/fc/.dsh rows=14
PASS  「离线打包」settings section visible
PASS  UI one-click packaging job done :: {"plugin":"dsh-better-sidebar","status":"done","sawProgress":true,
      "progressSequence":[
        {"pct":"12","phaseText":"Packaging progress 读取插件清单 12% Elapsed 0.0s"},
        {"pct":"94","phaseText":"Packaging progress 打包 zip 94% Elapsed 1.0s"},
        {"pct":"100","phaseText":"Packaging progress 完成 100% Elapsed 1.2s"}],
      "resultText":"Package\nDone\nElapsed 1.2s\nDownload zip · dsh-better-sidebar-offline-0.28.1-dsh-0.2.1-rc.2.zip
        \nSize\n5.0 MB\n…\nzip path\n/home/fc/dsh-offline-packer/verify/tmp/delta3-custom-ui/dsh-better-sidebar-…zip
        \nDirectory\n/home/fc/dsh-offline-packer/verify/tmp/delta3-custom-ui/dsh-better-sidebar-…",
      "downloadHref":"/dsh-offline-packer/api/download?name=dsh-better-sidebar-offline-0.28.1-dsh-0.2.1-rc.2.zip&outputRoot=%2Fhome%2Ffc%2Fdsh-offline-packer%2Fverify%2Ftmp%2Fdelta3-custom-ui"}
PASS  UI result shows a zip name
PASS  progress element observed :: samples=3
PASS  progress percent advances monotonically :: percents=12,94,100 distinct=3
PASS  progress reaches 100 :: last=100
PASS  result text contains custom output dir
PASS  download href carries outputRoot= :: /dsh-offline-packer/api/download?name=…&outputRoot=/home/fc/dsh-offline-packer/verify/tmp/delta3-custom-ui
PASS  required data-testid present :: found=4
PASS  no page errors
PASS  no console errors
UI_SMOKE=PASS assertions=20 failed=0
```

截图（`verify/artifacts/delta3/`，实拍）：
- `01-landing.png`、`02-settings.png`、`03-offline-packer.png`、`03b-scan-home.png`（14 个第三方插件 + 4 个官方已隐藏）、`04-after-refresh.png`
- `05-job-done.png` / `05b-job-panel.png`：可见 **`Packaging progress 完成 100% Elapsed 1.2s`** 进度条、Package(Done) 结果面板（zip 名 5.0MB、zip path/Directory 均为 `/home/fc/dsh-offline-packer/verify/tmp/delta3-custom-ui`）、下载链接；日志尾部 `job mvt1up1p-6-4757 finished in 1232 ms`

附加校验：UI 产出的 zip 在自定义目录内，`validate-zip.sh` 22 项 PASS（CHECKSUMS 481/481），5,276,916 B。
说明：UI 端 1s 轮询，故只捕获到 12/94/100 三帧（服务端 20ms 采样可看到 22/52/86，见 §2.1），最终 100% 与阶段文本均正确。**PASS**。

---

## 5. e) 用户 profile —— PASS

```text
installed: 0.1.2
dep: file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.2.tgz
deps: 13   bundles: 16

# 与上一版快照（delta2-after，v0.1.1）对比版本清单：
-dsh-offline-packer@0.1.1
+dsh-offline-packer@0.1.2          # 唯一版本变化；其余 328 个包版本全部未变（count=329）
```

`--dump-config`（只读意图，宿主行为仅刷新 cordis mtime）：exit 0、1408 行，仍含

```text
1406:# == dsh-offline-packer
1407:- id: offline-packer
1408:  name: dsh-offline-packer
```

执行前后 profile `package.json` sha256 均为 `aa55c642…`（未变）；`cordis.yml` 内容 sha256 前后均为 `c300dcf2…`（223B 不变，仅 mtime 更新）。**PASS**。

---

## 6. f) 用户 home 无意外写入 —— PASS

```text
# 复验开始前（12:31:40）与结束后（12:35:14）只读快照对比
$ diff -u verify/run/user-home-delta3-before.txt verify/run/user-home-delta3-after.txt
-# snapshot 'delta3-before' 2026-10-29T04:31:40Z
+# snapshot 'delta3-after' 2026-10-29T04:35:14Z
  ## profile package.json
  aa55c642…  /home/fc/.dsh/profiles/web/package.json
  mtime=2026-10-29 12:31:19 size=1184
# 除标签行外完全相同（package.json hash/mtime、node_modules 顶层、329 包版本清单均未变）

$ find /home/fc/.dsh -maxdepth 1 -mindepth 1 -newermt '2026-10-29 12:31:40'
(none)      # 本次 30s+ 验证窗口内用户 home 顶层零写入

# 唯一的 profile 级 mtime 变化：
/home/fc/.dsh/profiles/web/cordis.yml   (仅 mtime；内容 sha 不变，见 §5)

# packages/ 下只剩 0.1.2 tgz，sha 与项目根一致：
dsh-offline-packer-0.1.2.tgz  3512194bc6…c22d3（77,355 B）
```

所有打包产物都写入 `verify/**`（`delta3-out-api2`、`delta3-out-custom`、`delta3-tilde`、`delta3-custom-ui`、`home-delta3/offline-packages`），未写 `/home/fc/.dsh`。**PASS**。

---

## 7. 清理与环境

```text
端口 3084/3085/3086: free（复测三端口均 BIND OK）
3080 用户 GUI: HTTP 401（未触碰、未重启）
无遗留测试宿主进程；测试用自定义目录均在 verify/tmp/ 下
```

## 8. 证据文件索引

- 本报告：`verify/report-delta3.md`
- 截图 / UI 断言：`verify/artifacts/delta3/{01-landing,02-settings,03-offline-packer,03b-scan-home,04-after-refresh,05-job-done,05b-job-panel}.png`、`ui-smoke.json`（20 断言）
- 进度原始采样：`verify/artifacts/delta3/progress-local.{txt,log}`（12/22/52/86/94/100）、`progress-registry.{txt,log}`（15/25/35/60/86/94/100）
- 用户 home dump-config：`verify/artifacts/delta3/dump-config-user-home.txt`（1408 行）
- 快照：`verify/run/user-home-delta3-{before,after}.txt`、`user-home-delta3.diff`
- 测试宿主：`verify/home-delta3/`（官方通道安装 v0.1.2）、`verify/logs/host-3084.log`
- 自定义输出目录：`verify/tmp/delta3-out-api2/`、`delta3-out-custom/`、`delta3-tilde/`、`delta3-custom-ui/`（含各自 zip 与提取目录）
- 产物：`/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.2.tgz`（sha256 `3512194b…`）、`/home/fc/.dsh/packages/` 同 sha

## 9. 最终判断

**delta3 全部 PASS，可交付。**

- 进度：本地打包 12→22→52→86→94→100（单调、done=完成/100、startedAt/finishedAt 齐全）；registry 阶段串 下载→解包→npm→内嵌依赖→校验清单→打包→完成（单调、60.7s），附 1 条毫秒级 55→45 的源码优化建议（不影响 UI/判定）。
- 输出目录：自定义目录生效（result.dir/zipPath 落该目录）、带 outputRoot 下载 200 且字节/sha 与磁盘一致、默认目录缺文件时 404 合理、相对路径与指向文件均 400 `BAD_OUTPUT_DIR`、`~` 正确展开。
- UI：output 输入框 + 进度条（`data-progress-percent`/阶段文本）+ 结果面板（zip 名/大小/目录/下载链接带 outputRoot）+ 0 console/page error，20 断言全过。
- 用户 profile 0.1.2、其它 15 个插件版本未变；本验证对 `/home/fc/.dsh` 零写入，唯一 profile 级变化是 dump-config 引起的 `cordis.yml` mtime（内容不变）。
