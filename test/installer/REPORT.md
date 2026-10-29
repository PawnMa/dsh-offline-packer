# 离线安装器兼容性修复报告（task-8）

> 负责：installer-compat（「离线安装器兼容性」）
> 范围：`lib/scripts.mjs`（生成 `install-offline.sh` / `install-offline.ps1` / 包内 `README.md` 的模板）
> 测试产物：`test/installer/**`、`test/out-installer/**`（`test/out-*` 已在 `.gitignore` 中）
> 结论：**152 / 152 项断言通过**（第二轮安全加固后重跑），Node 8.17.0 + 魔改（假 dsh）+ `--profile-dir`
> 三种场景安装与卸载全部成功；显式 CLI 参数优先于环境变量（含事故回归用例）。

---

## 一、用户报障与根因

离线机器执行 `install-offline.sh` 时提示「未安装 dsh 环境（可能是非 dsh 命令，魔改版本）」，
且该机器 `node -v` 为 **8.17.0**。根因两条，都在 `lib/scripts.mjs` 生成的安装器模板里：

1. **内嵌 Node 帮助脚本用了新 API**（Node 8 直接抛错/退出，导致后续流程中断）：
   - `require('node:fs')` —— `node:` 前缀 Node 14.18+ 才支持；
   - `fs.mkdirSync(dir, { recursive: true })` —— Node 10.12+ 才有；
   - 还用了 `const` / 箭头回调 / 模板字符串等 ES6 写法（Node 8 能跑，但不符合「旧 Node 兼容」目标）。
2. **dsh 探测被当成硬前置**：探测不到标准 `@deepseek-ai/dsh` 就输出告警/误导性文案，而安装本身
   只需要「复制 `package/` + 追加 `dsh.profile.bundles`」，`--profile-dir` / `DSH_PROFILE_DIR` 这类
   直接指定 profile 的做法（`dsh-offline-bundle` 同款）在原安装器里不存在。

### 1.1 第二轮安全加固：显式 CLI 参数一律优先于环境变量

第一版按任务原始优先级把 `DSH_PROFILE_DIR` 放在 `--dsh-home` 之前。随后发生真实事故：在 DSH 会话里跑
测试时，环境自带 `DSH_PROFILE_DIR=/home/fc/.dsh/profiles/web`，覆盖了显式 `--dsh-home`，误写用户真实
profile（已恢复）。Lead 要求反转语义并加固，本报告内容已按新语义更新：

- **新优先级**：`--profile-dir` > `--dsh-home` + `--profile` > `DSH_PROFILE_DIR` >
  `$DSH_HOME` + profile > `~/.dsh/profiles/web`（bash 与 PowerShell 一致，`-ProfileDir`/`-DshHome` 同理）；
- **不一致警告**：当环境变量 `DSH_PROFILE_DIR` / `DSH_HOME` 推导出的目录与最终目标不同，打印
  `[警告] 环境变量 DSH_PROFILE_DIR=… 与本次安装目标 X 不同，已按显式参数/规则使用 X；如非预期请 unset DSH_PROFILE_DIR。`
  （`DSH_HOME` 同款措辞）；两者一致时（如无显式参数、直接用环境变量）不告警，避免噪音；
- **测试新增**：4d（env `DSH_PROFILE_DIR` + 显式 `--dsh-home` → 装进 `--dsh-home` 且告警、env 目录零写入）、
  4e（无任何显式参数 + env `DSH_PROFILE_DIR` → 装进该目录且不告警）、4f（env `DSH_HOME` + 显式
  `--profile-dir` → 用 `--profile-dir` 且告警）、PS 版同款（`-DshHome` 压过 env `DSH_PROFILE_DIR`）。

修复后：内嵌 JS 全部 ES5（Node 4+ 可跑），递归建目录交给 shell `mkdir -p`；node 可用
`--node`/`NODE_BIN` 指定；profile 可用 `--profile-dir`/`DSH_PROFILE_DIR` 直接指定；dsh 只作为
**可选**的宿主版本校验来源，探测不到降级为 `[信息]`，任何路径都不再出现「未安装 dsh 环境」。

---

## 二、改动清单（仅 `lib/scripts.mjs`，接口签名不变）

`renderInstallers()` / `renderReadme()` / `renderVersionsText()` 的入参、返回值与
`ARCHITECTURE.md` 的契约一致（`pack.mjs` 调用点零改动），因此**没有**需要同步的架构段落；
项目根 `ARCHITECTURE.md`/`README.md` 由 Lead 维护，本任务未改。

### 2.1 bash 安装器 `install-offline.sh`

| 项 | 改前 | 改后 |
|---|---|---|
| 内嵌 JS 模块系统 | `require('node:fs')` / `require('node:path')` | `require('fs')` / `require('path')` |
| 变量/函数 | `const`、箭头回调、模板字符串 | 全部 `var` / `function` / 字符串拼接 |
| 递归建目录 | `fs.mkdirSync(dir, { recursive: true })`（Node 10.12+） | shell `mkdir -p "$PROFILE_DIR"`，Node 只读写文件 |
| node 调用 | 硬编码 `node` | `"$NODE_BIN_RESOLVED"` |
| 其他 API | 无 | 不使用 `fs.promises` / `fs.rmSync` / `??` / `?.` / 对象展开 / `Array.from` |
| 输出编码 | 无要求 | heredoc `<<'NODE_X'` + `process.stdout.write`（无 BOM、无多余换行），`node -` 传参在 Node 8 实测可用 |

新增/变更的行为：

1. **node 可执行文件选择**：`--node <路径>` > `NODE_BIN` 环境变量 > `node` > `nodejs`
   （每个候选都会先用 `--version`/`-e` 试跑）；找不到时打印可操作错误并以 1 退出：
   ```
   [错误] 未找到可用的 Node（node / nodejs 都不在 PATH 上，或不可执行）。
   [错误]   本安装器只用 Node 读写 JSON（不联网、不装包，兼容 Node 4+/8.x）。
   [错误]   请安装 Node，或用 --node /path/to/node（或 NODE_BIN=/path/to/node）指定可执行文件。
   ```
   检测到 Node major < 10 时**只打印 info**（不阻断）：
   ```
   [信息] Node           : /path/to/node（v8.17.0）
   [信息] 检测到较旧的 Node（v8.17.0）：本安装器兼容 Node 4+/8.x（内嵌 JS 为 ES5），安装不受影响。
   [信息]   注意：DSH 宿主本身通常需要更新的 Node（>= 20），请确认 dsh 是用哪个 node 启动的。
   ```

2. **profile 目录定位**（`--profile-dir` / `DSH_PROFILE_DIR` 为新增）：
   `--profile-dir` > `--dsh-home` + `--profile` > `DSH_PROFILE_DIR` > `$DSH_HOME` + profile >
   `~/.dsh/profiles/web`（**显式 CLI 参数一律优先于环境变量**）；指定 profile 目录时**直接使用该目录**，
   不再拼接 DSH_HOME；相对路径会按当前目录转成绝对路径，尾部 `/` 会被去掉。安装摘要里新增「定位来源」一行便于排查。
   当环境变量 `DSH_PROFILE_DIR`/`DSH_HOME` 推导出的目录与最终目标不同，会打印醒目 `[警告]`：
   「环境变量 … 与本次安装目标 X 不同，已按显式参数/规则使用 X；如非预期请 unset …」。

3. **dsh 探测降级为 info**（新增 `--dsh-install` 参数；环境变量 `DSH_INSTALL_DIR` 保留）：
   探测顺序：`--dsh-install`/`DSH_INSTALL_DIR` → `<profile 的上一级>/node_modules/@deepseek-ai/dsh`
   与 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh`（`readlink -f` realpath，heal fallback，
   魔改宿主常用）→ PATH 上的 `dsh` 命令（向上 12 层找 `name: "@deepseek-ai/dsh"` 的 package.json）。
   - 找到：`[信息] 检测到宿主 : @deepseek-ai/dsh <版本>（<package.json>，来源：自动探测/--dsh-install…）`；
     版本不同仍然是 `[警告] 版本不匹配…（魔改宿主可忽略此提示）`，不阻断；
   - 只找到 dsh 命令但不是标准包：
     `[信息] 检测到 dsh 命令，但没找到标准 @deepseek-ai/dsh 安装目录（可能是魔改版本）。`
     `[信息]   本安装不依赖 dsh 命令，跳过宿主版本校验（可用 --dsh-install 指定）。`
   - 什么都没有：`[信息] 未检测到 dsh 命令行/安装目录；本安装不依赖 dsh 命令，跳过宿主版本校验…`
   - 显式 `--dsh-install` 指向非标准/不存在的目录：`[信息]` 后继续安装（不失败）。

4. **提示文案不再假设 dsh 命令存在**：重启提示改为「用你平时启动 dsh 的方式（例如 `dsh --profile web`）；
   非标准 / 魔改安装请运行它自己的启动脚本」，验证改为「打开页面 / 检查 profile 的 `node_modules`
   与 `dsh.profile.bundles`」；只有**确实探测到** dsh 安装目录时才额外给出 `--dump-config | grep` 的
   可选命令。卸载提示同样改为「重启 dsh 进程」。

### 2.2 PowerShell 安装器 `install-offline.ps1`

- 新增参数 `-ProfileDir`、`-Node`、`-DshInstall`；`$env:DSH_PROFILE_DIR` / `$env:NODE_BIN` /
  `$env:DSH_INSTALL_DIR` 同样生效；优先级与 bash 版一致（`-ProfileDir` > `-DshHome`+`-Profile` >
  `$env:DSH_PROFILE_DIR` > `$env:DSH_HOME`+Profile > `~/.dsh/profiles/<profile>`），环境变量不一致时
  同样打印 `[警告]`（用 `Get-ComparablePath` 忽略结尾分隔符差异）。
- 探测顺序/措辞与 bash 版一致（`profiles/node_modules` 回退目录 → PATH 上 `dsh` 命令 → info 降级）。
- PowerShell 版本就用 PowerShell 自身读写 JSON，**不依赖 node**；`-Node` 只用于版本信息提示：
  指定了但不存在才报错；检测到 major < 10 只打印 info；找不到 node 也仅 info（不阻断）。
- 仍为 PS5.1 兼容语法、UTF-8 BOM + CRLF（生成的产物实测 `efbbbf` + 全 CRLF）。

### 2.3 包内 `README.md` 模板（`renderReadme`）

- 快速开始新增置顶提示：魔改 / 无 `dsh` 命令 / 旧 Node 时用 `--profile-dir`、`NODE_BIN`、`--node`。
- 版本信息表新增 `dsh 命令（可选）` 行；Node 行注明「安装器本身兼容 Node 4+/8.x」。
- 第四节「安装原理」重写 profile 定位优先级，并新增子节
  **「特殊场景：魔改 DSH / 非标准安装 / 没有 dsh 命令 / 旧 Node」**：四个场景 ×（表现、你要做的）
  的表格 + bash/PowerShell 示例 + 「Node 8 上的具体表现」说明。
- 第五节验证改为**不依赖 dsh 命令优先**（页面 + profile 文件检查），`--dump-config` 明确标注为
  「只有有 dsh 命令时」的可选步骤。
- 第七节官方 CLI 通道注明仅适用于标准安装；第八节 FAQ 新增 3 条（未检测到 dsh 怎么办、Node 8 会怎样、
  魔改 profile 不在默认位置怎么办）；第九节新增「安装器兼容性」一条。

---

## 三、生成器与产物验证

### 3.1 源码与生成脚本

```bash
$ node --check lib/scripts.mjs && echo OK
OK

$ bash -n test/out-installer/.../install-offline.sh && echo 'bash -n OK'
bash -n OK

# 便携 pwsh 7.4.6 做 PS5.1 语法 AST 解析
$ /home/fc/dsh-plugin-build/staging/pwsh/pwsh -NoProfile -File test/installer/ps-ast-check.ps1 .../install-offline.ps1
AST OK: .../install-offline.ps1 (2573 tokens)
```

> 便携 pwsh 实际位于 `/home/fc/dsh-plugin-build/staging/pwsh/pwsh`（`dsh-offline-packer/staging/pwsh/pwsh`
> 不存在；测试脚本对两处都做了探测）。

### 3.2 内嵌 JS 的 ES5 兼容性（关键回归）

`test/installer/extract-embedded-js.mjs` 从生成的 `install-offline.sh` 里抽出 5 段 heredoc 帮助脚本，
逐个用 **Node 8.17.0** 做 `--check`，并扫描禁用构造：

```text
$ ls logs/embedded-js
NODE_ADD.js  NODE_INFO.js  NODE_INIT.js  NODE_REMOVE.js  NODE_VERSION.js

$ node@8.17.0 --check logs/embedded-js/NODE_ADD.js       # 全部 5 个均通过
node8 --check OK  NODE_ADD.js
node8 --check OK  NODE_INFO.js
node8 --check OK  NODE_INIT.js
node8 --check OK  NODE_REMOVE.js
node8 --check OK  NODE_VERSION.js

# 禁用构造扫描（只扫代码行，注释里提到的 API 名字不算）：
# require('node:、const/let、=>、??、?.、...、fs.promises、rmSync、recursive: true、
# Array.from、Object.fromEntries、async/await、模板字符串 —— 0 命中
PASS  内嵌 JS 无 node: 前缀 / const/let / 箭头函数 / 展开 / ?? / ?. / fs.promises / 模板字符串
```

### 3.3 真实离线包（`test/out-installer/`）

用本地打包引擎真实打包当前宿主里的 `dsh-unlag@1.12.3`（只读扫描 `/home/fc/.dsh`，输出写
`test/out-installer`）：

```bash
$ node --input-type=module -e "
    import { buildLocalPackage } from './lib/local.mjs'
    await buildLocalPackage({ pluginName: 'dsh-unlag', dshHome: '/home/fc/.dsh',
      profile: 'web', targetDshVersion: '0.2.1-rc.2' },
      { ctx: null, outputRoot: process.cwd() + '/test/out-installer', log() {} })"
```

```text
产物：test/out-installer/dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip
大小：109,931 B（16 个 zip 条目）
sha256：46285ea253f67e44c142962d3644d4c6a15015b64b6bca32385d989bbddc43f3
zip：unzip -t → No errors detected in compressed data
校验：解包目录内 sha256sum -c CHECKSUMS.txt → 全部 OK
manifest：dependencies: {}，peerDependenciesMeta 全部 optional
staging 里的 install-offline.sh / .ps1 与当前 generator 渲染结果 sha256 完全一致
```

---

## 四、测试矩阵（`bash test/installer/run-installer-tests.sh`）

测试脚本先真实解包 zip，再在 `test/out-installer/homes/` 下的**全新 home/profile** 上跑安装+卸载；
每个命令的完整输出在 `test/installer/logs/<name>.log`，整轮 PASS/FAIL 清单在
`test/installer/run-output.txt`。

| # | 场景 | 覆盖点 | 结果 |
|---|---|---|---|
| A | 正常 Node v24，`--dsh-home` 全新 home | 初始化 profile、复制、bundles 追加、幂等重装、`--uninstall`、重复卸载 | PASS |
| B | **`NODE_BIN=$(npx -y node@8.17.0 -p process.execPath)`**，全新 home | 用户报障场景：Node 8.17.0 安装 + `--node <node8>` 卸载 | PASS |
| C | `--profile-dir` + PATH 假 `dsh`（`#!/bin/sh; exit 1`）+ HOME 指向全新目录 | 魔改 / 无 dsh 来源：info 降级、装到自定义 profile 目录、幂等、卸载；`DSH_PROFILE_DIR` 环境变量；`--profile-dir` > `DSH_PROFILE_DIR` | PASS |
| C4/C5/C6 | 第二轮安全语义（事故回归） | 4d `env DSH_PROFILE_DIR=A` + 显式 `--dsh-home B` → **装进 B** 且打印不一致 `[警告]`、A 零写入；4e 无显式参数 + `DSH_PROFILE_DIR=A` → 装进 A 且不告警；4f `env DSH_HOME` + 显式 `--profile-dir` → 用显式目录并告警 | PASS |
| E/H/I | `--dsh-install` 指向 0.2.1-rc.2；heal fallback 符号链接（0.1.0-rc.7）；`--dsh-install` 指向非标准包 | 探测顺序与 info 降级 | PASS |
| J/K | PATH 上没有任何 node；`--node` 指向不存在路径 | 可操作错误、退出码 1、不写 profile | PASS |
| PS | 便携 pwsh：AST、BOM/CRLF、`-DryRun`、`-DshHome` 安装/卸载、`-ProfileDir`+假 dsh、`-Node` node8、`-DshInstall` 非标准包 | PowerShell 同步 | PASS |

全部 152 条断言：

```text
$ bash test/installer/run-installer-tests.sh; echo exit=$?
...
PASS  所有安装输出均无「未安装 dsh 环境」措辞
...
ALL TESTS PASSED
exit=0
```

### 4.1 Node 8.17.0 安装（场景 B）关键输出

```text
== 检查安装环境 ==
[信息] Node           : /home/fc/.npm/_npx/853ea35bc6b17ca6/node_modules/node/bin/node（v8.17.0）
[信息] 检测到较旧的 Node（v8.17.0）：本安装器兼容 Node 4+/8.x（内嵌 JS 为 ES5），安装不受影响。
[信息]   注意：DSH 宿主本身通常需要更新的 Node（>= 20），请确认 dsh 是用哪个 node 启动的。
[信息] DSH_HOME       : .../test/out-installer/homes/b-node8
[信息] profile        : web
[信息] profile 目录   : .../homes/b-node8/profiles/web
[信息]   定位来源     : --dsh-home + --profile
...
[安装] 已初始化 profile，新建文件：package.json,cordis.patch.yml,pnpm-workspace.yaml
[安装] 已安装：.../homes/b-node8/profiles/web/node_modules/dsh-unlag
[安装] 已追加 "dsh-unlag" 到 dsh.profile.bundles
[信息] 当前 bundles：["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-unlag"]
[安装] 安装完成：dsh-unlag 1.12.3（目标 DSH 0.2.1-rc.2）
```

随后用 `--node <node8>` 卸载：

```text
== 卸载 dsh-unlag ==
[安装] 已从 dsh.profile.bundles 移除 dsh-unlag
[安装] 已删除插件目录：.../homes/b-node8/profiles/web/node_modules/dsh-unlag
[信息] 下一步（必须）：重启 dsh 进程，插件即不再加载。
```

### 4.2 魔改 / 无 dsh 命令模拟（场景 C）

模拟条件：全新 `HOME`（没有 `~/.dsh`）、`PATH` 只含假 `dsh`（执行即 exit 1）+ 系统目录、
显式 `--node <node8>`、`--profile-dir .../c-custom/dsh-profile`（父目录故意不叫 `profiles`）：

```text
[信息] profile 目录   : .../homes/c-custom/dsh-profile
[信息]   定位来源     : --profile-dir
...
[信息] 检测到 dsh 命令，但没找到标准 @deepseek-ai/dsh 安装目录（可能是魔改版本）。
[信息]   本安装不依赖 dsh 命令，跳过宿主版本校验（可用 --dsh-install 指定）。
[安装] 已初始化 profile，新建文件：package.json,cordis.patch.yml,pnpm-workspace.yaml
[安装] 已安装：.../homes/c-custom/dsh-profile/node_modules/dsh-unlag
[安装] 已追加 "dsh-unlag" 到 dsh.profile.bundles
```

- 卸载：bundles 移除 + 目录删除，重复卸载幂等，全部 PASS；
- `DSH_PROFILE_DIR=...` 场景：`定位来源 : DSH_PROFILE_DIR`，装到该目录；
- 优先级：`DSH_PROFILE_DIR=ignored` + `--profile-dir=target` → 用 target，`ignored` 目录未被创建；
- **事故回归（第二轮）**：`env DSH_PROFILE_DIR=A` + 显式 `--dsh-home B` → 装进 B，A 零写入：

  ```text
  [信息] profile 目录   : .../c4-explicit-wins/explicit-home/profiles/web
  [信息]   定位来源     : --dsh-home + --profile
  [警告] 环境变量 DSH_PROFILE_DIR=.../c4-explicit-wins/env-profile 与本次安装目标 .../c4-explicit-wins/explicit-home/profiles/web 不同，已按显式参数/规则使用 .../c4-explicit-wins/explicit-home/profiles/web；如非预期请 unset DSH_PROFILE_DIR。
  [安装] 已安装：.../c4-explicit-wins/explicit-home/profiles/web/node_modules/dsh-unlag
  ```

  对照：4e 无任何显式 profile 参数 + `DSH_PROFILE_DIR=A` → 装进 A 且不发不一致警告；4f `env DSH_HOME` +
  显式 `--profile-dir` → 用显式目录并打印 `[警告] 环境变量 DSH_HOME=… 与本次安装目标 … 不同 …`。

### 4.3 dsh 探测降级 / 错误路径

```text
# --dsh-install 指向真实 0.2.1-rc.2
[信息] 检测到宿主   : @deepseek-ai/dsh 0.2.1-rc.2（.../npm/.../@deepseek-ai/dsh/package.json，来源：--dsh-install / DSH_INSTALL_DIR）

# heal fallback：$HOME_H/profiles/node_modules/@deepseek-ai/dsh -> host-pinned（realpath）
[信息] 检测到宿主   : @deepseek-ai/dsh 0.1.0-rc.7（.../host-pinned/node_modules/@deepseek-ai/dsh/package.json，来源：自动探测）

# PATH 上没有 node（最小化 PATH，只放 dirname）
[错误] 未找到可用的 Node（node / nodejs 都不在 PATH 上，或不可执行）。
[错误]   本安装器只用 Node 读写 JSON（不联网、不装包，兼容 Node 4+/8.x）。
[错误]   请安装 Node，或用 --node /path/to/node（或 NODE_BIN=/path/to/node）指定可执行文件。
exit=1（且未创建任何 profile 目录）

# 所有日志 grep「未安装 dsh 环境」→ 0 命中
PASS  所有安装输出均无「未安装 dsh 环境」措辞
```

### 4.4 PowerShell 版（Linux 便携 pwsh 7.4.6）

```text
AST OK: .../install-offline.ps1 (2573 tokens)
PASS  install-offline.ps1 带 UTF-8 BOM（efbbbf）
PASS  install-offline.ps1 全部为 CRLF 行尾
PASS  ps-dryrun / ps-install / ps-uninstall（全新 home，安装→bundles present→卸载→absent）
PASS  ps-profile-dir：-ProfileDir + 假 dsh + 全新 HOME
        [信息] 定位来源     : -ProfileDir
        [信息] 检测到 dsh 命令，但没找到标准 @deepseek-ai/dsh 安装目录（可能是魔改版本）。
PASS  ps-node8：-Node <node8>
        [信息] Node           : .../node（v8.17.0）
        [信息] 检测到较旧的 Node（v8.17.0）：PowerShell 版不需要 Node，安装不受影响；
PASS  ps-fake-install：-DshInstall 指向非标准包 → info 降级，不阻断
```

---

## 五、如何复跑

```bash
cd /home/fc/dsh-offline-packer

# 1) 重新生成真实离线包（只读扫描 /home/fc/.dsh，输出到 test/out-installer）
node --input-type=module -e "
  import { buildLocalPackage } from './lib/local.mjs'
  await buildLocalPackage(
    { pluginName: 'dsh-unlag', dshHome: '/home/fc/.dsh', profile: 'web', targetDshVersion: '0.2.1-rc.2' },
    { ctx: null, outputRoot: process.cwd() + '/test/out-installer', log: console.log })
"

# 2) 跑完整兼容性测试（会 npx 拉取 node@8.17.0、解包、装/卸到 test/out-installer/homes）
bash test/installer/run-installer-tests.sh
```

脚本会自清理 `test/installer/logs/`、`test/out-installer/{extract,homes,fakebin,nonode-bin}` 后重建；
逐条断言输出保存到 `test/installer/run-output.txt`，每个命令的原始输出在 `test/installer/logs/*.log`。

---

## 六、边界与未覆盖

- Windows 原生 `powershell.exe`（5.1）只做了「PS5.1 兼容语法 AST + Linux 便携 pwsh 行为测试」，
  未在真实 Windows 上执行；脚本新增代码刻意只用了 PS5.1 已有语法（无三元、无 `-not` 复合表达式陷阱）。
- `--dsh-install` 指定的目录若存在 `package.json` 但 `name` 不是 `@deepseek-ai/dsh`，按「魔改」处理
  （info 降级），不做版本校验。
- 安装器仍需要某种 Node（bash 版用它读写 JSON）；`--node`/`NODE_BIN` 已覆盖非 PATH 场景，
  完全没有 node 时给出可操作错误而不是静默失败。
- **给验证同学的重要提示**（第二轮后已安全）：本会话环境自带 `DSH_HOME=/home/fc/.dsh`、
  `DSH_PROFILE_DIR=/home/fc/.dsh/profiles/web`，但它们现在只是默认值——显式 `--dsh-home`/`--profile-dir`
  会压过环境变量，并打印「环境变量 … 与本次安装目标 … 不同」的 `[警告]`。因此在 DSH 会话里跑
  `test/a/verify-artifacts.sh` 这类 `--dsh-home "$FAKE_HOME"` 的验证不会再误写真实 profile；为完全消除
  噪音/避免非显式路径，仍建议加 `env -u DSH_HOME -u DSH_PROFILE_DIR`。
- 打包机 host 探测在本机解析到 0.1.0-rc.7（`profiles/node_modules` 回退链接），目标版本显式传
  0.2.1-rc.2，产物里已记录 warning；这与安装器改动无关（`lib/host.mjs` 不在本任务范围）。
