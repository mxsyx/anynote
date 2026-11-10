# Rust 桌面迁移：数据、备份与协议兼容

本文定义 Rust 数据与协议设计，配套 [总方案](RUST-DESKTOP-MIGRATION.md)、[配置契约](../development/RUST-CONFIG-MIGRATION.md) 与 [接管契约](../development/RUST-MIGRATION-TAKEOVER.md)。剩余实现及验收见 [TODO](../development/TODO.md)。

## 1. 决策与边界

首个 Rust 版本保留现行 Notebook schema v5、Markdown 正文、资源身份、归档格式、本地备份格式和 Cloudflare v1 协议。更换执行语言不同时更换持久化模型。当前用户明确要求现有数据兼容，该要求优先于项目一般性的“不保证历史兼容”约定。

桌面存储、导入、任务调度、备份、凭据访问均由 Rust 实现。采用总方案中的 Rust 后端子进程：同一个桌面二进制以 `--backend` 启动，封闭的类型化命令通过有界长度帧传递；附件使用受控流或资源 token，不把整库或大文件编码进 JSON。UI、系统 WebView、浏览器扩展均不持有 SQLite 写连接。后台服务内部保留一个写入队列、有界连接 LRU 和任务取消；不引入通用插件注册机制。

存储采用 `rusqlite` 和明确的 SQL，网络采用 `reqwest` + `rustls`，后台 I/O 使用有界 Tokio 任务；具体版本、功能开关和许可证冻结在总方案的技术验证阶段。数据库、归档、网络格式用 Rust 类型与校验函数表达；TypeScript 消费方继续使用原共享包，通过共同黄金样本验证协议等价，不在运行时跨语言调用。

不采用 ORM 自动迁移，理由是当前验证器会精确比对 `sqlite_master` 的 SQL 文本；重建“等价”表、修改触发器、删表或自动更名均可能使旧程序拒绝打开。也不采用“先导出普通 Markdown 再导入”迁移，因为该路径明确不保留历史、回收站、批注编辑能力和独立状态。[现有 schema](../../packages/storage-sqlite/src/schema.ts)、[结构验证](../../packages/storage-sqlite/src/backup-revision.ts)、[Markdown 导出](../../packages/storage-sqlite/src/open-export.ts)

## 2. 已核实的现状

### 2.1 组合根、写入边界与存储布局

`@anynote/backend` 继承 SQLite Storage 并注入备份服务；Electron `utilityProcess` 持有该实例，主进程代办系统凭据。`Storage.run` 校验入参和输出，默认进入全局串行队列，搜索、诊断及指定只读/网络操作可以绕过写队列。默认连接预算为 8 个可写、4 个只读，pin 阻止活动任务的写连接被逐出。[组合根](../../packages/backend/src/index.ts)、[服务组合](../../packages/backend/src/backup.ts)、[Storage](../../packages/storage-sqlite/src/index.ts)、[进程入口](../../apps/desktop/electron/storage.ts)

| 位置                                           | 当前内容                                                                | Rust 处理                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Electron `userData/notebooks/<notebook UUID>/` | `notebook.sqlite` 和 `assets/sha256/<前两位>/<完整 SHA-256>.bin`        | 完整保留布局、UUID、资源 ID、字节及大小；首版不改文件格式                      |
| 外部 Notebook 目录                             | 用户指定的本地目录，与托管目录同格式                                    | 保留路径登记、重复身份冲突、离线状态与重新连接能力；不得直接把备份目录当工作库 |
| `notebooks/_local/notebook-directories.json`   | 外部目录 `{id,path,name}` 登记                                          | 校验并迁移；断开的磁盘显示不可用，不删除登记                                   |
| `notebooks/_local/`                            | 备份目标/策略、恢复连接、任务历史、诊断、完整性报告、临时租约和续传数据 | 按第 5 节逐类处理；不放入 Notebook 内容备份                                    |
| `userData/secrets/<UUID>.bin`                  | Electron `safeStorage` 加密的 JSON 凭据                                 | 按第 5.3 节迁移，不能直接作为 Rust keyring 值读取                              |
| Chromium origin 的 Local Storage               | 外观、导航、最近项目、PDF 页码、图片视图状态                            | 关闭旧客户端后只读解析副本，转入 Rust 设备偏好存储                             |

写锁当前由 SQLite `locking_mode=EXCLUSIVE` 持续租约实现，开启 `WAL`、`synchronous=FULL`、`foreign_keys=ON`、`trusted_schema=OFF`，关闭时尝试切回 DELETE journal。Rust 必须与旧 Electron 实例竞争同一 SQLite 锁，不能仅使用自己的 PID 文件。对于外部目录，现实现验证完整 schema、完整性、附件和树结构；Notebook 内的符号链接、junction 与路径逃逸必须继续拒绝。[目录和锁](../../packages/storage-sqlite/src/workspace.ts)

### 2.2 Notebook schema v5

| 数据                 | 当前表/关键字段                                                                       | 不得丢失的语义                                                                              |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Notebook             | `notebook_meta`：ID、名称、封面图标/颜色、`schema_version=5`、`content_seq`、创建时间 | ID 与目录/远端身份的对应关系；`content_seq` 用于内容版本                                    |
| 树与组织             | `nodes`：父节点、folder/note、排序、revision、时间、删除批次、收藏、JSON 标签         | 父子关系、软删除/恢复、同级顺序、条件更新                                                   |
| 笔记与历史           | `notes`、`note_revisions`                                                             | markdown/pdf/image 类型、当前 revision、主资源、来源 URI、全部历史正文和 actor              |
| 资源                 | `assets`、`resources`、`revision_resources`                                           | 可变资源 ID 指向不可变哈希；历史 revision 固定原资源版本；白板嵌图递归闭包                  |
| PDF/图片附属信息     | `annotations`、`note_text`                                                            | 注释坐标 JSON、页码、摘录、正文、颜色、目标文件哈希、删除状态和全文索引来源                 |
| 链接、事件、报告     | `note_links`、`changes`、`import_reports`                                             | 反向链接、变更 seq、未下载媒体和重试记录、原始 HTML 资源                                    |
| 采集幂等             | `capture_receipts`                                                                    | `capture_id,digest,note_id,applied_seq` 与写入笔记同一事务提交                              |
| 扩展及核心 JSON 状态 | `extension_data`                                                                      | 未知插件数据、内置功能配置、AI 提案、历史元数据、跨库转移幂等回执                           |
| 搜索                 | `fts_notes` 及 FTS5 shadow tables                                                     | `trigram` 分词器；短于三个 Unicode 字符的查询走当前 substring 逻辑；过滤与结果截断/取消语义 |
| 备份修订             | 可选 `_backup_revision` 及各持久表 INSERT/UPDATE/DELETE 触发器                        | schema v5 可以没有该标记；存在时必须完整；`storage_epoch` 为 SQLite 整数，不能绕开触发器    |

以上以[schema](../../packages/storage-sqlite/src/schema.ts)、[备份版本契约](../../packages/storage-sqlite/src/backup-revision.ts)、[搜索](../../packages/storage-sqlite/src/search.ts)和[资源闭包](../../packages/storage-sqlite/src/index.ts)为准。新 SQLite 构建必须支持 FTS5 trigram、JSON 函数及现行 SQL；在三个平台运行真实库验证，不能用编译成功代替。

`extension_data` 不等于“可删插件表”。其中 `anynote.ai.proposals` 保存提案的 proposed/applied/undone 状态，`anynote.core.revision-meta` 保存修订元数据，`anynote.core.transfer-source`/`anynote.core.transfer-target` 保存跨库操作回执。删除它会破坏用户数据和重试安全。Rust 用明确的内置仓储函数读写这些命名空间；第三方记录视为不执行的兼容数据，原 JSON 原样保留，不再暴露插件 API。[提案](../../packages/storage-sqlite/src/proposals.ts)、[跨库转移](../../packages/storage-sqlite/src/transfer.ts)

### 2.3 四种不同的数据交换与备份格式

| 格式            | 当前结构与版本                                                                                                                                                    | 兼容要求                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 完整 `.anynote` | ZIP/ZIP64；`manifest.json`、`notebook.sqlite`、CAS 附件；`format=anynote.notebook`、`formatVersion=1`、`schemaVersion=5`                                          | 保留完整与“仅当前内容”两种导出语义；manifest 中历史/回收站/扩展状态声明与 `requiredExtensions` 内容要求继续可读写 |
| `.anyclip`      | ZIP；`format=anynote.capture`、`version=1`；`content.md`、`assets/<sha256>.<ext>`、来源及缺失媒体报告                                                             | 原样验证格式/大小/hash/路径；导入时重映射资源 ID；不作为 Notebook 恢复包处理                                      |
| 本地备份        | `AnynoteBackup/backup-root.json`，根标记版本 1；`notebooks/<id>/.backup/manifest.json` 为 `anynote.local-backup` 版本 3；1 MiB DB 分块、CAS 附件、pending/cleanup | 保留目标 ID、修订、文件 token、已验证状态及待清理 journal；恢复到新的工作库                                       |
| Cloudflare      | `format=anynote.sqlite`、`protocolVersion=1`、`schemaVersion=5`；D1 记录元数据、R2 保存 manifest/对象                                                             | DB 物理分块和整附件独立寻址；保留 generation/lineage/device/writer epoch/CAS head，不转为云端笔记 CRUD            |

来源：[归档流与 manifest](../../packages/storage-sqlite/src/archive-stream.ts)、[归档模式](../../packages/storage-sqlite/src/archive-content.ts)、[采集格式](../../packages/capture/src/format.ts)、[本地备份](../../packages/backup-local/src/index.ts)、[云快照](../../packages/backup/src/cloud-snapshot.ts)。当前这些格式使用 ZIP 或对象文件布局；迁移不另加 tar 容器。

`requiredExtensions` 仅为内容类型/版本及数据 schema 清单，现实现已经说明它不是安装或执行指令。Rust 保留它以供旧归档消费者理解，使用内置能力或未知内容降级显示；绝不据此安装、加载插件。[内容要求](../../packages/storage-sqlite/src/archive-content.ts)

普通 Markdown 导出另有目录或 ZIP 模式，生成 `EXPORT-MAP.json`、`EXPORT-REPORT.txt`、`_assets`、白板原始 scene/嵌图场景/预览与注释 JSON sidecar。保留其现有能力损失说明，不能标成完整恢复格式。[开放导出](../../packages/storage-sqlite/src/open-export.ts)

## 3. Rust 存储与数据模型实现

### 3.1 兼容实现顺序

1. 冻结现行 SQL 与格式样本，保存 schema 文本和测试生成器；先实现只读 catalog、树、正文、历史、附件、批注、搜索和诊断。
2. 实现与现行锁兼容的写连接、事务、`expectedRevision` 条件更新、资源写入和 revision 闭包，再启用编辑保存。UUID、时间戳单位、整数边界与 JSON 字段必须明确，不依赖语言隐式转换。
3. 按原 SQL 文本创建新库；旧库正常启用时只执行已有 `initializeBackupRevision` 语义，不在迁移阶段新增/删改业务表、FTS 定义或触发器。仅 FTS 被明确认定为可重建缓存，重建须使用同一正文/标签/PDF 文本规则。
4. 迁移树移动、回收站、历史恢复、跨库复制/移动、AI 提案、完整性检查和清理。跨库操作保持“目标提交成功，核对源和目标指纹，最后软删除源”的顺序；相同 operationId 读取回执，不重复复制，也不删除后续变更过的源。

可移植数据与进程缓存分开：`contentSeq`、`storageEpoch` 在本地修订协议中为十进制字符串；云端 `snapshotSeq` 为 JavaScript safe integer，Rust 超出上限时必须明确拒绝上传，不截断、不四舍五入。[数值边界](../../packages/backup/src/snapshot-metadata.ts)

本地备份零捕获优化有一个容易遗漏的限制：`Storage.localBackupRevision` 使用当前写租约的临时 lineage，重新打开连接会生成新的 lineage。Rust 迁移或进程重启后必须重新捕获和校验，不能因持久化 `_backup_revision.lineage_id` 相同而跳过检查；它也不能与 Cloudflare 目标的 `lineageId` 混为一谈。[连接与修订读取](../../packages/storage-sqlite/src/index.ts)、[本地捕获](../../packages/backup/src/local-capture.ts)

### 3.2 SQLite、文件与线程职责

- 后端存储线程独占可写 `rusqlite::Connection`，按命令顺序提交；禁止把连接分散到任意 Tokio task 并发写。只读任务使用有界连接与取消，延续现行 LRU/pin 行为。
- 捕获在写序列边界使用 SQLite Backup API，包含已提交 WAL 页；不直接复制仍活动的 `notebook.sqlite` 文件，不执行 VACUUM 重排备份页。
- 冻结副本与不可变附件闭包一起成为任务输入。原实现对同卷附件 hard link、跨卷 copy；Rust 保持该策略，但后续所有读仍检查大小和 hash，只有资源被保证不可变时才可使用 hard link。
- 备份副本只修剪未被引用的 asset 记录并保留源 storage epoch，不能清理源库；hash/压缩/上传在写队列外运行，任务结束释放 pin、快照、句柄和临时 lease。
- 所有用户文件路径经过根目录授权、相对路径和 symlink/junction 检查；Rust 用打开后的句柄身份与路径复核减少 TOCTOU，不把一次 `canonicalize` 当作长期授权。

依据：[一致性快照](../../packages/storage-sqlite/src/database-snapshot.ts)、[文件快照](../../packages/backup/src/file-snapshot.ts)、[本地相邻文件授权](../../packages/importer/src/directory.ts)。使用系统 SQLite 的备选方案虽减少打包体积，但平台版本/FTS5 能力不可控；首选锁定 bundled SQLite，并在升级 SQLite 时重复物理快照及旧客户端回读测试。

### 3.3 序列化规则

数据库中的 Markdown、未知 JSON 与未编辑白板场景不因读取而规范化。Rust 的 schema 校验应复制各入口当前的 strict/passthrough 行为；不能一概丢弃未知字段。

`.anyclip` 的 digest 是当前 `canonical()` 对 manifest 递归排序后的 UTF-8 SHA-256，不能只用 `serde_json::to_string`。黄金样本覆盖 key 顺序、数组、Unicode/转义、缺省字段、null、数值边界；需要比较 JavaScript 字符串 key 的 UTF-16 排序与 Rust 排序差异。[canonical 定义](../../packages/capture/src/format.ts)

Cloudflare generation 的幂等检查绑定上传的 manifest 字节；已有 `upload.cut` fingerprint 又依赖 TS `JSON.stringify`。Rust 恢复旧续传会话时优先保留并验证原始 manifest/会话身份；不能仅因解析对象“相等”就复用 generation ID。不能精确复原旧字节时先查询旧 generation 状态，保留已提交结果或按协议创建新的 staging generation。[续传会话](../../packages/backup/src/transfer-session.ts)、[云快照](../../packages/backup/src/cloud-snapshot.ts)

## 4. 导入、备份与 Cloudflare 行为

### 4.1 导入任务

Rust 内置导入负责 URL/HTML/Markdown/文件/`.anyclip` 的发现、预览、媒体本地化、原始 HTML 可选留存、缺失清单、确认提交与失败媒体重试。HTML 解析/清洗/正文提取用 Rust 库组合，当前 Turndown/Readability 的业务规则以黄金样本约束；第三方 HTML-to-Markdown 库输出不是自动通过标准。表格、链接协议、ChatGPT 卡片、懒加载媒体、相邻本地资源和未知内容必须逐项对照。[HTML 导入](../../packages/importer/src/html.ts)、[转换规则](../../packages/importer/src/convert.ts)、[提交/报告](../../packages/storage-sqlite/src/import-contracts.ts)

网络抓取保留现有 SSRF 防护、重定向/最终地址校验、响应大小和超时；本地目录授权保留目录 dev/inode/realpath 和句柄复核。导入成功后失败媒体仍可单独重试，重试必须校验当前正文中的占位标记和 revision，不覆盖用户编辑。[抓取](../../packages/importer/src/network.ts)、[授权](../../packages/importer/src/directory.ts)、[导入操作](../../packages/storage-sqlite/src/operations.ts)

保留入口各自预算，不能因 Rust 能流式处理而提高所有入口上限：普通单文件 50 MiB；旧归档/API 100 MiB；桌面流式归档与开放导出 20 GiB；跨库最多 10,000 节点，记录/附件各 100 MiB；HTML 10 MiB、媒体最多 200 项/单项 20 MiB/总 80 MiB、4 路并发、30 秒响应、40 MP 图像解码。`.anyclip` 另有 90 MiB 包体、8 MiB 正文、1 MiB manifest、202 entries 上限。[预算](../../packages/protocol/src/import-limits.ts)、[采集预算](../../packages/capture/src/format.ts)

### 4.2 本地备份

1. 校验备份根 `targetId`、实际路径、运行期间设备身份、源目标无交叠、空间和单文件限制；不支持的网络/云盘挂载继续拒绝。Linux mountinfo、macOS diskutil/mount 和 Windows 卷身份分别实现平台适配。
2. 保留 1 MiB 有序 DB chunk 列表，重复 hash 不等于重复位置可删除；附件仍为整文件，不改变现有 manifest。
3. 先写 `.backup/pending.json`，复制/hash/fsync 新分块和附件，原子发布新 manifest，最后仅清理由旧 manifest 管理且新版本不引用的文件。清理失败返回“备份已更新但清理待重试”。
4. 对现有 token 使用保守校验：迁移进程/平台的 inode 或时间表示不一致时重新 hash，不据 token 假定匹配；保留显式全量验证与损坏报告。
5. 恢复先装配到私有 staging，校验 DB、schema、hash、树和资源闭包后发布为新 Notebook。备份目录始终不能直接作为可写工作库打开。

依据：[引擎及恢复](../../packages/backup-local/src/index.ts)、[路径/fsync/token](../../packages/backup-local/src/files.ts)、[文件系统探测](../../packages/backup-local/src/filesystem.ts)、[卷适配](../../packages/backup-local/src/volume.ts)。Windows 必须新增真实 NTFS/exFAT 测试；现有 Linux/macOS 探测代码不能被当作 Windows 已验收证据。

### 4.3 Cloudflare 客户端

Cloudflare Worker、D1 migrations、R2 对象布局及浏览器扩展继续 TypeScript。Rust 仅替换桌面客户端，实现以下现有协定：[Worker 路由](../../apps/cloudflare-backup/src/index.ts)、[云端采集](../../apps/cloudflare-backup/src/capture.ts)、[对象约束](../../packages/protocol/src/cloud-objects.ts)。

| 协定                   | Rust 必须保持的行为                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| capability negotiation | 先请求 `/v1/capabilities`；校验 protocol/schema 与所用能力。缺 `capture-v1` 可以保留旧服务基本备份行为并明确采集不可用；缺 `sqlite-assets-v1` 必须拒绝不兼容备份，不误判为 token 错误 |
| plan → upload → commit | 保持 `generationId,lineageId,deviceId,expectedHead,writerEpoch`；本地先保存 pendingGeneration；commit 丢回包后查询 generation 状态，不能盲目重建提交                                  |
| 对象                   | DB 块 1 MiB；单次缓冲上传 20 MiB；大附件 multipart part 32 MiB；总对象预算 20 GiB；每块/整文件 hash 和大小双校验                                                                      |
| 冲突                   | `HEAD_CONFLICT`、`WRITER_REVOKED`、`IDEMPOTENCY_CONFLICT`、`GENERATION_RETIRED`、维护状态分别处理；不自动接管 writer、不自动覆盖 head                                                 |
| 续传                   | 会话身份绑定连接、endpoint、notebook、lineage、方向，上传还绑定 device/epoch；数据切面或 manifest 改变即废弃复用资格；已上传 parts/ETag/hash 必须再与远端核实                         |
| 恢复                   | 下载已提交 generation、验证身份/schema/manifest/hash；支持 restore pin 与 30 秒续租，失败/取消释放；恢复为新库，保留 sourceNotebookId 与远端 lineage 的区别                           |
| 维护                   | 保留 writer 接管、预览/执行 retention、日/周/月保留、受保护 head/pin/staging、维护状态/恢复及 tombstone 重放拒绝；只有用户原有明确动作才能触发删除                                    |
| 调度                   | 保留离线、电池、计费网络、大任务暂停；认证/永久/耗尽暂停必须显式修复；Retry-After、指数退避和 jitter 优先级一致                                                                       |

续传和调度依据：[客户端](../../packages/backup/src/providers.ts)、[上传/恢复](../../packages/backup/src/cloud-snapshot.ts)、[持久游标](../../packages/backup/src/service.ts)、[策略](../../packages/backup/src/policy.ts)。

采集端完整闭环必须实现：浏览器上传 `uploading → queued`；当前 writer 使用限时 claim 和 `targetVersion` 消费；父目录失效则 ack `needs-target`；本地事务提交正文、资源和 capture_receipt 后 ack `applied`；下一次同一数据库切面的备份带上 captureAcks，远端只有验证 `digest/noteId/appliedSeq/writerEpoch` 且 `appliedSeq <= snapshotSeq` 后才标记 `backedUp`。ack 丢失重试不得插入第二篇笔记。[桌面消费](../../packages/backup/src/capture.ts)、[云端确认](../../apps/cloudflare-backup/src/capture.ts)

浏览器阅读对象必须从实际上传的 DB 快照派生，不能从正在编辑的实时库拼装。保持 tree 页 100 条、路径 `tree/<parent|root>/<page>`、`note/<id>` 与资源闭包；browse 超预算可按当前实现省略，但 captureAcks 证据仍要发布。[浏览快照](../../packages/backup/src/browse-snapshot.ts)、[共享结构](../../packages/protocol/src/cloud-capture.ts)

### 4.4 TypeScript 包保留清单

| 保留方              | 实际依赖                                                                               | 迁移处理                                                                        |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 浏览器扩展          | `@anynote/capture`、`@anynote/importer`（`convert`、`discovery`）、`@anynote/protocol` | 保留 TS 模块与构建，不随桌面删除 importer；需要拆 Node 入口时保持浏览器导出路径 |
| Cloudflare Worker   | `@anynote/capture`、`@anynote/protocol`、`@anynote/types`                              | 保留 TS 验证/共享类型；Rust 使用共享 fixture，不把这些包打入桌面                |
| TypeScript 验收工具 | 当前 backend/storage/backup 及其测试适配器                                             | 迁移对照期保留为行为参考；Rust 替代验收覆盖建立后再移除桌面专用 TS 路径         |

证据：[扩展依赖](../../apps/browser-extension/package.json)、[实际导入](../../apps/browser-extension/src/convert.js)、[Worker 依赖](../../apps/cloudflare-backup/package.json)、[共享 capture](../../packages/capture/package.json)、[共享 protocol](../../packages/protocol/package.json)。构建脚本中 Worker 当前还调用 `build:backend`；切换桌面后必须把保留服务的构建闭包独立出来，再删除 Node 桌面组件，不能只按 package 名一刀切。

## 5. 设备配置、凭据与首次切换

### 5.1 配置分类

首版固定“原数据路径接管、设备配置分区”的布局。`<userData>` 指预检确认的原 Electron 用户数据根；保留应用身份，按当前实际安装路径及标记定位，非默认路径允许用户明确选择，不以新 Rust 路径库的默认目录悄悄创建空工作区。

| 目标路径                                        | 用途及激活规则                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `<userData>/notebooks/`、各外部 Notebook 原目录 | 正式库规范路径保持不变。只有验证副本通过、原目录指纹复核且独占锁成功后才启用 Rust 写入；不把 staging 注册为第二份同 ID 正式库 |
| `<userData>/notebooks/_local/`                  | 现有目标/任务/策略按原格式继续存放；内置业务所需配置不复制到另一套可分叉目录                                                  |
| `<userData>/rust/preferences.json`              | Rust 设备偏好，使用点分层键；只保存外观/导航/阅读位置等非秘密值，temp + flush + 原子替换                                      |
| `<userData>/rust/workspace.json`                | 设备启动选择：版本、原 storage root、最近 Notebook ID 及迁移状态；不是另一份 Notebook/外部目录注册表，也不改旧程序认识的路径  |
| `<userData>/rust/migrations/<id>/journal.json`  | 当前迁移步骤、源身份/指纹、完整保全清单、验证结果；所有更新可重入                                                             |
| `<userData>/rust/migrations/<id>/preserved/`    | 原配置、密文、Local Storage 和托管库/用户文件的完整保全副本；按受保护权限保存，不作为可写库注册                               |
| 同卷私有 `.anynote-migrate-<id>/`               | 外部库的 staging/保全，先校验可用空间与用户选定位置；路径写入 journal，不随库内清理删除；管理库的 staging 放在该迁移目录中    |
| OS 凭据库                                       | 后续秘密值，逻辑引用保留原 secret ID；原 `secrets/*.bin` 仅保全，不把明文写进迁移目录                                         |

旧 Electron 不认识 `rust/workspace.json`，所以回退不能只改 Rust 指针。由于 Notebook 规范路径保持原样，停止 Rust 并释放锁后，旧客户端应直接打开经验证的最新原路径；若必须从副本恢复，则先同卷验证/发布到原规范路径，并同步原格式外部目录登记。原始数据路径未迁移就不制造跨目录原子切换问题。单实例平台适配在 M1 验证与旧安装的互斥/进程检测；Notebook 的最终写保护仍依赖同一 SQLite 独占锁，不能只靠一个 Rust 私有锁文件。

| 分类           | 当前来源                                                                                                                                  | 切换策略                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 必须保留       | `_local/backup-targets.json`、`local-backup-targets.json`、`backup-policy.json`、`recovery-connections.json`、`notebook-directories.json` | 校验后继续使用原路径，另留保全副本；保留 target/disk/device/lineage ID、远端 head、暂停原因与用户策略；首次验证完成前暂停自动发布/清理 |
| 必须解释       | `_local/task-history.json`、`integrity-reports.json`、`diagnostics.json`                                                                  | 保留脱敏证据；原 running/committing 标为 interrupted；不恢复内存 worker/controller                                                     |
| 需核实后恢复   | `_local/cloud.transfers`、临时 job lease、pending/cleanup                                                                                 | 获取新 OS 租约后验证冻结身份和数据；无法复用就留下可诊断状态/重新计算，不宣称任务已完成                                                |
| 退役但保留数据 | `_local/extensions`、旧扩展包/下载、extension_data 第三方记录                                                                             | 归档且不执行；不继续更新调度，不加载权限/通信/生命周期系统；不把用户数据作为缓存清理                                                   |

配置与证据来源：[连接](../../packages/backup/src/connection.ts)、[本地目标](../../packages/backup/src/local.ts)、[恢复连接](../../packages/backup/src/recovery.ts)、[任务历史](../../packages/storage-sqlite/src/task-history.ts)、[诊断](../../packages/storage-sqlite/src/diagnostics.ts)、[临时租约](../../packages/storage-sqlite/src/temporary-jobs.ts)。

### 5.2 Local Storage 偏好

当前已发现 `anynote.appearance`、`anynote.navigation.tabs`、`anynote.notebooks.visits`、`anynote-recent`、`anynote-book`、`anynote-pdf-<book>-<note>`、`anynote-image-<book>-<note>`。后两者分别保存页码及 `{fit,zoom,rotate}`。[主界面](../../apps/desktop/src/main.tsx)、[外观](../../apps/desktop/src/appearance.ts)、[PDF](../../apps/desktop/src/PdfReader.tsx)、[图片](../../apps/desktop/src/ImageReader.tsx)

Rust 新增键使用 `a.b.c` 约定；旧键只作为读取映射保留。首次切换关闭旧应用，复制完整相关 Chromium origin 存储目录，只读解析实际 LevelDB/Chromium value 编码，严格按本应用 origin/key 白名单提取，写入例如 `anynote.navigation.recent`、`anynote.navigation.activeBook` 和阅读状态。不能仅把旧 key 改名便宣称迁移完成，也不能假设 Electron userData 下存在可直接读取的偏好 JSON。

此解析器是有边界的一次性 Rust 适配，须由真实 Electron 版本在 macOS/Windows/Linux 各生成 fixture，覆盖开发 URL 与打包 file origin、UTF-16 值及异常关闭。库选型以兼容这些样本为门槛，不引入 JavaScript 或调用 Electron。无法读出的偏好保留原始副本并在预检中显示，阻止“配置已完整迁移”的结论；正文读取不依赖偏好恢复。

### 5.3 凭据

当前凭据通过 Electron `safeStorage.encryptString(JSON.stringify(value))` 写入 `secrets/<id>.bin`。Linux 明确拒绝 `basic_text`；目标 JSON 只保存 `credentialsMode`，没有 token。Rust 的通用 keyring crate 不能自然读取这种密文文件。[实际实现](../../apps/desktop/electron/main.cts)

选用 Rust 系统凭据适配器，将新秘密保存到 OS 原生凭据库，服务名/键命名使用点分层。迁移分两个明确结果：

1. 同一用户、同一设备：针对锁定 Electron 版本的实际密文封装及 OS 后端实现一次性只读解密，使用 Windows/macOS/Linux 系统安全 API；只将内存明文写入新 OS 存储，逐条验证读取成功，不记日志或导出明文。此项必须用三个平台旧程序生成的 fixture 实测，未验证前不宣称支持自动迁移。
2. OS 权限拒绝、keyring 锁定、跨设备复制或封装不支持：保留旧密文/连接 ID/endpoint，标记“需重新提供凭据”，允许用户重新录入原 token；本地资料仍完整可用，远端自动任务暂停。新 token 经原 endpoint capability 测试成功后更新相同目标的凭据，禁止创建重复分支或清空云数据。

不将 token 写入普通 JSON，不使用“为了兼容”而附带 Electron/Node 解密助手。重新认证是受限情况下的恢复路径，不应被算成无损自动凭据迁移。发布前必须明确各平台支持矩阵与失败提示。

### 5.4 首次切换状态机与回滚

采用 `preflight → copied → verified → activated` 的设备侧迁移 journal，含迁移 ID、来源/目标路径、版本、每阶段完成标记与脱敏错误；写入 temp、flush 后原子替换。不得在新 schema v5 Notebook 内增加迁移表。

1. **预检**：找到用户实际 userData 与外部登记；关闭旧进程、验证 SQLite 锁；列出各目录空间预算、云游标、待提交任务、凭据/偏好可迁移状态。仍运行旧 writer、离线外部库或未完成关键验证时不启用该库的 Rust 写入。
2. **私有复制**：在同文件系统创建 staging；已关闭库复制 DB/必要 sidecar 并在副本完成恢复校验，附件复制并校验。迁移保全副本保留所有原文件（包括孤立附件、第三方状态），不得复用会修剪 orphan assets 的普通备份作为唯一保全副本。外部库需逐库准备独立保全副本和切换记录；用户原路径不自动移动。
3. **验证**：对比原库与候选的逻辑表行数/ID/正文/JSON/历史/资源 hash/引用闭包，运行 `integrity_check`、外键检查、树检查和格式互读。迁移 journal 记录副本清单；快照中数值和原始文件与原库比较。
4. **激活**：封存完整保全副本，复核原目录指纹，取得同一 SQLite 独占锁，继续使用原规范路径；首版不需要用转换后的 DB 替换原库。以原子文件替换激活 Rust 设备偏好和 workspace 状态，各文件分别记录 journal，不能把多文件更新假设为一个原子操作。崩溃恢复按 journal 重放；未通过的库保持只读/不可用并显示原因。staging 仅供验证，不成为第二个正式写入入口。
5. **恢复后台任务**：重新检查连接身份、远端 pending generation、writer epoch、磁盘 targetId；确认已提交则修复游标，未提交按冻结数据恢复或重开 staging。首次切换不自动接管远端 writer，不执行 retention/旧插件清理。
6. **回滚**：两种分支都先暂停调度、停止接收新写入、排空已接收的提交，并维持旧新实例互斥。尚无 Rust 新写入时只恢复切换前的 Rust 专属启动/偏好配置，不回退可能已被备份更新的共享 `_local` 云游标。已有新写入时保持冻结状态，生成完整已验证保全副本和 `.anynote`，在隔离副本验证旧 TS 程序能读最新 schema v5；保全和校验结束后才停止服务、释放锁、启动旧客户端使用最新原路径。必须从备份发布时按 §5.1 恢复原规范路径，不能只改 Rust 指针。禁止直接换回旧快照而丢失切换后的笔记，也禁止回退 `lastGeneration`/writerEpoch 造成云 head 冲突。原始数据与密文只在用户明确决定后删除。

回退配置单独核对：`_local` 仍为共享的现行格式，不回退其新游标；Rust 新增/修改的 UI 偏好先保全，按已知键逆映射到 Chromium 存储副本，离线验证后才原子发布，失败时保留两份并报告尚未回填的值。Rust 期间更新的秘密不会自动出现在旧 safeStorage 文件中；旧客户端需要重新认证时保持任务暂停，不能把旧密文视为最新凭据。回退数据无损与“旧 UI 偏好/凭据自动恢复”分别验收。

首次接管不移动数据路径。仅在需要从副本恢复且跨卷时，采用“复制到原规范路径所在卷的 staging → 校验 → 同卷发布”；中断不得删除来源。断电持久性由文件/目录 flush 与平台测试证明，不能仅据 `rename` 返回成功推断。

## 6. 实施依赖与验收矩阵

以下 D 编号是总方案阶段内的数据工作包，顺序为 `D1 → D2 → D3 → D4 → D5 → D6`；D3 的导入和备份引擎可在 D2 的稳定接口后并行，但不能先开放生产写入。映射为 D1→M0/M1、D2→M2/M3、D3→M3/M5/M7（本地备份）、D4→M7、D5→M1技术原型与M8完整切换、D6→M9。D5 的正式激活还必须等待 M4–M7 全部功能通过，不以数据工作包完成替代编辑器/媒体门槛。

| 工作包            | 前置               | 具体产物                                                                    | 可验证完成条件                                                                                                           |
| ----------------- | ------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| D1 格式基线       | 当前 TS 版本固定   | 合成 fixture 生成器、schema/manifest/protocol/JSON 样本、功能与异常案例清单 | TS 可生成并自校验，包含未知扩展、完整/当前归档、未提交 WAL、跨库回执、缺失附件、三平台偏好和凭据 fixture；不使用真实秘密 |
| D2 Rust 存储      | D1、Rust 后端 IPC  | catalog/读写队列/LRU/锁/事务/资源/历史/搜索/组织/提案                       | 旧库原样读；TS↔Rust 交替写不会丢数据；同时打开只有一个 writer；冲突不覆盖；表和引用逐项等价                             |
| D3 导入及文件服务 | D2                 | 导入预览/确认/重试、流式 ZIP/ZIP64、开放导出、完整性/诊断、本地备份 v3      | TS 导出→Rust 导入与反向均通过；边界与恶意归档被拒；取消/磁盘满/卷拔出保留旧成功快照；恢复新库可打开                      |
| D4 云协议         | D2、D3 快照        | Cloudflare v1 客户端、续传、采集、浏览投影、恢复/维护/调度                  | 现有 TS Worker 与未改的扩展全流程通过；commit/ack 丢包幂等；writer/head 冲突拒绝；pin/retention 交互正确                 |
| D5 首次切换       | D2–D4              | Rust 迁移 journal、偏好/凭据适配、预检与回滚 UI                             | 三平台逐步骤故障注入，可重复运行；无原文件/孤立资源/未知状态丢失；凭据未解密不启动云任务；回滚包含新写入                 |
| D6 发布兼容       | D5、全桌面功能完成 | 回归报告、固定硬件性能对照、真实设备/云验证记录                             | 下表所有发布必需项有独立证据；未完成项阻止声称全功能迁移完成                                                             |

| 测试组     | 输入与操作                                                                                                                         | 判定标准 / 对应现有参考                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB 与锁    | schema v5 有/无完整 backup tracker、损坏 tracker、WAL、中文/emoji、短查询、损坏/离线外部库、并发旧/新实例                          | 正常数据和搜索等价，异常分类明确；无双 writer；`storage/workspace/search/recovery-diagnosis` 测试的业务断言迁入 Rust                                    |
| 历史与资源 | 所有 note 类型、历史图片/白板嵌图、标签/收藏、回收站、跨库重复 operationId、提案 apply/undo 后正文被修改                           | 字节/hash/引用/ID 完整，条件更新与幂等相同；参考 `transfer`、`recovery`、`integrity-inspection`                                                         |
| 归档互操作 | TS↔Rust 完整/当前 `.anynote`、ZIP64、`.anyclip`、Markdown directory/ZIP、未知 JSON、路径穿越/重复 entry/压缩炸弹/大小与 hash 错误 | 每个声明与实际内容一致；完整数据可恢复；当前导出不泄漏旧页/FTS；参考 `archive-stream`、`capture`                                                        |
| 导入       | URL 重定向/私网、恶意 HTML、表格、原始 HTML、授权目录置换、媒体失败后编辑正文再重试                                                | 不跨授权读文件、不覆盖后续编辑、不丢报告；参考 `web-import`、`capture-components`                                                                       |
| 本地备份   | 无修改快路、重启失效、重复 DB 块、分块写后/manifest发布后中断、卷身份变化、FAT32大文件、NTFS/exFAT/APFS/ext4                       | 原成功快照始终可恢复；只删 journal 管理文件；full verify 报告真实损坏；参考 `backup-local` 和卷 fixtures                                                |
| 云协议     | 原 TS Worker、旧 capabilities、plan/part/commit 丢包、改 token/epoch/head、capture 重复 claim/ack、目标删除、浏览分页              | 不重复导入、不虚报 backedUp、不丢 pendingGeneration；旧能力明确降级；参考 `cloud-capture`、`cloud-recovery`、`maintenance-recovery`、`retention-policy` |
| 偏好/凭据  | 三平台实际 Electron fixture、keyring锁定/拒绝/无服务、file/dev origin、多来源路径                                                  | 兼容字段逐项对照；失败提示可操作，旧密文不变；明文不落盘、不出日志                                                                                      |
| 性能与资源 | 固定数据集分别运行旧 TS 与 Rust：1k/10k/100k节点、历史/附件密集库、20GiB流式边界；SSD/移动盘分别记录                               | p50/p95搜索、保存队列等待、捕获阻塞、复制/上传吞吐、RSS峰值、打开句柄/任务数与取消耗时；标准见总方案，未达标保留失败，不以单测通过替代                  |
| 真实部署   | 隔离的小型 Cloudflare 测试 Notebook、三平台系统密钥服务、应用/系统重启、真实 24h/7d 老化                                           | 报告分别注明 local、local-workerd、real-cloud、real-device；真实网络与真实时间证据独立保存，不能沿用旧部署被清除的老化样本                              |

现有测试是可复用的业务基准，不代表 Rust 已通过。先把格式 fixture 与纯状态机断言跨语言执行，再增加 Rust 子进程崩溃及 GPUI 端到端测试；Electron 特有 IPC 细节不逐行复制到新测试。源码测试目录为[tests](../../tests/)，旧真实验收边界见[Cloudflare 验收](../development/validation/CLOUD-ACCEPTANCE.md)。
