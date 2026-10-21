# G06 · 原生交互与无障碍人工验收

[返回总入口](../../TODO.md)

类型：验收 / 实测。目标：读屏、IME、原生对话框、键盘和缩放。

前置：目标平台、真实输入法/读屏器；最终验收使用待发布 UI。

并行边界：可先录制基线；G14/G20 改动相关界面后补测受影响部分。

## 建议入口

- [scripts/performance-ui-acceptance.mjs](../../scripts/performance-ui-acceptance.mjs)
- [scripts/desktop-local-backup-acceptance.mjs](../../scripts/desktop-local-backup-acceptance.mjs)
- [docs/PERFORMANCE-UI-ACCEPTANCE.md](../../docs/PERFORMANCE-UI-ACCEPTANCE.md)

## 执行顺序

1. 合并本地备份与平台 UI 的重叠场景，准备每平台人工检查表。
2. 执行读屏、IME、保存、目录选择与恢复导航，补完 axe incomplete。
3. 记录窗口/主题/缩放和辅助技术版本，区分自动化与人工结论。

## 待办

### T010 · 原 §2.1

- [ ] **P1 — 人工无障碍与平台 UI**：读屏器、真实 IME、原生对话框、200% 缩放、减少动态、键盘及窄窗口人工验收；核对 axe 的 incomplete 项和实际对比度，覆盖新增任务/维护/扩展页面。已有零自动违规不等于完整 WCAG 认证。

### T016 · 原 §3

- [ ] **P1 — 真实输入法与原生对话框**：人工确认组合输入、保存、目录选择和初始化取消/确认，覆盖本地备份及恢复导航。自动化对话框 fixture 和组合事件仅保留为回归证据。

## 验证与完成条件

- `pnpm run test:acceptance:ui`
- `pnpm run test:desktop:local-backup`
- 人工读屏、真实组合输入、原生目录授权、缩放及键盘验收。

完成条件：每种人工场景有结果；派发组合事件和零 axe 违规不能替代本组。

人工 / 外部资源：实际输入、听取读屏输出、操作原生对话框和检查对比度/视觉表现。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
