# 复验报告（delta4）：v0.1.3 —— registry 进度 55→44 微调（绝对单调）—— a) PASS / b) PASS / c) PASS / d) PASS

- 验证员：`qa-verifier`（独立 fresh context）
- 日期：2026-10-29 12:36-12:38（Asia/Shanghai）
- 范围：只复验 v0.1.3 的 historical 进度常量微调（`55`→`44`）与重新打包/升级用户 profile；进度/输出目录全量已在 v0.1.2 的 `verify/report-delta3.md` PASS，本次不重跑 UI/输出目录。
- 结论：**全部 PASS**，55→45 的毫秒级回退已消除（结构上 44 < 45）；未发现新问题，未改任何代码。

## 0. 产物一致性（tgz / 工作树 / 用户 home）

```text
$ node -e 'console.log(require("./package.json").version)'   -> 0.1.3
$ sha256sum dsh-offline-packer-0.1.3.tgz
f56116af8ead0d3fcfde5d2242b2d9b7d6efc48b4f744c568716977fcff9cc11   # == Lead 给定
$ sha256sum client.js                                                e26dc4b656d58a7ebbe29a6f3405a8b5756e2ee520ae16e6a27814c48a8a3c0c
$ tar -xzOf dsh-offline-packer-0.1.3.tgz package/client.js | sha256sum e26dc4b656d58a7ebbe29a6f3405a8b5756e2ee520ae16e6a27814c48a8a3c0c
# → tgz 内 client.js 与工作树一致（本次只改 historical.mjs）

# 修复点（工作树与 tgz 均为 44，旧 55 已消失）
$ grep -n "progress('生成离线包'" lib/historical.mjs
396:    progress('生成离线包', 44)
$ tar -xzOf dsh-offline-packer-0.1.3.tgz package/lib/historical.mjs | grep -n "progress('生成离线包'"
396:    progress('生成离线包', 44)
$ grep -c "55" <(tar -xzOf dsh-offline-packer-0.1.3.tgz package/lib/historical.mjs)   -> 0
$ grep -n "progress('准备输出目录'" lib/pack.mjs
315:  progress('准备输出目录', 45)      # 44 < 45：结构上已绝对单调

# 用户 home 中安装的 0.1.3
installed: 0.1.3
dep: file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.3.tgz
$ sha256sum /home/fc/.dsh/packages/dsh-offline-packer-0.1.3.tgz
f56116af8ead0d3fcfde5d2242b2d9b7d6efc48b4f744c568716977fcff9cc11
$ ls /home/fc/.dsh/packages/   -> 仅 dsh-offline-packer-0.1.3.tgz
```

---

## 1. a) 全新 home 安装 → boot 无 warning、state 200 —— PASS

```text
$ DSH_HOME=…/verify/home-delta4 node …/dsh/lib/bin.js plugin --profile web add \
    /home/fc/dsh-offline-packer/dsh-offline-packer-0.1.3.tgz
Packages: +1
Done in 757ms using pnpm v11.21.0
installed: 0.1.3

$ bash verify/setup-host.sh --no-plugin --port 3084 --home …/verify/home-delta4
boot log: dsh web: http://127.0.0.1:3084/?token=<redacted>
$ grep -niE 'warning|entry apply failed|duplicate prefix route|FAILED|Cannot resolve|ERR_MODULE|uncaught' verify/logs/host-3084.log
(no warning/failure lines)

$ bash verify/probe-api.sh --port 3084 state
ok=true host.dshVersion=0.2.1-rc.2 dshHome=…/verify/home-delta4 profile=web plugins=1
STATE_CHECK=PASS plugins=1 dshVersion=0.2.1-rc.2
```

**PASS**。

---

## 2. b) registry 进度不再回退 —— PASS

`POST /api/package-registry {dsh-better-sidebar, 0.13.1, targetDshVersion 0.1.0-rc.7}` + `verify/probe-api.sh progress <jobId> --interval 0.02` 高频采样：

```text
$ bash verify/probe-api.sh --port 3084 progress mvt1x7iz-1-ej87 --interval 0.02 --timeout 540 \
    --log verify/artifacts/delta4/progress-registry.log
watching job mvt1x7iz-1-ej87 progress (timeout 540s interval 0.02s)
  progress: status=running phase=下载 tarball percent=15 t=…
  progress: status=running phase=解包 tarball percent=25 t=…
  progress: status=running phase=安装运行时依赖（npm） percent=35 t=…
  progress: status=running phase=复制插件文件 percent=52 t=…
  progress: status=running phase=内嵌运行时依赖 percent=60 t=…
  progress: status=running phase=生成校验清单 percent=86 t=…
  progress: status=running phase=打包 zip percent=94 t=…
  progress: status=running phase=完成 percent=100 t=…
  progress: status=done phase=完成 percent=100 t=…
ASSERT_OK progress percent monotonically non-decreasing
final: status=done phase=完成 percent=100
startedAt=1793248610651 finishedAt=1793248654505 duration_ms=43854
PROGRESS_CHECK=PASS transitions=8 final=完成/100

# 显式检查：采样里没有 55、没有任何百分比回退
$ awk -F'|' '{p=$3; if(p=="")next; if(p+0<last) print "DECREASE"; if(p+0==55) print "PERCENT_55_SEEN"; last=p+0}' verify/artifacts/delta4/progress-registry.log
(无输出 → 无 55、无回退)
```

**说明**：44 与 45 两帧发生在 npm 安装结束后的同一瞬间（<100ms），20ms 级采样两次都没能捕捉到它们（直接从 35 跳到 52），因此采样序列里看不到 44；但修复是**结构性**的：

- 旧值 `55` 已从源码与 tgz 中消失（`grep -c 55` = 0）；
- 现在 `historical.mjs:396 progress('生成离线包', 44)` 紧接 `pack.mjs:315 progress('准备输出目录', 45)`，44 < 45，后续 52/60/86/94/100 递增；
- 即任何时刻读取 progress 都不会再出现 55→45 的下降；本次 8 次采样亦全部单调。

**PASS**。

---

## 3. c) local 通道进度仍单调（抽查）—— PASS

```text
$ bash verify/probe-api.sh --port 3084 package-local dsh-better-sidebar --home /home/fc/.dsh \
    --output-root /home/fc/dsh-offline-packer/verify/tmp/delta4-out-local
PACKAGE_LOCAL_CHECK=PASS jobId=mvt1ybpb-2-v3lw
  progress: status=running phase=读取插件清单 percent=12
  progress: status=running phase=复制插件文件 percent=52
  progress: status=running phase=打包 zip percent=94
  progress: status=done phase=完成 percent=100
ASSERT_OK progress percent monotonically non-decreasing
final: status=done phase=完成 percent=100
startedAt=… finishedAt=… duration_ms=1374
PROGRESS_CHECK=PASS transitions=3 final=完成/100
```

local 流水线未改动，抽查单调通过（中间帧因 1s 级 UI 轮询/短窗口可缺省，与 delta3 结论一致）。**PASS**。

---

## 4. d) 用户 profile / dump-config —— PASS

```text
installed: 0.1.3
dep: file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.3.tgz
deps: 13   bundles: 16

# 与上一版快照（delta3-after，v0.1.2）对比版本清单：
-dsh-offline-packer@0.1.2
+dsh-offline-packer@0.1.3          # 唯一版本变化；其余 328 个包版本全部未变（count=329）

$ DSH_HOME=/home/fc/.dsh node …/dsh/lib/bin.js --profile web --dump-config > verify/artifacts/delta4/dump-config-user-home.txt
exit 0，1408 行
1406:# == dsh-offline-packer
1407:- id: offline-packer
1408:  name: dsh-offline-packer
执行前后 profile package.json sha256 均为 e2293ad7…（未变）

# /home/fc/.dsh 零意外写入：delta4-before(12:36:27) vs delta4-after(12:37:48) 快照对比
# 除标签行外唯一差异 = cordis.yml 的 mtime（本报告 §4 的 dump-config 由宿主 compose 刷新；内容 sha 不变、223B）；
# 顶层 find -newermt 12:36:30 无任何新条目。
```

**PASS**。

---

## 5. 清理与证据

```text
端口 3084/3085/3086: free（复测三端口均 BIND OK）
3080 用户 GUI: HTTP 401（未触碰）
无遗留测试宿主进程；自定义输出目录均在 verify/tmp/ 下
```

证据文件：

- 本报告：`verify/report-delta4.md`
- 进度原始采样：`verify/artifacts/delta4/progress-registry.{txt,log}`、`progress-local.{txt,log}`
- 用户 home dump-config：`verify/artifacts/delta4/dump-config-user-home.txt`（1408 行）
- 快照：`verify/run/user-home-delta4-{before,after}.txt`、`user-home-delta4.diff`
- 测试宿主：`verify/home-delta4/`（官方通道安装 v0.1.3）、`verify/logs/host-3084.log`
- 产物：`/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.3.tgz`（sha256 `f56116af…`）、`/home/fc/.dsh/packages/` 同 sha

## 6. 最终判断

**delta4 全部 PASS，可交付。** `historical.mjs` 的 `55`→`44` 已落地（源码与 tgz 均为 44，旧值 55 不复存在；44 < pack 起始 45，结构上绝对单调）；registry 高频采样 8 帧全部单调、无 55、无回退；local 抽查仍单调；全新 home boot 干净、state 200；用户 profile 升级到 0.1.3 且其它 328 个包版本未变，dump-config 仍含 offline-packer 行，本验证对用户 home 零写入（仅 dump-config 引起 cordis.yml mtime，内容不变）。
