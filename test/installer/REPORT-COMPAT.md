# 离线安装器「适配性校验」实现与测试报告（task-1）

> 负责：`installer-compat2`（「离线安装器适配性校验」）
> 范围：`lib/scripts.mjs`（生成 `install-offline.sh` / `install-offline.ps1` / 包内 `README.md`
> 的模板）+ `test/installer/**`
> 结论：**262 / 262 条断言 PASS**（原有 152 条全部保留通过 + 新增 110 条），
> bash（Node 24 / Node 8.17.0）与便携 pwsh 7.4.6 两路行为实测通过。

---

## 一、用户真实故障与根因

把 **`dsh-better-sidebar@0.22.1`**（其 `@deepseek-ai/dsh-*` peer 全是 `^0.1.7-rc.1`）
装到**更老的 desktop DSH**（如 `0.1.0-rc.7`）上，DSH 启动报：

```text
The requested module '@deepseek-ai/dsh-session' does not provide an export named 'SessionLogOffset'
```

**整棵插件树加载失败**（不只该插件）。已核实：

- `SessionLogOffset` 在 `@deepseek-ai/dsh-session` **0.1.7-rc.1** 才出现，
  `0.1.0-rc.7` / `0.1.0-rc.8` / `0.1.1-rc.2` 都没有；
- 所有 `@deepseek-ai/dsh-*` 包与宿主核心 `@deepseek-ai/dsh` 版本同号段，因此可用宿主
  核心版本判断兼容性；
- `dsh-better-sidebar` 版本 ↔ peer：`0.13.1 → ^0.1.0-rc.7`、`0.22.1/0.24.1 → ^0.1.7-rc.1 /
  ^0.2.0-rc.1`、`0.26.1+` 不再 import `SessionLogOffset`。

旧安装器只把探测到的宿主版本与**打包目标版本**比较并给一条「版本不匹配」的普通
`[警告]`，照样继续安装，于是这类组合装上去必然启动失败。本次给生成的 bash/PS 安装器
加**写文件之前的适配性校验**。

---

## 二、改动清单

只改 `lib/scripts.mjs` 与 `test/installer/**`；`renderInstallers` / `renderReadme` /
`renderVersionsText` 的入参、返回值不变（`lib/pack.mjs` 调用点零改动，ARCHITECTURE §2
契约不变）。

### 2.1 `install-offline.sh`（bash）

1. 新参数 `--force`（`FORCE=1`），`--help` / 头部注释 / 示例同步；`--dsh-install` 的说明
   从「可选提示」改为「用于适配性校验；探测不到只警告不阻断」。
2. 新增内嵌 **`NODE_COMPAT`** 帮助脚本（ES5 / Node 4+，`require('fs')`、`var`、字符串
   拼接、无模板串/箭头/`const`），读取插件 `package.json`：
   - 收集 `@deepseek-ai/dsh` 与全部 `@deepseek-ai/dsh-*` 的 `peerDependencies` 范围并去重；
   - 用内置简易 semver 匹配器与宿主版本比较；
   - 输出一行 `0x1E` 分隔的 4 个字段（`状态`/`宿主版本`/`范围列表`/`不满足的范围`）。
     （不用 TAB：bash 的 `IFS=$'\t'` 会把连续 TAB 折叠成一个分隔符，空字段会错位，
     `0x1E` 记录分隔符没有这个问题。）
3. 新增「适配性校验」段，位置在宿主探测之后、`--uninstall` / 安装/预演分支之前，
   所以**不匹配时目标目录零写入**：

| 状态 | 输出 | 行为 |
|---|---|---|
| `skip`（无 DSH peer） | `[信息] 插件未声明 @deepseek-ai/dsh* peer 依赖，跳过适配性校验。` | 继续 |
| `unknown`（宿主版本不可探测/不可解析） | `[警告] 无法校验插件与宿主适配性（未检测到宿主 DSH 版本）；若启动报 missing export，请换匹配版本。` + 插件声明范围 + `--dsh-install` 建议 | 继续 |
| `pass` | `[信息] 适配性校验：通过（插件声明 <ranges>，宿主 <ver>）` | 继续 |
| `fail`（无 `--force`） | 中文错误块：`插件与宿主不匹配：该插件版本声明需要 <ranges>，但检测到宿主 DSH <ver>。` + 版本对照示例（`0.1.0-rc.7/rc.8 → dsh-better-sidebar 0.13.1`、`0.1.7-rc.x → 0.22.1`、`0.2.1-rc.x → 0.28.x`）+ `--force` 说明 + `SessionLogOffset` 报错解释 + 两条升级/降级路径 | **exit 2，零写入** |
| `fail` + `--force` | `[警告] … 已指定 --force：跳过检查继续安装（可能启动失败，例如 missing export）。` | 安装 |
| `fail` + `--dry-run` | `[警告] 适配性校验未通过…（--dry-run 只展示，正式安装会中止）` + 版本对照 | 预演照常、零写入、exit 0 |

4. `--uninstall` 完全跳过校验；原来「本分发包按 DSH X 适配」的 blocking-ish 警告改为
   普通 `[信息]`（以适配性校验结果为准），避免与校验通过结论自相矛盾。
5. `--help` / 头部新增「适配性校验」小节与 `--force` 示例。

### 2.2 `install-offline.ps1`（Windows PowerShell 5.1+）

与 bash 版**判定逻辑、文案、退出码一致**，但不依赖 Node（用 PowerShell 自身读写 JSON
和做 semver 计算）：

- 新参数 `[switch]$Force`；`Show-Usage` / 头部注释 / 示例同步；`-DshInstall` 说明更新。
- 新增 PS5.1 兼容的 semver 函数：`ConvertTo-DshVersion`、`Compare-DshIdentifier`、
  `Compare-DshVersion`、`New-DshUpperVersion`、`Expand-DshComparator`、`Test-DshRange`、
  `Get-DshPeerRanges`（无三元运算、无 `??`、无反引号续行）。
- 新增与 bash 同款的适配性校验段（`-Uninstall` 跳过；`-DryRun` 展示不中止；`-Force`
  警告后继续；不匹配 `exit 2`，且发生在任何写操作之前）。
- 保持 UTF-8 BOM + 全 CRLF；PS5.1 语法 AST 通过（便携 pwsh 7.4.6）。

### 2.3 包内 `README.md`

- 快速开始置顶「适配性校验（重要）」提示（默认 exit 2 / `--force` / 卸载不校验）；
- 第四节新增 **「适配性校验 / missing export 错误」** 小节：
  - 判定表（pass / fail / unknown / skip / force 的文案与退出码）；
  - 真实故障 `SessionLogOffset` 例子与原因；
  - **版本对照表**（0.1.0-rc.7/rc.8 → 0.13.1；0.1.1-rc.2 等更早 0.1.x → 0.13.1；
    0.1.7-rc.x → 0.22.1；0.2.0-rc.x/0.2.1-rc.x → 0.28.x 或 0.26.1+）；
  - 预发布 peer 范围的解释与「优先重新打包而不是 `--force`」建议；
- 版本信息表 / FAQ（新增第 9 条）/ 第九节「打包信息」同步；
- `--uninstall` 不校验、`--dry-run` 只展示的说明。

### 2.4 校验语义（含一处刻意的兼容放宽）

简易 semver 支持：`^ ~`、精确、`>= > <= <`、`=`、空格连接的 AND、`||` 的 OR、
x-range/wildcard、预发布 `a.b.c-rc.N` 按数字序比较。

**预发布范围放宽**：范围下界带预发布标签时（如 `^0.1.7-rc.1`），按「不低于下界、
同一主版本（0.x → `<1.0.0`）」解释，而不是 npm 严格的 caret 上界。原因：
DSH 0.x 预发布阶段版本迭代很快，插件作者普遍用 caret 表达**最低兼容版本**，
`dsh-better-sidebar@0.22.1` 的 `^0.1.7-rc.1` 实际兼容 `0.1.7-rc.x` 与 `0.2.x-rc.x`
（`SessionLogOffset` 在 0.1.7-rc.1 已存在且之后持续存在）。因此任务要求的
「0.22.1 + 宿主 0.2.1-rc.2 → 通过」成立，而「0.22.1 + 宿主 0.1.0-rc.7 → 拒绝」也成立。

边界：显式写的比较器（如 `>=0.2.0-rc.1 <0.3.0-0`）仍严格按范围判断；稳定版 caret
（如 `^0.2.0`）仍按 npm 语义。该放宽的代价是「很旧的插件 + 较新的宿主」可能被放过
（例如 `^0.1.0-rc.7` 的插件装到 0.2.1-rc.2 会通过），属于有意的「宁可放过、避免误拒」，
README 已写明「优先重新打包」。

---

## 三、ES5 / 旧 Node 兼容保障

- 新增 `NODE_COMPAT` 帮助脚本全部 ES5：`require('fs')`、`var`/`function`、字符串拼接，
  无 `node:` 前缀、`const/let`、箭头函数、模板字符串、展开、`??`/`?.`、`fs.promises`、
  `recursive: true`、`Array.from`、`async/await`；
- 测试会把生成的 sh 里所有 `<<'NODE_*'` heredoc 抽成独立 `.js`，用
  `node@8.17.0 --check` 逐个语法检查，并做禁用构造 + 模板字符串扫描；
  内嵌脚本数量断言相应由 5 → 6（新增 `NODE_COMPAT.js`），其余原有 152 条断言原样保留；
- 实测 Node 8.17.0 上「不匹配拒绝（exit 2）」与「匹配通过安装」两条真实执行通过。

---

## 四、测试矩阵（`bash test/installer/run-installer-tests.sh` → 262 PASS / 0 FAIL）

两个离线包在测试开始时用**当前 `lib/scripts.mjs`** 重新生成（`build-fixtures.mjs`：
dsh-unlag 走本地通道、dsh-better-sidebar@0.22.1 走 registry 历史版本通道），并逐字节断言
产物里的 `install-offline.sh/.ps1` 与当前 generator 渲染结果一致，避免测到旧模板。
所有用例均 `env -u DSH_HOME -u DSH_PROFILE_DIR` 且写入 `test/out-installer/` 沙盒，
**不读写 `/home/fc/.dsh`**（local fixture 只读扫描已装插件）。

| # | 场景 | 期望 | 结果 |
|---|---|---|---|
| 0 | 用最新源码重建两个离线包 + generator 一致性 + `node --check` | 重建成功、逐字节一致 | PASS（8） |
| 1 | dsh-unlag 包完整性：unzip、CHECKSUMS、`bash -n`、内嵌 JS 抽取 + Node8 语法 + ES5 扫描、manifest、README 特殊场景 | 全通过；新增 `NODE_COMPAT.js` 被抽取并过 Node 8 语法检查 | PASS（26） |
| 1b | **better-sidebar 0.22.1 产物**：unzip/CHECKSUMS/`bash -n`/PS AST+BOM、peer 为 `^0.1.7-rc.1`、README「适配性校验 / SessionLogOffset / 版本对照 / --force」、sh/ps1 含新参数 | 全通过 | PASS（26） |
| 2 | 原场景 A：正常 Node 24，全新 `--dsh-home` 安装/幂等/卸载 | 不回归 | PASS（18） |
| 3 | 原场景 B：`NODE_BIN=node@8.17.0` 安装/卸载 | 不回归 | PASS（10） |
| 4 | 原场景 C：`--profile-dir` / 假 dsh / 环境变量优先级 / 显式参数优先 | 不回归 | PASS（51） |
| 5 | 原探测降级 / `--dsh-install` / 非标准包 / 无 node | 不回归 | PASS（17） |
| 6 | 原 PowerShell：AST、BOM/CRLF、DryRun、安装/卸载、ProfileDir、Node8、显式参数优先 | 不回归 | PASS（28） |
| 7 | **新增 bash 适配性校验**（见下） | 全部符合 | PASS（53） |
| 8 | **新增 PowerShell 适配性校验**（见下） | 全部符合 | PASS（25） |

### 7. bash 适配性校验（用户真实组合：`dsh-better-sidebar@0.22.1`，peer `^0.1.7-rc.1`）

| 用例 | 命令要点 | 结果 |
|---|---|---|
| 7a 拒绝 | `--dsh-install <host-pinned 0.1.0-rc.7>`（不用 `--dry-run`） | `exit 2`；日志含「插件与宿主不匹配」「需要 ^0.1.7-rc.1」「检测到宿主 DSH 0.1.0-rc.7」「dsh-better-sidebar 0.13.1」「0.28.x」「SessionLogOffset」「--force」；**目标 home 目录不存在（零写入）**；无「安装完成」 |
| 7b 通过 | `--dsh-install <0.2.1-rc.2>` | `exit 0`；`适配性校验：通过（插件声明 ^0.1.7-rc.1，宿主 0.2.1-rc.2）`；安装完成、bundles present |
| 7c 强制 | 7a 组合 + `--force` | `exit 0`；`已指定 --force` 警告；安装完成、bundles present |
| 7d 预演 | 7a 组合 + `--dry-run` | `exit 0`；展示「适配性校验未通过 / 正式安装会中止 / 0.13.1」；**零写入** |
| 7e 无 DSH peer | dsh-unlag + `--dsh-install <0.2.1-rc.2>` + `--dry-run` | `exit 0`；`插件未声明 @deepseek-ai/dsh* peer 依赖，跳过适配性校验` |
| 7f 宿主不可探测 | `HOME=<隔离>` + `PATH=/usr/bin:/bin`（无 `dsh`）+ 无 `--dsh-install` | `exit 0`；`无法校验插件与宿主适配性（未检测到宿主 DSH 版本）` + 声明范围；安装完成 |
| 7g 卸载不受影响 | 对已安装且「宿主不匹配」的 profile 执行 `--uninstall --dsh-install <0.1.0-rc.7>` | `exit 0`；无「插件与宿主不匹配」；插件目录删除、bundles absent |
| 7h `--help` | — | `exit 0`；含 `--force` / `适配性校验` / `SessionLogOffset` |
| 7i Node 8.17.0 | `NODE_BIN=$(npx -y node@8.17.0 -p process.execPath)` 跑拒绝 + 通过 | 拒绝 `exit 2` 且零写入；通过 `exit 0` 且安装完成（ES5 helper 实测可用） |

### 8. PowerShell 适配性校验

| 用例 | 结果 |
|---|---|
| `-DryRun` + host-pinned | `exit 0`；「适配性校验未通过 / 正式安装会中止 / 0.13.1」；零写入 |
| host-pinned 正式安装 | **`exit 2`**；「插件与宿主不匹配 / 0.13.1 / SessionLogOffset」；零写入 |
| 0.2.1-rc.2 | `exit 0`；「适配性校验：通过」；安装完成 |
| host-pinned + `-Force` | `exit 0`；「已指定 -Force」；安装完成 |
| dsh-unlag + `-DshInstall 0.2.1-rc.2` | `exit 0`；「插件未声明 @deepseek-ai/dsh* peer 依赖，跳过适配性校验」 |
| 宿主不可探测（隔离 HOME + 无 dsh 的 PATH） | `exit 0`；「无法校验插件与宿主适配性…」；安装完成 |

逐条 PASS/FAIL 清单：`test/installer/run-output.txt`；每个用例完整命令输出：
`test/installer/logs/<用例名>.log`（如 `logs/bs-reject.log`、`logs/bs-pass.log`、
`logs/bs-node8-reject.log`、`logs/bs-ps-reject.log`）。

---

## 五、如何复跑

```bash
cd /home/fc/dsh-offline-packer

# 完整测试（默认先用当前源码重建两个离线包；约 1-2 分钟，registry 通道需要网络）
bash test/installer/run-installer-tests.sh

# 调试时复用已有 zip（跳过 fixture 重建）
SKIP_FIXTURE_BUILD=1 bash test/installer/run-installer-tests.sh

# 只重建 fixture
node test/installer/build-fixtures.mjs
```

产物（`test/out-installer/`，gitignored）：

| 文件 | 大小 | sha256 |
|---|---|---|
| `dsh-better-sidebar-offline-0.22.1-dsh-0.1.7-rc.2.zip` | 48,394,261 B | `bae3bc8d93a01505087d12d1cc1320d085849fdb6b306d63e161483a88b552f5` |
| `dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip` | 118,660 B | `0e310774777889bc1f4db1aa251d8545b5530c4ee131e06dae2cd08ad554c2d1` |

BS 产物内 `install-offline.sh` sha256 `c026c042…95ad3`、`install-offline.ps1` sha256
`40869404…f2ae3`（与当前 generator 渲染结果逐字节一致，测试内断言）。

---

## 六、边界与未覆盖

- **Windows 原生 `powershell.exe` 5.1** 仍只做「PS5.1 兼容语法 AST + Linux 便携 pwsh 7.4.6
  行为测试」，未在真实 Windows 上执行；新增 PS 代码刻意只用 PS5.1 已有语法。
- **预发布 caret 放宽**（见 §2.4）是有意取舍：旧插件 + 较新宿主可能被放过；需要更严格时
  可在 README/后续版本收紧，但会误拒 `0.22.1 → 0.2.1-rc.x` 这类实际兼容组合。
- 适配性校验只用**宿主核心 `@deepseek-ai/dsh` 的版本**去比对各 `@deepseek-ai/dsh-*`
  peer 范围，依赖「所有 dsh-* 与核心同号段」这一已核实事实；若将来某个库独立版本号，
  需改为按各包实际版本校验（当前宿主 manifest 的 dependencies 里有精确版本，可后续增强）。
- 校验器对无法解析的 peer 范围降级为 `unknown`（警告继续），不会误判为不匹配。
- 本任务只改 `lib/scripts.mjs` + `test/installer/**`；`ARCHITECTURE.md` / 根 `README.md`
  由 Lead 维护，未改动。
