# 独立验证报告（delta6 / task-11）：dsh-offline-packer v0.1.5 —— 旧 Node/魔改 DSH 安装、host 探测与手动覆盖、按需多内嵌、回归

- 验证员：`qa-verifier`（独立 fresh context；全部结论为本次亲手复现）
- 日期：2026-10-29 14:44-14:53（Asia/Shanghai）
- 产物：`/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.5.tgz`，sha256 `ad4b7cf83f3860d4462007bc96fee4fa9dfb3f4d1d6e1e523300f50b7dda19eb`（与 Lead 给定一致）；tgz 内 client.js 与工作树均 `005c2dfa…6876`
- 用户 profile：installed=**0.1.5**、dep=`file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.5.tgz`、deps=13 / bundles=16
- 结论：**全部 PASS**（1 a-e、2 a-c、3 三选项、4 回归、5 UI）。未发现需修复缺陷，未生成 `verify/suggested-fixes.md`，未改任何 A/B/C/Lead 文件。

## 0. 安全约束执行情况（重点）

本会话 shell 自带 `DSH_HOME=/home/fc/.dsh`、`DSH_PROFILE_DIR=/home/fc/.dsh/profiles/web`。遵守 Lead 要求：

- **所有 installer 测试**均在 `env -u DSH_HOME -u DSH_PROFILE_DIR`（外加 `-u DSH_INSTALL_DIR`/`-u NODE_BIN` 按需）下运行，目标全部是 `verify/tmp/delta6-installer/**` 下的全新沙盒 home/profile；**没有任何一次安装/卸载指向真实 profile**。
- 验证前/后对 `/home/fc/.dsh` 做只读指纹快照（`verify/run/user-home-delta6-{before,after-verify}.txt`，585 行：profile package.json hash/mtime、node_modules 顶层、329 个包版本清单）：
  ```text
  $ diff -u verify/run/user-home-delta6-before.txt verify/run/user-home-delta6-after-verify.txt
  -# snapshot 'delta6-before' 2026-10-29T06:45:21Z
  +# snapshot 'delta6-after-verify' 2026-10-29T06:51:18Z
    ## profile package.json
    be339424…  /home/fc/.dsh/profiles/web/package.json   (mtime=14:44:25, size=1184)
  # 除快照标签行外完全相同 → 本次验证对真实 profile 零写入
  ```
- 3080 用户 GUI：`HTTP 401`（未触碰）；3095（Lead 的）：`Connection refused`（未触碰）；验证端口 3084–3086 已全部释放（BIND OK）。
- 所有打包/安装产物均在 `verify/**` 下。

---

## 1. 旧 Node / 无 dsh 命令 / 魔改 DSH 安装器 —— PASS（a-e 全部）

测试包：用 v0.1.5 本地通道打包 `dsh-unlag`（默认 embed）→ `dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip`（109,810 B / 16 文件），解压到 `verify/tmp/delta6-installer/dsh-unlag-offline-…/`（含 `install-offline.sh` / `.ps1` / package / README / CHECKSUMS）。

Node 8.17 获取：

```text
$ npx -y node@8.17.0 -p "process.execPath"
/home/fc/.npm/_npx/853ea35bc6b17ca6/node_modules/node/bin/node     # v8.17.0
```

### a) Node 8.17 安装 —— PASS

```bash
env -u DSH_HOME -u DSH_PROFILE_DIR NODE_BIN=<node8.17> \
  bash install-offline.sh --dsh-home …/homes/a --profile web
```

```text
[信息] Node           : /home/fc/.npm/_npx/…/node/bin/node（v8.17.0）
[信息] 检测到较旧的 Node（v8.17.0）：本安装器兼容 Node 4+/8.x（内嵌 JS 为 ES5），安装不受影响。
[安装] 已初始化 profile，新建文件：package.json,cordis.patch.yml,pnpm-workspace.yaml
[安装] 已安装：…/homes/a/profiles/web/node_modules/dsh-unlag
[安装] 已追加 "dsh-unlag" 到 dsh.profile.bundles
[安装] 安装完成：dsh-unlag 1.12.3（目标 DSH 0.2.1-rc.2）
exit=0
bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-unlag"]
plugin dir exists: true
```

→ ES5 内嵌 JSON helper 在 Node 8.17 下真实跑通（profile 初始化/写 bundles 均由 Node 8 执行）。

### b) 假 `dsh` shim + 无真实 dsh 来源 —— PASS（info 级）

```bash
printf '#!/bin/sh\nexit 1\n' > fakebin/dsh        # 假 dsh，永远失败
env -u DSH_HOME -u DSH_PROFILE_DIR -u DSH_INSTALL_DIR \
    HOME=<隔离 home> PATH="fakebin:/usr/bin:/bin" NODE_BIN=<node8> \
    bash install-offline.sh --dsh-home …/homes/b --profile web
```

```text
[信息] 检测到 dsh 命令，但没找到标准 @deepseek-ai/dsh 安装目录（可能是魔改版本）。
[信息]   本安装不依赖 dsh 命令，跳过宿主版本校验（可用 --dsh-install 指定）。
[安装] 安装完成：dsh-unlag 1.12.3（目标 DSH 0.2.1-rc.2）
exit=0；bundles 含 dsh-unlag；plugin dir=true
$ grep -c '未安装 dsh 环境' log   -> 0
$ grep '\[警告\]' log             -> (none)
```

→ 输出为 **info 级**，无「未安装 dsh 环境」字样、无警告级输出，安装成功。

### c) `--profile-dir` / `DSH_PROFILE_DIR` / `--node` —— PASS

```text
# c1 --profile-dir（直接装到指定 profile 目录）
[信息] 定位来源 : --profile-dir
[安装] 已安装：…/homes/c1/node_modules/dsh-unlag
bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-unlag"] | plugin: true

# c2 DSH_PROFILE_DIR 环境变量
env -u DSH_HOME DSH_PROFILE_DIR=…/homes/c2 NODE_BIN=<node8> bash install-offline.sh
[信息] 定位来源 : DSH_PROFILE_DIR
bundles: [... "dsh-unlag"] | plugin: true

# c3 --node <wrapper>（PATH 中没有 node，也不给 NODE_BIN）
[信息] Node : …/node-wrapper（v8.17.0）
wrapper marker: YES
WRAPPER_USED args=-e process.exit(0)
WRAPPER_USED args=--version
[安装] 已安装：…/homes/c3/profiles/web/node_modules/dsh-unlag
```

（c1/c2 出现的 `[警告] 本分发包按 DSH 0.2.1-rc.2 适配，当前宿主是 0.1.0-rc.7` 是因为本机 PATH 上的 `dsh` 指向 host-pinned rc.7；安装器按设计做了版本校验告警，安装照常成功——非缺陷。）

### d) `--uninstall` 干净 + PowerShell —— PASS

```text
# d1 --dsh-home 卸载
[信息] 当前 bundles：["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]
[安装] 已删除插件目录：…/homes/a/profiles/web/node_modules/dsh-unlag
bundles: [base, web-app] | plugin dir: false

# d2 --profile-dir 卸载
[信息] 当前 bundles：["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]
[安装] 已删除插件目录：…/homes/c1/node_modules/dsh-unlag
bundles: [base, web-app] | plugin dir: false

# d3 PowerShell（便携 pwsh 7.4.6）
$ pwsh -NoProfile -File install-offline.ps1 -DshHome …/homes/ps -Profile web -DryRun
… [安装] [dry-run] 初始化 profile / 复制 package / 追加 bundles
[安装] 安装完成：dsh-unlag 1.12.3（目标 DSH 0.2.1-rc.2）
pwsh_exit=0；dry-run 后 homes/ps 文件数 = 0

# d4 AST 语法解析
AST_PARSE_OK tokens=2821
```

### e) 显式 `--dsh-home` 优先于 env `DSH_PROFILE_DIR` —— PASS

```text
env -u DSH_HOME DSH_PROFILE_DIR=…/homes/envp NODE_BIN=<node8> \
  bash install-offline.sh --dsh-home …/homes/e --profile web
[信息] 定位来源 : --dsh-home + --profile
[警告] 环境变量 DSH_PROFILE_DIR=…/envp 与本次安装目标 …/e/profiles/web 不同，已按显式参数/规则使用 …/e/profiles/web；如非预期请 unset DSH_PROFILE_DIR。
[安装] 已安装：…/homes/e/profiles/web/node_modules/dsh-unlag
envp 下文件数 = 0（未被写入）
```

---

## 2. host 探测 + 手动覆盖 —— PASS

### a) API 手动覆盖（`/api/state?dshInstallDir=&dshVersion=`）

```text
# 无覆盖（自动探测）
{"source":"argv","overridden":{"installDir":false,"version":false},
 "dshVersion":"0.2.1-rc.2","dshInstallDir":"/home/fc/.local/lib/node_modules/@deepseek-ai/dsh"}

# 两个都覆盖
GET /api/state?dshInstallDir=%2Fhome%2Ffc%2F.local%2Flib%2Fnode_modules%2F%40deepseek-ai%2Fdsh&dshVersion=9.9.9-override-test
{"source":"override","overridden":{"installDir":true,"version":true},
 "dshVersion":"9.9.9-override-test","dshInstallDir":"…/@deepseek-ai/dsh","nodeVersion":"v24.14.0"}
assert source===override: true
assert version overridden: true

# 只覆盖 version
source: argv  overridden: {"installDir":false,"version":true}  version: 8.8.8-only-version
```

### b) profile-fallback 探测（构造 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` 符号链接）

```text
$ ln -s /home/fc/.local/lib/node_modules/@deepseek-ai/dsh \
        verify/tmp/delta6-fb/profiles/node_modules/@deepseek-ai/dsh
# 无 argv 线索（探针脚本不在 dsh 目录）、PATH 无 dsh、无 DSH_INSTALL_DIR：
$ env -u DSH_INSTALL_DIR HOME=<隔离> DSH_HOME=…/delta6-fb PATH=/nonexistent \
      <node> verify/tmp/host-fallback-probe.mjs
 "dshHome": "…/verify/tmp/delta6-fb",
 "dshInstallDir": "/home/fc/.local/lib/node_modules/@deepseek-ai/dsh",
 "dshVersion": "0.2.1-rc.2",
 "source": "profile-fallback",
ASSERT source: profile-fallback
ASSERT hostProvided count: 545
# 对照（同 home 无符号链接）：source: path（回退到 PATH 探测）
```

### c) UI 手动覆盖（Playwright，含持久化）—— 见 §5 截图/断言

```text
PASS  host source becomes override :: sourceText=Host source: override sourceData=override
PASS  host version display shows override value :: versionText=9.9.9-ui-override
PASS  override persists across reload :: source=override version=9.9.9-ui-override
PASS  clearing override restores auto detection :: {"sourceText":"Host source: argv","sourceData":"argv","versionText":"0.2.1-rc.2"}
```

截图：`06-host-override-form.png`、`07-host-override-applied.png`、`08-host-override-persisted.png`、`09-host-override-cleared.png`。

---

## 3. 按需多内嵌 —— PASS（三选项 + UI + 产物校验）

### a) `embed.includeHostProvided=true`（dsh-better-sidebar）

```text
POST /api/package-local {pluginName:"dsh-better-sidebar", home:"/home/fc/.dsh",
  outputRoot:…/delta6-embed-host, embed:{includeHostProvided:true}}
POLL_CHECK=PASS status=done  progress={"phase":"完成","percent":100}
zip: dsh-better-sidebar-offline-0.28.1-dsh-0.2.1-rc.2.zip  size: 8,079,489 B  mode: local
vendored count: 23
@deepseek-ai/* 全部 0.2.1-rc.2（17 个）+ schemastery 3.18.5 + @standard-schema/spec 1.1.0
+ ws 8.22.0 + yaml 2.9.1 + zod 4.4.3 + js-yaml 4.3.2 + argparse 2.0.1
+ @deepseek-ai/cordis-plugin-loader 1.0.6 / @deepseek-ai/cosmokit 1.8.6（本就非 rc 版本）
warnings[0]: 已启用「内嵌宿主运行时依赖」…宿主包优先从当前 DSH 安装目录解析
            （/home/fc/.local/lib/node_modules/@deepseek-ai/dsh），确保内嵌版本与宿主一致…
warnings[1..3]: 依赖 zod 版本冲突说明；warnings[4]: 产物内嵌了宿主命名空间/peer 包（17 个）风险提示
# 无 host-pinned 残留告警（grep host-pinned -> 0）
package/package.json: dependencies == {}
validate-zip: unzip -t 1827 entries OK；sha256sum -c 1826/1826 OK；RESULT=PASS checks=22
```

→ 与 Lead 自测一致（23 vendored、@deepseek-ai/* 全 0.2.1-rc.2、schemastery 3.18.5、无 host-pinned 残留、warnings 有风险提示）。

### b) `embed.extraPackages=['ws','nonexistent-package-xyz']`（dsh-unlag）

```text
POST … embed:{extraPackages:["ws","nonexistent-package-xyz"]} -> job done 203ms
zip: 155,053 B / 35 文件 / 1 个内嵌依赖；vendored: ["ws@8.22.0"]
warnings: ["无法从插件位置解析依赖 nonexistent-package-xyz（…/dsh-unlag），已跳过；离线安装后可能缺模块"]
validate-zip: sha256sum -c 34/34 OK；RESULT=PASS checks=22
```

→ 可解析的 ws 被内嵌、不存在的包记 warning 且 **job 仍 done**。

### c) `embed.includeAllDeclared=true`（dsh-better-sidebar）

```text
POST … embed:{includeAllDeclared:true} -> job done 20,870 ms
zip: 47,342,008 B / 12,567 文件 / 120 个内嵌依赖（默认包 5,276,916 B / 482 文件 → 明显变大 ~9×）
vendored 抽查: @codemirror/autocomplete 6.20.3、@codemirror/lang-javascript 6.2.5、…、mermaid、d3、dompurify
package/node_modules 下 @codemirror/* / mermaid / d3 / dompurify 实测存在
validate-zip: unzip -t 12,567 entries OK；sha256sum -c 12,566/12,566 OK；RESULT=PASS checks=22
```

### d) UI：高级选项 + extraPackages=yaml + 结果 vendored 展示 —— 见 §5

```text
PASS  advanced options expand :: open=1
PASS  embed option controls present :: host=1 declared=1 extra=1
PASS  advanced summary reflects extra package :: summary=Enabled: +1 extra package
PASS  result vendored panel shows yaml@2.9.1 :: vendored=1 dependency embedded: yaml@2.9.1
PASS  result text contains custom output dir / download href carries outputRoot
```

### e) 默认（无 embed）行为不变

§4a 的默认 `dsh-unlag` 打包结果：`vendored: []`、109,811 B / 16 文件 / 15 条校验和（与 v0.1.4 行为一致，仅安装脚本随版本略增）。所有产物均通过 `validate-zip`（结构/manifest dependencies {} / peers optional / CHECKSUMS / `bash -n` / 成员安全）。

---

## 4. 回归 —— PASS

### a) 官方通道装最新 tgz → 全新 home → boot

```text
dsh plugin --profile web add dsh-offline-packer-0.1.5.tgz -> Done in 825ms, installed: 0.1.5
boot log: dsh web: http://127.0.0.1:3084/?token=<redacted>
grep warning/entry apply failed/duplicate prefix route/FAILED/ERR_MODULE -> (none)
/api/state: ok=true host.dshVersion=0.2.1-rc.2 plugins=1 -> STATE_CHECK=PASS
```

### b) local 打包 + 进度 + 自定义输出目录

```text
POST package-local dsh-unlag outputRoot=…/delta6-local -> HTTP 200
progress: 读取插件清单 12 → 完成/100（单调）；startedAt/finishedAt 齐全（189ms）
result: dir/zipPath 均在 …/delta6-local；size 109,811 B
download（带 outputRoot）-> HTTP 200；validate-zip RESULT=PASS checks=22（checksums 15/15）
```

### c) 历史版本 0.13.1 → 0.1.0-rc.7（重新打包 + host-pinned 启动）

```text
POST package-registry dsh-better-sidebar 0.13.1 0.1.0-rc.7 -> done
zip: 46,947,159 B / 12,864 文件 / 157 内嵌依赖 / 12,863 校验和
validate-zip: unzip -t 12,864 entries OK；sha256sum -c 12,863/12,863 OK；RESULT=PASS checks=22
安装（env -u DSH_HOME -u DSH_PROFILE_DIR）→ INSTALL_RESULT=PASS（12,859 文件，0.13.1）
host-pinned rc.7 启动（3086）证据：
  PASS startup log no hard failures
  PASS GET / 200；manifest contains dsh-better-sidebar: YES
  GET client bundle /plugins/dsh-better-sidebar/client.js -> 200（458,844 B）
  PASS dump-config mentions dsh-better-sidebar
  PROBE POST /sidebar/api/terminal.deps -> 200 {"ok":true,"value":{"ok":true}}  PASS
EVIDENCE_RESULT=PASS
```

### d) 用户 profile / 真实 home 指纹

```text
installed: 0.1.5；dep: file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.5.tgz；deps=13；bundles=16
版本清单 diff vs 上一版快照（v0.1.4）：仅 -dsh-offline-packer@0.1.4 +dsh-offline-packer@0.1.5
（其余 328 个包版本未变，count=329）
packages/ 仅 dsh-offline-packer-0.1.5.tgz，sha256 与项目根一致
dump-config: exit 0、1408 行，1406 行起含 offline-packer；执行前后 profile package.json sha 均为 be339424…
/home/fc/.dsh 指纹 before vs after-verify：除快照标签行外完全一致（本次验证零写入）
cordis.yml 内容 sha 仍 c300dcf2…（dump-config 只刷新 mtime，宿主 compose 行为）
顶层 .dsh 在 14:44 之后的新条目仅为 Lead 安装产生的 packages/ 与 3080 GUI 运行期写入（pet.json、storages），非本次验证
```

---

## 5. UI 回归（Playwright）—— PASS（18 项断言，0 console/page error）

脚本 `verify/v15-ui.mjs`（新增）：打开页面→Settings→Offline Packager→扫 home=/home/fc/.dsh→高级选项→UI 打包→host override 应用/持久化/清除。

```text
PASS  page loaded
PASS  plugin list loaded :: rows=14
PASS  advanced block present
PASS  advanced options expand :: open=1
PASS  embed option controls present :: host=1 declared=1 extra=1
PASS  advanced summary reflects extra package :: summary=Enabled: +1 extra package
PASS  plugin card found for packaging :: dsh-unlag
PASS  embed packaging job done :: status=done progress=["12","100"]
PASS  result vendored panel shows yaml@2.9.1 :: vendored=1 dependency embedded: yaml@2.9.1
PASS  result text contains custom output dir :: dir=…/verify/tmp/delta6-ui-out
PASS  download href carries outputRoot :: …&outputRoot=%2Fhome%2Ffc%2F…%2Fdelta6-ui-out
PASS  host override inputs present
PASS  host source becomes override :: sourceText=Host source: override
PASS  host version display shows override value :: versionText=9.9.9-ui-override
PASS  override persists across reload :: source=override version=9.9.9-ui-override
PASS  clearing override restores auto detection :: {"sourceData":"argv","versionText":"0.2.1-rc.2"}
PASS  no page errors
PASS  no console errors
V15_UI=PASS assertions=18 failed=0
```

截图（`verify/artifacts/delta6/`，实拍）：`01-landing.png`、`02-settings.png`、`03-packer-scanned.png`（14 第三方插件 + 官方隐藏提示）、`04-advanced-options.png`（高级选项展开、extra=yaml、summary "Enabled: +1 extra package"）、`05-embed-result.png` + `05-embed-job-panel.png`（结果面板 `1 dependency embedded: yaml@2.9.1`、自定义目录、下载链接）、`06/07/08/09` host override 表单/已应用/刷新后持久化/清除后恢复。

---

## 6. 观察与遗留风险（均非阻塞、无 FAIL）

| # | 观察 | 说明/建议 |
|---|---|---|
| R1 | `includeHostProvided` 的 warnings 含 3 条 zod 版本冲突（含两条同为 4.4.3 的重复说明） | 设计内信息（选宿主安装目录版本、忽略其它副本）；可考虑对同版本重复项去噪，纯文案优化 |
| R2 | `includeAllDeclared` 的 sidebar 产物 47.3MB / 12,567 文件 | 设计内（完整声明依赖树）；已验证可用、校验通过。体积大是预期 |
| R3 | 旧 Node 包的 `--profile-dir`/`DSH_PROFILE_DIR` 测试会打印“目标 DSH 0.2.1-rc.2 vs 当前宿主 0.1.0-rc.7”的版本不匹配警告 | 本机 PATH 上 `dsh` 指向 host-pinned rc.7；安装器按设计告警、安装成功。非缺陷 |
| R4 | `--dsh-install` 未能在“假 dsh shim + 无标准安装”场景自动定位 | 安装器明确 info 提示可用 `--dsh-install` 指定，属设计降级路径 |
| R5 | `/home/fc/.dsh/offline-packages/` 存在 12:04-13:30 的外部产物（session-manager / rewind-plugin / pet） | 3080 用户 GUI 上使用本插件的操作产物，**早于本次验证窗口**；本次所有产物均在 `verify/**` |
| R6 | 安装器旧 Node 场景只验证到 Node 8.17（task 要求下限） | Node 4/6 未实测（本机无对应二进制）；ES5 静态实现 + 8.17 实跑已覆盖主要风险 |

## 7. 证据文件索引

- 本报告：`verify/report-delta6.md`；新增脚本：`verify/v15-ui.mjs`（+ `verify/probe-api.sh` 增加 `--embed-host/--embed-declared/--embed-extra`）
- 安装器测试日志：`verify/artifacts/delta6/installer-{a-node8,b-fakedsh,c1-profiledir,c2-envprofiledir,c3-node-opt,d1-uninstall-home,d2-uninstall-profiledir,d3-ps-dryrun,e-precedence}.log`、`node-wrapper.log`
- 安装器沙盒：`verify/tmp/delta6-installer/{pkg, homes/{a,b,c1,c2,c3,e,envp,ps}}`（全部在 verify 下）
- host 探测：`verify/artifacts/delta6/host-fallback-probe.txt`；`verify/tmp/delta6-fb/…`
- embed 产物：`verify/tmp/delta6-embed-{host,extra,all}/`、`verify/artifacts/delta6/embed-{host,extra,all}-job.txt`
- 回归：`verify/logs/host-3084.log`、`host-3086.log`、`verify/artifacts/evidence-3086-*.{manifest,dump-config,client.js,probe-*}`、`verify/artifacts/delta6/{history-job.txt,progress-local.log}`
- UI：`verify/artifacts/delta6/{01..09}*.png`、`ui-v15.json`
- 用户 home 指纹：`verify/run/user-home-delta6-{before,after-verify}.txt`、`user-home-delta6.diff`
- 用户 profile 只读证据：`verify/artifacts/delta6/dump-config-user-home.txt`

## 8. 最终判断

**v0.1.5 可交付（全部 PASS）。**

- 旧 Node 8.17 可安装/卸载；无 dsh 命令（假 shim）时安装成功且仅 info 级提示，无「未安装 dsh 环境」；`--profile-dir` / `DSH_PROFILE_DIR` / `--node` / `--dsh-home` 优先级与 env 不一致告警全部符合契约；ps1 `-DryRun` 与 AST 通过。
- host 探测：API override（source=override、版本/目录覆盖、部分覆盖）正确；profile-fallback（构造 symlink、PATH 无 dsh、无 argv 线索）成功；UI 手动覆盖应用/刷新后持久化/清除恢复自动探测，全部通过。
- 按需多内嵌三选项 API/UI 行为、vendored 展示、warning、产物校验全部符合预期；默认行为不变。
- 回归与安全：新 tgz 全新 home boot 干净、local 打包/进度/自定义输出目录正常、history 0.13.1→rc.7 打包并在 host-pinned rc.7 启动（terminal.deps ok）；用户 profile 0.1.5 且其它 328 包未变；**本次验证对 `/home/fc/.dsh` 零写入**（指纹前后一致），3080/3095 未触碰，端口已释放。
