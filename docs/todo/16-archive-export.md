# G16 · 归档、开放导出与入口预算

[返回总入口](../../TODO.md)

类型：独立实现。目标：当前内容归档、流式 Markdown 导出、入口限制。

前置：先明确导出闭包与预算；提示汇总需接收 G15 的最终入口限制。

并行边界：与云盘/卷适配可并行；archive/storage 文件与正在进行的修改及 G17 串行集成。

## 建议入口

- [packages/storage-sqlite/src/archive-stream.ts](../../packages/storage-sqlite/src/archive-stream.ts)
- [packages/storage-sqlite/src/archive-jobs.ts](../../packages/storage-sqlite/src/archive-jobs.ts)
- [packages/storage-sqlite/src/open-export.ts](../../packages/storage-sqlite/src/open-export.ts)
- [packages/protocol/src/import-limits.ts](../../packages/protocol/src/import-limits.ts)
- [docs/STREAMING-ARCHIVE.md](../../docs/STREAMING-ARCHIVE.md)

## 执行顺序

1. 先在专用导出数据库实现仅当前内容闭包，保持源 Notebook 不变。
2. 再完成大型开放 Markdown 的流式目录/ZIP 导出与 sidecar，分阶段回归。
3. 汇总归档、普通导入、转移和开放导出的真实入口预算，统一提示后验证。

## 待办

### T048 · 原 §7

- [x] **P2 — “仅当前内容”归档**：使用导出专用数据库剔除历史/回收站并重新计算闭包，明确 includesHistory/includesTrash 与所需扩展版本；默认完整归档继续保真，不能直接删源库历史。

### T049 · 原 §7

- [x] **P2 — 大型开放 Markdown 导出**：将当前内存 ZIP/100MB 路径改为可取消的流式目录/ZIP 导出，验证深目录、长路径、大小写/名称冲突、内部链接、白板原场景/预览、PDF/图片原件和批注 sidecar；报告能力损失。

### T050 · 原 §7

- [x] **P2 — 大文件入口一致性**：统一展示普通单文件导入 50MB、旧归档/本地快照/开放导出 100MB、跨库转移预算和新流式路径的差异；按产品需求逐项扩展并复测，不让用户把 20GiB 云/归档预算理解为所有入口均支持。

## 验证与完成条件

- [tests/archive-stream.test.mjs](../../tests/archive-stream.test.mjs)
- `pnpm run test:archive`
- `pnpm run test:transfer`
- 大型导出的取消、命名冲突、内部链接和能力损失报告回归。

完成条件：源库未被裁剪，导出可取消且闭包正确；各入口能力没有被统一大预算误导。

人工 / 外部资源：特殊平台路径/大盘资源样本通过 G02/G03 补测；实现与合成边界回归可先行。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。

## 实施与交接（2026-10-21）

T048、T049、T050 已完成本地实现与本组自动化回归。基线 `760e939`，改动未提交。G02/G03 的特殊平台路径、大盘实机，以及 G06 的原生选择器人工体验仍由相应组补测；不将本组结项视为发行验收。

### 实现范围

- T048：新增 `archive-content.ts`；只在导出专用 SQLite 快照裁剪非 head 历史、回收站及其后代、已删除批注、无主资源、changes 和扩展独立状态。保留当前笔记元数据、head 固定资源、有效批注、当前文本索引/导入报告。采用有索引的临时资源映射重新计算闭包，重建 FTS 表并 `secure_delete` / `VACUUM` 清除旧文本。整个裁剪在可终止 Worker 中执行，源库不变。完整归档默认保真。
- 清单增加范围声明 `includesHistory` / `includesTrash` / `includesExtensionState` 和 `requiredExtensions`。后者列出保留块的 type/version 及数据命名空间/schemaVersion，不等同于已安装包 SemVer，也不携带可执行扩展。
- T049：桌面新增当前归档与开放 Markdown 目录/ZIP 原生授权入口，复用归档任务并发、进度、取消、快照校验和租约清理。开放导出按笔记转换、按 48–64 KiB 块读取附件及编码白板图片，目录写入与 ZIP 打包均有背压。白板 JSON 本体保持 50 MiB 上限，目录/资源元数据与单篇正文仍驻内存。
- 开放导出保留 PDF/图片原件、有效批注 sidecar、白板原场景/预览/图片原件及嵌图 Excalidraw 场景；采用完整 UUID 后缀、设备名保护和 UTF-8 长度限制避免名称碰撞。长目录映射到 `_long`，内部链接按最终路径转义重写，`EXPORT-MAP.json` 保留原目录与资源映射，`EXPORT-REPORT.txt` 列出能力损失和未知块要求。
- ZIP 复用通用流式写入器，打包时重查大小/哈希，失败不覆盖目标；目录先写同目录私有暂存，再独占新名称发布，不合并已有文件夹。取消等 Worker 退出后清理。开放输出执行 20 GiB / 100002 个显式条目上限，转换放大及跨卷副本需要额外磁盘空间。
- T050：共享 `entryLimits` 并用于真实入口与提示；普通单文件仍为 50 MiB，旧归档/本地快照/浏览器开放导出仍为 100 MiB，跨库转移仍为 10000 条目且记录/附件各 100 MiB。转移读取附件前也检查预算。设置、导入和转移界面明确这些限制与桌面流式 20 GiB 的差异，沿用 G15 的 HTML/媒体/响应/解码上限。
- 更新 `STREAMING-ARCHIVE.md`、ADR-008、README、IMPLEMENTATION 的当前契约。修正归档桌面测试中未引用的大附件 fixture，并将转移脚本更新到现有 Tiptap 编辑入口及 macOS Electron 默认可执行路径。

### 验证证据

环境：macOS 26.2 / Apple Silicon，Node 24.22.0，Electron 41.9.1。使用隔离临时 Notebook、合成笔记/白板/PDF，以及实际 112 MiB 不可压缩附件。

- `pnpm run typecheck`：通过，含前端、后端、类型测试。
- `pnpm run build`：通过；最终布局修改后另跑 `pnpm exec vite build`，最终后端修改后另跑 `pnpm run build:backend`，均通过。保留已有大 chunk 提示。
- `pnpm exec vitest run tests/archive-stream.test.mjs tests/extensions.test.mjs tests/editor-ecosystem.test.mjs tests/transfer.test.mjs tests/workspace.test.mjs tests/storage.test.mjs`：6 文件、68 项通过。归档文件 18 项（本组新增 5 项）。日志 `/tmp/anynote-g16-focused.log`。
- 新回归覆盖：当前包无历史/回收站/旧文本/旧附件、源库历史与 changes 不变、完整包继续保留旧附件与扩展状态；12 层长目录、大小写及 UUID 前缀碰撞、括号与中文链接/锚点、未导出链接、PDF 原件/批注、未知块损失报告、白板恢复旧版本后的图片闭包、112 MiB 开放 ZIP、浏览器 100 MiB 拒绝、转换 Worker 取消、目标保护及恶意路径 ID 拒绝。
- 112 MiB 分块写入回归采样 `arrayBuffers` 增量，断言小于 48 MiB，给 GC 时机保留余量；这是附件流式缓冲回归，不代表全应用 RSS、20 GiB 负载或真实设备吞吐。
- `pnpm run test:archive` 的沙箱内 Electron 启动失败；随后沙箱外执行相同 `node scripts/archive-smoke.mjs`，最终代码与布局通过。验证真实 Electron IPC、Storage、SQLite、完整包导出/导入、仅当前内容/源历史不变、112 MiB Markdown ZIP、目录输出/报告、入口权限拒绝、任务中心与预算提示。只替换原生选择器返回的授权测试路径，不模拟存储 RPC。
- `pnpm run test:transfer -- --desktop`：沙箱外通过，覆盖目录复制、编辑中内容保存、跨库移动与回收站恢复。日志 `/tmp/anynote-g16-transfer.log`。
- 最终 `pnpm exec vitest run`（沙箱外）：62 文件，449 通过、3 失败；仅 `tests/icons.test.ts` 的现有断言失败（期望 48×48 viewBox、SVG title 及独占 class，现有 Lucide 实现不同）。图标实现与该测试均无本组改动。其余 61 文件通过；日志 `/tmp/anynote-g16-final-tests.log`。此前沙箱内的 HTTP EPERM / APFS 识别失败已在沙箱外复验消除。
- 改动代码 ESLint、Prettier、`pnpm run workspace:check`、文档相对链接与 `git diff --check`：通过。
- 本机产物：`test-results/desktop-archive-acceptance.json`、`test-results/g16-export-settings.png`、`test-results/g16-export-task.png`；最终截图已查看，按钮与预算文案可读。桌面日志 `/tmp/anynote-g16-desktop.log`。报告/截图/日志未纳入版本库。

### 边界与下一步

- Windows/Linux 真机路径、Windows 长绝对路径、目标文件系统的硬链接能力、20 GiB 真负载及特殊磁盘资源继续交 G02/G03；本组没有执行这些外部验收。
- 原生 OS 选择器真实点击和系统授权体验交 G06。目标盘异常退出残留 `.partial` 仍需手工清理；应用内部 archive-jobs 暂存由租约恢复机制管理，无断点续传。
- 图标测试的 3 个既有失败不属于 G16，留给图标/界面维护；未将全量测试标为全绿。
- G17 集成需保留导出专用快照、Worker 退出后清理、共享 ZIP 写入器、入口预算和原生路径授权边界。当前内容归档主动排除扩展独立状态；需要完整扩展状态恢复时使用默认完整归档。
