# 本地磁盘备份

每个 Notebook 使用单一 SQLite 数据库；本地目标保存按内容哈希寻址的数据库块和一份完整清单。存储、格式与恢复契约见 [单 SQLite 设计](../../docs/SQLITE-STORAGE.md)。

```text
AnynoteBackup/
  backup-root.json
  .backup-lock.sqlite
  notebooks/<UUID>/
    .backup/manifest.json
    .backup/pending.json  # 仅有未完成写入时存在
    chunks/<SHA256>.bin
```

清单为 `anynote.local-backup` v2，包含有序 `database.chunks`、整库 SHA-256/大小、唯一块集合、切点、目标与 Notebook 身份。目标中不保存整库副本或独立附件。每块最多 1MiB，复制并发可选 1–4；默认 2。仅保留当前副本。

## 一致性与容错

捕获使用 SQLite Online Backup，验证 schema、引用和所有库内资源。副本不裁剪数据或重排页面。持久化表（含资源 BLOB）上的事务触发器推进 storageEpoch；无变化时结合连接 lineage、内容版本和目标 token 跳过捕获。token 快路径不能替代完整校验。

先登记 pending 写入计划，再写临时块、同步、读回校验并替换块文件。所有块就绪后原子发布 manifest；随后清理旧受管块和 pending。取消、ENOSPC、EACCES 或进程退出发生在发布前时，旧清单仍可恢复；发生在发布后时，新清单可恢复，清理可在下次重试。并行写入失败会等待全部 worker 退出后再释放源副本和目标锁。

根标记、路径组件、符号链接及目标设备身份在各阶段检查。目标用 OS 支持的 SQLite 独占锁，进程退出自动释放。只删除清单和 pending 登记的文件，保留用户文件。

完整校验逐块收集缺失、大小和哈希错误，重建临时数据库后检查整库哈希、SQLite、schema 和资源。取消报告为未完成。恢复先验证再交给 Storage 重映射身份，创建新 Notebook。清单丢失无法从无序块推断顺序；需要从源重新备份，不提供清单重建。

## UI、SDK 与验证

备份中心保留目标、范围、调度、预览、批量任务、校验、恢复与删除。预览展示复制/复用/清理块数和额外空间预算；分块替换不使用旧附件删除比例审批。SDK 的 `LocalBackupEstimate` 使用 `copyChunks`、`skipChunks`、`databaseChanged`。

```sh
pnpm run build:backend
pnpm exec vitest run tests/backup-local.test.mjs
pnpm run test:desktop:local-backup
pnpm run benchmark:local-backup --samples 1000:100
```

单元/集成测试覆盖 WAL、增量复用、捕获后编辑、发布前后 SIGKILL、取消、损坏块修复、空间/权限错误、独占锁及未知文件保护。桌面与规模脚本已更新为分块格式；既有 [BENCHMARK.md](BENCHMARK.md) 是旧格式的历史记录，需重新运行才能评价本实现。

Linux/macOS 文件系统探测与本地替换能力检查保留。每块小于 FAT32 单文件限制，但恢复目录必须容纳完整 SQLite。Windows/NTFS、物理拔盘、真实断电与跨设备性能仍需实测；不支持 SMB/NFS/云盘挂载目标。
