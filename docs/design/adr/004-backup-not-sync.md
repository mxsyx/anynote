# ADR-004 · 备份与同步分离及远端写入身份

状态：采用。

[返回 ADR 索引](README.md)

## 背景

本地知识写入不应依赖网络。多个设备备份时必须避免覆盖彼此的已提交版本。

## 决定

备份由用户为目标启用或手动触发，只有应用运行时调度；本地保存成功不等于远端成功。Cloudflare 目标使用 lineage、deviceId、writerEpoch 与 expectedHead；游标和待确认 generation 属于设备数据。

Cloudflare 用分支 CAS 发布，接管提升 epoch；恢复默认创建新 Notebook，接续原分支是显式操作。本地磁盘保留当前完整副本。

## 取舍与边界

不提供双向同步或冲突自动合并，也不假设应用退出后任务继续运行。Cloudflare 真实服务验收归 [A007–A009](../../development/TODO.md#a007)，独立设备验收归 [V 类任务](../../development/TODO.md#platform-validation)。

相关契约：[Rust 数据与协议](../RUST-DATA-COMPATIBILITY.md)、[剩余任务](../../development/TODO.md)。
