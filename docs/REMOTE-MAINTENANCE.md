# Cloudflare 远端维护

备份目标的「远端维护」提供版本清理和设备接管。先用 `pnpm run cloud:deploy` 升级 Worker，并应用 `0002.sql`；Wrangler 管理的地址和 Token 继续自动取得。

## 版本保留与清理

默认保留当前 lineage 最近 30 个已提交版本，可以调整数量。先「预览清理」，核对待删除版本 UUID、无引用对象数量与预计字节数，再勾选永久删除确认。预览不删除数据，有效期 10 分钟；版本、上传或恢复保护发生变化时，需要重新预览。

清理只移除所选分支的旧版本。所有分支的 head、其他分支已提交版本、所有 staging manifest 和有效恢复 pin 均参与保护。每个保留版本有完整 checkpoint，因此恢复不依赖被删除的旧 delta。对象按全部受保护 manifest 的引用标记，且 R2 上传时间必须已超过 24 小时，才成为回收候选。恢复开始时取得一小时 pin，每 30 秒续期，结束后释放。

确认执行后，在 D1 中锁住整个远端 Notebook，阻止新上传计划、提交、接管和新增恢复 pin。已持有的恢复 pin 可继续续期。待删除版本先标记为 retired，不再对外列举或恢复；随后分批删除 R2 对象、旧 manifest 和对应 D1 数据。每次最多处理 8 个对象或 8 个版本，使用持久化游标及执行锁，避免并发重试倒退进度。全部完成后释放 Notebook 锁；已完成计划可重复确认。

普通网络或删除失败会保留清理计划与 Notebook 锁。配置了持久化协调器的新 Worker 会通过闹钟恢复已经确认的计划，并在新协调器实例创建后安全释放旧实例的单批执行锁；不通过时间过期抢占活跃删除。旧版遗留且没有协调器身份的执行锁仍需管理员确认旧请求停止后处置，见「旧维护锁处置」；不会按时间抢占，也不会直接清除 Notebook 锁。升级包括 `0003.sql` 和 Durable Object 绑定，详见 [P0 备份可靠性](P0-BACKUP-READINESS.md)。

规划预算：整个 Notebook 最多 200 个未 retired 版本（包括 staging），最多列举 10000 个对象、标记 200000 个引用；每个计划最多回收 1000 个无引用对象。超出预算或保护 manifest 缺失/损坏时拒绝规划。云端运行时配额可能先于上述应用预算触发，错误时不执行清理；大规模规划尚未做真实负载验收。日/周/月采样上限分别为 365 天、104 周和 120 月。staging 不自动过期，孤立 manifest、清理计划、接管回执和 retired 墓碑暂不自动回收。

## UTC 日/周/月采样

在最近 N 个版本之外，可叠加「每日采样保留天数」「每周采样保留周数」「每月采样保留月数」。每个 UTC 日、周、月窗口保留其中最新的一个已提交版本；周从周一开始，窗口包含当前时间段。三项默认 0，即关闭采样，沿用原来的最近 30 个版本策略。

例如最近 1 个版本 + 7 天日采样 + 4 周周采样 + 12 月月采样，会保留各窗口代表版本的并集，同一个版本满足多个规则时只保留一次。采样只增加保护，不降低其他分支、head、staging 和恢复 pin 的保护。预览中可展开「查看策略保留版本与原因」，核对最近版本、日/周/月采样及未来时间保护。

时间来自版本 checkpoint 的 `createdAt`，解析为绝对 UTC 时间；不是 R2 对象上传时间。预览记录固定的 UTC 基准，确认时复用，跨午夜、周一或月初仍按原计划判断。未来时间版本保守保留，时间格式无效则拒绝规划。设备时钟错误会影响采样分桶，需要核对预览；不会据此自动修正云端历史。

采样仍为手动预览/确认流程，不自动定时删除，也不新增长期保存的目标策略配置。保留窗口在本次清理界面中选择。旧版仅按数量生成的未完成计划继续兼容；新客户端遇到不支持 `calendar-retention` 的 Worker 时，拒绝非零采样请求，提示升级，不悄悄退回数量策略。

## 设备接管

填写已有远端 Notebook UUID 和 lineage UUID，读取当前 head、writer epoch 和设备 UUID，再明确确认接管。服务端按 head 和 epoch 做条件更新，递增 epoch 并记录幂等回执。旧 epoch 的上传与提交会被拒绝，旧设备仍可读取。

本地恢复副本拥有新 Notebook UUID。接管时保存独立的 `remoteNotebookId`，继续指向原远端分支；上传副本会重建远端 Notebook 身份和已知的自指笔记链接，不改写本地源库。接管不会合并两端内容，自动备份会关闭，并清空旧 ack 与 pending 状态。先核对本地内容，再手动备份；后续可自行开启自动备份。

APP_TOKEN 是整个个人服务的授权凭据。设备 UUID/epoch 用于并发写入控制，不是独立设备身份认证或多用户权限系统。

## 旧维护锁处置

协调器只会清除带协调器身份的执行锁。旧版 Worker 在 `/retention/apply` 中写入的 `execution_id` 没有 `execution_owner`，这类无主执行锁被保守保留，不会自动过期；`maintenance-recovery-v1` 解决的是协调器实例被回收后留下的执行锁，不覆盖这种旧锁。

先做只读诊断，确认是否存在无主执行锁与 Notebook 锁：

```sh
pnpm run cloud:legacy-lock <远端NotebookUUID>
```

返回 `notebookLocked`、`legacyLock`，以及活动计划的 `executionId`/`executionOwner`/游标。诊断不改变锁状态。确认旧请求已停止后，用同一命令释放被观测到的确切执行锁：

```sh
pnpm run cloud:legacy-lock <远端NotebookUUID> --release <计划UUID> <执行UUID> --confirm-legacy-stopped
```

释放要求显式确认与「旧请求已停止」声明，并且只清除与诊断中 `planId`、`executionId` 完全一致、`status='deleting'`、`execution_owner IS NULL` 且归属同一 Notebook 的执行锁；条件不满足返回 `LEGACY_LOCK_CHANGED`，不会误清其他锁，也不会触碰协调器持有的执行锁。释放后 Notebook 锁继续保留，并写入 `maintenance_admin_actions` 审计记录；随后在维护界面重试未完成的清理，由协调器从持久化游标续跑同一计划。

必须先证明旧请求已停止，例如部署新 Worker 并确认旧版本不再有 `/retention/apply` 活动；不能按锁的时间长短猜测其是否仍在运行。`/v1/capabilities` 公布 `maintenance-admin-v1`，`0004.sql` 建立审计表。

## S3 遗留保护处置

崩溃或独立工具可能留下没有本地 pending 回执的写登记与残留恢复登记。它们会阻塞清理规划并保守保护对应版本，且不会自动过期。

先在维护界面点「审查遗留保护」（或调用 `remoteProtectionAudit`）做只读查看：返回当前写/恢复登记、活动保护预算、已提交/退役数量，以及每项是否匹配本地 pending 回执的判定。审查不改变任何状态；备份或恢复任务进行中也能查看。

确认这些登记的来源任务已停止后，勾选声明并逐项「解除」（或调用 `releaseRemoteProtection`）。解除要求显式确认与 `legacy-requests-stopped` 声明，并且只清除被确切观测的 `kind`+`id`+`generationId` 登记（控制记录 revision 条件写入）；条件不满足返回 `LEGACY_PROTECTION_CHANGED`，匹配本地 pending 回执的登记会被拒绝。未提交的写 generation 在解除时一并退役，迟到上传无法再发布它；已提交版本保持可恢复。残留 reader 解除后，其保护的旧版本才可能进入清理。

不以登记存在时间判断其是否仍在运行；必须由使用者确认来源任务已停止，且目标存在进行中的本地任务时拒绝解除。Cloudflare 目标沿用「旧维护锁处置」，不使用这里的入口。

## 验证与边界

- `pnpm test` 包含 11 项维护合约及 3 项采样策略合约：旧设备撤销、幂等接管、其他分支/恢复 pin/staging 保护、陈旧计划拒绝、中断重试、分批游标与并发执行互斥、恢复副本身份映射及公开 API 的持久化/显式确认。
- 旧维护锁的只读诊断、受限释放（显式确认 + 旧请求停止声明 + 精确 CAS）与释放后协调器从游标续跑由 `tests/maintenance-recovery.test.mjs` 合约覆盖；不按时间抢占。
- S3 遗留保护的只读审查、受限精确解除（显式确认 + 来源停止声明 + 登记身份 CAS）以及迟到上传/恢复不越权由 `tests/s3-maintenance.test.mjs` 合约覆盖；残留 reader 解除后旧版本才进入清理。
- `pnpm run test:cloud:local` 使用官方 workerd、本地 D1/R2 执行原有 7 项与新增 5 项维护场景。
- `pnpm run cloud:deploy` 部署后执行真实 Cloudflare 原有 8 项与新增 5 项检查。只删除本次新建验收 Notebook 内列出的旧版本，用户已有数据不参与测试。
- `pnpm run test:desktop:cloud --isolated-keyring --maintenance` 在真实 Electron、GNOME Keyring 和 Cloudflare 上验证清理预览/确认/恢复、接管确认与持久化、接管后重启备份。

真实桌面生产页面与 Linux 打包应用分别通过 12 项检查，见生产页面报告与 Linux 打包报告。

实际云验收覆盖旧版本 manifest/D1 删除和保留 head 恢复。新建测试对象仍在 24 小时宽限期内，因此超过宽限期对象的物理回收目前由使用模拟 R2 时间的合约验证，尚未声称真实云 aged-object 回收通过。

S3 已加入基于条件写入和不可变对象版本的保留/GC；需要实际桶启用版本管理且兼容 API 通过探测，否则拒绝删除。S3 不提供设备接管；旧客户端必须停止并升级。范围、预算、遗留保护和真实 MinIO 验收见 [P0 备份可靠性](P0-BACKUP-READINESS.md)。Windows/macOS、旧版无协调器锁、大规模规划及长期周期负载仍待验收。

日/周/月采样已通过官方 workerd、真实 Cloudflare、生产页面及 Linux 打包版验收；云端历史日期由独立测试分支的协议夹具指定，不改动用户既有版本。它验证采样版本的保留和恢复，不代表超过 24 小时 R2 孤立对象的真实老化回收。
