# G17 · 模块依赖与动态类型边界

[返回总入口](../../TODO.md)

类型：内核重构。目标：消除包循环、划清领域接口、收紧动态结果类型。

前置：先核对当前依赖图与运行时边界；每次仅选择一个循环或一组共享接口。

并行边界：不能与同包功能改动同时落地；可在独立 worktree 分析，按批次串行合入。

## 建议入口

- [packages/backup/src/service.ts](../../packages/backup/src/service.ts)
- [packages/storage-sqlite/src/operations.ts](../../packages/storage-sqlite/src/operations.ts)
- [packages/plugin-sdk/src/contracts.ts](../../packages/plugin-sdk/src/contracts.ts)
- [packages/extension-tools/src/commands.ts](../../packages/extension-tools/src/commands.ts)
- [tsconfig.backend.json](../../tsconfig.backend.json)

## 执行顺序

1. 枚举实际循环与动态边界，按共享文件选定一批，不在单会话重构整个仓库。
2. 在该批次抽离领域/存储/厂商接口，同步收紧 SQL 投影、分派和 JSON 类型并保留运行时校验。
3. 完成构建图和行为回归后交接下一批；同步记录 ADR 并通知受影响功能组。

## 待办

### T052 · 原 §8

- [ ] **P2 — 模块分层与循环依赖**：拆解 backup/storage、extension-tools/plugin-sdk 等循环，隔离领域服务、存储、UI 与厂商协议；建立无循环的包构建/TypeScript references 图。现有统一后端编译和 workspace 检查已实现，不重复建设。

### T053 · 原 §8

- [ ] **P2 — 动态类型边界收紧**：把常用 SQL 投影、操作分派和 JSON 结果从 `SqlRow/any` 收紧为专用接口，保留运行时校验；逐项改造公开契约，不把 TypeScript 编译通过当作数据校验。

## 验证与完成条件

- `pnpm run workspace:check`
- `pnpm run typecheck`
- `pnpm run build:backend`
- [tests/types](../../tests/types)
- 受影响包的行为测试及公共包消费测试。

完成条件：选定范围无循环、接口有运行时保护，整项勾选需覆盖所有约定批次。

人工 / 外部资源：通常无需外部账号或设备；出现产品契约取舍再交 G00 决定。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
