# Rust schema v5 写存储接续

RM05 在 [RM04 只读模型](RUST-READONLY-STORAGE.md) 上增加写队列、SQLite 租约、事务及核心操作。实现位于 [`anynote-storage::notebook`](../../crates/anynote-storage/src/notebook/mod.rs)，任务状态见 [TODO](TODO.md#rm05)，实际验证见[实施记录](IMPLEMENTATION.md#rm05)。RM06 在同一写队列上接入跨库协议，见下方[跨库复制与移动](#跨库复制与移动)。不改变现有 schema v5、资源布局或旧 TS 产品代码。

## 所有权与接口

宿主在后端建立一个 `WriteQueue::open(root, capacity)`，常规预算沿用 8 个写连接；容量范围 1–64。`submit` 把受信服务闭包放入容量 64 的全局 FIFO，返回 `WriteTicket`；队列满返回 Busy，未接受的请求没有副作用。`wait` 及最后一个队列句柄的析构都可能阻塞，只能在后台调用，不能放到 GPUI 事件线程。最后一个句柄释放时排空已接受工作，再关闭连接和线程。普通业务失败不会终止队列；服务闭包 panic 属于进程故障，未返回的调用失败，不能自动重放普通保存。

`WriteCatalog` 只在存储线程持有连接。`notebook(id)` 返回短借用，按 LRU 更新顺序；容量已满时先释放一个未 pin 的连接，全部固定则返回 Busy。`pin(id)` 返回可跨任务持有的 `NotebookPin`，其析构只减少计数；`close_notebook` 拒绝关闭仍被 pin 的库。跨调用租约保护使用 pin，不保存裸指针或 SQLite 连接。外部目录沿用 `_local/notebook-directories.json`，离线登记不删除，已有目录注册/重新连接的 UI 接线仍由后续工作区组负责。

核心接口：

- `create_notebook` / `create_notebook_at`：同卷私有目录中创建完整 schema v5，验证后发布 UUID 目录；外部登记用临时文件、flush、rename 更新。未注册失败清理本次创建的目录，已发布登记后的失败保留完整库。
- `rename_notebook`：提交名称、图标和封面颜色，并更新外部登记名称。DB 与登记文件不是跨文件原子事务；登记发布失败会报错，已提交的名称仍保留，与旧版边界相同。
- `WritableNotebook::create_node` / `save_note` / `restore_revision`：返回现有 `Note`，复用类型、UUID、标签和数值检查。`NotePatch` 可改标题、正文、标签和收藏；保存必须匹配 expected revision，失败返回 Conflict。标题按旧版 trim，长度按 UTF-16 单元，时间为毫秒安全整数。
- `move_node` / `place_node`：验证目录类型、父链及循环；排序保留旧小数键，间隙不足或键不适合继续插入时重排同级。移动沿用旧版无 expected revision 入口，排序使用 revision 条件。
- `trash_node` / `restore_node`：保存删除批次，恢复不复活更早删除的子项；恢复对象的父节点仍删除时移到根。只更新受影响条目的检索索引。
- `add_annotation` / `delete_annotation` / `reanchor_annotations`：页码、归一化矩形、文本和颜色校验，目标必须匹配当前主资源 hash；删除为软删除。PDF 阅读笔记生成、提取及具体媒体操作由对应媒体组接续。
- `set_core_setting` / `propose` / `apply_proposal` / `undo_proposal`：仅支持已有内置配置白名单和单笔记提案，不开放任意插件状态写入或执行入口。

`read()` 借用 RM04 的读视图，在当前写连接上读取正文、历史、批注和资源。它不创建第二个 SQLite 连接，也不暴露 SQL；不要为已持写租约的库另开只读连接。业务 IPC、任务取消消息、资源 token 和管理 UI 由 RM28/29 等后续组接入，本组未改 RM03 的连通性命令。

## 写租约与提交

打开已存在 DB 时使用 READ_WRITE、不带 CREATE，验证路径与 sidecar，通过与旧版相同的 SQLite `locking_mode=EXCLUSIVE` 持续持锁；精确校验 schema、树、资源闭包，再进入 WAL、FULL synchronous、foreign_keys、trusted_schema=OFF。不存在的 DB 不被误建，未知 schema/tracker 不修复。可缺省的 `_backup_revision` 按已冻结 SQL 初始化，未新增业务表或版本。

Unix 身份校验只用 stat 的 device/inode，不打开再关闭同一 DB 的额外描述符：POSIX close 会释放该进程在 inode 上的文件锁，即使 SQLite 自身还持有连接。同进程 SQLite 锁检查不足以发现这个问题，必须保留 TS + 两个 Rust 进程的争锁回归。Windows 继续使用已有 file handle 身份比较；尚未在 Windows/macOS 实机确认。

每笔业务事务使用 BEGIN IMMEDIATE，将节点、修订、资源绑定、修订元数据、FTS/反链、提案状态、changes 和 content_seq 一起提交；任何错误或栈展开均回滚。现有触发器更新 storage_epoch，耗尽时报错，不经浮点数转换。提案创建按旧版只更新 storage_epoch，不递增 content_seq；apply/undo 状态与正文处于同一事务。已 applied 的 apply 返回当前笔记，重复 undo 或后续编辑后的 undo 拒绝。

`lease_revision()` 的 lineage 每次重新取得写租约都变化；持久 `_backup_revision.lineage_id` 原样保留。后续备份免捕获快路必须使用租约身份，不能把只读视图中的持久 lineage 当成跨重启有效的内存身份。

正常释放先尝试回到 DELETE journal，再关闭 SQLite。路径替换后拒绝继续提交；未提交事务的子进程退出回滚、已提交 WAL 的 SIGKILL 后重新打开均有本机证据。这不等于断电、热拔盘或存储控制器故障验收。

## CAS、历史及 JSON 保全

`ResourceWrite` 接受有界字节或受信服务已打开的文件句柄，单资源上限 50 MiB、每次最多 200 项。文件输入以 1 MiB 缓冲流式复制并计算 SHA-256；写完 flush 后以 hard link 原子发布到现有 CAS 布局，已有目标必须通过 hash/size 校验，绝不覆盖。相同 hash 去重，resource ID 重绑定增加 revision，保留原始名称。Windows 正常错误路径先关闭临时句柄再删除文件。Unix 对发布目录逐层 fsync；不支持硬链接的卷明确失败，卷适配和实际持久性仍须 RM32/33 验证。

SQL 提交前资源文件可能已发布。SQL 失败时回滚全部表行，但不删除可能被早期修订引用的 CAS 文件；可能留下无引用文件或进程中断的临时文件，不能自动当作垃圾清理。后续清理属于 RM08 的计划、复核和证据保全范围。媒体签名、像素、场景完整结构和导入授权由上层对应服务验证，本层负责字节身份、预算及持久闭包。

资源捕获复用现有 directive 解析和 resource ID 提取；未显式变更的 ID 优先使用前一修订的 hash，新增/变更 ID 才用当前资源绑定。白板场景递归扩展 files.resourceId，去重并限制 10000 个引用、20 MiB 场景。恢复历史复制历史 revision_resources，恢复后再保存也继续使用历史绑定，不把图片或嵌图漂移到最新资源。

现有 `anynote.core.revision-meta`、`anynote.ai.proposals` 和内置配置使用原命名空间/键格式；未知 extension_data 的原 JSON、schema_version、revision 及未知正文均保留。旧秘密文件不在此模块读写或清理范围。

## 复现与证据边界

```sh
cargo test -p anynote-storage --locked --offline
cargo clippy -p anynote-storage --all-targets --locked --offline -- -D warnings
cargo build -p anynote-storage --example write_probe --locked --offline
node scripts/rust-write-reference.mjs
node_modules/.bin/vitest run tests/storage.test.mjs tests/organization.test.mjs tests/workspace.test.mjs tests/rust-migration.test.mjs
python3 scripts/check-rust-workspace.py
```

差分脚本依赖现有 `.build/packages/storage-sqlite`；缺少构建时按项目开发流程先构建旧后端。可用第一个参数传入非默认 `write_probe` 路径。所有输入与报告位于 `tmp/rm05/` 的独立合成目录，不接真实用户库或秘密。子进程执行受限的沙箱可能返回 EPERM 或使旧锁测试超时，应在允许本机子进程的环境重跑，不能吞掉执行错误作为通过。

差分对比节点、正文、历史、元数据、删除批次语义、原始未知 JSON、资源修订和 content_seq。独立运行产生的时间、修订 UUID 按历史位置规范化；原库身份、资源 hash、整数、正文和未知 JSON 不归一化。另在同一份合成库交替运行两种语言，验证旧提案→Rust apply→旧 undo、Rust 提案→旧 apply→Rust undo、Rust 建库→旧续写及历史白板嵌图字节。三进程使用真实 SQLite 锁，未提交事务退出和持锁进程 SIGKILL 分别验证回滚与重开。

本机离线存储结果不关闭 M3 整体、RM06–12、RM28/29、M8 接管、三平台、真实资料/卷、性能或 V/A/F 验收。该 RM05 结果未提供生产接管、导入、清理或完整 UI；RM06 跨库能力见下节。

## 跨库复制与移动

RM06 服务入口为 `anynote_services::transfer::transfer_node(&WriteQueue, TransferRequest)`，返回 `WriteTicket<TransferResult>`，调用者在后台等待。请求字段沿用旧 `transferNode`：`notebookId/id/targetNotebookId/targetParentId/mode/operationId/expectedRevision`。同库请求拒绝；重试必须使用原请求与 operation ID。IPC/UI 接入由 RM28/29 接续，不新增通用 SQL 或插件执行接口。

`WriteCatalog::with_pair` 在同一 FIFO 工作项内持有两端独占租约，防止普通保存、清理及其他转移插入协议中间。容量为 1 时临时允许 2 个连接，完成或普通错误后回到原预算；其他固定连接仍受预算限制。存储层 `completed_transfer`、`copy_transfer` 和 `finish_transfer_move` 分别负责源完成回执、目标提交和最终移动；最终移动自行验证目标，不能绕过目标核对直接软删除源。

闭包包含目录及已删除子项、笔记、全部历史修订、修订资源映射、当前资源、所有引用附件、批注、PDF 提取文本、导入报告与 `anynote.core.revision-meta`。保留未知正文块，重映射子树内部自链接、资源 URI、白板资源字段和场景文件；指向子树外的链接不变。库级未知 `extension_data` 保留在原库，不作为复制对象。节点上限 10,000，记录和附件各 100 MiB；逐行预算核对、递归查询限额，附件先验证 hash/size，再按总预算准备，不套用普通保存的单附件 50 MiB 限额。

目标使用一笔事务提交所有记录、索引、changes/content_seq 和 `anynote.core.transfer-target` 回执，附件复用 RM05 CAS 发布器。与普通保存一样，SQL 失败可能留下无引用 CAS，但不会发布半份副本、覆盖现有附件或删除源。回执沿用 schema v5 的 namespace、key 和 JSON 字段；请求与闭包指纹保留 TS 字段/行顺序，用 ECMAScript 数字格式处理小数/指数排序键，以支持两种实现交替续跑。

复制返回 `completed`。移动在目标提交后再次核对目标闭包和全部目标附件，再在源事务中核对源闭包；匹配后才软删除仍活动的源节点，同时写 `anynote.core.transfer-source` 完成回执。已删除子项保留原删除批次。目标或源后续变更分别返回 `copied-target-changed` / `copied-source-changed`，不再次复制或删除源；真正的 I/O/SQL 错误返回错误，同一请求可重试。关闭后的损坏库可能在取得租约时直接拒绝，不能保证每次损坏都转换为 changed 状态。完成回执优先返回原结果，因此用户恢复源条目后重复请求也不会再删除它。

复现入口：

```sh
cargo test -p anynote-storage --locked --offline
cargo test -p anynote-services --test transfer --locked --offline
cargo build -p anynote-services --example transfer_probe --locked --offline
node scripts/rust-transfer-reference.mjs
node_modules/.bin/vitest run tests/transfer.test.mjs
cargo clippy -p anynote-storage -p anynote-services --all-targets --locked --offline -- -D warnings
```

TS/Rust 互通脚本复用 `.build/packages/storage-sqlite`，所有测试库/输入/报告位于 `tmp/rm06/`。`transfer_probe` 的 copy 阶段用于模拟目标已提交但源未执行，crash 阶段仅在测试子进程中等待 SIGKILL；正式服务不含故障环境变量。storage 单元测试另覆盖两端事务内回执前后的进程退出，ignored child 由父测试显式执行。真实断电、跨平台/卷、性能和完整白板 UI 编辑互通仍分别归 RM32/33/31/24，本组本机合成结果不关闭这些验收。
