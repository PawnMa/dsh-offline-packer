---
name: dsh-offline-packaging
description: "用脚本把已安装的 DSH 插件打包成可拷到离线电脑的安装包（本地通道/历史版本通道、按需多内嵌、目标机安装与排障）。适用于\"给离线机器准备插件包、批量导出插件、没有 Web UI 时打包\"这类任务。"
---

# DSH 插件脚本离线打包

> 用 `dsh-offline-packer` 插件的**无头引擎**，在命令行把 DSH 插件打成「自包含 zip + 零联网安装脚本」，
> 拷到不能上网的机器安装。整个过程不依赖 Web UI，可放进脚本/CI 批量执行。

## 何时用 / 不用

- ✅ 要把当前机器已装的插件带到离线机器；
- ✅ 离线机器的 DSH 版本较老，需要装「与该 DSH 版本兼容的历史插件版本」；
- ✅ 批量导出、定时归档、无浏览器/无 GUI 的服务器；
- ✅ 目标机是魔改/非标准 DSH、甚至没有 `dsh` 命令（安装器的 `--profile-dir` 可直指 profile 目录）。
- ❌ 插件还没构建/没装好（打包的是安装目录里的构建产物，不负责 build）；
- ❌ 想跨 OS 打包原生依赖（如 node-pty）：应在与目标机同 OS/架构的机器上打包。

## 前置

1. 打包机已安装插件 `dsh-offline-packer`（设置页「离线打包」那个插件）；
   未安装时：`DSH_HOME=~/.dsh dsh plugin --profile web add /path/dsh-offline-packer-*.tgz`
2. Node ≥ 18（打包机）；目标机安装器支持旧 Node（8.17 实测可装）。
3. 历史版本通道需要打包机联网 + PATH 上有 `npm`；**生成的离线包安装时不需要网络**。

## 脚本位置

```
$DSH_HOME/skills/dsh-offline-packaging/scripts/offline-pack.mjs
```

下文用 `OP="node $DSH_HOME/skills/dsh-offline-packaging/scripts/offline-pack.mjs"` 简写。
脚本会自动在 `$DSH_HOME/profiles/*/node_modules/dsh-offline-packer` 找引擎；也可 `--packer-dir` 指定。

## 命令速查

```bash
# 0) 看宿主探测（脚本上下文常无法从 argv 识别 DSH，必要时显式指定）
node offline-pack.mjs host
node offline-pack.mjs host --dsh-install /opt/dsh/node_modules/@deepseek-ai/dsh --dsh-version 0.2.1-rc.2

# 1) 列出可打包的非官方插件（--all 含官方内置；--json 供脚本消费）
node offline-pack.mjs list
node offline-pack.mjs list --all --json

# 2) 本地通道：按当前宿主打包已装插件（默认输出 $DSH_HOME/offline-packages/）
node offline-pack.mjs local --plugin dsh-unlag
node offline-pack.mjs local --plugin dsh-better-sidebar --output /tmp/offline
node offline-pack.mjs local --plugin dsh-better-sidebar --target-dsh 0.2.1-rc.2 --dsh-install /opt/dsh/node_modules/@deepseek-ai/dsh

# 3) 按需多内嵌（体积换自包含；默认只内嵌服务端必需且宿主不提供的包）
node offline-pack.mjs local --plugin dsh-better-sidebar --embed-host        # 连宿主包一起带（体积变大、单例风险）
node offline-pack.mjs local --plugin dsh-better-sidebar --embed-declared    # 完整声明依赖树（可能几十 MB）
node offline-pack.mjs local --plugin some-plugin --extra ws,node-pty        # 点名额外包（本地已装版本）

# 4) 历史版本通道：给指定 DSH 版本打包兼容的插件版本（先查矩阵）
node offline-pack.mjs matrix --plugin dsh-better-sidebar
node offline-pack.mjs registry --plugin dsh-better-sidebar --version 0.13.1 --target-dsh 0.1.0-rc.7

# 5) 脚本消费：last line 是单个 JSON（错误走 stderr，退出码非 0）
node offline-pack.mjs local --plugin dsh-unlag --json --quiet | jq -r .zipPath
```

## 两个通道怎么选

| 场景 | 通道 | 说明 |
|---|---|---|
| 目标机 DSH 与打包机**同版本**（或同一套安装） | `local` | 按当前宿主解析依赖，产物小；可配 `--embed-*` 加料 |
| 目标机 DSH **版本不同/更老** | `registry` | 用矩阵挑「声明兼容目标 DSH 的插件版本」；产物内嵌该版本完整依赖树（可能几十 MB），**不内嵌宿主包**（`@deepseek-ai/*` 等由目标宿主提供） |
| 目标机 DSH 缺宿主包/被精简 | `local --embed-host`（同版本时） | 内嵌的是**打包机当前宿主**版本的包；目标 DSH 版本不同会串版本，不要用 |
| 目标机完全没有 node_modules | `--embed-declared` | 产物最大，但最自包含 |

**版本绑定关系**：插件版本 ↔ DSH 版本是「一对多」——每个插件版本用 peerDependencies 声明一个 DSH 兼容范围（如 `^0.1.0-rc.7` 覆盖 rc.7/rc.8）。所以先定目标 DSH 版本，再用 `matrix` 选择覆盖它的插件版本（通常取最新兼容版）。

## 产物与目标机安装

产物（默认 `$DSH_HOME/offline-packages/`）：

```
<plugin>-offline-<ver>-dsh-<target>/
  package/                   # 插件本体 + 需要时内嵌的 node_modules
  install-offline.sh / .ps1  # 零联网、幂等，支持 --profile-dir/--node/--dsh-install/--uninstall/--dry-run
  README.md  VERSIONS.txt  CHECKSUMS.txt
<plugin>-offline-<ver>-dsh-<target>.zip
```

目标机安装（不需要 `dsh` 命令）：

```bash
unzip <zip> && cd <解压目录>
bash install-offline.sh --profile-dir /目标机/DSH/profiles/web
# 指定 Node（目标机 PATH 上 node 太旧/缺失时）：
bash install-offline.sh --profile-dir ... --node /path/to/node
# 不知道 profile 目录时：--dsh-home <DSH_HOME> --profile web
# Windows：powershell -ExecutionPolicy Bypass -File .\install-offline.ps1 -ProfileDir <目录>
# 卸载：同上加 --uninstall
```

装完**重启 DSH 进程**；校验：`profiles/web/package.json` 的 `dsh.profile.bundles` 含插件名，
`profiles/web/node_modules/<插件>/package.json` 存在。

## 验证清单（打包后）

```bash
unzip -t <zip>                                   # 压缩包完整
cd <解压目录> && sha256sum -c CHECKSUMS.txt      # 校验和
bash -n install-offline.sh                       # 脚本语法
grep -o '"dependencies": *{[^}]*}' package/package.json   # 应为 {}
```

目标机启动后：boot manifest/页面能看到插件，或（有 dsh 命令时）`dsh --profile web --dump-config | grep <插件>`。

## 常见坑

1. **环境变量陷阱**：DSH 会话内 shell 自带 `DSH_HOME`/`DSH_PROFILE_DIR`；安装器优先级为
   `--profile-dir > --dsh-home+--profile > DSH_PROFILE_DIR > DSH_HOME`（显式参数优先，不一致会打警告）。
   自动化脚本建议始终用 `--profile-dir`。
2. **脚本里宿主探测可能不准**：打包脚本不是 DSH 进程，`host` 可能显示 `profile-fallback`
   （`$DSH_HOME/profiles/node_modules` 里的 heal 链接）。批量打包时显式传
   `--target-dsh <目标版本>` 和（需要宿主依赖时）`--dsh-install <DSH 安装目录>`。
3. **勾选内嵌却"没差异"**：`local` 通道对「服务端没有外部 import」的插件（如 dsh-unlag）无料可加；
   `registry` 通道本来就不使用这些选项。看结果里的 `warnings` 与 `vendored` 列表。
4. **历史版本包不含宿主包**：目标机 DSH 被精简时会缺 `@deepseek-ai/*`，此时该通道解决不了
   （内嵌当前宿主版本会串版本）；需目标机自带依赖，或在对应版本环境用 local 通道打包。
5. **原生依赖跨平台**：node-pty 等原生包按打包机平台构建；跨 OS 请在目标同平台机器上打包。
6. **内嵌宿主包的代价**：`--embed-host` 会让宿主服务出现两份实例的风险，仅在目标机缺包时用。

## 与 Web UI 的关系

设置页「离线打包」使用同一套引擎（本地/历史通道、进度、自定义输出目录、按需内嵌、宿主手动覆盖）。
本 skill 提供等价的脚本入口，适合自动化/无 GUI 场景；UI 里勾选的选项对应 `local` 的
`--embed-host` / `--embed-declared` / `--extra`。
