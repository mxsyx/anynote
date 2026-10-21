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

- [ ] **P2 — “仅当前内容”归档**：使用导出专用数据库剔除历史/回收站并重新计算闭包，明确 includesHistory/includesTrash 与所需扩展版本；默认完整归档继续保真，不能直接删源库历史。

### T049 · 原 §7

- [ ] **P2 — 大型开放 Markdown 导出**：将当前内存 ZIP/100MB 路径改为可取消的流式目录/ZIP 导出，验证深目录、长路径、大小写/名称冲突、内部链接、白板原场景/预览、PDF/图片原件和批注 sidecar；报告能力损失。

### T050 · 原 §7

- [ ] **P2 — 大文件入口一致性**：统一展示普通单文件导入 50MB、旧归档/本地快照/开放导出 100MB、跨库转移预算和新流式路径的差异；按产品需求逐项扩展并复测，不让用户把 20GiB 云/归档预算理解为所有入口均支持。

## 验证与完成条件

- [tests/archive-stream.test.mjs](../../tests/archive-stream.test.mjs)
- `pnpm run test:archive`
- `pnpm run test:transfer`
- 大型导出的取消、命名冲突、内部链接和能力损失报告回归。

完成条件：源库未被裁剪，导出可取消且闭包正确；各入口能力没有被统一大预算误导。

人工 / 外部资源：特殊平台路径/大盘资源样本通过 G02/G03 补测；实现与合成边界回归可先行。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
