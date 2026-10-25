# ADR-004 · 备份与同步分离及远端写入身份

状态：已采纳（当前实现追认）。核对：2026-10-21，源码基线 `e975c1c`。

[返回 ADR 索引](README.md)

## 背景

本地知识写入不应依赖网络。多个设备备份时必须避免覆盖彼此的已提交版本。

## 决定

备份由用户为目标启用或手动触发，只有应用运行时调度；本地保存成功不等于远端成功。Cloudflare 目标使用 lineage、deviceId、writerEpoch 与 expectedHead；游标和待确认 generation 属于设备数据。

Cloudflare 用分支 CAS 发布，接管提升 epoch；恢复默认创建新 Notebook，接续原分支是显式操作。本地磁盘保留当前完整副本。

## 取舍与边界

不提供双向同步或冲突自动合并，也不假设应用退出后任务继续运行。Cloudflare 真实服务验收归 [A007–A009](../../TODO.md#a007)，独立设备验收归 [V 类任务](../../TODO.md#platform-validation)。

## 证据与验证

[备份服务及游标确认](../../packages/backup/src/service.ts)、[Worker 发布](../../apps/cloudflare-backup/src/index.ts)。

[云流式测试](../../tests/cloud-stream.test.mjs)；[远端维护](../guides/REMOTE-MAINTENANCE.md)、[故障演练](../validation/RECOVERY-DRILLS.md)。

本轮执行结果统一见 [G18 核对报告](../history/todo-2026-10-24.md#g18)；测试入口和历史报告不等于本轮已执行或真实发布验收。
