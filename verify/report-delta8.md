# 独立验证报告（delta8 / task-2）：dsh-offline-packer v0.1.8 —— 安装器适配性校验 + 全量回归

- 验证员：`qa-verifier2`（独立 fresh context；以下结论均为本次亲手复现，未复用 Lead 的结论）
- 日期：2026-10-29 18:03–18:16（Asia/Shanghai）
- 产物：`/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.8.tgz`，sha256 `3aca2c34b72f03f925e4c7eacf357476485c2be801391765af2d7d4c262774d3`（与 Lead 给定一致）
- 测试包：`test/out-installer/` 下 18:01 由**当前源码**重新生成的
  `dsh-better-sidebar-offline-0.22.1-dsh-0.1.7-rc.2.zip`（sha256 `bae3bc8d…b552f5`）与
  `dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip`（sha256 `0e310774…54c2d1`）；已独立核对
  两个包内的 `install-offline.sh/.ps1` 与当前 `lib/scripts.mjs` 的 `renderInstallers()` 输出
  **逐字节一致**（见 §1），因此本次测到的就是 v0.1.8 要交付的生成器。
- **结论：全部 PASS（A1–A4、B1–B4、C1–C4、D1–D7、E1 共 20 项，0 FAIL）。未发现缺陷，未新增 `verify/suggested-fixes.md` 条目，未改任何产品文件。**

| # | 验证项 | 结果 |
|---|---|---|
| A1 | 不匹配默认拒绝：exit 2、中文「插件与宿主不匹配」+ 版本对照 + `SessionLogOffset` 提示、目标目录零写入 | **PASS** |
| A2 | `--dry-run`：展示校验未通过与建议、exit 0、零写入 | **PASS** |
| A3 | `--force`：warning 后安装成功，bundles / 插件目录 / 内嵌 node_modules 正确 | **PASS** |
| A4 | （补充）已存在 profile 时拒绝仍零写入（文件哈希前后一致） | **PASS** |
| B1 | 同包 + 宿主 0.2.1-rc.2 →「适配性校验：通过」+ 安装成功 | **PASS** |
| B2 | `dsh-unlag`（无 DSH peer）→ 跳过校验 + 安装成功 | **PASS** |
| B3 | `--uninstall` 即使宿主不匹配也成功、清理干净 | **PASS** |
| B4 | 宿主不可探测（隔离 HOME/PATH、无 dsh、无 `--dsh-install`）→ 仅 warning + 安装成功 | **PASS** |
| C1 | Node 8.17.0 跑「拒绝」（exit 2、零写入） | **PASS** |
| C2 | Node 8.17.0 跑「通过」（exit 0、安装成功） | **PASS** |
| C3 | PS1 AST 解析 OK、UTF-8 BOM + 全 CRLF、`bash -n` OK、sh/ps1 哈希与 generator 一致 | **PASS** |
| C4 | PS1 `-DryRun` / 默认拒绝 / `-Force` / 通过 / 无 peer 跳过 五条抽查 | **PASS** |
| D1 | v0.1.8 tgz 官方通道装全新 home → boot 无 warning、state 200、plugins=1 | **PASS** |
| D2 | 本地打包：默认 + 自定义输出目录 + 进度单调 + 下载 + validate-zip | **PASS** |
| D3 | 本地打包「高级选项」no-op warning（含默认包的同类提示） | **PASS** |
| D4 | （补充）本地打包新增的 **peer 预检 warning**：通过/不通过两条都实测 | **PASS** |
| D5 | 历史版本 0.13.1 → DSH 0.1.0-rc.7 重新打包 + validate + rc.7 启动 `terminal.deps` 200 | **PASS** |
| D6 | 用户 profile = 0.1.8、329 包清单仅 offline-packer 由 0.1.7→0.1.8、packages/ 仅 0.1.8 | **PASS** |
| D7 | `/home/fc/.dsh` 前后指纹快照：除快照标签行外完全一致（零写入） | **PASS** |
| E1 | 受影响老 desktop 的恢复路径（`--uninstall` → 换匹配版本）实测可走通 | **PASS** |

---

## 0. 安全约束执行情况（重点）

本会话 env 自带 `DSH_HOME=/home/fc/.dsh`、`DSH_PROFILE_DIR=/home/fc/.dsh/profiles/web`。执行情况：

- **所有** bash 安装器测试均以
  `env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN` 运行，且显式 `--dsh-home`
  指向 `verify/tmp/delta8/**` 下的一次性沙盒；PowerShell 测试同样是 `env -u …` + 显式 `-DshHome`。
  所有 installer 日志里的目标 DSH_HOME 均可在 `verify/artifacts/delta8/*.log` 的 `[信息] DSH_HOME` 行
  逐条核对为 `verify/tmp/delta8/**` 沙盒，**没有任何一次安装/卸载指向真实 profile**；
  `grep '/home/fc/.dsh'` 只命中本地打包 job 日志里的**只读扫描来源**行
  （`扫描：home=/home/fc/.dsh profile=web`，`package-local` 只读读取插件清单，不写该 home）。
- 验证前/后对 `/home/fc/.dsh` 做只读指纹快照（`verify/run/user-home-delta8-{before,after}.txt`，
  585 行：profile `package.json` sha256+mtime、profile 顶层条目、`node_modules` 顶层（含符号链接
  目标）、329 个包版本清单）：
  ```text
  $ diff -u verify/run/user-home-delta8-before.txt verify/run/user-home-delta8-after.txt
  -# snapshot 'delta8-before' 2026-10-29T10:04:52Z
  +# snapshot 'delta8-after' 2026-10-29T10:13:19Z
    ## profile package.json
    2e526bf4…d5cb9b85  /home/fc/.dsh/profiles/web/package.json   (mtime=18:02:57, size=1184)
  ```
  → 除快照标签行外**完全相同**（`verify/run/user-home-delta8.diff`，8 行）。
  说明：`/home/fc/.dsh` 被 3080 上的用户 GUI 持续写入（`pet.json`、session/日志等运行期文件），
  整树 hash 天生不稳定，故沿用既有 `verify/snapshot-user-home.sh` 的**范围化指纹**（profile+插件清单），
  它正是「安装器会不会动真实 profile」的决定性证据；所有命令的目标路径同样已逐条核对。
- 3080 用户 GUI：全程 `HTTP 401`（未触碰）；验证端口 3084/3086 用后已释放（3084–3086 当前均 `000`）。
- 所有打包/安装产物都在 `verify/**` 下（本地打包产物 `verify/tmp/delta8/local-*`，历史版本产物在
  `verify/tmp/delta8/home-reg/offline-packages/`）。

---

## 1. 测试包来源与 generator 一致性（独立核对）

```text
$ sha256sum test/out-installer/*.zip
bae3bc8d93a01505087d12d1cc1320d085849fdb6b306d63e161483a88b552f5  dsh-better-sidebar-offline-0.22.1-dsh-0.1.7-rc.2.zip
0e310774777889bc1f4db1aa251d8545b5530c4ee131e06dae2cd08ad554c2d1  dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip

# 用当前 lib/scripts.mjs 渲染同样入参，与包内文件逐字节比较
bs install-offline.sh  BYTE-IDENTICAL (gen 35761 B)
bs install-offline.ps1 BYTE-IDENTICAL (gen 35369 B)
unlag install-offline.sh  BYTE-IDENTICAL
unlag install-offline.ps1 BYTE-IDENTICAL
# 包内脚本哈希（与 test/installer/REPORT-COMPAT.md 一致）
c026c042…9695ad3  install-offline.sh
40869404…dcef2ae3 install-offline.ps1   (BOM=efbbbf, 709/709 行 CRLF, bash -n / AST OK)

# tgz 里的生成器 == 工作树（保证测的是交付版本）
$ tar -xOzf dsh-offline-packer-0.1.8.tgz package/lib/scripts.mjs | sha256sum
ba6e72c8d60bcf4848b64aa3220e664d1a8d0d58066683f7c6752dac2af7d0c5
$ sha256sum lib/scripts.mjs
ba6e72c8…2af7d0c5
```

`dsh-better-sidebar@0.22.1` 的 peer（包内 `package/package.json` 实测）：
`@deepseek-ai/dsh-session` 等全部 `^0.1.7-rc.1`。

---

## 2. 项 1：不匹配默认拒绝 / `--dry-run` / `--force`（bash，Node 24）

公共变量（下文命令中的缩写）：
```bash
BS=verify/tmp/delta8/dsh-better-sidebar-offline-0.22.1-dsh-0.1.7-rc.2
OLD=/home/fc/dsh-plugin-build/host-pinned/node_modules/@deepseek-ai/dsh   # 0.1.0-rc.7
NEW=/home/fc/.local/lib/node_modules/@deepseek-ai/dsh                     # 0.2.1-rc.2
E="env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN"
```

### A1 默认拒绝（PASS）

```bash
$ $E bash "$BS/install-offline.sh" --dsh-home …/reject-home --dsh-install "$OLD"
EXIT=2
[信息] 检测到宿主   : @deepseek-ai/dsh 0.1.0-rc.7（…/package.json，来源：--dsh-install / DSH_INSTALL_DIR）
[错误] 插件与宿主不匹配：该插件版本声明需要 ^0.1.7-rc.1，但检测到宿主 DSH 0.1.0-rc.7。
[错误] 请改用与宿主版本匹配的插件版本（在离线打包页「历史版本」里以实际宿主版本为目标重新打包；
[错误] 例如 DSH 0.1.0-rc.7/rc.8 → dsh-better-sidebar 0.13.1，0.1.7-rc.x → 0.22.1，0.2.1-rc.x → 0.28.x），
[错误] 或加 --force 强制安装（可能启动失败）。
[错误] 适配性校验不通过时继续安装，启动很可能报：
[错误]   The requested module '@deepseek-ai/dsh-session' does not provide an export named 'SessionLogOffset'
[错误] （该符号在 dsh-session 0.1.7-rc.1 才出现；更老的宿主请换用声明更低 peer 范围的插件版本。）
--- 目标目录：verify/tmp/delta8/reject-home -> ABSENT（零写入） ---
```
断言：exit=2；含「插件与宿主不匹配」/ 需要 `^0.1.7-rc.1` / 检测到 `0.1.0-rc.7` / 版本对照（0.13.1 / 0.22.1 / 0.28.x）/ `SessionLogOffset` / `--force`；目标 home 不存在、无「安装完成」。证据：`verify/artifacts/delta8/reject.log`。

### A2 `--dry-run`（PASS）

```bash
$ $E bash "$BS/install-offline.sh" --dsh-home …/dryrun-home --dsh-install "$OLD" --dry-run
EXIT=0
[警告] 适配性校验未通过：插件声明需要 ^0.1.7-rc.1，但检测到宿主 DSH 0.1.0-rc.7。
[警告]   --dry-run 只展示校验结果、不写文件；正式安装会中止（exit 2）。
[警告]   建议：在离线打包页「历史版本」里以实际宿主版本为目标重新打包；例如 DSH 0.1.0-rc.7/rc.8 → dsh-better-sidebar 0.13.1，…
[安装] [dry-run] … （随后展示将执行的复制/bundles 操作）
--- 目标目录：verify/tmp/delta8/dryrun-home -> ABSENT（零写入） ---
```
断言：exit=0；仍展示未通过与建议；零写入；无「插件与宿主不匹配」错误块（预演用警告级）。证据：`dryrun.log`。

### A3 `--force`（PASS）

```bash
$ $E bash "$BS/install-offline.sh" --dsh-home …/force-home --dsh-install "$OLD" --force
EXIT=0
[警告] 适配性校验未通过：插件声明需要 ^0.1.7-rc.1，但检测到宿主 DSH 0.1.0-rc.7。
[警告]   已指定 --force：跳过检查继续安装（可能启动失败，例如 missing export）。
[安装] 已初始化 profile，新建文件：package.json,cordis.patch.yml,pnpm-workspace.yaml
[安装] 已安装：…/force-home/profiles/web/node_modules/dsh-better-sidebar
[信息] 当前 bundles：["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-better-sidebar"]
[安装] 安装完成：dsh-better-sidebar 0.22.1（目标 DSH 0.1.7-rc.2）

# 独立复核
bundles_has_bs= true bundles_count= 3
plugin_dir= true pkg= true 0.22.1
node_modules_embedded= true
```
证据：`force.log`。

### A4 （补充）profile 已存在时拒绝仍零写入（PASS）

先手工放一个「看起来像已初始化」的 profile（`package.json` + `cordis.patch.yml`），再跑 A1 命令：

```text
EXIT=2
BEFORE=b5e2745f1f041842279c91a920956b75c336046cbfedffe70b384a90a0f8610d
AFTER =b5e2745f1f041842279c91a920956b75c336046cbfedffe70b384a90a0f8610d
ZERO_WRITE_ON_EXISTING_PROFILE=PASS
```
证据：`preexist-reject.log`。

---

## 3. 项 2：匹配通过 / 无 peer 跳过 / 卸载 / 宿主不可探测

### B1 同包 + 宿主 0.2.1-rc.2 → 通过（PASS）

```bash
$ $E bash "$BS/install-offline.sh" --dsh-home …/pass-home --dsh-install "$NEW"
EXIT=0
[信息] 检测到宿主   : @deepseek-ai/dsh 0.2.1-rc.2（…，来源：--dsh-install / DSH_INSTALL_DIR）
[信息] 适配性校验：通过（插件声明 ^0.1.7-rc.1，宿主 0.2.1-rc.2）
[安装] 安装完成：dsh-better-sidebar 0.22.1（目标 DSH 0.1.7-rc.2）
bundles_has_bs= true plugin_dir= true version= 0.22.1
```
证据：`pass.log`。

### B2 `dsh-unlag`（无 DSH peer）→ 跳过校验（PASS）

```bash
$ $E bash "…/dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2/install-offline.sh" --dsh-home …/skip-home --dsh-install "$NEW"
EXIT=0
[信息] 插件未声明 @deepseek-ai/dsh* peer 依赖，跳过适配性校验。
[安装] 安装完成：dsh-unlag 1.12.3（目标 DSH 0.2.1-rc.2）
bundles_has_unlag= true plugin_dir= true version= 1.12.3
```
证据：`skip.log`。

### B3 `--uninstall` 即使宿主不匹配也成功（PASS）

对 A3 已安装（且宿主 0.1.0-rc.7 不匹配）的 `force-home` 执行卸载：

```bash
$ $E bash "$BS/install-offline.sh" --dsh-home …/force-home --dsh-install "$OLD" --uninstall
EXIT=0
[信息] 检测到宿主   : @deepseek-ai/dsh 0.1.0-rc.7（…）      ← 有探测，但不做适配性校验
== 卸载 dsh-better-sidebar ==
[安装] 已从 dsh.profile.bundles 移除 dsh-better-sidebar
[信息] 当前 bundles：["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]
[安装] 已删除插件目录：…/force-home/profiles/web/node_modules/dsh-better-sidebar
bundles_has_bs= false plugin_dir_gone= true
```
断言：exit=0；无「插件与宿主不匹配」。证据：`uninstall.log`。

### B4 宿主不可探测 → 只 warning、安装成功（PASS）

```bash
$ env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN \
      HOME="…/iso-home" PATH=/usr/bin:/bin \
      bash "$BS/install-offline.sh" --dsh-home …/unknown-home
EXIT=0
[信息] Node           : /usr/bin/node（v10.19.0）
[信息] 未检测到 dsh 命令行/安装目录；本安装不依赖 dsh 命令，跳过宿主版本校验（可用 --dsh-install 指定）。
[警告] 无法校验插件与宿主适配性（未检测到宿主 DSH 版本）；若启动报 missing export，请换匹配版本。
[信息]   插件声明的 DSH peer 范围：^0.1.7-rc.1
[信息]   想校验时用 --dsh-install <dsh 安装目录> 指定标准 @deepseek-ai/dsh 包。
[安装] 安装完成：dsh-better-sidebar 0.22.1（目标 DSH 0.1.7-rc.2）
bundles_has_bs= true installed= true
```
断言：exit=0；仅 warning（无「插件与宿主不匹配」）；安装成功。证据：`unknown.log`。

---

## 4. 项 4：Node 8.17 与 PowerShell（便携 pwsh 7.4.6）

Node 8.17.0 路径（npx 实取）：
```text
$ npx -y node@8.17.0 -p process.execPath
/home/fc/.npm/_npx/853ea35bc6b17ca6/node_modules/node/bin/node   # v8.17.0
```

### C1/C2 Node 8.17 真实执行（PASS）

```text
# 拒绝
$ $E NODE_BIN=<node8.17> bash "$BS/install-offline.sh" --dsh-home …/node8-reject-home --dsh-install "$OLD"
REJECT_EXIT=2
[信息] Node           : …/node/bin/node（v8.17.0）
[信息] 检测到较旧的 Node（v8.17.0）：本安装器兼容 Node 4+/8.x（内嵌 JS 为 ES5），安装不受影响。
[错误] 插件与宿主不匹配：该插件版本声明需要 ^0.1.7-rc.1，但检测到宿主 DSH 0.1.0-rc.7。
[错误]   The requested module '@deepseek-ai/dsh-session' does not provide an export named 'SessionLogOffset'
node8-reject-home -> ABSENT（零写入）

# 通过
$ $E NODE_BIN=<node8.17> bash "$BS/install-offline.sh" --dsh-home …/node8-pass-home --dsh-install "$NEW"
PASS_EXIT=0
[信息] 适配性校验：通过（插件声明 ^0.1.7-rc.1，宿主 0.2.1-rc.2）
[安装] 安装完成：dsh-better-sidebar 0.22.1（目标 DSH 0.1.7-rc.2）
…/node8-pass-home/profiles/web/node_modules/dsh-better-sidebar/package.json -> OK
```
→ 新增 ES5 `NODE_COMPAT` helper 在 Node 8.17 下真实可用（读 JSON / semver 匹配 / 退出码均正确）。证据：`node8-reject.log`、`node8-pass.log`。

### C3 PS1 语法/编码/AST（PASS）

```text
$ pwsh -NoProfile -File test/installer/ps-ast-check.ps1 "$BS/install-offline.ps1"
AST OK: …/install-offline.ps1 (5295 tokens)     AST_EXIT=0
BOM: efbbbf      CRLF 行: 709/709      LF-only 行: 0
$ bash -n "$BS/install-offline.sh"      -> OK
```
证据：本报告 §1（哈希与 generator 一致）。

### C4 PS1 行为抽查（PASS，全部 `env -u …` + 显式 `-DshHome`）

```text
EXITS dryrun=0 reject=2 force=0 pass=0 skip=0

-DryRun + host-pinned(0.1.0-rc.7):
  [警告] 适配性校验未通过：插件声明需要 ^0.1.7-rc.1，但检测到宿主 DSH 0.1.0-rc.7。
  [警告]   -DryRun 只展示校验结果、不写文件；正式安装会中止（exit 2）。
  ps-dryrun-home -> ABSENT（零写入）
默认 + host-pinned:
  [错误] 插件与宿主不匹配：…（同上中文块，含 0.13.1 对照与 SessionLogOffset）
  exit 2；ps-reject-home -> ABSENT（零写入）
-Force + host-pinned:
  [警告]   已指定 -Force：跳过检查继续安装（可能启动失败，例如 missing export）。
  [安装] 安装完成：dsh-better-sidebar 0.22.1（目标 DSH 0.1.7-rc.2）
通过（0.2.1-rc.2）:
  [信息] 适配性校验：通过（插件声明 ^0.1.7-rc.1，宿主 0.2.1-rc.2）
  [安装] 安装完成：…
dsh-unlag（无 peer）:
  [信息] 插件未声明 @deepseek-ai/dsh* peer 依赖，跳过适配性校验。
  [安装] 安装完成：dsh-unlag 1.12.3（目标 DSH 0.2.1-rc.2）
```
证据：`ps-dryrun.log`、`ps-reject.log`、`ps-force.log`、`ps-pass.log`、`ps-skip.log`。

---

## 5. 项 3/5：回归

### D1 v0.1.8 tgz 官方通道装全新 home → boot 干净、state 200（PASS）

```bash
$ rm -rf verify/tmp/delta8/home-reg
$ $E DSH_HOME=…/home-reg dsh plugin --profile web add /home/fc/dsh-offline-packer/dsh-offline-packer-0.1.8.tgz
dsh: initialized profile web at …/home-reg/profiles/web
+ dsh-offline-packer file:/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.8.tgz
Done in 980ms using pnpm v11.21.0
installed_version= 0.1.8   deps=1   bundles=@deepseek-ai/dsh-base,@deepseek-ai/dsh-web-app,dsh-offline-packer

$ bash verify/setup-host.sh --no-plugin --port 3084 --home verify/tmp/delta8/home-reg   # 后台任务
HOST_READY port=3084 ... dsh bin=/home/fc/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js

$ bash verify/boot-evidence.sh 3084 --expect-plugin dsh-offline-packer --probe "GET /dsh-offline-packer/api/state"
PASS  startup log: no hard failures          (log 1 行；grep warning/entry apply failed/duplicate prefix route/FAILED/ERR_MODULE -> 0)
PASS  GET / 200
      boot manifest entries: 70；manifest contains "dsh-offline-packer": YES
PASS  plugin client bundle served (200, 102970 B)
PASS  dump-config mentions dsh-offline-packer（1232 行）
PASS  probe GET /dsh-offline-packer/api/state
EVIDENCE_RESULT=PASS

$ bash verify/probe-api.sh state --port 3084 --min-plugins 1
ok=true host.dshVersion=0.2.1-rc.2 … plugins=1
  - dsh-offline-packer  0.1.8  kind=bundle  installed=true enabled=true size=397062 files=18
hiddenOfficial=18 officialCount=18
STATE_CHECK=PASS
```
证据：`official-install.log`、`boot-3084-fresh.log`、`evidence-3084-100734.*`。

### D2 本地打包：默认 + 自定义输出目录 + 进度 + 下载/校验（PASS）

```text
POST /api/package-local {"pluginName":"dsh-unlag","home":"/home/fc/.dsh",
                          "outputRoot":"…/verify/tmp/delta8/local-out"} -> HTTP 200
poll: POLL_CHECK=PASS status=done  progress={"phase":"完成","percent":100}
result: dir/zipPath 均在 …/local-out；size 118,598 B；vendored []；mode local
logs: 扫描 1 个文件；静态依赖 0 个；… job finished in 231 ms

# 自定义输出目录 + 进度（单独再跑一遍，0.1s 采样）
POST package-local -> jobId=mvtdqt3j-3-o4gx（outputRoot=…/local-out2）
  progress: status=running phase=读取插件清单 percent=12
  progress: status=done    phase=完成        percent=100
ASSERT_OK progress percent monotonically non-decreasing
PROGRESS_CHECK=PASS transitions=1 final=完成/100（startedAt/finishedAt 齐全，duration 202 ms）

# 下载（必须带 outputRoot）+ 结构校验
GET /api/download?name=dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip&outputRoot=…/local-out2 -> HTTP 200 size=118600
DOWNLOAD_CHECK=PASS
$ bash verify/validate-zip.sh …/local-out2/dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip …
PASS  sha256sum -c CHECKSUMS.txt: 15/15 OK
PASS  README/VERSIONS 版本与目标版本一致；无绝对/../ 成员
files=16 dir_size=420K   RESULT=PASS checks=22 failures=0
```
证据：`local-default-job.log`、`local-default-result.log`、`progress-local-full.log`、`download-custom-root.log`。

### D3 高级选项 no-op warning（PASS）

```text
POST … {"pluginName":"dsh-unlag", embed:{"includeHostProvided":true}}
POLL_CHECK=PASS status=done；size 118,825 B（+227 B，仅安装器差异）；
warnings[0]: 已启用「内嵌宿主运行时依赖」…（既有风险提示，含解析来源与重复实例风险）
warnings[1]: 该插件的服务端没有静态/动态 import 任何外部包（只有 client bundle 或纯 node: 内建），
            因此「内嵌宿主运行时依赖 / 全部声明依赖 / 额外内嵌包」都不会改变产物内容。
```
（默认通道也打印同一条 no-op 提示，属 v0.1.7 起的既有行为。）证据：`local-embed-result.log`。

### D4 （补充）本地打包的 peer 预检 warning（v0.1.8 `lib/local.mjs` 新增）

- 通过分支（真实宿主 0.2.1-rc.2 + 已装 `dsh-better-sidebar@0.28.1`）：
  ```text
  适配性预检：通过（插件声明 ^0.2.1-rc.1，宿主 0.2.1-rc.2）   warnings=[]
  ```
- 不通过分支（同一插件，`package-local` 手动覆盖 `dshVersion:"0.1.0-rc.7"`）：
  ```text
  warnings[0]: 当前安装的插件版本 dsh-better-sidebar@0.28.1 声明需要 DSH ^0.2.1-rc.1，但当前宿主是 0.1.0-rc.7；
               产物可能无法在该宿主启动（例如运行时报缺少导出）。建议改用与宿主版本匹配的插件版本
               （「历史版本」里以实际宿主版本为目标重新打包）。
  ```
  证据：`preflight-pass-job.json`、`preflight-mismatch-job.json`。

### D5 历史版本 0.13.1 → DSH 0.1.0-rc.7：重新打包 + 安装 + rc.7 启动（PASS）

```text
POST /api/package-registry {"pluginName":"dsh-better-sidebar","version":"0.13.1","targetDshVersion":"0.1.0-rc.7"}
job mvtdqz6m-4-eg3n -> done in 94035 ms
  peer 兼容性检查通过：DSH 0.1.0-rc.7 落在 ^0.1.0-rc.7
  内嵌依赖 157 个（含 schemastery、ws、mermaid、codemirror…）
  已从 vendor 依赖中剔除需要安装脚本的包：node-pty@1.1.0（宿主提供）
zip: 46,955,700 B / 12,864 文件 / 12,863 条校验和

$ bash verify/validate-zip.sh …/dsh-better-sidebar-offline-0.13.1-dsh-0.1.0-rc.7.zip
PASS  sha256sum -c CHECKSUMS.txt: 12863/12863 OK
PASS  README/VERSIONS = 0.13.1 / 0.1.0-rc.7；无绝对/../ 成员
files=12864 dir_size=193M   RESULT=PASS checks=22 failures=0

# 安装到沙盒 home（env -u …）
INSTALL_EXIT=0
[信息] 适配性校验：通过（插件声明 ^0.1.0-rc.7，宿主 0.2.1-rc.2）   ← 本机探测到的宿主
[安装] 安装完成：dsh-better-sidebar 0.13.1（目标 DSH 0.1.0-rc.7）
bundles= @deepseek-ai/dsh-base,@deepseek-ai/dsh-web-app,dsh-better-sidebar

# 用 host-pinned rc.7 启动 3086
$ bash verify/setup-host.sh --no-plugin --port 3086 --dsh-bin /home/fc/dsh-plugin-build/host-pinned/node_modules/@deepseek-ai/dsh/lib/bin.js --home verify/tmp/delta8/home-hist
HOST_READY port=3086 ...
$ bash verify/boot-evidence.sh 3086 --expect-plugin dsh-better-sidebar --probe "POST /sidebar/api/terminal.deps"
PASS  startup log: no hard failures
PASS  GET / 200
      manifest entries: 39；contains "dsh-better-sidebar": YES
PASS  plugin client bundle 200（458,844 B）
PASS  dump-config mentions dsh-better-sidebar（496 行）
PROBE POST /sidebar/api/terminal.deps -> 200 {"ok":true,"value":{"ok":true}}
EVIDENCE_RESULT=PASS
```
证据：`history-job.log`、`validate-history.log`、`hist-install.log`、`boot-3086-hist.log`、`evidence-3086-101146.*`。

### D6 用户 profile = 0.1.8 且其它 328 包未变（PASS）

```text
installed: 0.1.8
dep: file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.8.tgz
profile package.json sha256: 2e526bf4…d5cb9b85（与验证前一致）；deps=13；bundles=16（含 offline-packer）
packages/ 仅 dsh-offline-packer-0.1.8.tgz，sha256 3aca2c34…774d3（与项目根一致）
版本清单 count=329
  dsh-offline-packer@0.1.8   # 对比上一版快照（delta7fix-after, 0.1.7）：
  dsh-better-sidebar@0.28.1  #   diff = 仅 -dsh-offline-packer@0.1.7 +dsh-offline-packer@0.1.8
  dsh-unlag@1.12.3           #   其余 328 个包版本逐行相同
  dshmarket@1.70.2
```

### D7 真实 home 前后指纹零写入（PASS）

见 §0：`verify/run/user-home-delta8.diff` 除快照标签行外为空；所有安装器命令的目标均为沙盒。

---

## 6. 项 6：受影响老 desktop 的恢复指引（并在沙盒实测走通）

**根因（与用户故障一致）**：`dsh-better-sidebar@0.22.1` 声明 `@deepseek-ai/dsh-session: ^0.1.7-rc.1`，
而更老的 desktop DSH（如 `0.1.0-rc.7`）的 `dsh-session` 还没有 `SessionLogOffset` 导出 →
启动时报 `The requested module '@deepseek-ai/dsh-session' does not provide an export named 'SessionLogOffset'`，
整棵插件树 failed to load。v0.1.8 的安装器现在会在**写任何文件之前**拒绝该组合（A1）。

**受影响 desktop 上的恢复步骤**（该机器插件树加载失败，不能依赖离线打包页 UI，直接用离线包/文件系统）：

1. 拿到**当前装上去的那个**离线包（如 `…-0.22.1-…zip`），解压后执行
   `bash install-offline.sh --uninstall`（PowerShell：`install-offline.ps1 -Uninstall`）——
   卸载**不做适配性校验**，宿主不匹配也能干净回滚（B3 已实测：exit 0、bundles 移除、插件目录删除）。
   不想跑脚本时手工等价操作：从 `<DSH_HOME>/profiles/web/package.json` 的
   `dsh.profile.bundles` 删掉 `"dsh-better-sidebar"`，并删除
   `profiles/web/node_modules/dsh-better-sidebar/`，然后重启 DSH。
2. **换匹配版本**再装：在实际宿主版本下用「历史版本」打包对应插件版本（`0.1.0-rc.7/rc.8 → 0.13.1`；
   `0.1.7-rc.x → 0.22.1`；`0.2.1-rc.x → 0.28.x`），在新机器上执行其 `install-offline.sh`
   （会显示「适配性校验：通过」）。本报告用 **0.13.1 产物 + rc.7 宿主**实测：校验通过 → 安装完成 →
   rc.7 启动 200、插件 client bundle 200、`/sidebar/api/terminal.deps` 200 `{ok:true}`（D5）。
3. 重启 DSH 后验证：`dsh --profile web --dump-config | grep dsh-better-sidebar`；
   页面侧边栏功能恢复。**不要**在旧 desktop 上对 0.22.1 用 `--force`（强行装回同样会启动失败）。

**恢复演练（沙盒实测，`recovery-*.log`）**：
```text
# 1) 模拟已坏的 desktop：在 0.1.0-rc.7 宿主上 --force 装 0.22.1
EXIT=0（已指定 --force，warning）
# 2) 直接装匹配的 0.13.1（同宿主）
[信息] 适配性校验：通过（插件声明 ^0.1.0-rc.7，宿主 0.1.0-rc.7）  EXIT=0
# 3) 再演示 --uninstall 回滚
[安装] 已从 dsh.profile.bundles 移除 dsh-better-sidebar；已删除插件目录  EXIT=0
# 4) 重装匹配版本
[信息] 适配性校验：通过（…）；[安装] 安装完成：dsh-better-sidebar 0.13.1
final bundles= @deepseek-ai/dsh-base,@deepseek-ai/dsh-web-app,dsh-better-sidebar
final installed= 0.13.1
```
（即：受损机器既可以「先 `--uninstall` 再装匹配版本」，也可以直接用匹配版本覆盖安装；两条路都实测成功。）

---

## 7. 已知行为说明（非缺陷）

1. **预发布 peer 范围刻意放宽**（`test/installer/REPORT-COMPAT.md` §2.4）：`^0.1.x-rc.N` 按「不低于下界、
   同 0.x 上界」解释，因此旧的 0.13.1 产物（`^0.1.0-rc.7`）装到 0.2.1-rc.2 会**通过**（D5 安装日志可见）。
   这是为避免误拒而做的有意取舍，README 已写明「优先重新打包而不是 --force」；本次任务要求的两条关键判定
   （0.22.1 + 0.1.0-rc.7 → 拒绝；0.22.1 + 0.2.1-rc.2 → 通过）均符合预期。
2. `/home/fc/.dsh` 被用户 3080 GUI 持续写入（pet.json、session/日志），整树 hash 不稳定；本报告采用既有的
   范围化指纹（profile package.json + 插件版本清单）作为「是否写真实 profile」的判据，并逐条核对了所有命令的
   实际目标路径。
3. 测试包为 18:01 由当前源码生成的 fixture，包内脚本与 `renderInstallers()` 逐字节一致、生成器源码与
   tgz 内文件 sha256 相同（§1），因此等价于「用最新源码自行生成」。

---

## 8. 证据清单（`verify/artifacts/delta8/` + `verify/run/`）

| 证据 | 内容 |
|---|---|
| `reject.log` / `dryrun.log` / `force.log` / `preexist-reject.log` | 项 1（A1–A4）完整命令输出 |
| `pass.log` / `skip.log` / `uninstall.log` / `unknown.log` | 项 2（B1–B4） |
| `node8-reject.log` / `node8-pass.log` | Node 8.17.0 两条真实执行 |
| `ps-dryrun.log` / `ps-reject.log` / `ps-force.log` / `ps-pass.log` / `ps-skip.log` | PS1 抽查（便携 pwsh 7.4.6） |
| `official-install.log`、`boot-3084-fresh.log`、`evidence-3084-100734.{manifest.txt,probe-*.json}` | 回归 D1 |
| `local-default-{job,result}.log`、`progress-local*.log`、`download-custom-root.log`、`local-embed-*.log` | 回归 D2/D3 |
| `preflight-{pass,mismatch}-*.json` | 本地打包 peer 预检 D4 |
| `history-post.log`、`history-job.log`、`validate-history.log`、`hist-install.log`、`boot-3086-hist.log`、`evidence-3086-101146.{manifest.txt,probe-*.json}` | 回归 D5 |
| `fixture-sha256.txt`、`user-home-delta8-{before,after}.txt`、`user-home-delta8.diff` | 测试包来源、真实 home 指纹 |
| `recovery-1..4-*.log` | 项 6 恢复演练 |

复跑要点：所有 installer 命令前置 `env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR -u NODE_BIN`
且 `--dsh-home` 指向 `verify/tmp/**`；打包/主机用 `verify/probe-api.sh`、`verify/setup-host.sh`、
`verify/boot-evidence.sh`、`verify/validate-zip.sh`；端口只用 3084/3086，3080 未触碰。

---

## 9. 结论

**v0.1.8 可交付。** 安装器对「插件 peer 与宿主不匹配」的默认拒绝（exit 2、零写入、中文版本对照与
`SessionLogOffset` 解释）、`--force`/`-Force` 强制、`--dry-run` 展示、无 peer 跳过、宿主不可探测仅 warning、
卸载不受校验影响，在 bash（Node 24 / Node 8.17）与 PowerShell 7.4.6 上均与契约一致；本地打包新增的
peer 预检 warning 也实测生效。回归无退化：v0.1.8 tgz 全新 home boot 干净、state 200；本地打包/进度/自定义
输出目录/历史版本 0.13.1→rc.7 + rc.7 启动 `terminal.deps` 均通过；用户 profile 为 0.1.8 且其它 328 个包
版本未变；本次验证对 `/home/fc/.dsh` 零写入。未发现需要修复的缺陷，未修改任何产品文件。
