# Rust schema v5 只读存储接续

RM04 的实现入口为 [`anynote-storage::notebook`](../../crates/anynote-storage/src/notebook/mod.rs)，状态统一见 [TODO](TODO.md#rm04)，本轮结果见[实施记录](IMPLEMENTATION.md#rm04)。这是本机合成数据上的只读数据面，未接 GPUI 业务页面，不代表 M2 或三平台数据验收放行。

## 所有权与接口

- `ReadonlyCatalog::open(root, capacity)` 读取现有 Notebook 根目录和 `_local/notebook-directories.json`，不创建目录或改写登记。普通宿主使用原有 4 个只读连接预算；参数允许 1–64。`refresh` 重新读取登记并释放旧连接；`diagnose` 保留离线外部库，分别报告离线、不安全路径、身份冲突、未知版本、结构不兼容、损坏、忙等原因。
- Catalog 独占 SQLite 连接和 LRU，放在后端存储线程；UI 不能调用同步 I/O。`read` 返回借用，调用期间不能逐出该连接；换库先淘汰最旧连接再打开。原文件替换或 WAL 改变使缓存失效，下次重新完整校验。没有写连接、任意 SQL 或插件 RPC 出口。
- `ReadonlyNotebook` 提供 `metadata`、`backup_revision`、`nodes`、`note`、`history`、`all_revisions`、`trash`、`annotations`、`extension_records`、`revision_resources` 和 `folder_path`。`nodes` 包含回收站记录，默认 `history` 与旧版一致取最近 100 条；`all_revisions` 可读取更早记录。正文、`value_json`、`selector_json` 均保留原始文本。修订元数据按旧 strict 规则投影，非法/归属不匹配时返回空，原记录仍保留。
- `ResourceScope::note(id).with_revision(revision)` 选择历史资源；省略 revision 使用该笔记 head，省略整个 scope 才读取资源当前绑定。范围读取由 `VerifiedAsset` 持有已校验文件句柄；调用 `read_range(expected_hash, offset, length)`，最大 `MAX_RANGE_BYTES` 为 1 MiB。文件内容采用流式 SHA-256，读取前后复核身份/大小/修改时间及路径；不把附件或路径装入控制帧。RM03 传输层接入时仍须按自身 256 KiB 块限制分块并管理 token 生命周期。
- `search(request, Arc<AtomicBool>)` 是同步存储算法，取消标志可从其他线程设置。采用旧版跨库软时间预算，在库间检查预算，取消清空部分结果并保留 `searched`；结果上限/时间耗尽用 `truncated` 表达，不能误报全量。重复请求身份、最多 8 个活动搜索和客户端过期结果由 RM03 的任务/请求宿主在业务接线时管理，存储层不另建任务状态机。
- `backlinks` 保留目标 Notebook + note 身份，排除已删除来源、跳过不可用库，按旧规则排序；搜索定位返回正文 query、PDF 页码、匹配当前主附件 hash 的批注 anchor 或 metadata。UI 访问历史、滚动和链接修复仍属 RM28，不属于本模块。

## 校验与保全规则

生产 `schema.sql` 和 `backup-revision.sql` 取自 RM01 冻结 SQL，差分脚本核对它们与 TS 导出的 SQL 完全相同。只在内存参考库建表，逐项比较原库 `sqlite_master` 的 name/SQL，不允许“等价 SQL”替换。可缺省整个 backup tracker；若存在则必须表/触发器/唯一数据行完整，lineage、整数 storage epoch 有效。整数 counter 不转浮点，备份修订输出十进制字符串。节点排序键允许旧格式的有限小数，不强制转换成整数。

打开执行 `READ_ONLY`、`query_only`、`trusted_schema=OFF`，在读事务内检查元数据、实际 schema、SQLite integrity/foreign keys、目录父子与循环、笔记 head 归属、全部 CAS 文件、当前主资源和历史/白板嵌图引用闭包。未知正文与 JSON 不规范化；白板只流式投影 files 的引用，其他字段不参与改写。旧 capture 会跳过未解析到资源记录的正文 ID，这些悬空文字不会被只读入口擅自补成记录。

路径要求现有绝对规范目录，检查根目录与各层 symlink/junction、DB sidecar、CAS 路径和打开后的文件身份。Windows 的普通路径与扩展长度前缀通过 `dunce` 统一比较，实际 Windows/macOS 行为仍等待平台验收。`.backup` 目录不能作为工作库直接打开。文件替换/变化后拒绝继续使用旧句柄，不把一次路径解析视为长期授权。

WAL 有现存共享内存时，读取 SQLite 已提交视图，未提交内容不可见；现有独占写租约返回 Busy。WAL 缺少 `-shm` 时返回 Busy 和恢复提示，不让只读入口创建共享内存或恢复数据库；应由原存储实例显式恢复后关闭。没有自动迁移、修复、checkpoint、重建 FTS 或新增业务表。测试以正常库、拒绝库和真实 WAL 样本的文件清单/字节 hash 核对本轮零变化；这不是并发外部 writer、三平台文件系统或断电的完整证明。

## 复现

在项目根目录，使用固定 Rust toolchain 与现有 Node 24 后端构建：

```sh
cargo test -p anynote-storage --locked --offline
cargo clippy -p anynote-storage --all-targets --locked --offline -- -D warnings
cargo build -p anynote-storage --example readonly_probe --locked --offline
node scripts/rust-readonly-reference.mjs
node_modules/.bin/vitest run tests/search.test.mjs tests/navigation.test.ts tests/workspace.test.mjs tests/rust-migration.test.mjs
python3 scripts/check-rust-workspace.py
```

TS 参考从 `.build/packages/storage-sqlite` 读取；缺少或更改后端源代码时先按项目流程重建后端。探针默认路径为 `target/debug/examples/readonly_probe`，非默认 target 或 Windows 可把实际 executable 路径作为脚本第一个参数传入。脚本直接运行已构建二进制，用输入文件避免受限环境的 stdin EOF 转发问题，不执行 `cargo run`。

Rust 测试覆盖冻结库的正文/历史/未知 JSON/批注/资源 ID/字节、7 库 2 连接 LRU、重复 note ID 的跨库隔离、历史资源范围与修改拒绝、非法 schema/tracker/树/外键/JSON/hash/路径/范围、64 位 counter、WAL 提交/未提交/缓存失效和恢复拒绝。搜索软预算与运行中取消使用确定性的时钟接缝验证部分结果契约；SQLite 测试实际运行 FTS5 trigram、JSON 函数和 Backup API。

差分脚本复用 `tests/search.test.mjs` 的数据场景和 `tests/navigation.test.ts` 的跨库/anchor 身份边界，创建独立合成库；28 组操作逐项对比搜索字段、片段、标签、路径、过滤、排序、小数 sort key、结果截断、定位、正文、历史、树、批注和反链。警告比较 Notebook 身份与出现顺序，错误文本不要求两种语言一致；Rust 分类另由 Rust 测试断言。脚本不覆盖 UI visit history、链接修复算法或真实设备导航，它们的旧 TS 回归仅作为已有行为基准。

临时输入/报告保存在 `tmp/rm04/`，可随时清理；RM01 冻结语料和 manifest 不被修改。测试不使用真实用户库、凭据或远端服务。

## 后续边界

RM05 已在[写存储模块](RUST-WRITE-STORAGE.md)接写租约、写队列、事务与核心业务写入；复用本模块的读投影和校验，未暴露原始连接。Unix 文件身份检查已改用 stat，避免额外 DB 描述符 close 释放写租约。RM28 接页面及封闭的业务命令、RM29 接诊断呈现；检索调度、取消消息与资源 token 复用 RM03。三平台、真实卷、用户数据、并发/断电和性能门槛留在既有验收组，不因本机差分通过而关闭 M2、V/A/F。
