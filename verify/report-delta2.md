# 复验报告（delta2）：v0.1.1「官方插件过滤」——a) PASS / b) PASS / c) PASS / d) PASS / e) PASS / f) PASS（附 1 条外部写入观察）

- 验证员：`qa-verifier`（独立 fresh context）
- 日期：2026-10-29 12:00-12:06（Asia/Shanghai）
- 范围：仅复验需求变更后的 v0.1.1 delta（官方插件过滤 + 版本升级 + 重新打包/用户 profile 安装），不重跑全部 8 项；基线见 `verify/report.md`、上一版 delta 见 `verify/report-delta.md`
- 结论：**a/b/c/d/e/f 全部 PASS**，官方插件默认隐藏/拒绝的行为与 Lead 描述完全一致；唯一需 Lead 确认的是验证窗口内**另一个执行者**（非本次验证）在用户 home 写入了 `offline-packages/`（见 §6），本次验证自身对用户 home 零写入。

## 0. 被复验的产物与版本

```text
$ node -e 'console.log(require("./package.json").version)'          -> 0.1.1
$ sha256sum dsh-offline-packer-0.1.1.tgz
c1d1e838716ce9f8b9943ce7827a0f9f8d8bf13943f87848f96c163227ccb105    # 与 Lead 给定一致
$ tar -xzOf dsh-offline-packer-0.1.1.tgz package/client.js | sha256sum
58e86882a3e4627ab280f2d3d3768fd23068ff1ba19b8ea5e6b5dbb988b4704d
$ sha256sum client.js
58e86882a3e4627ab280f2d3d3768fd23068ff1ba19b8ea5e6b5dbb988b4704d    # tgz == 工作树

# 用户 home 中安装的那一份（Lead 复制 + 官方通道安装）
$ ls /home/fc/.dsh/packages/
dsh-offline-packer-0.1.1.tgz
$ sha256sum /home/fc/.dsh/packages/dsh-offline-packer-0.1.1.tgz
c1d1e838716ce9f8b9943ce7827a0f9f8d8bf13943f87848f96c163227ccb105
$ node -e '…profile node_modules version…'                           -> 0.1.1
$ profile dep:  dsh-offline-packer = file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.1.tgz
$ profile bundles: 16（4 官方 + 12 非官方，顺序未变，offline-packer 在末尾）
```

代码层（`lib/inventory.mjs` 约 291/442 行、`index.js` 111-184、225-233 行）确实实现了 `official` 字段、state/plugins 默认过滤 + `includeOfficial=1`/`official=all`、`package-local` 默认拒绝官方插件（`OFFICIAL_PLUGIN`）与状态码映射表。

> 环境说明：验证窗口内 **3084 端口出现一次短暂的隐藏占用**（`bind` 返回 EADDRINUSE，但 `ss`/`/proc/net/tcp` 无监听、`curl` 连接被拒；约 2 分钟后自行恢复，复测 3084/3085/3086 均可 BIND OK）。本次所有宿主使用 **3086**（仍在约束的 3084-3086 范围内），不影响任何判定。

---

## 1. a) 最新 tgz 装全新 home → boot 无 warning、state 200 —— PASS

```text
$ DSH_HOME=…/verify/home-delta2 node …/dsh/lib/bin.js plugin --profile web add \
    /home/fc/dsh-offline-packer/dsh-offline-packer-0.1.1.tgz
dependencies:
+ dsh-offline-packer file:/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.1.tgz
Packages: +1
Done in 906ms using pnpm v11.21.0

installed version: 0.1.1
bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-offline-packer"]
```

启动（端口 3086）：

```text
boot log: dsh web: http://127.0.0.1:3086/?token=<redacted>
$ grep -niE 'warning|entry apply failed|duplicate prefix route|FAILED|Cannot resolve|ERR_MODULE|uncaught' verify/logs/host-3086.log
(no warning/failure lines)

$ bash verify/probe-api.sh --port 3086 state
ok=true host.dshVersion=0.2.1-rc.2 dshHome=…/verify/home-delta2 profile=web plugins=1
hiddenOfficial=18 officialCount=18
STATE_CHECK=PASS plugins=1 dshVersion=0.2.1-rc.2
```

（全新 home 的 in-box 官方 bundle 全部被默认隐藏：仅剩 1 个非官方插件 `dsh-offline-packer`，`hiddenOfficial=18`，符合预期。）

**PASS**。

---

## 2. b) 用户 home（只读扫描）官方过滤 —— PASS（数字与 Lead 完全一致）

```text
$ bash verify/probe-api.sh --port 3086 state --home /home/fc/.dsh --profile web \
    --expected-plugins 14 --expect-hidden-official 4 --assert-no-official
ok=true host.dshVersion=0.2.1-rc.2 dshHome=/home/fc/.dsh profile=web plugins=14
hiddenOfficial=4 officialCount=4
ASSERT_OK no @deepseek-ai/* and no official===true in plugins
STATE_CHECK=PASS plugins=14 dshVersion=0.2.1-rc.2

$ bash verify/probe-api.sh --port 3086 state --home /home/fc/.dsh --profile web \
    --include-official --expected-plugins 18 --expect-official-count 4 --expect-hidden-official 0
ok=true … plugins=18
hiddenOfficial=0 officialCount=4
official===true rows with includeOfficial=1: 4
STATE_CHECK=PASS plugins=18 dshVersion=0.2.1-rc.2

官方 4 条（includeOfficial=1）：
@deepseek-ai/dsh-base, @deepseek-ai/dsh-experimental-agent-team-profile,
@deepseek-ai/dsh-experimental-auto-review, @deepseek-ai/dsh-web-app
```

`/api/plugins` 同样默认过滤，附加验证：

```text
$ bash verify/probe-api.sh --port 3086 plugins --home /home/fc/.dsh
dshHome=/home/fc/.dsh profile=web plugins=14    PLUGINS_CHECK=PASS
GET /api/plugins?home=/home/fc/.dsh&includeOfficial=1
includeOfficial=1 plugins: 18 official: 4 hiddenOfficial: 0
```

→ 默认 14 条全部 `official===false` 且不含任何 `@deepseek-ai/*`；`hiddenOfficial=4`。`includeOfficial=1` 时 18 条、含 4 条 official、`hiddenOfficial=0`。与 Lead 期望逐项一致。**PASS**。

> 说明：14 = 13 个 profile dependencies + 1 个装机残留 `@local/dsh-offline-bundle`（非官方，正常显示）；4 个官方 = 上面 4 个 in-box bundle。

---

## 3. c) `package-local` 对官方插件的拒绝/放行 —— PASS

### 3.1 默认拒绝（HTTP 400 `OFFICIAL_PLUGIN`）

```text
$ bash verify/probe-api.sh --port 3086 package-local '@deepseek-ai/dsh-base' --home /home/fc/.dsh --expect-error
POST /api/package-local payload={"pluginName":"@deepseek-ai/dsh-base","home":"/home/fc/.dsh"} -> HTTP 400
PACKAGE_LOCAL_CHECK=PASS (expected error HTTP 400 code=OFFICIAL_PLUGIN)
body={"ok":false,"error":{"code":"OFFICIAL_PLUGIN",
      "message":"「@deepseek-ai/dsh-base」是 DSH 官方内置插件，离线打包页只处理非官方插件（如确需打包官方插件，请直接调用接口并传 includeOfficial:true）"}}
```

### 3.2 body 传 `includeOfficial:true` 放行（HTTP 200 起 job，且 job 最终 done）

```text
$ bash verify/probe-api.sh --port 3086 package-local '@deepseek-ai/dsh-base' --home /home/fc/.dsh --include-official
POST /api/package-local payload={"pluginName":"@deepseek-ai/dsh-base","home":"/home/fc/.dsh","includeOfficial":true} -> HTTP 200
PACKAGE_LOCAL_CHECK=PASS jobId=mvt0qo83-1-hamh
$ bash verify/probe-api.sh --port 3086 poll mvt0qo83-1-hamh
POLL_CHECK=PASS status=done
```

产物写入的是**测试宿主** outputRoot（`verify/home-delta2/offline-packages/@deepseek-ai-dsh-base-offline-0.1.0-rc.7-dsh-0.2.1-rc.2.zip`），未写用户 home。**PASS**。

---

## 4. d) 非官方插件一键打包回归（dsh-unlag）—— PASS

```text
$ bash verify/probe-api.sh --port 3086 package-local dsh-unlag --home /home/fc/.dsh
POST /api/package-local … -> HTTP 200
PACKAGE_LOCAL_CHECK=PASS jobId=mvt0qrxz-2-bux7
$ bash verify/probe-api.sh --port 3086 poll mvt0qrxz-2-bux7
POLL_CHECK=PASS status=done
  "zipName": "dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip", "sizeBytes": 102944,
  "version": "1.12.3", "mode": "local"
完成：…（102944 B，16 个文件，0 个内嵌依赖，校验和 15 条）；job finished in 215 ms

$ … download?name=dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip -> HTTP 200 size=102944
sha256=9e0c0da2f3173f74e1aefc6069ea1c8cff0e30d1fe00f373339d9ed204d6e0f6
$ bash verify/validate-zip.sh … --expect-plugin dsh-unlag --expect-version 1.12.3 --expect-target 0.2.1-rc.2
PASS  sha256sum -c CHECKSUMS.txt: 15/15 OK
RESULT=PASS checks=22 failures=0
```

→ 官方过滤没有破坏非官方插件打包。**PASS**。

---

## 5. e) UI（Playwright）官方过滤 —— PASS

命令（headless Chromium，locale en-US，1600×1000）：

```bash
node verify/ui-smoke.mjs --port 3086 --scan-home /home/fc/.dsh --min-plugins 10 \
  --expect-rows 14 --require-hidden-official --assert-no-official \
  --out verify/artifacts/delta2 --json verify/artifacts/delta2/ui-smoke.json
```

输出（15 项断言全 PASS）：

```text
PASS  page loaded (title) :: title="DeepSeek Harness"
PASS  authenticated app shell rendered
PASS  onboarding modal dismissed
PASS  settings panel opened
PASS  scan home lists plugins :: home=/home/fc/.dsh rows=14
PASS  「离线打包」settings section visible
PASS  core data-testid present :: offline-packer-page,offline-packer-list,offline-packer-refresh,offline-packer-home-input
PASS  plugin rows == 14 :: heuristic=data-testid=offline-packer-row count=14
PASS  no official rows rendered :: 14 rows, none @deepseek-ai/*
PASS  hidden-official note present :: 4 built-in official plugins hidden (this page only packs third-party plugins)
PASS  plugin rows >= 10 :: … count=14
PASS  plugin list rendered (>=1 row heuristic) :: {"heuristic":"data-testid=offline-packer-row","count":14}
PASS  refresh control usable :: clicked=true
PASS  no page errors
PASS  no console errors
UI_SMOKE=PASS assertions=15 failed=0
```

截图（`verify/artifacts/delta2/`）：`01-landing.png`、`02-settings.png`、`03-offline-packer.png`、`03b-scan-home.png`、`04-after-refresh.png`。
其中 `03b-scan-home.png` 实拍可见：搜索行显示「14 third-party plugins」，其下灰字 **「4 built-in official plugins hidden (this page only packs third-party plugins)」**（`data-testid="offline-packer-hidden-official"`），列表首项为 `@linxin666/dsh-pet`，没有 `@deepseek-ai/*` 行；0 console/page error。**PASS**。

---

## 6. f) 用户 home 未被本验证写入 —— PASS（含一条外部写入观察）

### 6.1 本验证自身：零写入

```text
# 复验开始前（12:01:32）与结束后（12:04:16）两次只读快照对比
$ diff -u verify/run/user-home-delta2-before.txt verify/run/user-home-delta2-after.txt
-# snapshot 'delta2-before' 2026-10-29T04:01:32Z
+# snapshot 'delta2-after' 2026-10-29T04:04:16Z
  ## profile package.json
  6cd989a978a04bc4fc1c61b30b31eaf9c5da314b44eb6b01a62484830b2f5de9  …/profiles/web/package.json
  …/profiles/web/package.json mtime=2026-10-29 12:01:08 size=1184
# 除标签行外完全相同：package.json hash/mtime、node_modules 顶层条目、329 个包版本清单均未变

# 本验证所有打包产物都落在测试宿主 home 内：
$ ls verify/home-delta2/offline-packages/
@deepseek-ai-dsh-base-offline-0.1.0-rc.7-dsh-0.2.1-rc.2.zip
dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip
```

### 6.2 与上一版快照（v0.1.0 → v0.1.1 升级）的差异，全部预期

```text
$ diff -u verify/run/user-home-delta.txt verify/run/user-home-delta2-after.txt
-# snapshot 'delta' 2026-10-29T03:53:14Z
+# snapshot 'delta2-after' 2026-10-29T04:04:16Z
-eaa407e1…  profile/web/package.json        # 旧（dep 指向 0.1.0）
+6cd989a9…  profile/web/package.json        # 新（dep 指向 0.1.1）
  …（node_modules、pnpm-lock.yaml、.modules.yaml、.package-map.json、.pnpm、.pnpm-workspace-state-v1.json：
     均为 pnpm 升级安装的元数据更新；dsh-offline-packer 目录 mtime 更新）
-dsh-offline-packer@0.1.0
+dsh-offline-packer@0.1.1                  # 版本清单唯一变化；其余 328 个包版本全部未变
# 另有 .dsh-market / .super-code-presets.json / super-code-connection 的 mtime 变化：
#   这些是运行中的用户 GUI（3080）上 dshmarket / dsh-super-code 等插件的自身运行期写入，
#   发生在本次验证开始（12:01:32）之前，不是本验证造成。
```

`/home/fc/.dsh/packages/`：仅 `dsh-offline-packer-0.1.1.tgz`（旧 0.1.0 已移除），sha256 `c1d1e838…` 与项目根一致。

`--dump-config`（只读意图）复核：exit 0、1408 行，仍含 `# == dsh-offline-packer`（1406 行起）；执行前后 profile `package.json` sha256 均为 `6cd989a9…`（未变）；`cordis.yml` 内容 sha256 仍为 `c300dcf2…`（与 delta1 记录相同，仅宿主 compose 刷新 mtime，223B 不变）。

### 6.3 ⚠️ 外部写入观察（非本次验证）

验证窗口内 `/home/fc/.dsh` 出现一个新写入，**不是本验证造成的**：

```text
/home/fc/.dsh/offline-packages/                                    (12:04:10 创建)
/home/fc/.dsh/offline-packages/dsh-session-manager-offline-0.7.5-dsh-0.1.0-rc.7.zip  (192,333 B, 12:04:11)
```

判读：这是某个 `DSH_HOME=/home/fc/.dsh` 的**另一个进程**用本插件打包了 `dsh-session-manager@0.7.5 → 目标 rc.7`（典型的「版本历史」操作）产生的，outputRoot 默认就是 `<DSH_HOME>/offline-packages`。本次验证所有宿主 DSH_HOME 均在 `verify/**`（产物见 §6.1），且我从未对 dsh-session-manager 发起过打包。同一时间段 `/home/fc/.dsh/storages/cost-meter` 也有运行期写入，指向 3080 用户 GUI 正在被使用（可能已重启加载新插件，或 Lead 在用其做最终集成）。**请 Lead 确认这是你的操作**；若是，则 f) 完全符合预期（用户正常使用插件产生的产物目录）。本验证自身对用户 home 零写入。

---

## 7. 状态与清理

```text
端口 3084/3085/3086: free（3084 的短暂隐藏占用已消失，复测 BIND OK）
3080 用户 GUI: HTTP 401（未触碰、未重启）
无遗留测试宿主进程；verify/ 内仅新增 delta2 相关证据
```

## 8. 证据文件

- 本报告：`verify/report-delta2.md`
- 截图与 UI JSON：`verify/artifacts/delta2/{01-landing,02-settings,03-offline-packer,03b-scan-home,04-after-refresh}.png`、`ui-smoke.json`
- 用户 home dump-config：`verify/artifacts/delta2/dump-config-user-home.txt`（1408 行）
- 快照：`verify/run/user-home-delta2-before.txt`（12:01:32）、`user-home-delta2-after.txt`（12:04:16）、`user-home-delta2.diff`（本验证零写入）、`user-home-upgrade.diff`（v0.1.0→v0.1.1 升级差异）
- 复验宿主：`verify/home-delta2/`（官方通道安装 v0.1.1；含 outputRoot 的 2 个 zip 证据）、日志 `verify/logs/host-3086.log`
- 产物：`/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.1.tgz`（sha256 `c1d1e838…`）、`/home/fc/.dsh/packages/` 同 sha

## 9. 最终判断

**delta2 全部 PASS。** v0.1.1 官方插件过滤行为与需求/描述逐项一致：state/plugins 默认只返回非官方（用户 home 14 条、hiddenOfficial=4、零 `@deepseek-ai/*`），`includeOfficial=1` 返回 18 条含 4 官方；`package-local` 对官方插件默认 400 `OFFICIAL_PLUGIN`、`includeOfficial:true` 放行且 job 成功；非官方 dsh-unlag 打包与 zip 校验无回归；UI 显示 14 条第三方插件 + 「4 built-in official plugins hidden」提示、无 console/page error；用户 profile 升级为 0.1.1 后其它插件 versions/bundles 未变，本验证对用户 home 零写入。唯一需 Lead 确认的外部写入是 `offline-packages/` 下的 session-manager 历史包（12:04:10，非本验证）。
