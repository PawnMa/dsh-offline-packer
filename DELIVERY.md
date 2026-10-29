# 交付说明：dsh-offline-packer 0.1.7

> 一个 DSH web 插件：把当前宿主已装的插件变成可直接拷到离线电脑的安装包，并支持按历史 DSH 适配版本打包。
> 已验证宿主：`@deepseek-ai/dsh` **0.2.1-rc.2**；历史目标宿主已验证：`0.1.0-rc.7`。

## 交付物

| 路径 | 说明 |
|---|---|
| `dsh-offline-packer-0.1.7.tgz` | 可安装插件包（约 90 KB，纯 JS 无运行时依赖；sha256 `313a51f2…1e02b82f0`） |
| `index.js` / `client.js` / `lib/*.mjs` | 插件源码（服务端路由 / 浏览器设置页 / 打包引擎） |
| `README.md` | 用户文档：安装、使用、已知限制 |
| `ARCHITECTURE.md` | 架构与模块接口契约 |
| `screenshots/` | 实机截图（插件列表 / 实际数据 / 打包进度 / 打包结果 / 版本矩阵 / 输出目录） |
| `verify/report.md` | 独立验证员报告：8 项 + 2 项补充验证全 PASS（含命令与输出） |
| `verify/report-delta.md` | 交付后小改动（HTTP 状态码映射）的复验记录 |

## 已安装到当前宿主

已通过官方通道装入用户当前 profile：

```bash
cp dsh-offline-packer-0.1.7.tgz ~/.dsh/packages/
DSH_HOME=~/.dsh dsh plugin --profile web add ~/.dsh/packages/dsh-offline-packer-0.1.7.tgz
```

- profile：`~/.dsh/profiles/web`（dependencies 13 项 / bundles 16 项，含 `dsh-offline-packer`）
- 插件目录：`~/.dsh/profiles/web/node_modules/dsh-offline-packer`
- **必须重启 dsh web 进程**后插件才加载（当前运行中的 GUI 仍是旧进程，看不到新页面）。
- 卸载：`DSH_HOME=~/.dsh dsh plugin --profile web remove dsh-offline-packer`

重启后：打开任意页面 → 左下 Settings（或 More → Settings）→ 左侧「离线打包 / Offline Packager」。

## 三个能力对应实现

1. **图形化显示当前插件**：Settings 内独立页面（**只显示非官方/第三方插件**，官方内置插件默认隐藏并标注数量），扫描 `$DSH_HOME/profiles/<profile>`（含 `/home/fc/.dsh` 等其它 home 的只读扫描），显示名称、版本、类型（bundle/plugin/installation）、启用状态、DSH peer 兼容范围、客户端/服务端、体积、来源、warnings；支持搜索、刷新、切换 home/profile。
2. **一键生成离线安装版本（带进度与结果）**：每行「打包离线版」→ 任务面板显示**阶段+百分比进度条与耗时**，完成后显示**打包结果**（zip 名称、大小、插件版本、目标 DSH、目录、zip 路径、下载按钮）；**可指定输出目录**（默认 `$DSH_HOME/offline-packages/`，页面里填任意可写绝对路径，记忆在浏览器本地）。服务端分析插件服务端运行时 import、内嵌宿主不提供的依赖 → 生成自包含 zip（`package/` + `install-offline.sh`/`.ps1` + 中文 README + `VERSIONS.txt` + `CHECKSUMS.txt`），产物写 `$DSH_HOME/offline-packages/`，页面可下载；目标机解压后零联网安装、重启即生效。
3. **支持历史适配版本打包（目标驱动）**：插件版本与 DSH 版本不是一对一（每个插件版本声明一个 DSH 兼容范围，可覆盖多个 DSH 版本）。先选「目标 DSH 版本」（= 离线电脑上的 dsh 版本），版本列表自动筛出声明兼容的插件版本并选中最新兼容版；可切换「显示全部版本（含不兼容）」，并展示所选插件版本声明的兼容 DSH 版本（点选可反填目标）。确定后下载 tarball、npm 安装运行时依赖、重打包为离线包（需打包机联网 + npm）。已验证：`dsh-better-sidebar@0.13.1` → DSH `0.1.0-rc.7`，产物装进纯 rc.7 宿主后 boot manifest 含插件、`/sidebar/api/terminal.deps` 返回 `ok:true`。

## 验证摘要（详见 verify/report.md）

- 宿主加载：boot 日志干净、`/dsh-offline-packer/api/state` 200、`dshVersion=0.2.1-rc.2`。
- UI：Playwright 实机操作（Settings → 离线打包 → 切扫描源 → 刷新 → 一键打包 → 任务轮询 → 下载），15 项断言、零 console/page error。
- 产物可用性：dsh-unlag（102 KB）与 dsh-better-sidebar 0.28.1（5.28 MB）离线包均通过 unzip/校验和/manifest/安装脚本检查；并在 **`unshare -rn` 真断网**环境装进全新 home 启动、卸载、再启动。
- 历史版本：矩阵 36 个版本；`0.13.1` peer 含 `^0.1.0-rc.7`；产物 46.9 MB（完整依赖树），rc.7 宿主启动 + API 验证通过。
- 安全：伪造 Origin → 403；`../` 穿越下载 → 400；错误路径结构化 `{ok:false,error:{code,message}}`。

## 已知限制

- 历史版本通道按契约内嵌该版本**完整声明依赖树**，产物较大（如 47 MB）；本地通道按实际 import 裁剪，产物小。
- 历史版本打包需要联网 + PATH 上有 `npm`；生成的离线包安装时完全不需要网络。
- 原生依赖（如 `node-pty`）不内嵌，由目标宿主依赖闭包提供；跨平台请在同一平台打包。
- 只读扫描其它 DSH_HOME；产物只写当前进程的 `$DSH_HOME/offline-packages/`。
- 页面只打包非官方插件（`@deepseek-ai/*` 等官方内置插件被过滤；HTTP 接口传 `includeOfficial=1` 可查看，`includeOfficial:true` 可强制打包）。
- PowerShell 安装脚本为 5.1 兼容语法，本轮未在真实 Windows 上执行（建议 Windows 用户冒烟一次）。
- 支持魔改/非标准 DSH：页面可手动指定宿主安装目录/版本；生成的安装器不依赖 `dsh` 命令（`--profile-dir` / `DSH_PROFILE_DIR` / `--dsh-install` / `--node`），内嵌安装脚本兼容旧 Node（Node 8.17 实测可用），DSH 宿主本身仍建议较新 Node。
- 「高级打包选项」可按需多内嵌：宿主运行时依赖 / 插件全部声明依赖 / 额外指定包；结果面板列出实际内嵌清单（体积与单例风险自负）。
