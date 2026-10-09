# 本地磁盘备份

桌面应用的「备份 → 本地磁盘备份」为当前 Notebook 选择目录，在其下初始化 `AnynoteBackup`。可在目标卡片中选择全部或部分 Notebook，并批量备份/恢复；任务按目标串行，附件默认并发为 2。仅维护当前副本，不生成历史版本。

## 数据与提交

- `packages/backup/src/local-capture.ts` 在 Storage 写队列内调用 SQLite Online Backup API，读取完成副本中的元数据与资源闭包；仅在临时数据库中去掉没有资源、历史、批注或正文引用的 Asset 登记，源数据库不变。Notebook pin 覆盖捕获、复制与提交；源目录孤立文件、缓存、快照和凭据目录不纳入备份。
- 新附件及数据库均流式复制到目标盘临时文件，重读 SHA-256、同步文件，再执行同盘替换。数据库最后发布；不会先删除旧数据库来绕过替换失败。
- `prepared.json` 保存新清单、引导信息、旧/新数据库哈希及新清单哈希。下次备份、校验或恢复会先协调中断状态。数据库不匹配旧/新哈希时停止写入和清理。
- 删除仅来自旧受管清单且已不在新资源集合中。清理失败保留 prepared 与清理清单；当前备份可恢复，下次幂等重试。用户文件保留。
- 目标 UUID、绝对路径组件与 symlink/junction 检查覆盖初始化和任务阶段。整个目标使用 OS 支持的 SQLite 独占 lease；进程退出即释放，避免按超时猜测并删除陈旧锁。
- 自动检查默认间隔为 10 分钟（需用户开启），可选择重新接入磁盘时触发。挂载重新出现的检测基于调度轮询，最多受一分钟检查周期影响。

## 增量与校验

`backupRevision` 由 Notebook 身份、lineage、业务 `contentSeq`、schemaVersion 与 `storageEpoch` 组成。v2 的所有持久化表通过事务内触发器推进 `storageEpoch`，包括插件数据和历史维护；FTS 缓存不推进。计数以十进制字符串读取，避免大整数精度损失。v1 库先迁移再安装版本标记；旧 v2 库首次写入时安装。可选版本元数据按完整结构校验，不能据此放行其他未知表或触发器。

无变化备份比较版本、快速检查目标数据库/引导/附件 token，并在同一写队列中再次确认源切点。全部匹配时跳过 SQLite 捕获及内容复制；源引用资源仍检查存在和大小。目标异常、版本不匹配或无法证明版本可靠时，回退到一致性捕获与哈希。损坏的版本标记会停止发布，保留现有备份。

持久化 lineage 在恢复/身份重映射时重置；快路径额外绑定当前写连接的 lineage。应用重启或写连接被 LRU 淘汰后，首次任务保守捕获，防止替换/分叉数据库复用旧版本。若内容哈希相同，仅更新清单切点，不复制数据库与附件；随后可再次跳过捕获。这个连接范围内的保证尚未扩展为跨会话免捕获优化。

附件使用数据库登记的不可变 SHA-256 身份。普通任务检查目标大小及纳秒 mtime/ctime/inode token，异常时重新读取目标哈希并修复；这是快速检查，不是全量校验。「校验备份」会读取全部受管文件，检查 SQLite 与数据库资源清单。校验逐文件收集缺失、大小不符、哈希不符、读取失败和 SQLite 错误，报告保留路径、错误码及期望/实际值。取消或目标身份变化会中断并标记未完成；这些结果不能当作完整校验通过。任务中心展示汇总与异常明细，异常列表按每次 50 项展开。

闭包包含 Resource API 登记、历史 Revision、批注和正文引用，因此历史、回收站与插件持久化资源得以保留。源目录孤儿文件与无引用 Asset 行不备份；备份不推断任意插件缓存中的文件引用。

预览与实际执行共用差异计划，展示复制、跳过、提交后删除和额外空间预算。删除达到至少 20 个附件且占旧集合一半时暂停任务，需预览确认；确认绑定源切点与旧清单，内容变化后失效。

成功结果包含复制/跳过/删除计数、复制字节、捕获及计划检查耗时、写后校验耗时、切点与清理状态。校验耗时为各文件校验时间累计；并发时不等于任务墙钟时间。批量结果分别记录每个 Notebook 的完成、失败、等待磁盘及恢复身份。

## 恢复与配置

恢复界面展示当前副本完成时间、资源规模、完整校验时间及中断状态。恢复先校验当前副本，再复制至本机临时工作目录，复用已有独立校验线程迁移格式、重建索引、重映射 Notebook 身份并登记新 Notebook。禁止直接将受管备份目录作为工作库打开。

移出备份范围只删除本机配置，保留磁盘副本。修改位置更新当前配置，保留原磁盘副本。单独删除 Notebook 备份仅删除清单登记的文件；需要在 UI 中确认。

清单丢失可从现存数据库显式重建，检查 SQLite 与内容寻址附件后标记 `rebuilt-needs-review`。重建不能证明数据库与过去源状态逐字节一致。

## 公开 SDK

`@anynote/plugin-sdk` 导出可移植的本地备份契约及 `createLocalBackupAPI` 宿主适配器。长任务返回 ID，通过 `getTask` 查询统计、结构化校验报告及恢复后的新 Notebook 身份；配置操作仍调用宿主目录选择器，不接收调用方路径。接口未授予扩展新的权限，详见 [SDK 使用说明](../plugin-sdk/README.md#宿主本地磁盘备份接口)。

## 文件系统能力

Linux 通过 statfs magic 与 `/proc/self/mountinfo` 报告磁盘名称、文件系统、挂载点与可用空间。macOS 先用 `df -P` 定位设备节点，再用 `diskutil info -plist` 取得文件系统类型、用户可见卷名与稳定 `VolumeUUID`（`volumeIdentity: "volume-uuid"`），`mount` 表作为回退并保留网络挂载与可移动介质判断；命令输出解析为纯函数，工具缺失、输出损坏或平台不支持时降级为 statfs 基础信息，绝不因探测失败中断检查。目标路径先取真实路径再匹配挂载表，避免 macOS `/var`、`/tmp` 等符号链接前缀被误判为 `/`。

两个平台都拒绝已识别的网络/云挂载，并按归一化文件系统名（Linux 还结合 statfs magic）判定 FAT32 的 4 GiB−1 单文件限制；exFAT 不设该限制。真实复制前在独占临时目录探测覆盖替换、同步与读回；不会触碰现有 Notebook 文件。每阶段验证目标标记，任务期间还验证文件系统设备标识。Windows 的稳定卷标识与能力适配尚未完成。

## 验证与平台边界

`tests/backup-local.test.mjs` 覆盖首次复制、零复制增量、WAL 内容、捕获后继续编辑、恢复、取消、真实 SIGKILL、提交协调、并发进程 lease、空间不足、数据库占用、受管清理、未知文件保护、路径攻击和清单重建。

运行：

```sh
pnpm run build:backend
pnpm exec vitest run tests/backup-local.test.mjs
pnpm run typecheck
pnpm run test:desktop:local-backup
```

桌面验收在隔离临时数据中启动生产 Electron 窗口和真实 Utility Process，覆盖目录授权/取消、范围和计划、增量统计、组合输入保护与保存、异常删除确认、批量部分失败、损坏报告、恢复保护与新库导航、大附件复制取消。原生对话框使用临时目录适配器；组合事件由自动化派发，不能代替真实输入法硬件验收。结果写入 `artifacts/local-backup-acceptance.json`，失败会写入 `passed: false`，临时数据自动移除。需要可用的桌面显示环境；可设置 `ANYNOTE_EXECUTABLE` 验收已打包可执行程序。

`tests/backup-local.test.mjs` 的文件系统测试使用录制并合成到 `tests/fixtures/volume/macos/` 的 `diskutil -plist`、`mount` 与 `df` 输出，逐项覆盖解析、平台合并、自闭合空值、损坏输出、网络/自动挂载、转义空格与最长挂载点优先，并断言降级不会抛错。

macOS/APFS 实盘验收：

```sh
pnpm run test:macos:volume
# 真实 Electron 与 Utility Process 在 APFS 上的端到端验收：
mkdir -p artifacts/macos-desktop
node scripts/desktop-local-backup-acceptance.mjs --base-dir artifacts/macos-desktop \
  --require-filesystem apfs --report-path artifacts/macos-desktop/desktop-local-backup-apfs.json
```

`scripts/macos-volume-acceptance.mjs` 用 `hdiutil` 挂载真实 APFS 与 FAT32 卷（不需要 root，结束自动卸载并删除临时镜像），逐项验证：卷身份与 `diskutil` 报告一致且可区分源卷、替换/读回/目录 fsync 探测、复制与覆盖替换、完整校验与完整恢复（含恢复后数据库与附件哈希）、卸载后 `TARGET_OFFLINE`、重挂载后清单与身份一致、同一路径换上另一块卷被拒绝、FAT32 单文件限制按计划拒绝超限。报告写入 `test-results/macos-volume-acceptance.json`；环境无法完成的项目记入 `skipped`，不会写成通过。

已在本开发环境验证 Linux 与 macOS/APFS。Windows/NTFS、外接物理 exFAT 盘的真实拔盘、真实断电、独立设备、真实网络盘挂载及不同物理设备的性能样本仍需对应设备实测；本机系统拒绝创建 exFAT 镜像（`hdiutil` 返回「操作不被允许」），exFAT 限制识别目前只有解析层 fixture 覆盖。目录同步在平台不支持时明确按能力跳过；不承诺任意断电或拔盘零损坏，也不能仅凭 Node `stat.dev` 证明两个分区位于独立物理磁盘。SMB/NFS/云盘挂载不属于首版保证范围。

尚未完成的功能、平台与性能验收见 [TODO.md](./TODO.md)。

## ext4 与规模基准

桌面验收可指定临时目录所在文件系统，并单独保存报告：

```sh
mkdir -p artifacts/local-backup-ext4
node scripts/desktop-local-backup-acceptance.mjs --base-dir artifacts/local-backup-ext4 --require-filesystem ext4 --report-path artifacts/local-backup-ext4-acceptance.json
pnpm run benchmark:local-backup --base-dir artifacts/local-backup-ext4 --samples 1000:100,10000:100,100000:100,1000:1024 --report-path artifacts/local-backup-ext4-benchmark.json
```

基准的 `--samples` 为「附件数:SQLite MiB」，默认覆盖千、万、十万附件及 100MiB/1GiB 数据库；`--concurrency` 可选 1–4。每个样本在独立子进程中创建真实 Notebook、1KiB 小附件及 8MiB 合成 PDF，数据库体积来自真实历史正文，不使用未知表或仅扩张空闲页。测量首次备份、无变化、少量变更、完整校验、恢复和 1GiB 流式附件取消；验证无变化零复制且跳过捕获、恢复数据库哈希一致、取消保留旧数据库。十万附件已达到清单上限，少量变更和取消样本替换一个资源引用以保持数量上限。

报告逐个样本保存耗时、捕获耗时、采样峰值 RSS、进程累计峰值 RSS及 Node 事件循环延迟，包含实际数据库大小、文件系统、机器和缓存条件。仅为本机同盘、热缓存、每阶段单次样本；事件循环指标不代表渲染器 UI 响应，备份阶段另外记录各阶段墙钟耗时（包括提交）；桌面验收报告单独记录 2GiB 附件复制期间的可见渲染帧间隔和任务查询耗时，该样本不等于十万附件下的 UI 性能。本机四组规模结果见 [BENCHMARK.md](./BENCHMARK.md)，其他平台与剩余验收状态见 TODO。临时数据执行结束自动删除，报告留在 `artifacts`；失败报告保持 `passed: false`，已完成样本仍可审阅。

基准在完成全量校验后中断时，可用报告与保留的隔离目录续跑恢复和取消阶段；只有校验已完成的检查点可复用：

```sh
node scripts/benchmark-local-backup.mjs --base-dir artifacts/local-backup-ext4 --resume-report artifacts/local-backup-ext4-benchmark.json --resume-root artifacts/local-backup-ext4/anynote-local-benchmark-XXXXXX
```

将末尾目录名替换为实际保留的 fixture；新检查点会记录 `inProgress.root`。续跑先核对目录、Notebook、清单身份与切点，清除 fixture 内未完成的恢复目录，再执行剩余阶段；完成的样本不会重复执行。续跑指标标记独立进程，种子生成耗时记为未知，保留原始阶段数据，不能把多个进程的累计 RSS 当作同一进程测量。
