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

- [x] **P2 — 模块分层与循环依赖**：拆解 backup/storage、extension-tools/plugin-sdk 等循环，隔离领域服务、存储、UI 与厂商协议；建立无循环的包构建/TypeScript references 图。现有统一后端编译和 workspace 检查已实现，不重复建设。

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

## 首批实施与交接（2026-10-21）

基线：`7cf9358` 工作树；macOS arm64、Node 24.22.0、pnpm 12.14.0。按本组“每次一组共享接口”的约束，本批选择扩展 SDK/工具/Storage 共享接口，不重构整个仓库。T052、T053 保持未勾选，以下仅代表首批完成。

### 当前依赖与动态边界盘点

- 开工时 SDK ↔ extension-tools、SDK ↔ storage-sqlite 存在直接及间接循环。本批移除 SDK 到工具/Storage 的反向依赖；SDK → types，tools → SDK/protocol，Storage → tools/SDK，extension-host → Storage/SDK。
- backup、backup-local、backup-core 与 storage-sqlite 仍组成循环依赖组；pnpm 的循环提示仍有依据。下一批应围绕备份所需 Storage 门面/快照/任务契约串行实施。
- 动态边界还包括 Storage 总分派的 `result?: any`、通用 `SqlRow`、权限门面的行映射及公共 `createAPI` transport 的泛型断言。本批只收紧提案操作/SQL JSON/返回值，以及脚本结果 JSON，不将其余项目视为已完成。
- 现有后端使用统一严格编译，没有新建包级 composite/references 图。本批在既有 workspace 检查中加入受保护包的传递依赖及显式 references 循环检查；全仓无循环条件仍待后续批次。

### 已实施

- 搜索/网络 schema 和校验归 SDK；权限门面、AI 提案状态机归 Storage，移除旧路径并同步调用方、测试、manifest、lockfile、打包清单和 lint 配置。
- 提案操作名为联合类型，创建/应用/撤销分别验证参数；SQL 投影明确 `value_json`，记录按 proposed/applied/undone 区分，验证目标 ID、修订号及笔记结果。畸形 JSON、缺失字段和错目标在写入前拒绝，保留版本冲突、重复应用和条件撤销行为。
- 脚本 JSON 输出通过正文/状态校验再出 Worker；搜索/网络校验返回公开契约，dry-run 状态不再为 `unknown`。
- 修复 G18 发现的 SDK 云盘实现/声明漏打包，补齐类型路径改写与云盘 API 消费测试。CLI 离线消费脚本用 npm 重打包第三方依赖，四个模板分别安装本地 tarball，避免依赖父目录或触发注册表安装。
- 决策记录：[ADR-011](../adr/011-extension-module-boundaries.md)。

### 验证

- `pnpm run workspace:check`：18 个 workspace 通过，本批依赖边界无循环；未声称备份依赖组无循环。
- `pnpm run typecheck`、`pnpm run build:backend`：通过，含 `tests/types` 新增的结果类型、状态和提案分派负向断言。
- `pnpm exec vitest run tests/module-boundaries.test.mjs tests/extensions.test.mjs tests/sdk.test.mjs tests/sdk-extension-points.test.mjs tests/extension-host.test.mjs tests/extension-tools.test.mjs tests/script-runtime.test.mjs tests/script-state.test.mjs tests/script-search.test.mjs tests/script-async.test.mjs tests/script-network.test.mjs tests/editor-ecosystem.test.mjs tests/extension-data.test.mjs tests/extension-settings.test.mjs tests/extension-updates.test.mjs`：15 文件 / 133 项通过；最后收紧提案返回值后重跑 extensions/module-boundaries，21 项通过。
- `pnpm run lint`、本批文件 Prettier 检查、`git diff --check`：通过。
- `pnpm run test:sdk:package`、`pnpm run test:extension-tools:package`：SDK 独立 tarball：干净离线消费者类型检查与运行通过，覆盖本地/云盘 API；CLI tarball：四种 TypeScript 模板及同步搜索/异步搜索/网络 fixture 通过。报告：`test-results/extension-tools-package.json`（由 `pnpm run test:extension-tools:package` 生成）。
- 验证环境以 Node 24 路径优先；pnpm script 检查时使用 `npm_config_verify_deps_before_run=false`，避免本机缓存目录切换触发自动重装。此前重装已停止，使用原缓存离线恢复成功，未下载依赖；lockfile 仅修改本批 workspace 边。
- 不涉及 UI 改动，未执行浏览器/性能基准、真实公网插件或最终发行设备矩阵；本地 SQLite/Worker 回归和离线 tarball 不能替代这些验收。

### 后续批次与跨组交接

1. 备份依赖组：围绕 backup / backup-local / backup-core / storage-sqlite 的实际 Storage 能力抽离接口，同步其 SQL 投影与任务结果；与 G08/G11–G13 同包功能修改错开。
2. Storage/API 动态边界：逐组收紧总分派、常用 SQL 行和 transport 响应，补齐运行时校验；与 G14–G16 的调用方协调，最后才勾选 T052/T053。
3. G05/T009：SDK 云盘产物闭包已修复并有当前离线证据，真实发行矩阵保持原验收要求。G18：本次已同步 ADR-007/009/011、SDK README 和实施摘要；G21 的真实网络验收条件不变。

## 第二批实施与交接（2026-10-21）

基线：`76a52ef` 工作树；Linux x64、Node 24.11.1、pnpm 12.14.0。首批已处理扩展循环，本批按“一组共享接口”约束处理备份/Storage 循环及其快照与任务分派边界。T052 在两批合计覆盖下完成；T053 仍未完成，不把全仓类型编译通过视为所有动态数据已验证。

### 依赖核对与实施

- 当前会话未提供 codebase-memory 图工具，按技能回退到实际 manifest、静态/动态 import、调用方及源码检查；未声称取得图索引覆盖证据。核对发现 Storage 的备份分派、快照捕获及任务重试反向引用 backup / backup-core。
- 新增私有 `@anynote/backend` 装配入口，Electron、预览 API、备份工具和集成测试使用该入口。基础 Storage 接收每实例服务映射，移除 backup / backup-core 依赖；backup / backup-local / backup-core 继续单向使用 Storage。操作目录由对应服务包维护，装配层不在启动时加载备份实现或厂商 Provider。
- `ServiceOperation` 输入/结果为 `unknown`，`advancedOperations` 改为判别联合结果。并发标记归装配层；捕获保持串行，远端读取/维护保留原并发行为，任务重试直接使用同一分派并验证返回句柄，避免重新排队死锁。
- 捕获入口严格验证 UUID、受管目录、真实 AbortSignal；SQL 使用专用元数据投影并限制最多两行，验证唯一行、Notebook 身份、schema v4、十进制序列。远端清单拒绝不安全整数，本地备份保留精确字符串。页数、页大小和任务句柄也保留运行时验证。
- 全部 workspace 现在受循环检查保护，含 manifest 中的类型/开发依赖及显式 references。继续使用统一严格编译；按包构建补入官方扩展闭包，未新增 composite 流水线。
- 同步 manifest、lockfile、入口、测试、README、开发工作流与实施摘要；设计决策见 [ADR-012](../adr/012-backup-service-composition.md)。

### 验证与环境限制

- `pnpm run workspace:check`：19 个 workspace 通过，全仓包依赖及当前显式 references 无循环。
- `pnpm run typecheck`、`pnpm run build:backend`、`pnpm --filter @anynote/backend build`：通过。新增 `tests/types/backup-boundaries.ts` 覆盖 unknown 输入/结果、未处理分支、任务 ID、SQL 序列和取消信号负向断言。
- `pnpm exec vitest run`：64 文件中 63 文件通过；457 项通过、1 项跳过、3 项失败。失败均为既有 `tests/icons.test.ts` 与当前 Lucide 实现不一致（viewBox、title、class）；测试和图标实现本批均未修改。备份、Storage、Web 导入、扩展及新增边界回归通过。
- 最终定向回归覆盖 backup-boundaries、module-boundaries、task-history、backup-policy、backup-local、cloud-stream、cloud-recovery、cloud-account-settings、cloud-verification-budget、remote-maintenance、web-import：11 文件通过，118 项通过、1 项跳过。
- `pnpm run test:sdk:package`：干净离线 SDK tarball 消费的类型检查与运行通过。新增 backend 测试在临时独立 Node 工程通过 workspace 导出消费，覆盖笔记创建、备份目标及官方云盘注册；backend 为私有包，此项不声称独立 tarball 发布验收。
- `node scripts/benchmark-local-backup.mjs --samples 100:1 --report-path test-results/g17-local-backup.json`：通过。合成样本 100 资源、约 1 MiB 数据库，脚本另含 8 MiB PDF 和 1 GiB 取消夹具；首次备份 132.43 ms、未变化 7.12 ms、小修改 32.05 ms、校验 106.60 ms、恢复 92.95 ms，取消场景通过。报告为 `test-results/g17-local-backup.json`；不代表真实外接盘、大规模清单或 Electron 响应验收。
- `pnpm run lint`、本批文件格式检查、`git diff --check`：通过。
- 本机 node_modules 来自旧 pnpm 缓存布局，pnpm 12 离线安装缺少迁移后的元数据；只同步本次 workspace importer 并补齐本地 workspace 链接，没有下载或修改第三方版本。已解析比对所有 importer 与 manifest，外部 packages/snapshots 及包管理器锁文档与基线相同。脚本使用 `pnpm --config.verifyDepsBeforeRun=false …` 避免自动重装；不声称冻结安装通过。
- 首轮沙箱回归因 loopback 监听/Node 子进程 EPERM 出现 3 项环境失败，允许本地监听和子进程后全部通过；与上述图标断言失败分开记录。不涉及 UI 改动，未执行浏览器交互、真实云账号、物理磁盘或最终发行矩阵。

### 下一批与跨组交接

1. T053：继续按接口组收紧 `Storage.run/execute`、常用 SqlRow、持久 JSON（含备份目标）及公共 `createAPI` transport；本批的服务分派 unknown 不能替代各调用点的数据验证。备份实现内部仍使用具体 Storage 能力，后续接口细化不需要恢复包反向依赖。
2. G08/G11–G13：完整应用服务从 backend 创建；直接消费基础 Storage 不会隐式获得备份操作。快照保持写队列屏障，网络服务并发标记在 backend，后续同包改动串行集成。
3. G14–G16：`advancedOperations` 结果必须先检查 handled，再验证 unknown；媒体导入确认及任务重试调用方已同步。
4. G05/G18：打包按新增 backend workspace 收齐闭包，继续使用既有发行组装流程；设计与开发工作流已回写。全量测试中的图标既有失败交 G20，真实设备/账号验收要求不变。
