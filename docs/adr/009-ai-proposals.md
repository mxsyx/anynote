# ADR-009 · AI 提案、显式应用与条件撤销

状态：已采纳（当前实现追认）。核对：2026-10-21，源码基线 `e975c1c`。

[返回 ADR 索引](README.md)

## 背景

整理提案不能直接覆盖用户后来编辑的正文，也不能将预留工具接口描述为已接入模型。

## 决定

当前提供 `proposePatch`、`applyProposal`、`undoProposal` 存储操作。提案保存在 `anynote.ai.proposals` 命名空间，记录目标、旧/新正文、原因和预期修订号；提出提案不修改正文。

显式应用检查提案状态与笔记版本，经正常保存事务写入正文和提案状态；同一已应用提案重复应用不新增版本。撤销仅在笔记仍处于应用产生的版本时恢复旧正文，后续编辑存在则拒绝。

2026-10-21 G17 补充：提案状态机归 Storage；SQL JSON 投影、操作分派和返回值使用专用类型，持久记录按状态校验字段、目标 ID 与修订号。缺失参数、畸形 JSON 和目标不匹配在正文写入前拒绝，见 [ADR-011](011-extension-module-boundaries.md)。

## 取舍与边界

这些是受信核心操作，不表示已开放第三方自主 AI 权限，也不提供模型 Provider、自动模型调用或自主代理 UI。模型选择与首发范围仍由 G00 和 BACKLOG 决策；本 ADR 不替负责人作产品决定。

## 证据与验证

[提案状态机](../../packages/storage-sqlite/src/proposals.ts)、[操作分派与保存](../../packages/storage-sqlite/src/operations.ts)。

[提案冲突、重复应用与撤销测试](../../tests/extensions.test.mjs)；[实施状态](../history/IMPLEMENTATION.md)。

本轮执行结果统一见 [G18 核对报告](../history/todo-2026-10-24.md#g18)；测试入口和历史报告不等于本轮已执行或真实发布验收。
