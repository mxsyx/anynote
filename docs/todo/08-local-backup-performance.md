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

- [x] **P2 — 大清单性能优化**：优化资源闭包同步扫描、十万附件元数据检查、完整 JSON 清单和内存数组；基准零变化检查约 30 秒、事件循环最长停顿约 4.7 秒、阶段采样 RSS 最高约 825MiB。评估捕获 barrier、共享 I/O 预算及多 Notebook 检查开销，复测耗时、内存、取消和数据保护。

### T019 · 原 §3

- [x] **P2 — 规模下桌面响应测量**：真实 Electron 测量万/十万附件检查、捕获、提交期间的帧间隔、任务查询和取消响应；已有 2GiB 附件复制的短时测量不覆盖大清单阶段。

## 验证与完成条件

- [tests/backup-local.test.mjs](../../tests/backup-local.test.mjs)
- `pnpm run benchmark:local-backup`
- `pnpm run test:desktop:local-backup`

完成条件：提交前后对照和数据保护回归齐全；复制阶段短时响应不代表大清单阶段。

人工 / 外部资源：若需低配置或外接设备样本，由设备持有者运行；本地优化不等待这些样本。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。

## 2026-10-21 实施记录

实现、测量口径、环境和原始报告路径见 [G08 性能交接](../G08-local-backup-performance.md)。本次基于 `c1ad96e`，改动仍在工作区。

- T018：已实施资源闭包分批扫描、共享 I/O 预算、分批清单校验/序列化、十万附件文件及日志预算修复、捕获取消、异步暂存清理和小文件缓冲调整。保留捕获切点、目标身份、写后校验与原子发布契约。跨会话免捕获未纳入。
- T019：补充 `test:desktop:local-backup --scale --samples 10000,100000`；全程采集真实 Electron 帧间隔、任务查询、取消应答/终态与进程 RSS，包含两个 Notebook 范围任务。万附件中间对照及最终十万附件测量已完成；十万附件真实 Electron 6/6 场景通过，Node 9/9 场景通过。
- 最终本地备份专项 41/41 通过；常规真实 Electron 8/8 通过。完整回归 443/446 通过，3 项失败为未修改的现有图标断言，详见报告。
- 类型、工作区依赖、改动文件 lint/格式检查通过。T018 / T019 完成并勾选；前后对照、数据保护结果和规模边界已在交接报告汇总。
- 剩余性能边界：十万清单仍有约 1 秒的后端等待；连续 Node 场景进程 RSS 高水位约 1.07GiB，复制/扫描取消后的清理约 5–7 秒。未宣称整体内存或首次复制吞吐下降；无本组完成阻塞。
- 未执行：低配置设备、外接 USB/HDD、冷缓存、真实拔盘与断电；这些设备样本仍按 G03/G04 的边界另行验收。
