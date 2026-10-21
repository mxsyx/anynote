# G07 · Cloudflare 真实故障与容量验收

[返回总入口](../../TODO.md)

类型：验收 / 实测。目标：长期调度/故障、24h 老化 GC、真实容量与成本。

前置：受控 Cloudflare 测试环境与真实对象；云盘通用故障结果由 G01 提供。

并行边界：与本地任务并行；同一远端命名空间内 GC、恢复和故障注入串行。

## 建议入口

- [scripts/cloud/maintenance-scenarios.mjs](../../scripts/cloud/maintenance-scenarios.mjs)
- [scripts/cloud/stream-scenario.mjs](../../scripts/cloud/stream-scenario.mjs)
- [docs/REMOTE-MAINTENANCE.md](../../docs/REMOTE-MAINTENANCE.md)
- [docs/STREAMING-CLOUD-BACKUP.md](../../docs/STREAMING-CLOUD-BACKUP.md)

## 执行顺序

1. 准备独立测试命名空间与长期任务，老化对象实际跨过宽限期后再验证删除。
2. 验证网络/权限/配额故障和恢复保护，接收 G01 的厂商故障报告以闭合通用 T003。
3. 以随机数据、大附件与长期版本测量真实负载；G09/G10 改动后补测对应路径。

## 待办

### T003 · 原 §1

- [ ] **P0 — 真实远端故障与长期调度**：覆盖网络中断/限流、鉴权或权限撤销、配额不足、服务不可用及多轮自动备份；核对退避、取消、幂等、提交结果确认、旧版本可恢复和本地编辑不受阻，保留真实服务报告。

### T021 · 原 §4

- [ ] **P0 — 真实老化对象回收**：Cloudflare R2 实测超过 24 小时宽限期的无引用对象删除，同时验证保留版本、其他分支、staging 和恢复保护不受损。当前 aged-object 删除主要依赖受控时间合约。

### T025 · 原 §4

- [ ] **P2 — 远端容量与真实负载**：测量大规模维护规划、20GiB/大量附件、长期版本积累、D1/R2 配额与成本；必要时拆分清单、分批验证或异步任务。现有重复块 112MiB 样本不代表随机数据吞吐或满预算通过。

## 验证与完成条件

- `pnpm run test:cloud`
- `pnpm run test:cloud:stream`
- `pnpm run test:cloud:recovery`
- 真实超过 24h 的对象年龄、负载、配额/成本及多轮调度证据。

完成条件：保护对象未受损、旧版本可恢复，报告区分实际执行与环境限制。

人工 / 外部资源：真实服务账号与权限/配额故障条件，持续运行环境；不要把受控时钟当真实老化。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
