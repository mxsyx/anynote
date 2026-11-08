# Rust 快照、归档、开放导出与清理接续

RM08 复用 [RM05 写队列与租约](RUST-WRITE-STORAGE.md)、schema v5、CAS 和 revision_resources。任务状态见 [TODO](TODO.md#rm08)，本轮证据见[实施记录](IMPLEMENTATION.md#rm08)。不改变 Notebook schema、`.anynote` 格式或旧 TS 实现。

## 调用边界

[`snapshot.rs`](../../crates/anynote-storage/src/notebook/snapshot.rs) 提供 `WriteCatalog::capture_snapshot`，服务在 `WriteQueue::submit` 内调用，返回可移交后台线程的 `FrozenSnapshot`。Online Backup 按 256 页推进，包含已提交 WAL；在同一写序列中固定所有附件，优先 hard link，跨卷/不支持时使用有界 copy。捕获校验路径、大小和文件身份；文件 SHA-256、完整性、裁剪、压缩在队列外执行。SQLite 连接始终留在所属线程，附件可在冻结后继续由后续写事务生成新 hash。

`FrozenSnapshot` 持有源 `NotebookPin`、私有临时目录及当前写租约 revision。析构释放 pin 并清理目录，失败路径也如此。进程强制退出可能留下临时目录或 `.partial`，不能自动复用或当成成功包；本组不自动删除重启后未知 staging。`lease_revision` 重开即变化，不能将持久 lineage 当成跨进程免捕获凭据。RM09/10 在此接口上接备份任务与调度。

模式是单次转换：

- `Full`：裁剪副本的无引用 asset 行，恢复原 storage_epoch，保留历史、回收站、未知 JSON 和所有持久引用；不修改源库。
- `Current`：沿用旧版 SQL 裁剪历史/回收站/独立状态，只保留当前 revision metadata，重建 FTS 并 `secure_delete` / `VACUUM`，清除旧页中的正文。
- `Preservation`：不裁剪。`inspect_snapshot` 只接受从未裁剪的切面，连同全部捕获文件、大小/hash、revision、完整性结果写入独立证据目录。即使检验失败也保留原字节；处理失败的裁剪副本不能重新标成保全。此证据仅覆盖 Notebook DB 与已登记附件，不包含整个工作区、偏好/密文/外部文件，不能替代 RM14 迁移保全。

`Cancellation` 可由宿主任务取消事件触发，捕获页、流式复制/hash/压缩和发布前均检查。当前 SQLite schema/树/资源完整性验证是同步检查，取消可能要等待这一步结束；最终发布前仍会拒绝已取消任务。这些函数必须在后台调用，不在 GPUI 事件线程运行。RM29 接现有 RM03 任务状态和管理页面，本组不增加独立任务状态机或 IPC 命令。

## 归档及持久快照

[`archive.rs`](../../crates/anynote-services/src/archive.rs) 提供 `export_archive`、`validate_archive`、`import_archive`、`snapshot`、`list_snapshots`、`restore_snapshot`。

导出以 64 KiB 流式处理，输出到目标目录的私有 `.partial`，完成每项大小/hash 校验、flush 和取消复核后无覆盖发布。正常失败删除本次临时文件，已有目标拒绝覆盖。ZIP writer/reader 支持 ZIP64；小样本可强制 ZIP64 条目 extra field，超过经典 ZIP 限制时库生成 ZIP64 结束记录。20 GiB 解压总预算、100002 条目及 16 MiB manifest 与旧流式格式对齐，没有提供会把该预算传入旧 100 MiB base64 API 的兼容入口。

导入先预检中央目录，再建立 ZIP reader，拒绝重复名称（reader 的名称映射会去重，不能只查 reader.len）、路径穿越、链接/特殊文件、加密、分卷、不支持压缩、超预算及数据重叠。所有条目在私有 staging 中流式核对 CRC、大小和 SHA-256；随后检查精确 schema、身份、完整性、树、revision 资源闭包、manifest 与 DB 附件集合、`requiredExtensions` 和 current 声明。requiredExtensions 只是内容要求，没有安装或执行入口。

校验通过才重置 Notebook ID/备份 lineage，改写历史正文中的库内链接并重建索引；同步文件与目录后发布新 UUID 库。源库与归档均保留，发布后宿主可通过 `WriteCatalog::refresh_catalog` 刷新目录。接口不替换原库，也不自动激活真实用户资料。

持久快照仍使用 Notebook 下 `snapshots/<毫秒时间>.anynote`。创建走同一完整导出；同毫秒目标冲突拒绝，不覆盖。列举、校验、恢复可直接使用已授权 Notebook 路径，不要求先打开源 DB，因此损坏源库仍可恢复到新库。外部库路径由 `notebook_path` 获取；路径和文件名继续拒绝 symlink/junction、穿越及特殊文件。

## 开放导出

[`open_export.rs`](../../crates/anynote-services/src/open_export.rs) 的 `export_markdown` 支持目录和 ZIP，统一使用当前切面、原子 staging 及导出预算。标题 NFC、跨平台字符处理、完整 UUID 后缀、过长路径 `_long` 映射与旧版保持一致；保留空目录，重写库内链接和资源 URL。

输出 `EXPORT-MAP.json`、`EXPORT-REPORT.txt`、`_assets`、白板原始 `.scene.json` / 嵌图 Excalidraw 场景 / 预览 / 图片原件，以及批注 JSON sidecar。资源按每篇笔记的 head revision 固定 hash，即使同一 resource ID 后来重绑定，也不会使旧 scene 的图片漂移。嵌图 base64 分块输出；未知块保留原文并报告阅读损失。开放导出不保留历史、回收站、独立业务状态或原编辑能力，不能当恢复格式。RM24/26 继续提供完整媒体工作流终验。

## 清理与恢复

[`cleanup.rs`](../../crates/anynote-storage/src/notebook/cleanup.rs) 的 `preview_cleanup` / `apply_cleanup` 由写队列执行。候选与旧核心清理相同，仅限超出保留数量和天数的持久快照；不删除 CAS、历史修订、未知 JSON、旧秘密、临时目录或第三方状态。参数为保留 1–1000 份、0–3650 天；最多 20 个内存计划，5 分钟过期。

计划绑定当前写租约、storage epoch、content sequence、候选集合、文件身份/大小/hash；执行必须明确 `confirmed=true`，并重新计算和核对全部条件。重开、过期、引用变更、文件被替换、出现新候选或仍有活动 pin 时拒绝。快照大文件 hash 复核仍可能占用写队列，本轮没有大规模清理延迟验收。

执行先持久化 `_local/cleanup-quarantine/<planId>/journal.json`（`anynote.cleanup.v1`），再移动已审阅文件。移动失败尽力恢复；若恢复遇到路径冲突或文件异常，保留 journal 和剩余隔离文件。`recover_cleanup` 无需打开 DB，验证身份/hash，拒绝覆盖新快照。

`apply_cleanup` 返回的是 **quarantined / bytes**，不是已释放空间。宿主提交清理后可调用 `purge_cleanup(..., confirmed=true)` 释放隔离文件；也可先提供撤回。永久删除前再次校验全部剩余文件，部分删除失败返回 removed / reclaimedBytes / pending / error，保留回执及剩余字节供重试；已经永久删除的文件不能承诺恢复。两阶段共用同一计划和显式确认上下文，UI 不应将隔离字节显示为已释放空间。回执保留作审计，不自动清理未知文件。

## 复现

```sh
cargo test -p anynote-storage -p anynote-services --locked --offline
cargo clippy -p anynote-storage -p anynote-services --all-targets --locked --offline -- -D warnings
cargo build -p anynote-services --example archive_probe --locked --offline
node scripts/rust-archive-reference.mjs
node_modules/.bin/vitest run tests/archive-stream.test.mjs tests/cleanup.test.mjs tests/integrity-inspection.test.mjs
python3 scripts/check-rust-workspace.py
```

差分脚本使用现有 `.build` TS 基线、RM01 冻结语料和 `tmp/rm08/` 隔离副本。检查完整/当前/ZIP64 双向互读、schema 与未知状态、开放导出逐项对比和流式写包 SIGKILL。子进程受限时需在允许本机测试进程的环境运行，不能把 EPERM 当成功。合成媒体和故障注入不代表真实用户库、三平台、独立卷/物理磁盘满/断电/拔盘、20 GiB 或完整媒体终验。
