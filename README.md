# dsh-offline-packer

DSH web 插件：把**当前宿主已安装的插件**变成可拷到离线电脑的安装包，一页设置面板完成。

- **图形化插件清单**：设置 → 「离线打包」里列出当前 DSH_HOME/profile 已装插件（版本、类型、启用状态、DSH 兼容范围、体积、客户端/服务端位置），支持切换 DSH_HOME/profile 与搜索。
- **打包进度与结果**：任务面板带阶段/百分比进度条与耗时，完成后显示 zip 名称、大小、目录、下载链接。
- **可指定输出目录**：默认 `$DSH_HOME/offline-packages/`，页面里可改成任意可写绝对路径（记在浏览器本地）。
- **一键生成离线安装包**：为任意已装插件生成零联网 zip —— 插件文件 + 内嵌服务端依赖 + `install-offline.sh`/`.ps1` + 中文 README + `CHECKSUMS.txt`，产物默认在 `$DSH_HOME/offline-packages/`，页面可直接下载。
- **历史适配版本打包（目标驱动）**：插件版本与 DSH 版本不是一对一 —— 每个插件版本声明一个 DSH **兼容范围**（peerDependencies，可覆盖多个 DSH 版本）。所以先选**目标 DSH 版本**（= 离线电脑上的 dsh 版本），版本列表会自动筛出声明兼容它的插件版本并选中最新兼容版；可一键「显示全部版本」查看不兼容项，页面也展示所选插件版本声明的兼容 DSH 版本（点选可反填目标）。例如给 `dsh 0.1.0-rc.7` 打包时自动选中 `dsh-better-sidebar@0.13.1`（其声明范围 `^0.1.0-rc.7` 覆盖 rc.7/rc.8）。

## 安装（装到 DSH 0.2.x 宿主）

```bash
dsh plugin --profile web add /path/to/dsh-offline-packer-0.1.0.tgz
# 或开发态：bash test/install-dev-plugin.sh ~/.dsh web
```

装完**重启 dsh web**，打开任一页面 → 左下 Settings → 左侧导航「离线打包」。

## 使用

1. 打开设置 → 离线打包；默认扫描当前进程的 `DSH_HOME/profile`，可在顶部改成别的 home（只读扫描）。
2. 选中插件 → **打包离线版**：按当前宿主版本生成离线包；完成后显示 zip 路径与下载按钮。
3. 需要旧版本宿主时 → **历史版本…**：选择目标 DSH 版本与插件版本 → **下载并打包**（联网）。
4. 把 zip 拷到离线机器，解压后 `bash install-offline.sh`（Windows 用 `install-offline.ps1`），重启 dsh 即生效。

## 生成的离线包长什么样

```
dsh-<plugin>-offline-<version>-dsh-<targetDshVersion>/
  package/                       # 插件本体（服务端/客户端 bundle，服务端依赖已内嵌 node_modules）
  install-offline.sh / .ps1      # 零联网、幂等、支持 --dsh-home/--profile/--uninstall/--dry-run
  README.md                      # 目标 DSH 版本、安装/卸载/验证/排障
  VERSIONS.txt                   # 内嵌依赖的版本与来源
  CHECKSUMS.txt                  # sha256 清单
```

服务端依赖只内嵌「宿主不提供、且插件运行时会 import」的包；`@deepseek-ai/*`、react 等宿主包留空由目标宿主提供，`node-pty` 这类平台相关原生包由宿主闭包提供（缺失时插件按自身设计降级）。

## 开发

- 纯 JS，无构建：`index.js`（服务端路由）、`client.js`（浏览器 settings.section 页面）、`lib/*.mjs`（引擎）。
- 接口契约与模块分工见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
- 测试宿主：`bash test/install-dev-plugin.sh /tmp/dsh-pack-test web` 后 `DSH_HOME=/tmp/dsh-pack-test dsh --profile web --port 3081`。

## 限制

- 历史版本打包需要打包机**联网**且 PATH 上有 `npm`（用于下载并安装该历史版本的运行时依赖）；生成的离线包本身安装时不需要网络。
- 原生依赖（如 `node-pty`）不内嵌：离线目标机需要宿主自带；跨平台（Linux↔Windows/macOS）打包时请在同一平台打包。
- 只读扫描别的 DSH_HOME 时不会写入该目录；产物只写当前进程的 `$DSH_HOME/offline-packages/`。

## 按需多内嵌（高级打包选项）

打包页「高级打包选项」可勾选/填写要额外内嵌的依赖（默认只内嵌服务端真正 import、且宿主不提供的包）：

| 选项 | 作用 |
|---|---|
| 内嵌宿主运行时依赖 | 连宿主会提供的 `ws` / `schemastery` / `node-pty` / `@deepseek-ai/*` 也一起内嵌；目标机宿主缺包时用，体积变大，可能让宿主服务出现两份实例 |
| 内嵌全部声明依赖 | 把插件 `package.json` 的 `dependencies`/`optionalDependencies` 全部内嵌（完整依赖树） |
| 额外内嵌包 | 逗号/空格分隔的额外包名（本地按已装版本内嵌，不支持 `name@version`） |

> 这些选项**只影响「打包离线版」（本地通道）**；「历史版本」通道（下载并打包）本来就内嵌该版本声明的完整依赖树，勾选与否产物一致。
> 若插件服务端没有任何外部 import、或分析到的依赖都不是宿主提供的，勾选第一项不会改变产物——结果 `warnings` 会明确提示「本次没有因此多内嵌任何包」。

结果面板会列出实际内嵌的包（`name@version`）。

## 魔改 / 非标准 DSH（没有 dsh 命令）

- 插件页「当前宿主」里可展开「手动指定宿主（魔改/非标准 DSH）」，填写 DSH 安装目录（含 `@deepseek-ai/dsh/package.json` 的目录）和/或 DSH 版本；留空自动探测。探测顺序：`DSH_INSTALL_DIR` → 启动脚本所在安装 → `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh`（heal fallback）→ PATH 上的 `dsh` → 常见全局目录。
- 生成的离线安装器**不依赖 `dsh` 命令**：可用 `--profile-dir <目录>` / `DSH_PROFILE_DIR` 直接指定 profile，`--dsh-install <目录>` 提供宿主安装目录做版本校验，`--node <path>` 指定 Node 可执行文件。
- 安装器内嵌帮助脚本兼容旧 Node（ES5；Node 8.17 实测可用），不会因系统 `node` 较旧而崩溃；DSH 宿主本身仍建议使用较新 Node。

## 已知限制与说明

- **两种打包通道的语义不同**：
  - *本地通道*（一键打包已装插件）：按**当前运行宿主**解析依赖——只内嵌「宿主不提供、且插件服务端会 import」的包，产物小、与当前宿主版本绑定。
  - *历史版本通道*（registry）：按 npm 上该版本声明的**完整运行时依赖树**内嵌（安全超集），因此产物可能较大（例如 `dsh-better-sidebar@0.13.1` → DSH `0.1.0-rc.7` 约 47 MB）；需要打包机联网且 PATH 上有 `npm`。
- 原生依赖（如 `node-pty`）不内嵌：由目标宿主的依赖闭包提供（缺失时插件自身降级）。跨平台（Linux↔Windows/macOS）请在同一平台打包。
- 生成的离线包安装时**完全不需要网络**；但装完必须重启 dsh web 进程。
- 扫描其它 `DSH_HOME` 是只读的；产物只写当前进程的 `$DSH_HOME/offline-packages/`。
- `home` 参数传相对路径时会被解析为绝对路径（相对进程工作目录）；建议始终传绝对路径。
- 本插件要求宿主 `@deepseek-ai/dsh >= 0.2.0-rc.1`（在 0.2.1-rc.2 上开发与验证）。
- 卸载：`dsh plugin --profile web remove dsh-offline-packer`。

## 只显示非官方插件

打包页只展示**非官方（第三方）插件**：DSH 官方内置插件（`@deepseek-ai/*` 或由 dsh 安装目录提供的 bundle）默认隐藏，并在列表上方标注「已隐藏 N 个官方内置插件」。
- 接口层同样默认过滤；`GET /api/state?includeOfficial=1` 可查看全部（诊断用）。
- 本地打包官方内置插件会被拒绝（错误码 `OFFICIAL_PLUGIN`），离线包面向第三方插件；如确需打包可在 HTTP 请求体传 `includeOfficial:true`。
