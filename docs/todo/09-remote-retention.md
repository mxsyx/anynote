# G09 · 远端维护生命周期与保留配置

[返回总入口](../../TODO.md)

类型：内核 / 配置。目标：维护记录回收、保留配置与空间预估。

前置：先定义保护项与安全回收协议；自动清理如纳入需独立确定授权契约。

并行边界：与导入/卷适配可并行；同一维护协议与 G07/G10 串行集成。

## 建议入口

- [apps/cloudflare-backup/src/maintenance.ts](../../apps/cloudflare-backup/src/maintenance.ts)
- [apps/cloudflare-backup/src/maintenance-coordinator.ts](../../apps/cloudflare-backup/src/maintenance-coordinator.ts)
- [apps/cloudflare-backup/src/retention-policy.ts](../../apps/cloudflare-backup/src/retention-policy.ts)
- [packages/backup/src/service.ts](../../packages/backup/src/service.ts)
- [apps/desktop/src/RemoteMaintenance.tsx](../../apps/desktop/src/RemoteMaintenance.tsx)

## 执行顺序

1. 先定义 staging、孤立 manifest、计划/回执/墓碑的生命周期与预算。
2. 实现幂等回收及保护验证，再持久化按目标的数量/日周月配置和空间预估。
3. 验证长期运行和超预算场景，将真实服务复测要求交给 G07。

## 待办

### T022 · 原 §4

- [x] **P2 — 维护记录生命周期**：设计并实现 staging、孤立 manifest、清理计划、接管回执和 retired 墓碑的安全归档/回收；解决长期运行触及活动版本、保护项及 2000 项身份预算的情况，保持幂等和恢复证据。

### T023 · 原 §4

- [x] **P2 — 保留策略持久化与空间预估**：按目标保存数量/日周月保留配置，首次设置展示预计空间；自动执行清理如要支持，单独定义用户授权和保护契约。当前采样为每次手动预览/确认，不是定时删除策略。

## 验证与完成条件

- [tests/retention-policy.test.mjs](../../tests/retention-policy.test.mjs)
- [tests/cloud-acceptance.test.mjs](../../tests/cloud-acceptance.test.mjs)
- [docs/REMOTE-MAINTENANCE.md](../../docs/REMOTE-MAINTENANCE.md)

完成条件：保护契约、实现、幂等回归与 UI 语义一致，手动预览不被标为自动策略。

人工 / 外部资源：如增加自动删除，产品负责人明确授权语义；真实远端证据由 G07 提供。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。

## 实施交接（2026-10-21）

基线：`9834141` 工作树；Linux x86_64、Node 24.11.1、Google Chrome 154.0.8037.57。本组完成实现、本地回归及模拟 RPC 浏览器验证；真实服务复测归 G07。

### 改动

- T022：新增 D1 `0005.sql`、`maintenance-lifecycle-v1`。staging 按服务端活动时间保护 7 天，仅在手动确认后取消当前分支的过期上传；回收超过 24h 的孤立 manifest 和已完成的临时对象。head、其他分支和有效 pin 始终受保护，缺失/损坏保护项或预算溢出拒绝清理。
- 清理计划、接管回执、retired 墓碑按 UUID 先归档 R2 再回收 D1；每类每批 64 条，失败保持锁，永久保留旧 ID 拒绝重放和完成计划幂等证据。预览 10 分钟过期，最多 128 个有效预览；后续预览可归档过期记录。
- 新上传在事务内限制 2000 个活动身份，清理可在上限执行；历史墓碑不占活动预算。入场 maintenance epoch CAS 和 commit staging 存在性验证阻止迟到请求复活已归档版本。
- T023：按目标原子保存数量/日周月配置，重启恢复。首次先展示当前占用、本批预计释放和清理后占用，再保存；保存与预览均不授权删除。修改规则使旧预览/确认失效，没有定时清理。
- 测试夹具统一从迁移目录加载全部迁移；新增可复用云验收场景及浏览器脚本。保护契约见 [远端维护](../REMOTE-MAINTENANCE.md)，决策见 [ADR-013](../adr/013-remote-maintenance-lifecycle.md)。

### 验证

| 命令 / 范围                                                                                                                                                                                                                                                           | 结果与证据                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run build`、`pnpm run typecheck`                                                                                                                                                                                                                                | 通过；生产构建仍有既有大 chunk 提示                                                                                                                                                                |
| 修改文件的 ESLint / Prettier、`git diff --check`                                                                                                                                                                                                                      | 通过                                                                                                                                                                                               |
| `pnpm exec vitest run tests/remote-maintenance.test.mjs tests/retention-policy.test.mjs tests/maintenance-recovery.test.mjs tests/cloud-acceptance.test.mjs tests/extensions.test.mjs --reporter=default --reporter=json --outputFile=test-results/g09-targeted.json` | 55/55 通过；覆盖过期活动、归档中断、旧 ID 重放、迟到 commit/plan、跨分支并发入场、预算拒绝、空间估算与配置重启/隔离。2000 版本合成清理用例约 0.7 秒；是本地内存 R2 / SQLite 回归，不代表真实云吞吐 |
| `ANYNOTE_BROWSER=/usr/bin/google-chrome node scripts/remote-retention-smoke.mjs`                                                                                                                                                                                      | 3/3 通过；首次预估与独立保存、重新打开、改动规则撤销确认。报告 `test-results/remote-retention-ui.json`；模拟 RPC，非真实 Electron/云端                                                             |
| `node scripts/cloud-worker-local.mjs`                                                                                                                                                                                                                                 | 官方本地 workerd/D1/R2：7 项基础、6 项维护、5 项流式、4 项持久化恢复均通过，包括真实 SIGKILL 后闹钟续跑；报告 `test-results/cloud-worker-local.json`                                               |
| 全量 `pnpm exec vitest run --reporter=default --reporter=json --outputFile=test-results/g09-vitest.json`                                                                                                                                                              | 465 通过、1 跳过、4 失败。3 项未改动的 `icons.test.ts` 断言与当前图标实现不符；1 项未改动的 `archive-stream.test.mjs` 内存增长为 51583392 字节，超过 48 MiB 阈值。全量未标为通过                   |

归档流式测试在构建结束后单独串行复测 18/18 通过，报告 `test-results/g09-archive-recheck.json`；一次较早复测与构建清理产物重叠，产生模块缺失错误，已排除该次无效运行。全量报告中的内存阈值失败仍保留，未重写为全量通过。

初次全量在沙箱内受本地端口/子进程 EPERM 限制；上述全量报告来自允许本地端口/子进程后的复测。报告由命令生成于忽略目录，不作为已提交仓库文件引用。

### 剩余边界与下一步

- G07 T003/T021/T025：未部署真实 Worker，未执行真实 24h/7d 老化、满预算配额、归档成本和长期调度验收；复测需求已写入 [G07](07-cloudflare-acceptance.md)。部署前应用全部 D1 迁移至 `0005.sql`。
- R2 回执/墓碑长期保留，D1 工作集回收不等于远端总空间恒定。估算不含归档、D1、服务商费用及未完成 multipart 分段；G10 负责这些未完成分段的会话注册/abort/续传。
- 没有新增自动删除；当前协调器只续跑已经明确确认的计划。不存在等待产品负责人批准自动策略的阻塞。
- 全量中图标断言与归档内存阈值问题在本组范围外；归档单独复测通过，但不据此宣称项目全量测试通过。
