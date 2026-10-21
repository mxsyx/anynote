# G15 · 网页媒体流式导入与目录授权

[返回总入口](../../TODO.md)

类型：独立实现。目标：有界资源入库、可配置预算、相邻资源目录。

前置：先定义流式资源句柄与授权目录边界；统一大文件提示交给 G16。

并行边界：与云盘/卷适配并行；Storage 资源接口修改与 G16/G17 串行集成。

## 建议入口

- [packages/importer/src/html.ts](../../packages/importer/src/html.ts)
- [packages/importer/src/media.ts](../../packages/importer/src/media.ts)
- [packages/importer/src/network.ts](../../packages/importer/src/network.ts)
- [packages/storage-sqlite/src/assets.ts](../../packages/storage-sqlite/src/assets.ts)
- [apps/desktop/src/ImportDialog.tsx](../../apps/desktop/src/ImportDialog.tsx)

## 执行顺序

1. 定义资源句柄、并发/响应/单资源/总量预算并实现流式入库。
2. 接入原生授权目录，在授权边界内解析相对资源与符号链接。
3. 回归媒体重试、预览提交和取消，把入口限制交给 G16 汇总提示。

## 待办

### T046 · 原 §7

- [x] **P2 — 媒体流式入库与可配置预算**：将当前图片逐个缓冲/base64 的流程扩展为有界并发/流式资源句柄，提供响应、单资源、总量和解码预算；不直接套用设计建议的 100/500MB 默认值而绕过现有保护。

### T047 · 原 §7

- [x] **P2 — 授权相邻资源目录**：支持原生授权目录内的相对资源解析、符号链接和路径边界校验；当前用户逐个提供相邻资源文件是安全的有限实现。若支持内网站点，须新增显式任务/Notebook 策略并保留 DNS/连接地址验证。

## 验证与完成条件

- [tests/extensions.test.mjs](../../tests/extensions.test.mjs)
- `pnpm run test:features`
- 目录逃逸、符号链接、预算与取消回归。

完成条件：内存有界、取消可用、路径不逃逸；可配置预算不会绕过已有保护。

人工 / 外部资源：原生目录授权人工体验复用 G06；真实站点样本需有相应访问权限。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。

## 实施与交接（2026-10-21）

T046、T047 已完成本地实现与自动化回归。基线版本 `7e81e6e`，本次修改尚未提交。原生选择器的人工体验继续归 G06，未声称完成真实站点或跨平台人工验收。

### 实现范围

- `importer/resources.ts` 定义内部 `ResourceHandle { id, file, size, mime, name }`；网络响应与授权文件以分块、背压方式写入私有暂存目录，预览与 Worker 消息只携带句柄。Storage 复用 `putAssetFile` 的分块散列、校验与不可变文件发布，再在事务中绑定资源引用。
- 图片、附件、音视频共用计数和总量预算；首次导入以有界并发处理，重试共用流式下载、签名与尺寸校验，并扣除已入库资源和原始 HTML 占用，不能通过重试提高原任务预算。失败项保留占位符，重试仍保留用户编辑、跳过已删除的引用。
- `budget` 为可选任务参数，UI 的「导入预算」可配置；所有值必须为正整数且不超过现有保护上限。默认 HTML 10 MiB、单资源 20 MiB、单响应 20 MiB、总资源 80 MiB、最多 200 项、4 路并发、每响应 30 秒（包含 DNS 与重定向）；图片解码预算为每张 40 MP × 4 字节，保留 16,384 像素边长保护。图片头部最多读取 256 KiB，无法在此范围解析尺寸时按失败项报告。保留的原始 HTML 计入总资源预算。
- 同一 Storage 最多同时运行 2 个导入/预览/重试任务，最多保留 8 个预览、每个 30 分钟。提交、放弃、取消、关闭、超时、Worker 异常均清理暂存文件；`temporary-jobs` 新增 `import-jobs`，进程异常退出后的残留通过已有 SQLite 租约恢复机制回收。
- 原生 `chooseImportDirectory` 只接收 Notebook ID，由 Electron 选择器把路径交给内部 `registerImportDirectory`；渲染器得到 Notebook 绑定、30 分钟有效的不透明授权 ID。路径参数和内部注册操作不在公共 IPC 授权范围内。关闭导入窗口/取消目录授权会撤销授权；重试本地 HTML 媒体时重新选择目录。
- 相对路径在 Readability 归一化前保存；读取前同时检查词法边界、真实路径、目录身份、打开文件身份及普通文件类型。允许指向授权目录内部的符号链接，拒绝外部链接、绝对路径、编码逃逸、远程/file URL 和被替换的目录；读取后检查文件大小与修改时间。用户逐个选择文件的浏览器路径继续保留，并受输入总量限制。
- HTTP(S) 公网 DNS、重定向与连接地址校验继续生效；未增加内网站点策略。导入对话框改为动态加载，首次导入、预览提交、取消与本地资源重试均已接入。

### 验证证据

环境：macOS 26.2 / Apple Silicon，Node 24.22.0，Electron 41.9.1。测试全部使用合成 HTML/媒体与隔离临时 Notebook。

- `pnpm run typecheck`：通过，包含前后端及类型测试。
- `pnpm exec vitest run tests/web-import.test.mjs tests/extensions.test.mjs tests/script-network.test.mjs tests/extension-download.test.mjs tests/extension-directories.test.mjs tests/extension-updates.test.mjs tests/sqlite-assets.test.mjs tests/first-party-adapters.test.mjs`：8 个文件、79 项通过，其中 G15 新增 13 项。
- 新增回归覆盖共享总量竞争、媒体计数、响应头/流式大小限制、超时、写入失败、取消、图片签名/解码、路径逃逸、内外符号链接、目录替换、Notebook 授权隔离、预览过期/提交/放弃、Worker 取消清理和重试预算。
- 16 MiB 合成网络媒体回归检查结果不含 base64/完整 Buffer，并断言 `arrayBuffers` 增量小于 8 MiB；这是分块内存回归，不代表全应用 RSS 或真实设备性能基线。
- `pnpm run test:features`：通过（包含完整构建）。更新了旧脚本中的编辑器与导入按钮路径，使用真实 Electron IPC、Storage 子进程及 SQLite，验证目录授权拒绝渲染器路径、预算配置、只预览不写笔记、提交可读附件、关闭/返回修改清理、取消预览以及再次授权后的媒体重试；同时保留图片、视频卡片与白板回归。
- 桌面自动化仅替换原生选择器返回的测试目录，没有模拟存储 RPC。由于沙箱内启动 Electron 出现 EPERM，该测试在沙箱外执行，所有数据仍位于隔离临时目录。
- `pnpm run workspace:check`、改动文件 ESLint、Prettier 与 `git diff --check`：通过。构建仍有现有大 chunk 提示。
- 本机证据：`test-results/web-import-budget.png`、`test-results/web-import-preview.png`、`test-results/web-import-result.png`；已检查预算与预览截图。完整桌面运行日志：`/tmp/anynote-g15-features.log`。截图/日志为本机产物，不纳入版本库。

### 下一步与边界

- G16 复用 `packages/protocol/src/import-limits.ts` 的 `ImportBudget` / `resolveImportBudget` 汇总入口限制提示；内部资源句柄只能由可信导入流程产生，不接受渲染器文件路径。G17 集成时保留文件句柄、事务绑定与清理生命周期。
- 原生目录选择器的真实点击、读屏与系统授权体验交 G06；Windows/Linux 路径与符号链接实机验证、授权真实网站样本尚未执行。不阻塞本组本地实现结项。
