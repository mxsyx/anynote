# ADR-002 · Markdown 真源与连续编辑边界

状态：已采纳（当前实现追认）。核对：2026-10-21，源码基线 `e975c1c`。

[返回 ADR 索引](README.md)

## 背景

阅读和编辑已合并为连续文档；编辑器 JSON 不能成为第二份持久化正文，未知扩展也不能因编辑丢失。

## 决定

以 Markdown 为唯一正文。Tiptap/ProseMirror 负责连续编辑、斜杠命令和 Markdown 输入转换，不提供旧的源码/阅读/Beta 模式切换。

解析时记录可编辑块的原文和语义签名，未变化块复用原文；修改块序列化为 Markdown，块间统一空行。复杂语法和未知内容用 `preservedBlock` 的 `data-source` 保存，不能直接编辑其内部文本。

## 取舍与边界

不承诺任意 Markdown 全文逐字节往返；块间空白和被修改块可能规范化。不把保留块显示为可直接编辑的源码。真实输入法验收仍归 G06。

## 证据与验证

[文档转换](../../apps/desktop/src/document-model.ts)、[连续编辑器](../../apps/desktop/src/DocumentEditor.tsx)。

[文档模型测试](../../tests/document-model.test.ts)；[编辑器说明及 test:document](../guides/EDITOR-ECOSYSTEM.md)。

本轮执行结果统一见 [G18 核对报告](../history/todo-2026-10-24.md#g18)；测试入口和历史报告不等于本轮已执行或真实发布验收。
