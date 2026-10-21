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

- [ ] **P2 — 排序与查询契约决策**：当前稀疏整数 `sort_key` 与同级事务重排有效，设计建议为字符串分数排序及分页子项查询；评估大目录开销，选择实现迁移或更新设计，避免仅为形式一致而迁移。

### T042 · 原 §6

- [ ] **P2 — 搜索定位与失效链接修复**：命中后定位正文/PDF 页/批注位置，失效内部链接提供修复入口，快速打开提供选择预览；现有全局筛选、路径、片段、跨库跳转及反链已实现。

### T043 · 原 §6

- [ ] **P2 — 导航与首次启动细节**：补齐可隐藏文档标签页、前进/后退、属性辅助面板，以及 Notebook 图标/封面色、创建位置和最近库路径/备份状态等设计项；深层目录和窄窗口行为持续按实际内容验收。

## 验证与完成条件

- [tests/search.test.mjs](../../tests/search.test.mjs)
- `pnpm run test:organization`
- `pnpm run test:search`
- `pnpm run test:bookshelf`

完成条件：行为、查询契约和设计记录一致，深目录、长标题及跳转定位有回归。

人工 / 外部资源：最终 IME/窄窗口/键盘体验由 G06 验收；自动化先覆盖可验证行为。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
