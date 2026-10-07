# P0：备份可靠性与发布验收

更新：2026-10-04。这里区分代码完成、本机隔离实测和仍需外部设备的发布门槛；不会把不同临时目录当作另一台物理设备。

## Cloudflare 维护中断恢复

新增 `MaintenanceCoordinator` Durable Object，每个远端 Notebook 使用一个全局唯一协调器。已确认清理仍持有 Notebook 锁，按原计划和持久化游标分批执行；同一协调器的请求和闹钟通过队列串行，等待删除完成后才进入下一批，不使用时间过期来抢占活跃删除请求。

D1 `0003.sql` 为执行锁记录协调器实例身份。协调器实例被平台终止并重新创建后，新的全局唯一实例可清除旧实例所拥有的单批执行锁，再继续原计划；Notebook 锁不被清除。确认请求开始前保存闹钟，失败或中断后继续处理已经进入 `deleting` 的计划，完成后取消闹钟。预览不会自动变成删除任务。

升级：`pnpm run cloud:deploy`。自动生成的 Wrangler 配置和仓库配置均包含 `MAINTENANCE` 绑定、SQLite Durable Object 迁移 `maintenance-v1` 及 D1 迁移。能力标记为 `maintenance-recovery-v1`。

旧版遗留且没有协调器身份的执行锁仍安全保留，需要管理员确认旧请求已经停止后处理；不会通过期限猜测其是否仍在运行。处置入口为只读诊断 `/retention/diagnostics` 与受限释放 `/retention/legacy-lock/release`，并提供 `pnpm run cloud:legacy-lock` 管理员工具：仅清除被确切观测、无协调器身份且属于同一 Notebook 的执行锁，保留 Notebook 锁并写入审计记录，详见 [远端维护](REMOTE-MAINTENANCE.md) 的旧维护锁处置。新协议解决的是被协调器持有的执行锁。对象变更、保护清单损坏等错误仍保持锁，不能通过重启绕过。

生命周期依据：[Cloudflare Durable Object 生命周期](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)、[全局唯一与并发规则](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)。队列串行覆盖外部 I/O，避免长时间使用 `blockConcurrencyWhile` 引起 30 秒重置。

## S3 远端保留与垃圾清理

S3 目标现提供「远端维护」。首次启用及预览前，用户须确认访问该分支的全部客户端已升级、旧任务已经停止。后台检查桶版本管理，并在独立随机探测键上验证 `If-None-Match`、`If-Match` 和按版本删除；不支持时明确拒绝清理，不降级为无条件删除，也不自动改变现有桶的版本设置。

范围为当前目标的 `Notebook/lineage`。最近 N 个版本与 UTC 日/周/月采样沿用 Cloudflare 策略；保留版本、活动恢复引用参与保护，上传期间拒绝规划或启动清理。预览有效十分钟，提交前核对控制 revision 和实际候选。管理记录使用 ETag 条件写入；已确认计划、退役版本及游标持久化，失败后重试同一计划。

管理模式下，备份完成后还须将 generation 发布至条件更新的控制记录。未被接受的 COMMITTED 文件不会被列举或恢复，防止取消后的迟到上传绕过维护门禁。已中断的本地 pending generation 会在重试时撤销其写入登记；迟到 Worker 不能再发布被撤销的 generation。AWS SDK 接收独立的凭据字段副本，避免 SDK 内部字段污染原配置。

每批删除最多八个不可变对象版本 ID。旧版本的 manifest/COMMITTED 可清理；无引用资源的各对象版本还须超过 24 小时宽限期，受保护资源键的所有版本保守保留。迟到重复删除只指向原 VersionId，不会删除重新上传的同名对象。这依赖服务实际遵守对象版本及条件写入协议，见 [S3 条件写入](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)。

预算：最多 200 个活动备份版本、10000 个对象版本、1000 个删除候选、200000 个保护引用、64 项活动保护；控制记录最多 256KiB，已提交/退役身份最多 2000 项。非版本化的历史对象返回 `null` VersionId 时拒绝清理，需先迁移至可安全维护的独立版本化范围。阿里云 OSS 是否满足这些能力取决于实际桶配置和兼容 API，不能仅凭备份恢复成功认定可清理。

S3 不提供设备接管；保留范围不跨 lineage。保护不通过时间抢占，因崩溃残留的恢复登记会继续保守保留对应版本。独立工具产生且没有本地 pending 回执的写登记、残留恢复登记可通过维护界面的只读审查（`remoteProtectionAudit`）与受限解除（`releaseRemoteProtection`，显式确认 + 来源停止声明 + 登记身份 CAS）处置；未提交的写 generation 解除时一并退役以阻止迟到上传发布，已提交版本仍可恢复，不按时间抢占；预算超限时拒绝新任务。第三方工具或旧客户端绕过管理记录直接改写存储不在并发保证内。

## 第二种 S3 实现验收

已有阿里云 OSS 实测之外，增加真实 MinIO 服务验收入口：

```sh
pnpm run test:s3:second --binary /path/to/minio
# 同时验证真实 Electron、隔离系统 keyring 和远端维护界面：
pnpm run test:s3:second --binary /path/to/minio --desktop
# 已有另一种外部 S3 服务：
node --env-file-if-exists=.env.cloud scripts/s3-second-acceptance.mjs --external
```

外部模式只读取 `.env.cloud.example` 中的 `ANYNOTE_S3_SECOND_*`，不回退到主 OSS 账号。没有配置时失败。本地模式仅监听回环地址，使用独立随机桶、随机凭据和版本管理，结束后关闭服务并删除临时数据。桌面 HTTP 验收只有显式 `--local-s3` 且地址为回环时允许，普通真实云配置仍要求 HTTPS。

官方 MinIO 固定源码版本 `RELEASE.2025-10-15T17-29-55Z` 可用于构建测试服务：

```sh
go install github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z
```

脚本覆盖：备份与增量去重、损坏拒绝、真实子进程 SIGKILL 后重启确认、源目录不可用、空工作区云发现与旧新版本恢复，以及条件写入/对象版本检查、清理确认和保留版本恢复。报告为 `test-results/second-s3-acceptance.json`。真实新对象仍在宽限期内；超过 24 小时孤立资源的物理回收由受控版本时间的合约测试验证。

MinIO 是第二种真实 S3 实现，但此轮运行于同一物理主机，不代表第二个公网云厂商或跨设备验收。固定版本仅用于隔离测试，实际部署应按服务维护状态选型；本项目不发布或部署 MinIO 服务。

## 可携带的跨设备恢复验收包

```sh
pnpm run test:recovery:portable prepare /path/to/new-kit
# 把完整验收包目录复制到另一台干净设备，在已构建的仓库运行：
pnpm run test:recovery:portable verify /path/to/kit
# 本机排练必须显式声明，报告仍标为排练：
pnpm run test:recovery:portable verify /path/to/kit --allow-same-host
```

准备过程仅创建独立临时 Notebook，包含 Markdown/图片/PDF、中文目录、未知块、自链接、标签收藏、历史、回收站、PDF 批注/文本及插件数据。包内仅有流式 `.anynote`、领域证据与使用说明，无账号凭据；源临时目录随后删除。

验证在全新临时工作区导入，核对归档大小/SHA-256、领域表行、所有附件哈希、恢复后的自链接及搜索。保留原始变更日志，并单独规范化导入产生的 Notebook 身份和名称。识别同一主机时拒绝正式跨设备验收；显式排练生成 `same-host-rehearsal` 报告。主机标识不同仍不能自动证明独立物理设备，需要人工记录设备和故障过程。

输出为 `test-results/portable-recovery-acceptance.json`。本轮的独立物理设备、Windows/macOS、整机断电/磁盘丢失恢复尚未执行，不能标记 v1 全部发布门槛完成。验收包不是用户资料的备份工具，也不是自动触发整机故障的工具。

## 本轮验收结果（2026-10-04）

- 严格 TypeScript 与生产构建通过，Linux 应用目录打包通过；最终完整回归 233 项通过，失败为零。
- Cloudflare 已通过 Wrangler 部署协调器与 D1 迁移，真实云 13 项检查通过，见 `docs/cloudflare-acceptance.json`。官方本地 workerd 另通过备份 7 项、维护 5 项、流式传输 5 项、硬中断恢复 4 项，见 `test-results/cloud-worker-local.json`。硬中断确实在 D1 执行身份锁已持有时向服务进程组发送 SIGKILL，重启后仅由持久化闹钟继续原计划；这不是主动终止 Cloudflare 公网运行实例的测试。
- 真实 MinIO 服务的备份 7 项、中断恢复 6 项、干净工作区发现与恢复 6 项，以及版本化清理/保留版本恢复通过。生产版和 Linux 打包版桌面各 10 项检查通过，包含系统 keyring、自动调度与维护界面；见 `test-results/second-s3-acceptance.json`、`test-results/desktop-s3-maintenance-acceptance.json`、`docs/second-s3-packaged-acceptance.json` 和 `test-results/desktop-s3-maintenance-packaged-acceptance.json`。
- 便携恢复包位于 `artifacts/recovery-kit/`，本机隔离排练 4 项通过；正式模式已验证拒绝同一主机。见 `test-results/portable-recovery-acceptance.json`。包不含云凭据。独立物理设备及整机故障验收仍待完成。
- 主阿里云 OSS 桶能力检查被安全阻止：桶未启用版本管理。未改变桶设置、未清理已有备份，见 `test-results/s3-maintenance-capabilities.json`。此环境尚不能确认清理已验收；启用版本管理或配置独立版本化桶后，可执行 `pnpm run test:s3:maintenance:capabilities` 再检查条件写入与按版本删除。历史非版本化对象仍需独立迁移，不会因启用版本管理而自动获得安全版本 ID。

两个 P0 的代码与自动化验收入口已交付，但发布验收尚未全部闭环：独立物理设备/整机灾难实测，以及当前 OSS 桶的维护能力前提仍未满足。
