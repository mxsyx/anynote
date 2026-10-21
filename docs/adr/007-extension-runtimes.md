# ADR-007 · 扩展信任等级与公共 SDK

状态：已采纳（当前实现追认）。核对：2026-10-21，源码基线 `e975c1c`。

[返回 ADR 索引](README.md)

## 背景

首方进程需要 Node 能力，第三方代码则必须受权限与预算约束；独立进程本身不构成权限沙箱。

## 决定

受信首方扩展通过独立进程、Notebook 会话授权及 SDK broker 隔离故障；只有内置清单可选择该等级。第三方支持声明式贡献和 Worker 内的 QuickJS/WASM 正文转换，不能执行任意 Node/React 模块。

QuickJS 只获得授权快照及声明的搜索/固定 HTTPS 桥接，设内存、时间、消息与并发预算；提交重查授权、版本和清单。SDK 绑定 Notebook，写入带版本条件与幂等 ID，停用清理命令和 disposer。独立 tarball 的目标是只包含公开契约，源码 workspace 还含 Node/QuickJS 执行器及校验；G17 将存储权限门面移入 Storage，见 [ADR-011](011-extension-module-boundaries.md)。

## 取舍与边界

不把受信 Node 工厂视为恶意插件沙箱。签名验证、设备信任与 Notebook 授权分别执行；自动检查更新不会自动安装。G18 发现的 SDK 云盘模块漏打包已在 G17 修复并通过独立离线消费；当前执行证据见 [G17](../todo/17-module-boundaries.md)，真实发行矩阵仍由 G05/T009 验收。

## 证据与验证

[首方宿主](../../packages/extension-host/src/index.ts)、[权限门面](../../packages/storage-sqlite/src/extension-host.ts)、[脚本调度](../../packages/plugin-sdk/src/script-runner.ts)、[QuickJS guest](../../packages/plugin-sdk/src/script-worker.ts)、[SDK 打包](../../scripts/build-sdk.mjs)。

[SDK 合约测试](../../tests/sdk.test.mjs)、[脚本测试](../../tests/script-runtime.test.mjs)；[SDK 文档](../../packages/plugin-sdk/README.md)、[扩展宿主](../EXTENSION-HOST.md)、[G18 核对报告](../G18-documentation-review.md)。

本轮执行结果统一见 [G18 核对报告](../G18-documentation-review.md)；测试入口和历史报告不等于本轮已执行或真实发布验收。
