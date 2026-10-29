# 复验报告（delta）：交付后小改动（HTTP 状态映射 + 重新 npm pack + 用户 profile 官方安装）

- 验证员：`qa-verifier`（独立 fresh context）
- 日期：2026-10-29 11:53-11:56（Asia/Shanghai）
- 范围：仅复验 Lead 的两处 delta（index.js 状态码映射、README 已知限制章节）与重新打包/用户 profile 安装，不重跑全部 8 项；完整基线见 `verify/report.md`
- 结论：**a) PASS，b) PASS，c) PASS**。未发现缺陷，无需改代码。

## 0. 被复验的 delta（实测确认存在）

```text
$ sha256sum dsh-offline-packer-0.1.0.tgz
547a2023be8f6e39cc6d833b37db9293eb7f17ab6bc2a0324e742060c8dc1ff4   # 与 Lead 给定一致
$ tar -xzOf dsh-offline-packer-0.1.0.tgz package/client.js | sha256sum
1f160c426d9f3c11da0cd0731d0727b97572b785de4a7e59db4765998c3a18ed   # == 工作树 client.js
$ sha256sum index.js
791964cc96055f53f9de1ca6678cb5bd90a480fa5bd89089a7dd43418c81df80
$ tar -xzOf dsh-offline-packer-0.1.0.tgz package/index.js | sha256sum
791964cc96055f53f9de1ca6678cb5bd90a480fa5bd89089a7dd43418c81df80   # 工作树 == tgz 成员
# 用户 home 中 Lead 复制的那一份：
$ sha256sum /home/fc/.dsh/packages/dsh-offline-packer-0.1.0.tgz
547a2023be8f6e39cc6d833b37db9293eb7f17ab6bc2a0324e742060c8dc1ff4   # 同一产物
```

`index.js` 中确实存在状态映射表（节选）：

```text
225:        BAD_REQUEST: 400,
226:        BAD_BODY: 400,
228:        BODY_TOO_LARGE: 413,
229:        FORBIDDEN: 403,
232:        METHOD_NOT_ALLOWED: 405,
233:        JOB_BUSY: 429,
```

---

## 1. a) 最新 tgz → 全新 home 官方通道安装 → boot/state + 状态码断言 —— PASS

### 1.1 安装（全新 home `verify/home-delta`，官方通道）

```text
$ DSH_HOME=…/verify/home-delta node …/dsh/lib/bin.js plugin --profile web add \
    /home/fc/dsh-offline-packer/dsh-offline-packer-0.1.0.tgz
dsh: initialized profile web at …/verify/home-delta/profiles/web
dependencies:
+ dsh-offline-packer file:/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.0.tgz
Packages: +1
Done in 897ms using pnpm v11.21.0
```

安装后 profile 正确（bundles 自动追加）；安装副本 `client.js` sha=`1f160c42…`、`index.js` sha=`791964cc…`，与工作树/tgz 完全一致（证明 tgz 含最新映射代码）。

### 1.2 启动（端口 3084）与 state

```text
boot log: dsh web: http://127.0.0.1:3084/?token=<redacted>
$ grep -niE 'warning|entry apply failed|duplicate prefix route|FAILED|Cannot resolve|ERR_MODULE|uncaught' verify/logs/host-3084.log
(no warning/failure lines)

$ bash verify/probe-api.sh state
ok=true host.dshVersion=0.2.1-rc.2 dshHome=…/verify/home-delta profile=web plugins=19
STATE_CHECK=PASS plugins=19 dshVersion=0.2.1-rc.2
```

### 1.3 状态码映射真实行为（Lead 点名的 3 条 + 附加 6 条）

| # | 请求 | 期望 | 实测 |
|---|---|---|---|
| 1 | `GET /api/state?profile=bad%2Fname` | 400 | **400** `{"ok":false,"error":{"code":"BAD_REQUEST","message":"profile 名不合法：bad/name"}}` |
| 2 | `GET /api/download?name=../x.zip` | 400 | **400** `{"ok":false,"error":{"code":"BAD_NAME","message":"只允许下载 offline-packages 目录下的 zip 文件"}}` |
| 3 | `POST /api/package-local` body=`{not-json` | 400 | **400** `{"ok":false,"error":{"code":"BAD_BODY","message":"请求体不是合法 JSON"}}` |
| 4 | `GET /api/nope`（未知路由） | 404 | **404** `NOT_FOUND` |
| 5 | `GET /api/package-local`（POST-only 用 GET） | 405 | **405** `METHOD_NOT_ALLOWED` |
| 6 | `GET /api/job?id=nope` | 404 | **404** `JOB_NOT_FOUND` |
| 7 | `GET /api/state` + `Origin: http://evil.example` | 403 | **403** `FORBIDDEN` |
| 8 | `POST /api/package-local` body >1MB | 413 | **413** `BODY_TOO_LARGE` |
| 9 | 连续 3 个 registry 打包 job（maxConcurrent=2） | 第 3 个 429 | job1 200、job2 200、job3 **429** `JOB_BUSY` |

原始输出：

```text
--- 1) state?profile=bad%2Fname
HTTP 400 {"ok":false,"error":{"code":"BAD_REQUEST","message":"profile 名不合法：bad/name"}}
--- 2) download?name=../x.zip
HTTP 400 {"ok":false,"error":{"code":"BAD_NAME","message":"只允许下载 offline-packages 目录下的 zip 文件"}}
--- 3) invalid JSON POST
HTTP 400 {"ok":false,"error":{"code":"BAD_BODY","message":"请求体不是合法 JSON"}}
--- 4) unknown route
HTTP 404 {"ok":false,"error":{"code":"NOT_FOUND","message":"没有这个接口：GET /api/nope"}}
--- 5) wrong method
HTTP 405 {"ok":false,"error":{"code":"METHOD_NOT_ALLOWED","message":"没有这个接口：GET /api/package-local"}}
--- 6) unknown job
HTTP 404 {"ok":false,"error":{"code":"JOB_NOT_FOUND","message":"没有这个任务：nope"}}
--- 7) forged Origin
HTTP 403 {"ok":false,"error":{"code":"FORBIDDEN","message":"forbidden"}}
--- 8) >1MB body
HTTP 413 {"ok":false,"error":{"code":"BODY_TOO_LARGE","message":"请求体过大"}}
--- 9) JOB_BUSY
job1 HTTP 200 {"ok":true,"value":{"jobId":"…"}}
job2 HTTP 200 {"ok":true,"value":{"jobId":"…"}}
job3 HTTP 429 {"ok":false,"error":{"code":"JOB_BUSY","message":"已有 2 个打包任务在运行，请等待其中一个完成"}}
--- 服务仍可用
STATE_CHECK=PASS plugins=19 dshVersion=0.2.1-rc.2
```

→ 原来 R4（非法 profile 返回 500）已修复为 400；所有映射（400/413/403/404/405/429 与其余 500）真实生效，且错误后服务正常。**PASS**。

---

## 2. b) `/home/fc/.dsh` 的 `--dump-config`（只读）与用户 profile —— PASS

```text
$ DSH_HOME=/home/fc/.dsh node …/dsh/lib/bin.js --profile web --dump-config > verify/artifacts/delta-dump-config.txt
dump-config exit=0
1408 verify/artifacts/delta-dump-config.txt

$ grep -n 'offline-packer' verify/artifacts/delta-dump-config.txt | head
1406:# == dsh-offline-packer
1407:- id: offline-packer
1408:  name: dsh-offline-packer
```

composed bundle 顺序末尾：

```text
1397:# == dsh-super-code
1400:# == dsh-unlag
1403:# == dsh-rewind-plugin
1406:# == dsh-offline-packer        # 追加在末尾，未打乱既有顺序
```

用户 profile `package.json`（只读）与正式验证前记录的 bundles 对齐检查：

```text
recorded-before count: 15
current        count: 16
first 15 identical & in order: true
exactly one appended at end (dsh-offline-packer): true
dependencies count: 13 | dsh-offline-packer spec: file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.0.tgz
```

即：`bundles` = 原有 15 项（顺序完全一致）+ 末尾 `dsh-offline-packer`；`dependencies` 13 项，仅新增 `dsh-offline-packer: file:/home/fc/.dsh/packages/…tgz`。**PASS**。

> 说明：`--dump-config` 会刷新 `profiles/web/cordis.yml` 的 **mtime**（宿主 compose 行为，非本插件）。内容未变：
> `cordis.yml` sha256 在两次 dump-config 前后均为 `c300dcf2ebc5f02062d6591268d29d3db6fe45e0cb138f5467276fe2ba06076e`（大小 223B 不变）。若以后要求"零 mtime 变化"，需在 dump-config 前备份 mtime；本报告如实记录。

---

## 3. c) 用户 home 未被意外修改 —— PASS（预期变更逐项归类）

与正式验证快照（`verify/run/user-home-formal-after.txt`，11:50，安装前）对比本次快照（`verify/run/user-home-delta.txt`，11:54）：

```text
count=328  ->  count=329
+dsh-offline-packer@0.1.0        # 版本清单 diff 唯一新增；其余 328 个包 name@version 全部未变
```

diff 全量（28 个 +/- 行）逐项归类，无意外项：

| 变更 | 归类 |
|---|---|
| `profiles/web/package.json` sha `50a955b5…`→`eaa407e1…`，size 1068→1184，mtime 11:52 | 预期：新增 dependency + bundle（内容见 §2） |
| `node_modules/dsh-offline-packer` 新增 | 预期：官方安装 |
| version 清单 328→329（仅 +`dsh-offline-packer@0.1.0`）；scoped 分组 hash 变化 | 预期 |
| `pnpm-lock.yaml`（100939→101492B）、`node_modules/.modules.yaml`、`.package-map.json`、`.pnpm/`、`.pnpm-workspace-state-v1.json` | 预期：pnpm add 的锁/元数据更新 |
| `profiles/web/.plugin-manager` mtime 变化 + `logs/pnpm.log`（安装日志） | 预期：dsh plugin manager 记录安装 |
| `profiles/web/cordis.yml` 仅 mtime 变化（内容 sha 不变，见 §2 说明） | 预期：宿主 dump-config 行为 |
| `/home/fc/.dsh/packages/` 新增（内含与项目根同 sha 的 tgz） | 预期：Lead 的插件安装包存放约定 |
| `/home/fc/.dsh/pet.json`（11:51）、`/home/fc/.dsh/unlag-reload.log`（11:45） | **非本次验证**：运行中的用户 GUI（3080）上 dsh-pet / dsh-unlag 插件的自身运行期写入；本验证所有宿主/安装均在 `verify/**` 内，未触碰用户 home |

其它检查：

```text
$ bash verify/teardown-host.sh
port 3084: free   port 3085: free   port 3086: free
$ curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
401        # 用户 GUI 未被重启、未被触碰
$ find /home/fc/.dsh -maxdepth 2 \( -name offline-packages -o -name '*.zip' \)
(none)     # 无本插件产物写入用户 home
```

→ 除"新增 packages/ + offline-packer 依赖/bundles + pnpm 元数据"外，无插件版本变化、无意外文件；用户 GUI 未被触碰。**PASS**。

---

## 4. 观察与建议（均非阻塞）

1. **`--dump-config` 会刷新用户 profile 的 `cordis.yml` mtime**（内容逐字节不变）：这是 host 的 compose 行为，不是插件行为；以后若要求"绝对只读"，请用 profile 副本或先记录/还原 mtime。
2. 用户 profile 的 `cordis.yml` 在 11:52 Lead 安装时已被 host 重写一次（size 223B 不变），本报告只验证内容稳定，无法逐字节对比安装前原件（安装前未留存该文件 hash）；如需严格审计可在下一次安装前留 hash。
3. `--dump-config` 的 offline-packer 行为第 **1406** 行（Lead 消息里写 1405，可能因统计口径差 1 行；条目本身 1407-1408，均正确）。
4. 本次复验未重跑项 3/4/5 的打包全链路（仅 Lead 要求的状态映射/安装/配置 delta）；打包功能仍以上次 `verify/report.md` 为准，未被本次改动触及（改动仅 index.js catch 与 README）。
5. 用户 GUI（3080）仍运行旧进程、未加载新插件，符合 Lead 说明的预期；重启后才会出现「离线打包」。

## 5. 证据文件

- 本报告：`verify/report-delta.md`
- dump-config 与只读性：`verify/artifacts/delta-dump-config.txt`（1408 行）、`verify/run/dsh-home-stat-{before,after}-dumpconfig.txt` 及 `.diff`
- 用户 home 快照对比：`verify/run/user-home-formal-after.txt`（安装前）、`verify/run/user-home-delta.txt`（复验后）、`verify/run/user-home-delta.diff`
- 复验宿主日志：`verify/logs/host-3084.log`（fresh-home 官方安装，仅一行 URL）
- 复验宿主 home：`verify/home-delta/`（官方通道安装；测试后已停止进程，可随时复查）
- 最新产物：`/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.0.tgz`（sha256 `547a2023…`）、`/home/fc/.dsh/packages/dsh-offline-packer-0.1.0.tgz`（同 sha）

## 6. 最终判断

**delta 复验 PASS。** 状态码映射全部按 Lead 描述生效（含附加 413/429 验证），最新 tgz 官方通道安装后全新 home boot 干净、state 200；用户 profile 的 offline-packer 行与 bundles 顺序正确，其它插件版本/顺序未变；用户 home 除预期新增项外无意外修改，3080 未触碰、3084-3086 已释放。可交付。
