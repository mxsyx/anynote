# ADR-008 · 完整归档、安全导入与版本拒绝

状态：采用。

[返回 ADR 索引](README.md)

## 背景

归档既要携带完整知识数据，也必须把不可信 ZIP、数据库与附件隔离在登记之前。开发期不要求历史数据兼容。

## 决定

完整 `.anynote` 是 ZIP/ZIP64，`anynote.notebook` v1、schemaVersion 5，包含清单、SQLite、附件、历史、回收站和扩展状态。设备凭据、授权、游标不携带。

提供显式“仅当前内容”导出：只在专用快照裁剪历史、回收站和扩展独立状态，并清除空闲页/旧搜索文本；源库保持不变。清单以 includesHistory/includesTrash/includesExtensionState 声明范围，requiredExtensions 记录保留块格式版本和数据 schema 要求。完整导出仍为默认保真入口。开放 Markdown 导出采用独立当前快照和可取消流式目录/ZIP，附目录映射及能力损失报告；预算与路径取舍见 [流式归档](../../features/STREAMING-ARCHIVE.md)。

流式导入在私有目录检查条目路径、重复条目、链接类型、解压与磁盘预算；验证 schema、数据库完整性、外键、大小/哈希及资源闭包后重映射身份，登记新 Notebook。取消或失败不登记半成品。

按当前结构严格校验，拒绝旧 BLOB schema/旧备份格式，不自动迁移；同为 schemaVersion 5 也不保证开发期新增字段前的数据库可用。

## 取舍与边界

不原位覆盖活动 Notebook，不把开放 Markdown 导出视为完整恢复容器。ZIP 与 ZIP64 是当前容器支持范围，不是旧业务 schema 兼容承诺。用户主动确认的扩展状态字段迁移是另一种能力。

相关契约：[Rust 数据与协议](../RUST-DATA-COMPATIBILITY.md)、[剩余任务](../../development/TODO.md)。
