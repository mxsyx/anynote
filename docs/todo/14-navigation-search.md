# G14 · 搜索定位、导航与目录契约

[返回总入口](../../TODO.md)

类型：内核 / UI。目标：大目录决策 → 搜索定位/链接修复 → 导航与书橱。

前置：可先测现有排序/查询；视觉规范与 G20 协调，格式变更需记录决策。

并行边界：与云盘/导入可并行；main.tsx、Storage 与 G17/G20 不同时修改。

## 建议入口

- [packages/storage-sqlite/src/organization.ts](../../packages/storage-sqlite/src/organization.ts)
- [packages/storage-sqlite/src/search.ts](../../packages/storage-sqlite/src/search.ts)
- [apps/desktop/src/main.tsx](../../apps/desktop/src/main.tsx)
- [apps/desktop/src/Bookshelf.tsx](../../apps/desktop/src/Bookshelf.tsx)

## 执行顺序

1. 测量大目录开销，先决定保留稀疏整数还是调整排序/查询契约。
2. 实现搜索命中定位、链接修复和预览，再补导航、属性与 Notebook 元信息。
3. 按搜索/目录与导航两个连续步骤推进，必要时分会话；保留现有书橱进入工作区流程。

## 待办

### T044 · 原 §6

- [x] **P2 — 排序与查询契约决策**：当前稀疏整数 `sort_key` 与同级事务重排有效，设计建议为字符串分数排序及分页子项查询；评估大目录开销，选择实现迁移或更新设计，避免仅为形式一致而迁移。

### T042 · 原 §6

- [x] **P2 — 搜索定位与失效链接修复**：命中后定位正文/PDF 页/批注位置，失效内部链接提供修复入口，快速打开提供选择预览；现有全局筛选、路径、片段、跨库跳转及反链已实现。

### T043 · 原 §6

- [x] **P2 — 导航与首次启动细节**：补齐可隐藏文档标签页、前进/后退、属性辅助面板，以及 Notebook 图标/封面色、创建位置和最近库路径/备份状态等设计项；深层目录和窄窗口行为持续按实际内容验收。

## 验证与完成条件

- [tests/search.test.mjs](../../tests/search.test.mjs)
- `pnpm run test:organization`
- `pnpm run test:search`
- `pnpm run test:bookshelf`

完成条件：行为、查询契约和设计记录一致，深目录、长标题及跳转定位有回归。

人工 / 外部资源：最终 IME/窄窗口/键盘体验由 G06 验收；自动化先覆盖可验证行为。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。

## 实施记录（2026-10-21）

T044、T042、T043 已完成本地实现；完整契约、性能表和格式决策见 [G14 决策](../G14-navigation-decision.md)。

- 稀疏整数排序保留；普通移动改用相邻键索引查询，重排复用语句。1k/10k/50k 同级测量完成，完整元信息快照暂不改为分页。
- 搜索命中定位正文、PDF 页与当前版本批注；快速打开选择预览；失效内部链接可搜索替换。导航历史、可隐藏/关闭标签、属性面板和深目录编号已补齐。
- Notebook 图标、封面色和指定创建位置可保存；最近库显示路径、打开时间和本地快照状态。开发期 v4 schema 扩充，不迁移旧格式库，详见决策。
- 验证环境：macOS arm64 / Apple M4，Node 24.22.0，Chrome，基线 `af51fe7`；真实 SQLite 与临时本机 API，书橱脚本为模拟 RPC。
- 已通过：`pnpm run build`、`pnpm run typecheck`、改动文件 ESLint、`git diff --check`；搜索/目录/导航/PDF/存储专项 27 项；`pnpm run test:organization`、`pnpm run test:search`、`pnpm run test:bookshelf`。
- 全量 Vitest：426 项中 412 项首次通过；11 项受沙箱回环端口/磁盘权限影响，与同文件其他用例一起在本机重跑 71 项全部通过。余下 3 项为既有 `tests/icons.test.ts` 与当前 Lucide 图标输出不一致（两文件与 HEAD 一致，本组未修改），交 G20。不宣称全量绿色。
- 生成证据：`docs/organization-benchmark.json`（忽略文件），最终截图 `/tmp/anynote-g14-screenshots/{search-location,pdf-annotation,narrow-properties,narrow-dark,recent-books}.png`；书橱截图 `/tmp/anynote-bookshelf-screenshots`。
- 外部验收：真实 IME、读屏及原生键盘/窗口体验仍归 G06；代表性设备大库整机性能归 G19。本组没有剩余实现阻塞。
