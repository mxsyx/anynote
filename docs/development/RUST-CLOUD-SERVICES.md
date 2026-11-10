# Rust 云传输、调度与维护契约

本文维护 Rust 云服务的调用约束；真实故障与老化验收见 [RM34](TODO.md#rm34)，操作方法见 [云验收](RUST-CLOUD-ACCEPTANCE.md)。

<a id="rm10"></a>

## 云传输、恢复与调度

- [`cloud/client.rs`](../../crates/anynote-services/src/cloud/client.rs) 实现能力协商、HTTPS 默认/显式 HTTP 测试连接、禁止自动重定向、有限响应、超时与取消、Retry-After、错误代码脱敏；独立恢复连接通过 RM03 RuntimeState 持久化元数据，Token 只交 RM13 `SecretStore`，也支持仅会话内提供凭据。`Manifest::parse` 保留 Worker `JSON.stringify` 字节、未知字段与属性顺序，按 JS array-index key 规则和 `ryu-js` 处理数值；协议整数、大小与序列必须为 JS safe integer。`prepare_manifest` 可接收冻结 TS manifest 和 hash 命名对象，不重新推导旧 generation。
- [`cloud/session.rs`](../../crates/anynote-services/src/cloud/session.rs)、[`upload.rs`](../../crates/anynote-services/src/cloud/upload.rs)、[`restore.rs`](../../crates/anynote-services/src/cloud/restore.rs) 将连接/endpoint/notebook/lineage/方向及上传 device/epoch 绑定到独占 OS 文件租约；冻结对象、原始 manifest hash、pendingGeneration 与游标先 fsync/原子落盘再请求 plan。丢 plan/commit 响应不产生新身份；先查 generation，再核对已提交 manifest 字节后推进游标，旧 head/较小序列拒绝。下载逐次复核缓存 chunk/range，核对 Content-Range、整 DB/附件 hash、schema/源 Notebook/资源闭包后恢复新 UUID、lineage、自链接和索引；发布回执使同一恢复重试返回原新库，目标已变化时拒绝冒充原结果。无本地 Notebook 也可分页发现跨库/lineage 版本。pin 在开始/30 秒续租/结束维护，初始 pin 丢响应、取消或续租失败也尝试释放。
- [`scheduler.rs`](../../crates/anynote-services/src/scheduler.rs) 在同一持久准入/失败状态机下派发 Local/Remote executor，保留原 RM03 `background_decision`。支持离线、所启用的电池/计费网络策略、未知观察、大任务、磁盘/Notebook 缺失、interval/on-mount、Retry-After 优先的指数退避/jitter、取消及 auth/permanent/exhausted 显式修复。运行前持久 claim，重启将 running 标为 interrupted，executor 依据原传输身份接续；挂载事件不能绕过退避。

### 接续契约与限制

`prepare_upload` 只消费 RM08 `FrozenSnapshot::Full`，使用 1 MiB **有序** DB chunk 和整附件，拒绝覆盖未解决的 pending。宿主先调用 `resume_upload`，需要放弃旧 staging 时显式调用 `abandon_upload`；后者仍先查询是否已提交。新切面/新 writer 身份使用新 generation/传输槽，不复用旧切面数据。已提交对象清理仅涉及该 cut 的本地 owned object 文件；未完成传输、manifest/part 元数据和下载缓存保留供接续，不自动扫描删除其他文件，也没有提供磁盘缓存配额管理 UI。

Worker v1 无 list-parts API，不能只凭本地 ETag 宣称远端仍有片段：重试对片段执行幂等 PUT 并检查 partNumber/hash，最终由 Worker 校验整对象后发布。已上传整对象由 plan 去重；multipart 会话过期重新建立会话。该保守行为可能重传已确认片段，不能宣称零重传。

网络每次响应有界；普通请求 60 秒，multipart 请求最长 30 分钟。同步快照/文件状态操作必须在服务工作线程执行；恢复大文件复制、最终完整性/重映射在 blocking worker，缓存回放主动让出执行以维持续租。取消须传 token 并等待任务结束，不能仅丢弃 future；SQLite 同步检查可能延后观察取消。pin DELETE 失败时保留原操作结果，由 Worker TTL 最终释放，不能保证网络断开时立即远端释放。

Scheduler 的 executor 和可用性由宿主提供，须校验 `ScheduledTarget.binding` 对应的当前连接/卷身份，实际失败不应返回成功；取消后等待底层作业结束再更新状态。自动 timer、业务 IPC、任务中心/设置 UI 由 [管理宿主](RUST-MANAGEMENT.md) 负责；RM14 才迁移/接管真实配置路径，`prepare_manifest` 不等于自动读取旧 TS `_local/cloud.transfers`。RM11 负责 writer 接管/retention/维护；RM12 负责在同一冻结切面生成 browse/captureAcks，同切面生成规则见 [采集与云浏览](RUST-CLOUD-CAPTURE.md)。

<a id="rm11"></a>

## Writer、保留与维护恢复

- **Writer**：`remote_writer` 返回 head/device/epoch/lineage，`owns` 供宿主呈现当前写入权；`takeover_writer` 要求显式确认和 requestId/expectedHead/expectedWriterEpoch，CAS 输入在请求前持久化。`pending_takeover`/`resume_takeover` 跨进程复用原请求，未知网络结果不生成新身份。接管中的旧槽被 `WRITER_REBIND_REQUIRED` 阻止准备/上传，成功后创建新 epoch 槽，初始游标只有远端 head，ack 为 0、pending 为空；重复回执不覆盖新槽已推进的游标。返回 `autoBackup=false`，不会自动夺取 writer。
- **保留配置与预览**：`save_remote_retention`/`remote_retention_policy` 以目标 UUID 存入 `cloud.retention.<targetId>`；不读取凭据、不请求网络、不自动清理。数量和日/周/月窗口有明确上限。`preview_retention` 将策略交给保留的 TS Worker，返回保护版本、候选、UTC 采样理由、staging 和空间估算；日周月/未来时间/分支/head/pin/staging 规则只维护服务端一份。
- **确认与恢复**：本地 `maintenance.retention` 状态为 planned→confirmed→completed。`apply_retention` 只接受当前已预览的 planId 与显式确认，每次最多驱动一个服务端批次；请求前持久化 confirmed。`resume_retention` 仅恢复已确认计划，网络失败、取消或进程退出不撤销服务端删除，也不放开本地未解决状态；不得替换成新预览。`recover_retention` 可在本机回执丢失后显式接续同分支、已处于 deleting 的服务端计划。过期/保护变化/撤销 writer 等明确入场拒绝允许重新预览。服务端继续负责 revision CAS、保护闭包变化、墓碑永久归档、删除游标及协调器续跑。
- **诊断**：`remote_retention_state`/`maintenance_diagnostics` 查询活动计划、对象/版本游标和执行锁，不解锁。旧版无 owner 的执行锁必须用精确 planId/executionId 和“旧请求已停止”的明确确认调用 `release_legacy_maintenance_lock`；释放执行锁后 Notebook gate 仍保留，按原计划续跑。没有按时间抢锁。错误只接受已知协议码/既有固定中文错误的映射，未知响应文本继续脱敏。

### 接续契约

宿主须用同一上传 `TransferSession` 串行协调上传与维护，不另建绕过其独占租约的相同身份任务。接管后依据返回的新 identity 重新绑定目标，持久保存 `autoBackup=false` 并更新 scheduler binding；旧槽原冻结 manifest/对象保留，不修改成新 epoch 重传。业务 IPC、冲突界面、任务中心、设置及配置接线由 [管理宿主](RUST-MANAGEMENT.md) 负责。同步本地状态读写放到服务工作线程；取消后等待任务结束，服务端已确认清理仍可能由协调器自动完成。每次 `resume_retention` 只推进一批，宿主按任务预算继续调用，不把网络取消显示为远端删除已撤销。

## 验证方法

```sh
pnpm run build:worker
cargo build -p anynote-services --example cloud_probe --example maintenance_probe --locked --offline
node scripts/rust-cloud-reference.mjs --workerd
node scripts/rust-maintenance-reference.mjs --workerd
```

本地 workerd/故障代理结果不替代真实 Cloudflare、三平台、老化或容量费用验收。运行需要本机端口权限；原始结果写入各驱动的 `tmp/` 目录。
