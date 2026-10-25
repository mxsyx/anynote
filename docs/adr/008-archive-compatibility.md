# ADR-008 · 完整归档、安全导入与版本拒绝

状态：已采纳（当前实现追认）。核对：2026-10-21，源码基线 `e975c1c`。

[返回 ADR 索引](README.md)

## 背景

归档既要携带完整知识数据，也必须把不可信 ZIP、数据库与附件隔离在登记之前。开发期不要求历史数据兼容。

## 决定

完整 `.anynote` 是 ZIP/ZIP64，`anynote.notebook` v1、schemaVersion 4，包含清单、SQLite、附件、历史、回收站和扩展状态。设备凭据、授权、游标不携带。

G16 增加显式“仅当前内容”导出：只在专用快照裁剪历史、回收站和扩展独立状态，并清除空闲页/旧搜索文本；源库保持不变。清单以 includesHistory/includesTrash/includesExtensionState 声明范围，requiredExtensions 记录保留块格式版本和数据 schema 要求。完整导出仍为默认保真入口。开放 Markdown 导出采用独立当前快照和可取消流式目录/ZIP，附目录映射及能力损失报告；预算与路径取舍见 [流式归档](../guides/STREAMING-ARCHIVE.md)。

流式导入在私有目录检查条目路径、重复条目、链接类型、解压与磁盘预算；验证 schema、数据库完整性、外键、大小/哈希及资源闭包后重映射身份，登记新 Notebook。取消或失败不登记半成品。

按当前结构严格校验，拒绝旧 BLOB schema/旧备份格式，不自动迁移；同为 schemaVersion 4 也不保证开发期新增字段前的数据库可用。

## 取舍与边界

不原位覆盖活动 Notebook，不把开放 Markdown 导出视为完整恢复容器。ZIP 与 ZIP64 是当前容器支持范围，不是旧业务 schema 兼容承诺。用户主动确认的扩展状态字段迁移是另一种能力。

## 证据与验证

[归档校验](../../packages/storage-sqlite/src/archive-stream.ts)、[数据库结构与导入](../../packages/storage-sqlite/src/index.ts)、[格式版本](../../packages/protocol/src/release.ts)。

[流式归档测试](../../tests/archive-stream.test.mjs)、[存储测试](../../tests/storage.test.mjs)；[归档说明](../guides/STREAMING-ARCHIVE.md)、[扩展数据迁移](../extensions/EXTENSION-DATA-MIGRATIONS.md)、[G14 schema 决策](../history/G14-navigation-decision.md)。

本轮执行结果统一见 [G18 核对报告](../history/todo-2026-10-24.md#g18)；测试入口和历史报告不等于本轮已执行或真实发布验收。
