# 本地磁盘备份

每个 Notebook 使用 SQLite 与独立的不可变附件；本地目标保存数据库块、完整附件文件和统一清单。存储、格式与恢复契约见 [存储与备份设计](../../docs/design/SQLITE-STORAGE.md)。

```text
AnynoteBackup/
  backup-root.json
  .backup-lock.sqlite
  notebooks/<UUID>/
    .backup/manifest.json
    .backup/pending.json  # 仅有未完成写入时存在
    chunks/<SHA256>.bin
    assets/sha256/<前两位>/<SHA256>.bin
```

清单为 `anynote.local-backup` v3，包含有序 `database.chunks`、整库 SHA-256/大小、唯一块集合、切点、目标与 Notebook 身份。`assets` 记录完整附件集合，`files` 记录唯一数据库块和附件文件；目标不保存整库副本。每块最多 1MiB，复制并发可选 1–4；默认 2。仅保留当前副本。

## 一致性与容错

捕获使用 SQLite Online Backup，验证 schema 和资源引用，固定历史与回收站使用的附件文件。副本只移除无引用资源记录，不重排页面。持久化表上的事务触发器推进 storageEpoch；无变化时结合连接 lineage、内容版本和目标 token 跳过捕获。token 快路径不能替代完整校验。

先登记 pending 写入计划，再写临时块、同步、读回校验并替换块文件。所有块和附件就绪后原子发布 manifest；随后清理旧受管块及附件和 pending。取消、ENOSPC、EACCES 或进程退出发生在发布前时，旧清单仍可恢复；发生在发布后时，新清单可恢复，清理可在下次重试。并行写入失败会等待全部 worker 退出后再释放源副本和目标锁。

根标记、路径组件、符号链接及目标设备身份在各阶段检查。目标用 OS 支持的 SQLite 独占锁，进程退出自动释放。只删除清单和 pending 登记的文件，保留用户文件。

完整校验逐文件收集缺失、大小和哈希错误，重建临时数据库后检查整库哈希、SQLite、schema 和资源。取消报告为未完成。恢复先验证再交给 Storage 重映射身份，创建新 Notebook。清单丢失无法从无序块推断顺序；需要从源重新备份，不提供清单重建。

## 大清单与响应预算

最多支持 100,000 个附件；`files` 与 pending 日志为附件加数据库块预留 120,480 个条目，cleanup 使用同样上限。单个 JSON 记录读取预算为 128MiB，可容纳全量替换时的新文件和待清理旧文件。格式仍为 v3；所有集合、大小、身份和路径约束保持验证。

资源描述与引用扫描、清单条目验证每 256 项让出事件循环。JSON 顶层数组按约 64KiB 批次写入，仍在完整写入、fsync 后原子替换。扫描计划复用已验证的旧清单；成功提交后直接移除本任务的 pending，不再次读取整份日志或重写空 cleanup 清单。

附件固定、元数据检查、复制和完整校验共享进程内 4 个 I/O 槽；单个备份仍遵守用户配置的 1–4 复制并发。同一目标的 Notebook 任务串行执行，其他目标也不会无限扩张 I/O。取消等待槽的任务不必等待其他任务释放文件；发生失败时，已进入 I/O 的 worker 全部退出后才释放源和目标。

捕获仍在 Storage 写队列中，直到数据库副本及不可变附件全部固定，避免放开写入后资源回收破坏切点。任务查询和取消走独立控制路径；SQLite Online Backup 的进度回调、扫描批次和附件 I/O 检查取消信号。任务进入终态前完成暂存目录清理并释放 Notebook pin。SQLite 单条完整性查询仍是同步操作，不能保证任意机器上的固定延迟上限。

## UI、SDK 与验证

备份中心保留目标、范围、调度、预览、批量任务、校验、恢复与删除。预览展示复制/复用/清理块数和额外空间预算；分块替换不使用旧附件删除比例审批。SDK 的 `LocalBackupEstimate` 使用 `copyChunks`、`skipChunks`、`copyAssets`、`skipAssets`、`databaseChanged`。

```sh
pnpm run build:backend
pnpm exec vitest run tests/backup-local.test.mjs
pnpm run test:desktop:local-backup
pnpm run benchmark:local-backup --samples 10000:100,100000:100
pnpm run test:desktop:local-backup --scale --samples 10000,100000
```

单元/集成测试覆盖 WAL、增量复用、捕获后编辑、发布前后 SIGKILL、取消、损坏块修复、空间/权限错误、独占锁及未知文件保护。规模基准还覆盖检查、捕获和计划阶段取消。`--scale` 使用真实 Electron、SQLite 和 IPC，在整个任务期间连续记录帧间隔、查询延迟、各进程采样 RSS、取消应答及终态时间，并执行两个 Notebook 的范围任务。阶段标签取自最近一次 IPC 观察，不能当作后端的精确阶段时间；后端阶段墙钟时间见 Node 基准。数据为确定性合成附件，样本生成和最终目录清理不计入任务耗时。

当前 G08 证据与边界见 [性能交接](../../docs/history/G08-local-backup-performance.md)。[BENCHMARK.md](BENCHMARK.md) 保留旧格式历史记录，不能套用于当前实现。

Linux/macOS 文件系统探测与本地替换能力检查保留。数据库块小于 FAT32 单文件限制，但附件可能超过限制；计划检查最大的附件文件，恢复目录必须容纳完整 SQLite 和附件。Windows/NTFS、物理拔盘、真实断电与跨设备性能仍需实测；不支持 SMB/NFS/云盘挂载目标。
