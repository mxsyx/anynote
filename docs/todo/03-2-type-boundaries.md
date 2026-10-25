# 动态类型边界收紧

[返回功能任务入口](03-feature-logic.md) · [返回总入口](../../TODO.md)

更新：2026-10-25。

F005 按接口和调用点分批完成，每批同时交付专用类型、运行时校验与回归。跨批次保留一份任务状态，不以全仓替换或仅修改返回类型作为完成依据。

## 任务

<a id="f005"></a>

### F005 · 动态类型边界收紧

- [ ] **P2 — 动态类型边界收紧**：按接口组收紧 Storage.run/execute、常用 SQL 投影、持久 JSON（含备份目标）及公共 createAPI transport，使用专用接口并保留运行时校验。全仓包循环和服务装配重构已完成；服务分派结果改为 unknown 不能替代调用点的数据验证。

## 会话拆分

| 批次                | 工作范围                                             | 验收与交接                                                             |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| 1：Storage 操作边界 | Storage.run/execute 的输入、结果与实际调用点         | 类型回归、非法输入/结果校验及受影响操作测试一起通过                    |
| 2：SQL 与持久 JSON  | 按业务接口收紧常用 SQL 投影、持久 JSON，包含备份目标 | 每次只处理共享调用点和测试的一组数据；检查空值、缺失字段和非法持久数据 |
| 3：公共 transport   | createAPI transport 与消费方契约                     | 专用接口和运行时结果验证同时落地，覆盖 transport 异常和非法返回        |

建议按 1 → 2 → 3 推进；每批启动时列出实际文件和受影响测试，若某批仍跨独立业务模块，继续按调用点切小。已存在的服务装配和包循环治理不重复实施。

## 本轮进展（2026-10-25）

F005 保持未勾选：本轮完成基础调用链，后续继续按业务接口分批，不将动态服务返回 `unknown` 视为所有操作契约已完成。

| 批次 | 已交付范围                                                                                                                                                                                           | 剩余范围                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1    | `Storage.run/execute` 移除 `any` 输入/结果；基础 Notebook、节点、历史、搜索、资源读取、归档发布及本地备份版本共 17 项操作建立关联输入/结果契约；动态服务消费方校验快照、扩展目录/下载/更新和导入结果 | 其余操作目前返回 `unknown`，继续按导入/编辑、扩展管理、备份任务等接口组补齐操作名关联类型，复用现有运行时校验 |
| 2    | 校验 Notebook/节点/修订投影、标签 JSON、导入报告与导入提交、幂等修改回执、远程备份目标；调度器共用备份目标读取，写入前校验本地/远程配置，本地版本复用既有 schema                                     | 白板场景、批注 selector、清理计划等剩余 SQL/JSON 边界仍需独立收紧；全局 `SqlRow` 尚未替换                     |
| 3    | `createAPI` 方法/输入映射与固定结果校验完成；动态 settings 返回 `unknown`，由扩展校验；宿主搜索补齐声明的笔记快照；首方宿主通道命名为 `OperationTransport`，SDK 发布包包含新模块且无新增运行时依赖   | 首方 `OperationTransport` 适配器仍有独立结果断言，不能将公共 `createAPI` 的完成推广到这些适配器               |

实现入口：[Storage 契约](../../packages/storage-sqlite/src/operation-contracts.ts)、[导入契约](../../packages/storage-sqlite/src/import-contracts.ts)、[扩展结果](../../packages/storage-sqlite/src/extension-results.ts)、[备份连接](../../packages/backup/src/connection.ts)、[SDK transport](../../packages/plugin-sdk/src/transport.ts)。调用方与 SDK/首方适配器 README、独立打包脚本已同步。

验证记录：

- `pnpm run build:backend`、`pnpm run typecheck`、`pnpm run workspace:check` 通过；变更文件 ESLint、Prettier 与 `git diff --check` 通过。
- [运行时回归](../../tests/type-boundaries.test.mjs)与[类型回归](../../tests/types/type-boundaries.ts)覆盖非法输入/结果、缺失字段、损坏 JSON、备份调度拒绝非法配置、嵌套 transport 返回、异常与取消。最终受影响的 storage、SDK、web-import、backup-boundaries、backup-policy、backup-local、extension-download、extension-updates、extension-directories、search、transfer 等 13 个测试文件：118 通过、1 跳过。
- `node scripts/sdk-package-smoke.mjs`、`node scripts/build-first-party-adapters.mjs && node scripts/first-party-package-smoke.mjs`：离线独立消费方类型和运行时通过。最初独立 Node 子进程测试在沙箱内遇到 `EPERM`，允许本地子进程后已通过。
- 完整 `pnpm exec vitest run`：439 通过、1 跳过、4 失败；3 项为未修改的 `icons.test.ts` 与现有图标输出不符，1 项为 `archive-stream.test.mjs` 的流式导出缓冲增长 51,943,840 字节，超过 48 MiB 阈值。该归档文件与新增边界/SDK 回归随后单独运行共 24 项通过；首次内存阈值失败原因未定位，不能据重跑通过宣称修复。完整回归未全绿。

下一批先选择一个剩余 Storage 业务组，将其输入、结果和消费方校验一起落地；保持本文件为跨会话状态入口。未执行真实云、真实设备或 UI 验收，本轮没有修改界面流程。

## 代码与验证入口

- [Storage 操作](../../packages/storage-sqlite/src/operations.ts)、[公共 API](../../packages/plugin-sdk/src/index.ts)、[类型回归](../../tests/types)。
- 每批运行 `pnpm run typecheck`、`pnpm run workspace:check` 及受影响功能测试；类型检查不能替代运行时非法数据回归。
- 与 F001/F002、F013/F014/F015 等修改同包接口的工作错开；先合入功能契约，再针对稳定调用点收紧类型。不能据此认定 F005 阻塞所有功能开发。

完成与交接遵循[统一规则](03-feature-logic.md#handoff)。阶段完成不等于整项完成；未满足完整验收条件时保留未勾选。
