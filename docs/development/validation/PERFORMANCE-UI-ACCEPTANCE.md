# 性能与界面验收

> 状态归属：本文维护验收步骤和历史证据，剩余任务状态只在 [V014 性能](../TODO.md#v014)、[V012/V013 人工原生 UI](../TODO.md#v012) 维护；已完成视觉实现见 [历史证据](../history/todo-2026-10-24.md#g20)。旧格式报告不构成当前 schema v4/独立附件协议验收；维护规则见 [文档维护](../DOCUMENTATION.md)。

验收使用真实 Electron 生产页面、正式 Preload/IPC 和独立 SQLite 进程。每次创建临时工作区，结束后删除，不读取 `.env.cloud`，不修改日常 Notebook。当前任务状态见 [V014](../TODO.md#v014)，2026-10-21 实测见 [历史证据](../history/todo-2026-10-24.md#g19)。单次测量报告属于可删除的临时产物。

## 运行

```sh
# Node >= 24；包含生产构建、首屏体积预算、真实 Electron 性能验收
pnpm run test:performance
pnpm run benchmark:search

# 当前机器的未签名目录包；macOS 示例
pnpm run package
ANYNOTE_EXECUTABLE="$PWD/release/mac-arm64/Anynote.app/Contents/MacOS/Anynote" node scripts/performance-ui-acceptance.mjs

# 单独记录长时负载；默认只采样 60 秒
ANYNOTE_DEVICE_LABEL="设备型号与内存" ANYNOTE_SOAK_SECONDS=3600 node scripts/performance-ui-acceptance.mjs
# 仅离线首次编辑阶段施加 renderer CPU 节流，不代表真实低配硬件
ANYNOTE_CPU_THROTTLE=4 node scripts/performance-ui-acceptance.mjs

# G20 界面/无障碍与单独的备份响应检查，按需运行
pnpm run test:acceptance:ui
```

Linux 需要可用显示会话、`dbus-run-session` 和 GNOME Keyring。脚本为 Linux 创建独立 D-Bus 会话和临时密钥目录，不替换 safeStorage。测试启动参数包含 `--no-sandbox` 及禁止后台窗口限速的参数；应用 renderer sandbox/contextIsolation 保持原配置。测试参数不加入正常启动流程。

报告生成到 `tmp/reports/performance-ui-acceptance.json`、`tmp/reports/performance-ui-packaged-acceptance.json`；格式为 `anynote.performance-ui-acceptance.v2`。先看 `includedSuites`，再核对 `status: passed` 和每项检查，默认性能通过不能替代 `--ui` 或 `--backup` 验收。搜索报告为 `tmp/reports/search-benchmark.json`，体积报告为 `tmp/reports/renderer-bundle.json`。这些生成文件不提交仓库，需要随运行归档，避免下一轮覆盖。

## 当前测量与体积约束

- 四个 Notebook，11,064 个节点：主库 10,000 篇索引语料、1,000 层目录、复杂文档、超大 Markdown、PDF 和图片；另三库各 20 篇跨库链接。验证跨库搜索返回 60 篇、反链来自三个库。
- 普通文档 52,216 字节；连续编辑器打开 p95 < 300ms，真实 IPC 保存提交 p95 < 150ms（不包含自动保存防抖），万篇搜索与跨库反链 p95 < 500ms，虚拟树滚动 p95 < 150ms。
- 五次新进程启动到固定 Notebook 可操作 p95 < 3s。固定 Notebook 避免书橱最近访问顺序污染样本。保留 OS 文件缓存，不宣称冷磁盘启动。
- 首次使用另启进程，清除 Chromium HTTP/代码缓存、关闭网络后重新导航；在书橱检查大模块未加载，再验证首次文档输入、持久化、白板文字、本地 Excalifont 字体和预览导出。记录实际 `file:` 资源路径。Excalidraw 注册的 CDN 字体回退仍被 CSP 阻止，不放宽 CSP；验证实际本地字体加载成功。
- PDF 为 104,887,221 字节、100 页的注释填充样本，验证范围读取、页面文字、绘制和单 canvas；图片为 4096×4096、约 3.3MB 的确定性渐变 PNG，验证真实解码与预览。两者都不代替复杂扫描件、嵌入字体、照片或矢量语料。
- 持续循环打开图片、PDF、50KiB 文档并查询反链，记录每进程工作集、总工作集、renderer JS heap、峰值与首末增长。默认 60 秒是短时基线；不强制 GC，不据此声称没有泄漏。长任务与 G08 备份大清单单独记录。
- 构建报告遍历入口的静态导入闭包，分开统计首屏 JS、gzip 与所有懒加载 JS；首屏预算为 400KiB / gzip 128KiB。体积检查同时阻止编辑器、PDF、白板、任务与恢复弹窗进入同步闭包，并检查动态模块与本地字体路径存在。
- 保留 Vite 内容哈希文件名与 ESM 模块缓存。大型 Excalidraw、Mermaid、PDF 与文档编辑器按功能加载，不将整个 vendor 合并回首屏。备份、扩展、设置和对话框各自有 Suspense 边界，加载期间保留工作区。

## 证据边界

CPU 节流不等于低配机器，新进程启动不等于清空操作系统缓存；合成 PDF 不代表扫描件、复杂字体或真实照片负载。短时工作集数据不证明无泄漏。自动无障碍扫描不替代读屏、真实 IME、原生对话框和跨平台人工验收。每次重新运行后，记录设备、语料、版本和实际运行的场景；未执行或失败不得写成通过。
