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

- [ ] **P2 — 维护记录生命周期**：设计并实现 staging、孤立 manifest、清理计划、接管回执和 retired 墓碑的安全归档/回收；解决长期运行触及活动版本、保护项及 2000 项身份预算的情况，保持幂等和恢复证据。

### T023 · 原 §4

- [ ] **P2 — 保留策略持久化与空间预估**：按目标保存数量/日周月保留配置，首次设置展示预计空间；自动执行清理如要支持，单独定义用户授权和保护契约。当前采样为每次手动预览/确认，不是定时删除策略。

## 验证与完成条件

- [tests/retention-policy.test.mjs](../../tests/retention-policy.test.mjs)
- [tests/cloud-acceptance.test.mjs](../../tests/cloud-acceptance.test.mjs)
- [docs/REMOTE-MAINTENANCE.md](../../docs/REMOTE-MAINTENANCE.md)

完成条件：保护契约、实现、幂等回归与 UI 语义一致，手动预览不被标为自动策略。

人工 / 外部资源：如增加自动删除，产品负责人明确授权语义；真实远端证据由 G07 提供。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
