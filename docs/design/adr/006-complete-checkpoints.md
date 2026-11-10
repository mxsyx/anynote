# ADR-006 · 每代完整 checkpoint 与物理分块增量

状态：采用。

[返回 ADR 索引](README.md)

## 背景

原设计 §12 的实体级 delta、周期性逻辑 checkpoint 与可选整库快照已被当前物理备份协议替代。

## 决定

通过 SQLite Online Backup 捕获一致性数据库，以 1MiB 固定块计算哈希；附件按完整文件哈希保存。每代清单记录整库大小/哈希、有序块列表及完整附件集合，可独立恢复。

“每代 checkpoint”指完整恢复清单，不指每次重传整个数据库，也不是 SQLite WAL checkpoint。上传按对象哈希去重；恢复按该代顺序拼接并验证数据库及资源闭包，不读取早期 generation 或重放实体 delta。

## 取舍与边界

不采用每 100 代/每日 checkpoint 链或 D1 领域表重建。降低恢复与 GC 对版本链的依赖，但捕获仍需完整临时数据库，页面重排可能放大上传量。旧 BLOB/逻辑格式不兼容，不增加迁移层。

相关契约：[Rust 数据与协议](../RUST-DATA-COMPATIBILITY.md)、[剩余任务](../../development/TODO.md)。
