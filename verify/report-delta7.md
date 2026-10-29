# 复验报告（delta7）：v0.1.6 提示/警告文案 + 版本号 —— a) PASS / b) PASS / c) **部分 FAIL（1 个英文 i18n 缺陷，非阻塞）** / d) PASS

- 验证员：`qa-verifier`（独立 fresh context）
- 日期：2026-10-29 15:06-15:14（Asia/Shanghai）
- 产物：`/home/fc/dsh-offline-packer/dsh-offline-packer-0.1.6.tgz`，sha256 `5c8b1824c55d615bdd5a8479eea1269c340ef89e96dc97ae8d6922124d8fdef9`（与 Lead 给定一致）；tgz 内 `client.js` 与工作树均 `4a813348…ab49`
- 用户 profile：installed=**0.1.6**、dep=`file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.6.tgz`、deps=13 / bundles=16
- **结论：功能与回归 PASS；发现 1 个非阻塞 UI i18n 缺陷（英文界面下历史版本提示行为空），已写入 `verify/suggested-fixes.md`（DEF-1）并报告 Lead。未改任何产品文件。**

## 0. 改动范围核对（与 Lead 描述一致）

用 v0.1.5 安装副本（`verify/home-delta6/.../dsh-offline-packer`）对比 v0.1.6 tgz：

```text
--- full tree diff (0.1.5 installed vs 0.1.6 tgz):
Files <0.1.5>/README.md and <0.1.6>/README.md differ
Files <0.1.5>/client.js and <0.1.6>/client.js differ
Files <0.1.5>/lib/local.mjs and <0.1.6>/lib/local.mjs differ
Files <0.1.5>/package.json and <0.1.6>/package.json differ

--- logic files byte compare:
SAME  index.js
SAME  lib/scripts.mjs
SAME  lib/host.mjs
SAME  lib/vendor.mjs
SAME  lib/pack.mjs
DIFF  lib/local.mjs
SAME  lib/jobs.mjs / analyze / inventory / zip / tar / registry / historical
```

`lib/local.mjs` 的 diff **只新增了 no-op warning 块**（未改任何既有逻辑/返回结构）：

```diff
@@ -313,6 +313,30 @@
     warnings.push(...vendorResult.warnings)
+    if (packages.length === 0) {
+      const noDeps =
+        '该插件的服务端没有静态/动态 import 任何外部包（只有 client bundle 或纯 node: 内建），' +
+        '因此「内嵌宿主运行时依赖 / 全部声明依赖 / 额外内嵌包」都不会改变产物内容。'
+      warnings.push(noDeps); log(`提示：${noDeps}`)
+    } else {
+      if (embed.includeHostProvided && hostEmbedded === 0) { … "本次产物没有因此多内嵌任何包" … }
+      if (embed.includeAllDeclared && declaredNames.length === 0) { … "没有声明 dependencies/optionalDependencies，产物不会因此变化" … }
+    }
```

→ 除文档/版本号/客户端提示与 `lib/local.mjs` 的新增 warning 外无逻辑变化；Node8 安装器全量未重跑（`lib/scripts.mjs` SHA 相同）。

---

## 1. a) 全新 home 安装 + boot + 用户 profile —— PASS

```text
$ dsh plugin --profile web add dsh-offline-packer-0.1.6.tgz
Done in 905ms, installed: 0.1.6
$ bash verify/setup-host.sh --no-plugin --port 3084 --home …/verify/home-delta7
boot log: dsh web: http://127.0.0.1:3084/?token=<redacted>
$ grep -niE 'warning|entry apply failed|duplicate prefix route|FAILED|Cannot resolve|ERR_MODULE|uncaught' verify/logs/host-3084.log
(no warning/failure lines)
/api/state: ok=true host.dshVersion=0.2.1-rc.2 plugins=1 -> STATE_CHECK=PASS

# 用户 profile（只读）
installed: 0.1.6
dep: file:/home/fc/.dsh/packages/dsh-offline-packer-0.1.6.tgz
deps: 13  bundles: 16
packages/ 仅 dsh-offline-packer-0.1.6.tgz（sha256 与项目根一致）
版本清单 diff vs v0.1.5：仅 -dsh-offline-packer@0.1.5 +dsh-offline-packer@0.1.6（其余 328 包不变，count=329）
dump-config: exit 0、1408 行，1406 行起含 offline-packer；执行前后 profile package.json sha 不变（a29e0c7c…）
```

---

## 2. b) API：no-op warning + sidebar 回归 —— PASS

### b1) `dsh-unlag` + `embed.includeHostProvided=true`（no-op 场景）

```text
POST … {pluginName:"dsh-unlag", embed:{includeHostProvided:true}} -> HTTP 200, job done
progress={"phase":"完成","percent":100}
zip: dsh-unlag-offline-1.12.3-dsh-0.2.1-rc.2.zip  size: 110,193 B
vendored: []
warnings[0]: 已启用「内嵌宿主运行时依赖」…（既有风险提示）
warnings[1]: 该插件的服务端没有静态/动态 import 任何外部包（只有 client bundle 或纯 node: 内建），
            因此「内嵌宿主运行时依赖 / 全部声明依赖 / 额外内嵌包」都不会改变产物内容。
ASSERT no-op warning: true
ASSERT vendored empty: true
validate-zip: sha256sum -c 15/15 OK；RESULT=PASS checks=22
```

（实测 110,193 B，Lead 自测 110,192 B，差 1 字节属 zip 元数据/压缩差异，可忽略。）

### b2) `dsh-better-sidebar` + `embed.includeHostProvided=true`（回归）

```text
POST … -> job done；zip size 8,079,487 B（Lead 8,079,488，差 1 字节）；vendored 23
@deepseek-ai/* 版本集合 = 0.2.1-rc.2（17 个）+ 1.0.6（cordis-plugin-loader）+ 1.8.6（cosmokit）
@deepseek-ai/schemastery@3.18.5 存在
warnings 5 条（风险提示 + zod 冲突说明），无 host-pinned 残留
```

→ 与 v0.1.5 行为一致。

---

## 3. c) UI —— 15/16 PASS；**1 FAIL = DEF-1（英文 i18n 缺失）**

脚本 `verify/delta7-ui.mjs`（en-US，1600×1000）：

```text
PASS  page loaded
PASS  plugin list loaded :: rows=14
PASS  advanced scope note present (always rendered)
      text: Applies to "Build offline package" (the local channel) only; version history already
            embeds that version's full declared dependency tree and ignores these options.
PASS  scope note says local-only / history ignores options
PASS  embed host checkbox present
PASS  local no-op warnings visible            # job panel 文本含新增 no-op 提示
PASS  warnings explain no external imports :: 该插件的服务端没有静态/动态 import 任何外部包…
PASS  embed-not-applicable NOT shown for local job
PASS  registry matrix loaded for dsh-unlag :: rows=40
PASS  registry package button present
PASS  registry job panel shows embed-not-applicable      # element 存在
FAIL  hint explains history ignores advanced options     # 英文界面下该元素文本为空（DEF-1）
PASS  registry job settled :: status=done
PASS  no page errors
PASS  no console errors
DELTA7_UI=FAIL assertions=16 failed=1
```

**DEF-1 详情**（写入 `verify/suggested-fixes.md`）：

```text
$ grep -n 'embedNotApplicable' client.js
147: embedNotApplicable: '历史版本通道：…'   # 仅中文 COPY 块
964: COPY.embedNotApplicable;                 # 英文 COPY 块缺少该 key

# 英文 locale 实测：
{
 "hintExists": true, "hintTextContent": "", "hintInnerText": "",
 "hintOuter": "<div data-testid=\"offline-packer-embed-not-applicable\" style=\"font-size: 11.5px; opacity: 0.75;\"></div>"
}
```

→ 功能/打包不受影响；中文界面正常；英文界面这一行是空白。建议在 client.js 英文 COPY 块补一行
`embedNotApplicable: 'Version history already embeds the full dependency tree … do not apply to this channel.'`。
截图证据：`verify/artifacts/delta7/06-registry-not-applicable.png`（英文界面提示行为空）。

截图清单（`verify/artifacts/delta7/`）：`01-landing.png`、`02-packer-scanned.png`、
`03-advanced-scope.png`（高级面板底部常显 scope 文案）、`04-local-noop-warnings.png`
（no-op 打包 job 面板可见两条 warning：风险提示 + 没有静态/动态 import 说明）、
`05-history-panel.png`、`06-registry-not-applicable.png`（**提示行空白 = DEF-1 证据**）、`07-registry-job-done.png`。

> 工具说明：首次 UI 运行因 `innerText` 在元素刚挂载时读到空串（测试脚本时序问题，非产品缺陷），
> 改用 `textContent` + 轮询后，warnings 断言稳定 PASS；唯一持久 FAIL 是上述真实 i18n 缺陷。

---

## 4. d) 回归抽查 —— PASS

- 逻辑文件：`lib/scripts.mjs` / `lib/host.mjs` / `lib/vendor.mjs` / `lib/pack.mjs` 与 0.1.5 **逐字节一致**；`index.js` 也一致；仅 `lib/local.mjs` 增加 warning 块（见 §0）。
- 本地打包/进度/输出目录：b1 使用自定义 `outputRoot`（`verify/tmp/delta7-unlag-host`），job 进度 12→完成/100、result.dir/zipPath 均在自定义目录、下载/validate 通过（§2）。
- `/home/fc/.dsh` 零写入：验证前后 585 行指纹快照 **仅快照标签行不同**；顶层 15:05 之后仅 Lead 安装产生的 `packages/`；`offline-packages/` 无新条目。
- 端口 3084-3086 已释放（BIND OK）；3080 用户 GUI 未触碰（HTTP 401）。

---

## 5. 最终判断

**v0.1.6 功能与回归 PASS；1 个非阻塞缺陷（DEF-1：英文界面 `offline-packer-embed-not-applicable` 文案缺失、该行空白）**，修复方式为一行英文 COPY 文案（`verify/suggested-fixes.md`）。

- a) PASS：全新 home boot 干净、state 200；profile 0.1.6、packages/ 仅 0.1.6、dump-config 含 offline-packer、其它 328 包未变。
- b) PASS：unlag+includeHostProvided 产生「没有静态/动态 import」no-op 说明且 vendored=[]；sidebar+includeHostProvided 仍 23 vendored / @deepseek-ai/* 全 0.2.1-rc.2 / 无 host-pinned。
- c) 15/16 PASS：advanced scope 文案存在；本地 no-op warnings 可见；registry 提示元素存在但**英文文本为空**（DEF-1）；0 console/page error。
- d) PASS：scripts/host/vendor/pack 与 0.1.5 逐字节一致（local.mjs 仅加 warning）；本地打包/进度/输出目录正常；用户 home 零写入。
