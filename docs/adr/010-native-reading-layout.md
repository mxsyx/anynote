# ADR-010 · 原生阅读布局、设计 token 与辅助面板

状态：已采纳（当前实现追认）。核对：2026-10-21，源码基线 `e975c1c`。

[返回 ADR 索引](README.md)

## 背景

应用采用书橱到笔记本的阅读流程，保持原生桌面操作和克制的拟物层次。旧设计数值不应成为与当前主题并行的第二份样式来源。

## 决定

亮/暗模式由 `anynote.appearance` 持久化；CSS 语义变量集中管理纸张、桌面、文字、边框、圆角与阴影。使用 Tailwind v4、Radix/shadcn 源码控件及集中图标入口，避免全局 reset 破坏正文。

书橱进入工作区，章节目录在正文左侧，纸张限宽居中，侧边辅助面板按需展开。G14 已加入文档标签、导航历史、属性及搜索定位；桌面设置/备份/扩展通过原生菜单访问。编辑器、PDF、图片和白板按需加载。

## 取舍与边界

不把主题枚举扩展成任意配色，也不把 CSS/测试通过当作人工视觉、真实 IME 或读屏验收。现有所有弹窗是否完全满足动态创建要求仍由 G20 核对，本 ADR 不声明全局已达标。

## 证据与验证

[主题](../../apps/desktop/src/appearance.ts)、[token 与样式](../../apps/desktop/src/styles.css)、[工作区及懒加载](../../apps/desktop/src/main.tsx)。

[主题测试](../../tests/appearance.test.ts)、[导航测试](../../tests/navigation.test.ts)；[G14 决策](../G14-navigation-decision.md)、[视觉验收任务](../todo/20-visual-components.md)。

本轮执行结果统一见 [G18 核对报告](../G18-documentation-review.md)；测试入口和历史报告不等于本轮已执行或真实发布验收。
