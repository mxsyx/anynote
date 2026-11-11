# Rust 配对、采集消费与云浏览

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 服务接入顺序

宿主在后台服务线程持有 RM10 `TransferSession` 和 RM05 `WriteQueue`。本组不负责启动 timer、业务 IPC 或 GPUI 设置页；这些接线属于 RM29。

1. 打开并绑定既有上传槽；若存在 pending generation，先调用 `resume_upload` 确认或继续原任务，不能重新捕获实时数据或消费新采集替换它。
2. 调用 `consume_captures(client, session, queue, local_notebook, temporary_root, cancel)`。本地 Notebook ID 与云端 ID 可以不同；宿主负责从已配置备份目标解析该映射，不能使用浏览器传入的本地路径。该函数每批最多处理 20 条，检查能力、上传身份、writer/epoch，使用 exclude 避免同批重复领取。ZIP 和队列等待是阻塞工作，必须离开 UI 线程执行。
3. 通过 `pending_capture_acks` 取得当前远端 applied 集合（最多 20 个 ID），然后通过 `WriteCatalog::capture_snapshot` 捕获切面。
4. 调用 `prepare_upload_with_captures`，传入该冻结切面和待确认 ID。完整 DB、附件、browse、captureAcks 一并落盘并绑定原 generation；`resume_upload` 负责 plan/objects/commit 和丢响应确认。同步快照阶段使用 RM08 `Cancellation`，网络阶段使用 `CancellationToken`，宿主须将任务取消传播到两者。

普通 `prepare_upload` 也生成同切面 browse 和空确认对象；它不会自行查询远端待确认集合。`prepare_manifest` 继续按原字节接纳既有清单，重试不重新生成投影。

## 采集与配对边界

- `pair_capture_device`、`capture_devices`、`revoke_capture_device` 复用 RM10 的鉴权、能力协商、有限响应、超时及重定向禁用。配对码只返回调用者；不写 RuntimeState 或日志。一次性兑换、五分钟配对码有效期及设备令牌失效仍由 Worker 判定。
- 限时 claim 保留 `claimId`、`targetVersion`、父目录和 canonical manifest digest；本地以请求开始时间保守检查 20 分钟领取期限，过期不提交/ack。最终有效性由 Worker 的 claim、版本及 writer 条件更新裁定。
- 优先在写队列读取 `capture_receipts`。同 captureId 不同 digest 报冲突；已有回执直接重发原 noteId/appliedSeq，即使目录已删除也不重新导入。
- 无回执时校验当前父目录和所有祖先。只将目录不存在、被删除或不是合法目录视为 needs-target；离线、路径变化或损坏不冒充目录失效。下载期间目录消失时再检查，绝不自动改投根目录。
- 对象限长并核对实际大小/hash，每次最多缓冲一个 20 MiB 对象，再写私有临时 ZIP。复用 RM07 的完整格式/路径/预算/正文/媒体校验、资源 ID 重映射与事务提交。正文、资源、报告和回执提交完成后才 ack applied。取消或 ack 失败不会撤销已经提交的本地笔记；重试读取回执。
- 客户端不设置 backedUp；Worker 仅在成功发布包含相符回执的备份事务中更新它。浏览器仍只写采集箱。

## 同切面投影

从实际上传的冻结数据库读取可达且未删除的节点，生成每页 100 条的 `tree/<parent|root>/<page>` 与 `note/<id>`。笔记资源读取该修订固定的 asset hash，不能因当前资源重绑定而改用新字节。正文与附件只读对象继续使用现有 TS schema。

本地投影元数据读取最多 30,000 个节点，输出最多 30,000 个对象、单对象 20 MiB；更大目录或投影失败时省略 browse，保留数据库备份和 captureAcks。该本地节点预算比 TS 的仅输出对象预算更保守，属于有界降级，不能声称更大目录已通过云浏览验收。取消不得吞掉。回执只从本次切面查询待确认 ID，且 appliedSeq 必须不大于本切面 content_seq；不扫描或上传全部历史回执。

## 复现

```sh
cargo test -p anynote-services --test cloud_capture --locked --offline
cargo build -p anynote-services --example cloud_probe --locked --offline
pnpm run build:backend
node scripts/build-browser-extension.mjs
CAPTURE_CHROMIUM=/absolute/path/to/chrome node scripts/rust-cloud-reference.mjs --capture --workerd
node scripts/rust-cloud-reference.mjs
```

`--capture` 复用 RM10 HTTP 故障代理；`--workerd` 使用隔离 local-workerd、D1/R2，而不带该参数使用 TS Worker 与测试 D1/R2 适配器。扩展闭环启动独立 Chromium profile，复制构建出的 MV3 扩展，只给临时副本预授予合成 HTTPS 站点；请求由测试代理转交本地 Worker。配对、上传、采集箱和正文读取执行实际扩展代码。报告、故障数据库与截图写入 `tmp/rm12/`，均可删除；合成 Token 不读取真实云凭据。

这不替代真实 Cloudflare、三平台、真实用户库、浏览器商店、容量/费用/老化或完整桌面 GUI 验收。RM34/F011/F012/F020 和其他当前 F 任务保持原状态。
