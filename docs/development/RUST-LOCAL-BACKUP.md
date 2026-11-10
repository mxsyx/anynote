# Rust 本地备份 v3 接续

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 服务与任务接入

[`local_backup`](../../crates/anynote-services/src/local_backup/mod.rs) 提供 `initialize_target`、`LocalBackupService::{backup, backup_group, verify, restore}`。同步调用必须放在服务工作线程，`WriteQueue` 只负责读取当前写租约和捕获切面；hash、复制、校验及恢复在队列外进行。恢复直接读取备份，不要求源 Notebook DB 可用。

`initialize_target` 只能在用户选定的现有目录中初始化 `AnynoteBackup`；已有无有效标记的目录拒绝接管。宿主传入所有源目录以检查交叠，持久化返回的 `Target`（根 ID、规范路径与卷事实），后续调用不得用重新初始化掩盖卷身份变化。磁盘换挂载点时，需要宿主重新授权目录、检查根 ID 后更新设备映射；不扫描磁盘或自动创建缺失根。`Target::status` 返回 `ready`、`waiting-disk` 或 `failed`，供 RM29 呈现。

[`jobs.rs`](../../crates/anynote-services/src/local_backup/jobs.rs) 的 `prepare_job` 复用 RM03 `TaskHistory` 创建可立即呈现的任务句柄；宿主随后在工作线程调用 `execute_job`。支持单库/分组备份、验证、单库/分组恢复，分组按库串行，每个库独立提交并保留结果。取消与某个库失败不隐去已成功的结果。

结果写入现有 `RuntimeState` 的 `backup.local.receipt.<operationId>`，`job_receipt` 可重读。目标离线以业务结果 `waiting-disk`、通用任务历史 `Interrupted` 表示；不扩充通用状态机。进程重启由 RM03 将活动任务标为中断；先查回执和备份 manifest，再决定新任务，不自动重放恢复。发布后本机任务库写入失败不撤销已发布数据，宿主需要核对目标。GUI/IPC/任务管理页仍属 RM29，自动调度与环境订阅属 RM10。

## 卷与路径

[`volume.rs`](../../crates/anynote-services/src/local_backup/volume.rs) 的 `VolumeProbe` 可注入模拟卷，`NativeVolumes` 使用 Linux mountinfo/statvfs、macOS statfs/statvfs/getattrlist、Windows 卷 API。Linux 按最长挂载点匹配并处理转义，能读取时补 `/dev/disk/by-uuid`；Windows 读取 volume GUID、serial、drive type、文件系统及可用空间。macOS 在卷根上组合 `ATTR_VOL_INFO | ATTR_VOL_UUID` 查询卷 UUID，文件系统不提供时保留设备身份；调用约束见 [Apple getattrlist 手册](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getattrlist.2.html)。`volume_uuid=None` 表示身份降级，`device_id` 相同或不同均不能证明两份副本位于独立物理设备。

拒绝识别出的网络/云挂载；FAT/vfat/msdos 单文件上限为 4 GiB−1。备份 DB 拆成 1 MiB 块，因此 FAT32 限制检查整附件和分块大小；恢复还检查重组后的整个 DB。空间预算保留旧成功副本，另计本轮新文件、分块余量及 JSON 临时文件。

目标根和库目录绑定开放句柄；每次发布、删除和文件访问复核根标记、路径、目录身份和卷身份。能力目录限制访问范围，拒绝符号链接/junction、穿越与非普通文件。Rust 文件锁防止本进程并发，另持有与旧 TS 相同的 `.backup-lock.sqlite` 排他事务锁；进程退出由 OS 释放，不按时间猜测删除旧锁。

## 捕获、增量与发布

本地备份使用 `FrozenSnapshot::prepare(Preservation)`，保留 DB 页布局和全部已登记附件，包括暂未引用的 asset 行；不同于完整归档的裁剪模式。保留源历史、回收站和未知 JSON，捕获副本不反写源。

DB manifest 的 `chunks` 保留有序位置和重复 hash，物理文件集合按 hash 去重；附件沿用完整 CAS 文件。总量 20 GiB、最多 20,480 个 DB 分块位置、100,000 个附件；JSON 沿用旧本地备份的 128 MiB 读取上限，以有界缓冲序列化，不套用 ZIP 的 16 MiB manifest 限额。

仅同一服务实例、完整 manifest 指纹相同、写租约 revision 未变且全部目标文件仍匹配时允许零捕获；返回前再次读取 revision。Unix token 含实例 nonce、dev/inode、长度、纳秒 mtime/ctime。旧 TS token、重启、manifest 改变或非 Unix 平台均重新 hash；Windows 不使用弱元数据 token。重开写租约/重启先重新捕获，不能将持久 lineage 当作跨进程免捕获身份。

发布顺序：

1. 对旧 pending 按 journal 恢复，保护当前 manifest 与待清理引用；不扫描删除未知文件。
2. 捕获与规划，检查预算，持久化 `.backup/pending.json`。
3. 写入带 task ID 的临时块/附件，流式 hash、fsync、写后读回验证，再替换受管文件。
4. 复核取消、文件 token/hash、目录及卷身份，原子替换 `.backup/manifest.json`。
5. 仅清理旧 manifest 声明且新版本不引用、仍与预期 hash 一致的文件；更新 cleanup，再移除 pending。

发布前失败保留旧 manifest；发布后清理失败返回 `pendingCleanup=true`，新副本仍成功。损坏或被替换的待清理文件不自动删除，返回错误供人工核对。强制退出可能留下 JSON 临时文件；没有 journal 的文件不会被重启清理。成功 rename 后目录 fsync 失败属于需核对的提交结果，不能假定磁盘仍保留旧 manifest。

## 验证与恢复

全量验证无条件读取所有文件 hash，返回逐项损坏报告；随后在私有 staging 按有序块重建 DB，校验 DB 总 hash、精确 schema、Notebook ID、完整性、历史资源闭包和附件集合。取消报告为 `interrupted`，不刷新 `lastFullVerifiedAt`。

恢复复用同一校验流程，之后调用 RM08 的 `remap_imported_notebook` 重置 ID/lineage、改写库内链接并重建索引，fsync 后发布到新 UUID 目录。拒绝与备份目录交叠，失败不注册半库、不替换原库。恢复目的地必须由宿主授权。

## 验证方法

```sh
cargo test -p anynote-services --test local_backup --test archive --locked --offline
cargo clippy -p anynote-services --test local_backup --example local_backup_probe --locked --offline -- -D warnings
cargo build -p anynote-services --example local_backup_probe --locked --offline
node scripts/rust-local-backup-reference.mjs
node_modules/.bin/vitest run tests/backup-local.test.mjs tests/backup-boundaries.test.mjs
python3 scripts/check-rust-workspace.py
```

结果按实际运行记录；设备、云端、性能及最终候选的剩余验收统一见 [TODO](TODO.md)。
