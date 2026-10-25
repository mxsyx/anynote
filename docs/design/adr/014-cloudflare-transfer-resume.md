# ADR-014 · Cloudflare 持久传输进度

状态：已采纳。日期：2026-10-21；G10，基于 `682cf55` 工作树。补充 [ADR-005](005-generation-publication.md) 和 [ADR-013](013-remote-maintenance-lifecycle.md)。

[返回 ADR 索引](README.md)

## 背景

应用数据库分块和 R2 multipart 是不同层次。服务端 plan 已能复用完整对象，但客户端原先在失败后丢弃所有进度；Worker 也无法通过 R2 完整对象列表找到未完成 multipart。不能仅凭块大小宣称中断续传。

## 决定

- 本机 `_local/cloud.transfers/<scope-hash>/` 保存 `anynote.cloud-transfer.v1` 原子 JSON 记录；不含凭据。scope 包含方向、连接、endpoint、Notebook 和分支，上传另含 writer/epoch。SQLite 独占锁覆盖整个任务，进程退出自动释放；下载不使用新设备恢复的临时 deviceId。
- 每次上传重新捕获一致性 SQLite 与附件闭包。清单除 generationId/createdAt 外的所有字段构成切点指纹，包含 snapshotSeq、完整数据库/附件哈希及大小、head、writer/epoch。指纹一致才复用原 generation、createdAt 和 multipart 回执；改变则替换槽位并创建新 generation。已清理的 generation 或已失效的 multipart 会话重新申请，不绕过退役和写入身份检查。
- 数据库沿用 1 MiB 应用块；大附件沿用 32 MiB R2 传输片段。客户端在回执落盘前后可能重发最后一个片段，按同一编号覆盖。复用前重读并核对每个已确认片段的 SHA-256，服务端仍校验完整附件后才发布。已完成私有对象在服务端复制失败时保留，重试提交可跳过传输阶段。
- 下载进度绑定完整远端 manifest 摘要。数据库缓存按清单块哈希校验；附件按 16 MiB HTTP Range 保存数据与本地摘要，数据 sync 后才发布进度。重试重新核对缓存，损坏范围及其后缀重下。范围摘要只证明本地缓存未改变，完整附件仍须与 manifest SHA-256 一致才能进入发布暂存目录。拒绝忽略 Range 的 200 响应和不匹配的 Content-Range。
- 失败或取消释放临时目录及 pin，保留传输槽位；成功清除槽位数据。重新选择不同版本时替换该槽位。任务中心保存无凭据的恢复重试参数。保留少量空 SQLite 租约文件，避免删除锁文件导致并发实例锁住不同 inode。
- `0006.sql` 登记上传与服务端复制会话，能力为 `transfer-resume-v1`。登记受 writer、staging、retired、维护锁和每 Notebook 2000 会话预算约束。G09 预览加入可回收会话，显式确认后按游标 abort，再删登记；异常保留锁和登记以便重试。复制会话的 abort 不删除同名已发布对象。

## 取舍与边界

续传节省网络传输，仍需重捕获和读盘校验；没有保存活跃 SQLite 句柄，也没有承诺在任意字节偏移恢复单个未完成请求。下载缓存与发布暂存会占用额外本地空间，沿用总量和磁盘预算。取消保留缓存以支持重试；应用关闭后可删除整个 `_local/cloud.transfers` 目录以放弃本地进度，下一次按新传输处理。

R2 创建会话与 D1 登记无法组成原子事务。创建后、登记前进程终止的窗口中尚未发送任何片段；依靠桶的未完成 multipart 生命周期兜底。Cloudflare 默认在创建 7 天后回收未完成上传，部署不能禁用该规则；自定义期限和真实回收需 G07 核验。见 [R2 上传生命周期](https://developers.cloudflare.com/r2/objects/upload-objects/) 和 [桶生命周期](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。客户端处理已消失会话并重新上传，不把厂商自动回收当作已提交备份的删除授权。

未完成片段的实际存储量不由 R2 完整对象列表提供，清理预览展示会话数，空间估算仍排除这些字节。已有完整备份、其他分支与有效 pin 的保护契约不变。没有新增自动删除版本策略。

## 实现与验证

[持久进度](../../../packages/backup/src/transfer-session.ts)、[范围下载](../../../packages/backup/src/transfer-download.ts)、[传输客户端](../../../packages/backup/src/providers.ts)、[会话登记](../../../apps/cloudflare-backup/src/upload-sessions.ts)、[维护流程](../../../apps/cloudflare-backup/src/maintenance.ts)。

[进程/缓存回归](../../../tests/cloud-resume.test.mjs)、[公开任务回归](../../../tests/cloud-stream.test.mjs)、[新设备恢复](../../../tests/cloud-recovery.test.mjs)、[真实/本地共用场景](../../../scripts/cloud/stream-scenario.mjs)。结果和外部边界见 [历史实施证据](../../development/history/todo-2026-10-24.md#g10)。
