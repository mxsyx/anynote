# G08 · 本地备份大清单与桌面响应

[返回总入口](../../TODO.md)

类型：内核 / 性能。目标：大清单优化与真实 Electron 响应测量。

前置：可立即建立当前基线；真实规模样本和 Electron 测量环境。

并行边界：与云盘/导入组可并行；涉及 Storage 或捕获契约时与 G17 串行集成。

## 建议入口

- [packages/backup/src/local.ts](../../packages/backup/src/local.ts)
- [packages/backup/src/local-capture.ts](../../packages/backup/src/local-capture.ts)
- [scripts/benchmark-local-backup.mjs](../../scripts/benchmark-local-backup.mjs)
- [scripts/desktop-local-backup-acceptance.mjs](../../scripts/desktop-local-backup-acceptance.mjs)

## 执行顺序

1. 先测万/十万附件扫描、捕获、提交的耗时、RSS、帧间隔和取消响应。
2. 按瓶颈优化扫描、元数据/清单与共享 I/O 预算，保持捕获切点和数据保护契约。
3. 复用同一数据集重测性能与取消；跨会话免捕获仍在后续清单单独评估。

## 待办

### T018 · 原 §3

- [ ] **P2 — 大清单性能优化**：优化资源闭包同步扫描、十万附件元数据检查、完整 JSON 清单和内存数组；基准零变化检查约 30 秒、事件循环最长停顿约 4.7 秒、阶段采样 RSS 最高约 825MiB。评估捕获 barrier、共享 I/O 预算及多 Notebook 检查开销，复测耗时、内存、取消和数据保护。

### T019 · 原 §3

- [ ] **P2 — 规模下桌面响应测量**：真实 Electron 测量万/十万附件检查、捕获、提交期间的帧间隔、任务查询和取消响应；已有 2GiB 附件复制的短时测量不覆盖大清单阶段。

## 验证与完成条件

- [tests/backup-local.test.mjs](../../tests/backup-local.test.mjs)
- `pnpm run benchmark:local-backup`
- `pnpm run test:desktop:local-backup`

完成条件：提交前后对照和数据保护回归齐全；复制阶段短时响应不代表大清单阶段。

人工 / 外部资源：若需低配置或外接设备样本，由设备持有者运行；本地优化不等待这些样本。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
