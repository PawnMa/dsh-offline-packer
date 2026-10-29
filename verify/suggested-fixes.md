# suggested-fixes（delta7 / v0.1.6 复验发现，验证员未改任何产品文件）

## DEF-1（中低，UI 文案 i18n 缺失，非阻塞）：`offline-packer-embed-not-applicable` 在英文界面为空白

**现象**：英文语言环境（`navigator.language=en*`）下，历史版本（registry）job 面板里
`data-testid="offline-packer-embed-not-applicable"` 的 div 存在但**没有任何文字**，用户看不到
「历史版本通道不使用高级打包选项」的提示。

**证据**：

```text
# 1) 代码里该 key 只加进了中文 COPY 块，英文 COPY 块缺失：
$ grep -n 'embedNotApplicable' client.js
147:          embedNotApplicable: '历史版本通道：已内嵌该版本声明的完整依赖树（含前端库），高级打包选项不适用于此通道。',
964:              COPY.embedNotApplicable,
# 英文 COPY 块（client.js ~L280-310）有 advancedScopeNote，但没有 embedNotApplicable

# 2) headless Chromium（locale=en-US）实测：div 存在、文本为空
{
 "hintExists": true,
 "hintTextContent": "",
 "hintInnerText": "",
 "hintOuter": "<div data-testid=\"offline-packer-embed-not-applicable\" style=\"font-size: 11.5px; opacity: 0.75;\"></div>",
 "jobCount": 1
}
```

**影响**：仅英文界面下该行提示不可见；中文界面正常（key 存在）。作业与打包功能不受影响。
`offline-packer-advanced-scope`（高级面板常显提示）英文文案存在且正常（已实测 PASS）。

**建议修复**（只改 `client.js` 英文 COPY 块，一行）：

```js
// 在英文 COPY 对象里（advancedScopeNote 附近）补上：
embedNotApplicable: 'Version history already embeds the full dependency tree that version declares (including frontend libraries); the advanced packaging options do not apply to this channel.',
```

修复后建议复跑：`node verify/delta7-ui.mjs --port <host> --scan-home /home/fc/.dsh`
（断言 `hint explains history ignores advanced options` 应由 FAIL 变 PASS）。

**复现命令（本报告验证环境）**：见 `verify/report-delta7.md` §3；截图
`verify/artifacts/delta7/06-registry-not-applicable.png`（英文界面提示行为空）。

## 附注（非缺陷，可选改进）

- v0.1.6 新增的服务端 no-op 提示（`lib/local.mjs` 里 `result.warnings` 的中文字符串）与既有
  `result.warnings` 一致，始终为中文（不随 UI locale 变化）；若未来要做完整 i18n，可考虑把这些
  warning 也做成 key + 前端映射，但这是既有设计，不属本次回归缺陷。
