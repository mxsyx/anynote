# G10 · Cloudflare 中断续传

[返回总入口](../../TODO.md)

类型：内核实现。目标：可恢复分块/下载进度与遗留上传清理。

前置：先定义源切点、持久进度和遗留上传生命周期；复用现有分块协议。

并行边界：与云盘 Provider 实现可隔离并行；涉及维护协议时与 G09 串行。

## 建议入口

- [packages/backup/src/cloud-archive.ts](../../packages/backup/src/cloud-archive.ts)
- [packages/backup/src/restore-task.ts](../../packages/backup/src/restore-task.ts)
- [packages/protocol/src/file-chunks.ts](../../packages/protocol/src/file-chunks.ts)

## 执行顺序

1. 明确复用已验证应用分块和厂商 multipart 的边界，决定持久进度格式。
2. 实现中断、取消、切点变化与重启后的正确复用，补遗留上传清理。
3. 先自动回归，再交 G07 实测吞吐与故障；不以 16MiB 分块宣称字节续传。

## 待办

### T024 · 原 §4

- [x] **P2 — 中断字节续传**：评估复用已验证分块/下载进度及可选 multipart 的续传和遗留上传清理，补充中断、取消、源切点变化测试；当前重试重新捕获或下载，16MiB 应用分块不等于厂商 multipart 或字节续传。

## 验证与完成条件

- [tests/cloud-stream.test.mjs](../../tests/cloud-stream.test.mjs)
- [tests/cloud-recovery.test.mjs](../../tests/cloud-recovery.test.mjs)
- `pnpm run test:cloud:stream`

完成条件：重启后的续传确实复用数据，源变化不拼接旧进度，取消与清理可恢复。

人工 / 外部资源：真实服务复测使用 G07 环境；实现与模拟故障不需要先准备账号。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。

## 实施交接（2026-10-21）

基线：`682cf55` 工作树；Linux x86_64、Node 24.11.1、pnpm 12.14.0、系统 Google Chrome。本组完成实现与本地故障回归；真实服务验收仍归 G07。上方条目保留旧清单原文：当前数据库应用块实际为 1MiB，R2 multipart 为 32MiB，本次新增的附件下载范围为 16MiB，三者不混称。

### 改动

- 定义 `anynote.cloud-transfer.v1` 持久记录、SQLite 进程租约和切点指纹。每次上传重新捕获，但只在源清单、head 与写入身份完全一致时复用原 generation/createdAt、已验证对象及 multipart 回执。失效会话可重新申请；已退役 generation 生成新身份，不能复活旧版本。
- 下载按完整 manifest 摘要隔离，复用重新校验的数据库块与附件 Range 进度。数据同步后保存检查点，范围损坏重下后缀，最终整文件哈希仍必须通过；拒绝错误范围响应。任务取消/失败释放暂存和 pin，保留缓存供重试；成功清除缓存数据。普通目标和全新设备恢复都支持任务中心重试。
- 新增 D1 `0006.sql` 和 `transfer-resume-v1`。登记传输及服务端复制会话，接入 G09 手动确认清理；abort 失败或丢响应时保留登记和锁重试，复制会话终止不会删除同名已提交对象。维护窗口区分无引用对象与本批遗留会话数量。
- 共用流式验收脚本新增上传/下载中断与 Storage 重启，记录实际节省字节；沿用现有块协议，没有引入第二套备份清单。当前契约和取舍见 [ADR-014](../adr/014-cloudflare-transfer-resume.md)、[分块云备份](../STREAMING-CLOUD-BACKUP.md)、[远端维护](../REMOTE-MAINTENANCE.md)。

### 验证

| 命令 / 范围                                                                      | 结果与证据                                                                                                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run build`、`pnpm run typecheck`、`pnpm run workspace:check`               | 通过；生产构建仍有既有大 chunk 提示                                                                                                                             |
| 修改代码的 ESLint / Prettier、`git diff --check`                                 | 通过                                                                                                                                                            |
| 下方 12 文件 Vitest 命令                                                         | 86/86 通过，报告 `test-results/g10-targeted.json`；含公开任务重启、真实子进程 SIGKILL、切点改变、缓存损坏、过期会话、退役身份、冷恢复、清理丢响应及提交结果确认 |
| `node scripts/cloud-worker-local.mjs`                                            | 官方本地 workerd/D1/R2：7 项基础、6 项维护、7 项流式、4 项协调器恢复通过；报告 `test-results/cloud-worker-local.json`                                           |
| `ANYNOTE_BROWSER=/usr/bin/google-chrome node scripts/remote-retention-smoke.mjs` | 3/3 通过；验证遗留会话数量、独立保存配置、重新打开和显式确认失效。报告 `test-results/remote-retention-ui.json`；模拟 RPC，非真实 Electron/云端                  |

```sh
pnpm exec vitest run tests/cloud-stream.test.mjs tests/cloud-resume.test.mjs tests/cloud-multipart.test.mjs tests/cloud-recovery.test.mjs tests/remote-maintenance.test.mjs tests/retention-policy.test.mjs tests/maintenance-recovery.test.mjs tests/cloud-acceptance.test.mjs tests/cloud-backup.test.mjs tests/task-history.test.mjs tests/backup-boundaries.test.mjs tests/recovery.test.mjs --reporter=default --reporter=json --outputFile=test-results/g10-targeted.json
```

112MiB 附件上传在确认首个 32MiB 片段后中断，重启只上传剩余 80MiB；下载在首个 16MiB 范围后中断，重启只请求剩余 6 个范围并通过完整哈希校验。本地适配器还验证已缓存数据库块不重复请求。样本由随机 64KiB 块重复生成，这是复用与完整性证据，不是随机数据吞吐基准。SIGKILL 下载检查点测试使用合成字节源；HTTP 公开任务和协调器强杀另有独立场景。

初次扩展回归受沙箱本机端口/子进程 EPERM 限制，4 项失败；允许相应本地测试权限后完整复测通过。初次 Wrangler 本地子进程启动失败，同样在允许本机端口/子进程后通过。报告由命令生成于忽略目录，不作为已提交文件引用。未执行项目全量测试，不据此声明全仓测试通过。

### 剩余边界与下一步

- 实现与模拟故障无剩余阻塞。部署前应用全部迁移至 `0006.sql`，升级 Worker 的 `transfer-resume-v1` 能力；本次未部署真实服务，也未运行会访问现有云配置的 `pnpm run test:cloud:stream`。该命令与本地 workerd 共用已验证的流式场景，真实复测要求已交 [G07 T003/T021/T025](07-cloudflare-acceptance.md)。
- R2 创建与 D1 登记不能原子提交；创建后登记前的空会话尚未传入片段，由桶未完成 multipart 生命周期兜底。必须保留该规则；真实默认/自定义期限、实际 7 天老化、满 2000 会话预算和费用由 G07 验证。未完成片段字节仍不计入空间估算。
- 恢复粒度是完整数据库块、已确认 multipart 片段或完整落盘下载范围；单个未完成请求会重发。重试仍有捕获与读盘校验成本，本地缓存占用空间并在取消后保留；处置方式见 ADR-014。没有新增自动删除已提交备份策略。
