# 复验报告（delta7-fix）：v0.1.7 —— DEF-1（英文 `embedNotApplicable` 文案缺失）修复复验

- 验证员：`qa-verifier`（独立 fresh context）
- 日期：2026-10-29 15:14-15:19（Asia/Shanghai）
- 产物：`/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.7.tgz`，sha256 `313a51f2cc0e708187c7c0fe823c4b3f4e45a8cb1c765d18ae75e0c1e02b82f0`（与 Lead 给定一致）
- 结论：**a/b/c/d 全部 PASS —— DEF-1 已修复；中英文界面提示均正常；可交付。**

## 0. 改动范围核对（仅 client.js 一行文案 + 版本号）

```text
$ sha256sum dsh-offline-packer-0.1.7.tgz
313a51f2cc0e708187c7c0fe823c4b3f4e45a8cb1c765d18ae75e0c1e02b82f0   # == Lead 给定
$ tar -xzOf dsh-offline-packer-0.1.7.tgz package/client.js | sha256sum
b20082ca84a6a03b6126364de2327d21ac1df8657acb39b306cbd7859c2a2946
$ sha256sum client.js
b20082ca84a6a03b6126364de2327d21ac1df8657acb39b306cbd7859c2a2946    # tgz == 工作树

# 与 v0.1.6 安装副本对比：仅 client.js 与 package.json 变化
Files <0.1.6>/client.js and <0.1.7>/client.js differ
Files <0.1.6>/package.json and <0.1.7>/package.json differ
# index.js 与 lib/*.mjs 全部逐字节相同（无 DIFF 行）

# 英文 COPY 块已有 embedNotApplicable（tgz 与工作树一致）：
147: embedNotApplicable: '历史版本通道：已内嵌该版本声明的完整依赖树（含前端库），高级打包选项不适用于此通道。'
288: embedNotApplicable: 'Version history already embeds that version\'s full declared dependency tree (including browser libraries); advanced packaging options do not apply to this channel.'
```

→ a) **PASS**：tgz 内含英文 `embedNotApplicable`，且 client.js 与工作树一致；逻辑文件未变。

## 1. b) 全新 home 装 0.1.7 → boot 无 warning、state 200 —— PASS

```text
$ dsh plugin --profile web add dsh-offline-packer-0.1.7.tgz   -> Done in 667ms, installed: 0.1.7
$ bash verify/setup-host.sh --no-plugin --port 3084 --home …/verify/home-delta8
boot log: dsh web: http://127.0.0.1:3084/?token=<redacted>
$ grep -niE 'warning|entry apply failed|duplicate prefix route|FAILED|Cannot resolve|ERR_MODULE|uncaught' verify/logs/host-3084.log
(no warning/failure lines)
$ bash verify/probe-api.sh --port 3084 state
ok=true host.dshVersion=0.2.1-rc.2 plugins=1 -> STATE_CHECK=PASS
```

## 2. c) UI：英文 locale 提示非空且文案一致 + 中文 locale 正常 —— PASS

使用现成脚本 `verify/delta7-ui.mjs`（新增 `--navigator-lang` 以隔离插件语言与宿主 UI 语言）。

### 2.1 英文 locale（headless Chromium，navigator.language=en-US，默认）

```text
PASS  advanced scope note present (always rendered)
PASS  scope note says local-only / history ignores options
PASS  local no-op warnings visible            # job panel 含「没有静态/动态 import」说明
PASS  warnings explain no external imports
PASS  embed-not-applicable NOT shown for local job
PASS  registry job panel shows embed-not-applicable
      text: Version history already embeds that version's full declared dependency tree
            (including browser libraries); advanced packaging options do not apply to this channel.
PASS  hint explains history ignores advanced options
PASS  registry job settled / no page errors / no console errors
DELTA7_UI=PASS assertions=16 failed=0
```

→ `offline-packer-embed-not-applicable` 文本**非空**，且与 client.js 英文文案一致。截图：
`verify/artifacts/delta7-fix/06-registry-not-applicable.png`（对比 delta7 报告里同一位置为空白）。

### 2.2 中文 locale（强制 navigator.language=zh-CN，宿主 UI 随之中文）

```text
PASS  plugin list loaded :: rows=14
PASS  advanced scope note present :: 仅影响「打包离线版」（本地通道）；「历史版本」通道（下载并打包）本身已内嵌该版本声明的完整依赖树，不使用这些选项。
PASS  registry job panel shows embed-not-applicable :: 历史版本通道：已内嵌该版本声明的完整依赖树（含前端库），高级打包选项不适用于此通道。
PASS  hint explains history ignores advanced options
PASS  local no-op warnings visible / no console/page errors
DELTA7_UI=PASS assertions=16 failed=0
```

→ 中文界面仍正常（与原 zh 文案一致）。截图：`verify/artifacts/delta7-fix-zh/06-registry-not-applicable.png`。

（脚本适配说明：为验证中文 locale，`delta7-ui.mjs` 增加了 `--navigator-lang` 与中文弹窗/菜单识别；两次运行均 16/16 PASS。此前一轮 EN run 曾因测试脚本 `count()` 读取时序误报 1 项，已修正为等待文本后取 count——非产品问题。）

## 3. d) 用户 profile / 真实 home —— PASS

```text
installed: 0.1.7
dep: file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.7.tgz
deps: 13  bundles: 16
packages/ 仅 dsh-offline-packer-0.1.7.tgz（sha256 313a51f2… 与项目根一致）
版本清单 diff vs v0.1.6：仅 -dsh-offline-packer@0.1.6 +dsh-offline-packer@0.1.7（其余 328 包未变，count=329）

# /home/fc/.dsh 指纹 before vs after（本次验证窗口 07:14:51Z → 07:18:59Z）：
diff 仅快照标签行不同（package.json hash/mtime、node_modules 顶层、329 包版本清单完全一致）
→ 本次验证对真实 home 零写入
顶层 15:14 之后新条目：packages/（Lead 安装）与 pet.json（3080 GUI 运行期写入），非本次验证
```

## 4. 最终判断

**v0.1.7 可交付：DEF-1 已修复且中英文均验证通过。**

| 项 | 结果 |
|---|---|
| a) tgz 含英文 embedNotApplicable 且与工作树一致 | PASS |
| b) 全新 home 装 0.1.7 → boot 无 warning、state 200 | PASS |
| c) 英文 locale 提示非空且与英文文案一致；中文 locale 正常；0 console/page error | PASS（EN 16/16、ZH 16/16） |
| d) profile 0.1.7、其它 328 包未变、/home/fc/.dsh 零写入 | PASS |

证据：
- 脚本与 JSON：`verify/delta7-ui.mjs`、`verify/artifacts/delta7-fix/ui-en.json`、`verify/artifacts/delta7-fix-zh/ui-zh.json`
- 截图：`verify/artifacts/delta7-fix/*.png`（EN）、`verify/artifacts/delta7-fix-zh/*.png`（ZH）
- 指纹：`verify/run/user-home-delta7fix-{before,after}.txt`、`user-home-delta7fix.diff`
- 宿主日志：`verify/logs/host-3084.log`
- 端口 3084-3086 已释放；3080 用户 GUI 未触碰（HTTP 401）。
