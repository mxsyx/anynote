# Cloudflare 故障、维护与容量验收

[返回账号任务入口](02-account-validation.md) · [返回总入口](../../TODO.md)

更新：2026-10-24。已更新独立测试部署并重跑小规模真实云基线、进程恢复与续传验收，建立真实老化样本。三项均为部分完成，证据和剩余范围见下方交接。

## 执行边界

- 资源：受控 Cloudflare 账号/部署权限、独立 Worker/D1/R2 测试命名空间、持续运行环境，以及能够跨过真实宽限期的对象与 staging 样本。
- 顺序：核对当前版本与真实备份/恢复基线 → 建立 A008 老化样本并记录时间和保护关系 → A007 故障与长期调度 → A008 到期验收 → A009 容量/负载批次。A009 不依赖老化等待结束；资源隔离时可在等待期间执行。
- 三项复用部署和报告，但不是一次持续等待的会话：按故障、老化复验、容量三个阶段接续。不得用改时钟代替超过 24h 或连续 7 天的真实等待。
- 同一远端槽或命名空间中的故障、清理及负载操作串行；若要并行，分别使用独立命名空间、配额预算和报告。A009 的负载不得污染 A007 调度或 A008 生命周期观测。
- endpoint 条件写与发布冲突验收并入 A007，记录双写冲突、响应丢失及读回确认的真实服务结果。已存在的历史云验收不等于本组全部通过。

## 任务

<a id="a007"></a>

### A007 · 真实远端故障与长期调度

- [ ] **P0 — 真实远端故障与长期调度**：覆盖网络中断/限流、鉴权或权限撤销、配额不足、服务不可用及多轮自动备份；核对退避、取消、幂等、提交结果确认、旧版本可恢复和本地编辑不受阻，保留真实服务报告。

续传协议还需在真实服务验证：上传/下载中断与 Storage 重启后的实际字节复用、未登记的空 multipart、默认/自定义桶生命周期、服务端复制中断、abort 丢响应，以及短于 7 天桶规则下的会话重建。参见 [续传协议](../adr/014-cloudflare-transfer-resume.md)。

<a id="a008"></a>

### A008 · 真实老化对象回收

- [ ] **P0 — 真实老化对象回收**：Cloudflare R2 实测超过 24 小时宽限期的无引用对象删除，同时验证保留版本、其他分支、staging 和恢复保护不受损。当前 aged-object 删除主要依赖受控时间合约。

当前维护协议复测还需覆盖：超过 24h 的孤立 manifest/临时对象、连续 7 天无活动 staging、归档写失败后的恢复及墓碑旧 ID 重放；保护保留版本、分支和恢复任务。参见 [维护生命周期协议](../adr/013-remote-maintenance-lifecycle.md)。

<a id="a009"></a>

### A009 · 远端容量与真实负载

- [ ] **P2 — 远端容量与真实负载**：测量大规模维护规划、20GiB/大量附件、长期版本积累、D1/R2 配额与成本；必要时拆分清单、分批验证或异步任务。现有重复块 112MiB 样本不代表随机数据吞吐或满预算通过。

补测 2000 活动版本、200000 引用、满上传会话预算、随机大文件吞吐、永久归档增长及首次预览请求量；记录 D1/R2 实际成本。空间估算不包含 D1、维护归档和未完成 multipart 分段。

## 资源与验收入口

- [真实云验收](../CLOUD-ACCEPTANCE.md)、[维护协议](../REMOTE-MAINTENANCE.md)、[云传输](../STREAMING-CLOUD-BACKUP.md)、[维护生命周期协议](../adr/013-remote-maintenance-lifecycle.md)、[续传协议](../adr/014-cloudflare-transfer-resume.md)。
- 按场景选用 `pnpm run test:cloud`、`pnpm run test:cloud:stream`、`pnpm run test:cloud:recovery`；本地回归入口包括 `tests/cloud-acceptance.test.mjs`、`tests/cloud-resume.test.mjs`、`tests/cloud-stream.test.mjs`、`tests/cloud-recovery.test.mjs`。现有入口未覆盖的真实故障、生命周期和容量场景仍需补测。
- 授权负责人提供账号访问和测试资源/成本范围；人工登录或授权完成后可使用现有部署工具。真实时间等待和厂商实际故障不能用 AI 模拟结果代替。

收尾：按[统一完成与交接规则](02-account-validation.md#handoff)更新本文件复选框、阻塞原因、下一步和证据；部分通过保持未完成，完成后归档并同步入口。

<a id="current-evidence"></a>

## 2026-10-24 实施与交接

- 范围：用户限定仅小规模验证，本次不做付费压力测试。复用 `anynote-backup-acceptance-518ee6c2` 独立 Worker/D1/R2；通过现有 Wrangler 登录完成部署、D1 迁移、应用接口与 R2 只读检查，未撤销账号权限或修改桶规则。
- 版本：源码基于 `8afc60a`，本次增加老化入口并修复部署后验收仍传入已移除 `--provider` 的问题；Worker 更新到 schema v4，版本 ID `8b464dd2-b17b-437b-89c2-e0a97b258e13`。旧部署能力检查只支持 schema v2，不能沿用旧报告。
- **A007 部分通过**：`pnpm run build:backend` 后执行 `node scripts/cloud-deploy.mjs`，真实云协议/维护 14 项通过；`node --env-file-if-exists=.env.cloud scripts/cloud-recovery-acceptance.mjs` 的 6 项通过，覆盖提交前/后 SIGKILL、游标确认、恢复中断及源库离线恢复。报告：`test-results/cloud-acceptance.json`、`test-results/cloud-recovery-acceptance.json`。
- **A007 续传**：`node --env-file-if-exists=.env.cloud scripts/cloud-stream-acceptance.mjs` 首次收到 HTTP 503，保留 `test-results/cloud-stream-acceptance-first.json`；开启只读诊断后复跑 7 项通过，上传重启复用 32MiB、下载重启复用 16MiB、112MiB 附件完整哈希校验通过。成功报告及脱敏日志为 `test-results/cloud-stream-acceptance.json`、`test-results/cloud-stream-tail.json`。首次 503 根因未确认；复跑成功不能替代限流退避、厂商故障或长期调度验收。
- **A008 等待真实时间**：新增 [老化场景](../../scripts/cloud/aging-scenario.mjs)、[CLI](../../scripts/cloud-aging-acceptance.mjs) 和 [回归](../../tests/cloud-aging.test.mjs)。已运行 `node --env-file-if-exists=.env.cloud scripts/cloud-aging-acceptance.mjs --seed`，状态为 `waiting`；提前运行 `--verify 24h` 返回 2，未冒充通过。状态文件 `.cloudflare-acceptance/aging.json` 保存完整 manifest、对象哈希、保护关系和后续清理计划，不含凭据。
- **R2 基线**：独立管理端下载验证了 167936 字节孤立对象及其 SHA-256；桶规则为已启用的 `Default Multipart Abort Rule`，所有前缀的未完成 multipart 在 7 天后 abort。记录在 `test-results/cloud-aging-resource-check.json`。这里只核对当前规则，未证明厂商已执行到期回收。
- **A009 未执行满负载**：遵守本次预算范围，不运行 20GiB、2000 活动版本、200000 引用、满上传会话预算或长期归档增长/成本测试。112MiB 重复块仅用于续传与完整性，不代表随机吞吐或容量预算通过。
- **本地验证**：Cloudflare 相关 9 个测试文件、61 项全部通过（`cloud-aging`、`cloud-deploy`、`cloud-acceptance`、`cloud-resume`、`cloud-stream`、`cloud-recovery`、`remote-maintenance`、`cloud-multipart`、`maintenance-recovery`）；报告 `test-results/cloud-validation-local.json`。后端构建和变更脚本 ESLint 检查通过。受控时钟只用于本地回归，不作为真实老化证据。

本次老化样本（时间为北京时间 UTC+8）：

| 项目                                     | 标识 / 时间                            |
| ---------------------------------------- | -------------------------------------- |
| Notebook                                 | `a4259e93-0469-4f44-a561-187b9577d9a8` |
| 当前分支                                 | `4943c2a0-a3b1-4fc6-915b-8ca9865c8b1a` |
| 旧版本（已退役，保留无引用对象等待老化） | `8e890304-867b-4feb-8e0d-8807a57be351` |
| 恢复 pin 验证版本                        | `66d88983-2606-458c-bc7b-2797e1516997` |
| 保留 head                                | `c0d50f38-fd03-4571-af1f-8ddc36c04b7d` |
| 其他分支 head                            | `cb07988b-4d9a-4936-95dc-f6a50dca1072` |
| 无活动 staging                           | `296600c0-b02a-43a1-9f11-a4a4fd96fb4e` |
| 样本建立完成                             | 2026-10-24 21:10:18                    |
| 24h 最早复验                             | 2026-10-25 21:11:19（已留 1 分钟余量） |
| 7 天最早复验                             | 2026-10-31 21:11:19（已留 1 分钟余量） |

下一步按[老化验收命令](../CLOUD-ACCEPTANCE.md#跨会话老化样本)先执行 `pnpm run test:cloud:aging --verify 24h`，在 staging 满 7 天前完成该阶段；到期后再执行 `--verify 7d`，同时用管理端核实 R2 物理删除。等待期间不要对该样本重新 plan、上传或提交，以免刷新 staging 活动或改变保护集合。本次未启动后台调度器，需后续会话按期接续。

剩余阻塞：A007 尚缺长期自动备份、多类真实故障/权限撤销/配额不足、multipart 生命周期/复制中断/abort 丢响应；A008 尚需真实等待及物理删除证据、孤立 manifest/临时对象、7 天 staging 到期和归档失败恢复；A009 需要另行明确负载费用范围。保持 A007–A009 未勾选。
