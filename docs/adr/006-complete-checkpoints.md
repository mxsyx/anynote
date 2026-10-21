# ADR-006 · 每代完整 checkpoint 与物理分块增量

状态：已采纳（当前实现追认）。核对：2026-10-21，源码基线 `e975c1c`。

[返回 ADR 索引](README.md)

## 背景

原设计 §12 的实体级 delta、周期性逻辑 checkpoint 与可选整库快照已被当前物理备份协议替代。

## 决定

通过 SQLite Online Backup 捕获一致性数据库，以 1MiB 固定块计算哈希；附件按完整文件哈希保存。每代清单记录整库大小/哈希、有序块列表及完整附件集合，可独立恢复。

“每代 checkpoint”指完整恢复清单，不指每次重传整个数据库，也不是 SQLite WAL checkpoint。上传按对象哈希去重；恢复按该代顺序拼接并验证数据库及资源闭包，不读取早期 generation 或重放实体 delta。

## 取舍与边界

不采用每 100 代/每日 checkpoint 链或 D1 领域表重建。降低恢复与 GC 对版本链的依赖，但捕获仍需完整临时数据库，页面重排可能放大上传量。旧 BLOB/逻辑格式不兼容，不增加迁移层。

## 证据与验证

[数据库捕获](../../packages/storage-sqlite/src/database-snapshot.ts)、[物理快照](../../packages/backup/src/file-snapshot.ts)、[完整清单及恢复](../../packages/backup/src/cloud-snapshot.ts)。

[SQLite/附件测试](../../tests/sqlite-assets.test.mjs)、[云流式测试](../../tests/cloud-stream.test.mjs)；[格式与预算](../SQLITE-STORAGE.md)、[流式备份说明](../STREAMING-CLOUD-BACKUP.md)。

本轮执行结果统一见 [G18 核对报告](../G18-documentation-review.md)；测试入口和历史报告不等于本轮已执行或真实发布验收。
