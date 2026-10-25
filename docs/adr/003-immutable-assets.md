# ADR-003 · 不可变 Asset、Resource 身份与历史闭包

状态：已采纳（当前实现追认）。核对：2026-10-21，源码基线 `e975c1c`。

[返回 ADR 索引](README.md)

## 背景

附件更新、历史恢复和回收站必须引用当时的字节，不能只保存一个会被覆盖的资源路径。

## 决定

Asset 用 SHA-256 内容寻址并以完整文件不可变保存；Resource 用稳定 ID 绑定当前 asset hash。更新资源生成新字节和哈希，历史正文通过 `revision_resources` 固定 resourceId → assetHash。

先同步并发布附件，再提交数据库引用；失败最多留下未引用文件。一致性快照根据数据库副本的资源、历史、批注和文本索引引用确定闭包，同卷硬链接固定字节，跨卷私有复制。清单必须与闭包完全对应。

## 取舍与边界

不采用覆盖原文件或只备份当前正文引用的方案。需要独立清理孤立对象；知识历史与回收站仍引用的资源不能删除。搬运 Notebook 必须包含数据库和附件。

## 证据与验证

[资源发布与闭包](../../packages/storage-sqlite/src/assets.ts)、[资源换绑与保存](../../packages/storage-sqlite/src/operations.ts)、[快照](../../packages/storage-sqlite/src/database-snapshot.ts)。

[SQLite/附件测试](../../tests/sqlite-assets.test.mjs)、[扩展及资源历史测试](../../tests/extensions.test.mjs)；[存储契约](../design/SQLITE-STORAGE.md)。

本轮执行结果统一见 [G18 核对报告](../history/todo-2026-10-24.md#g18)；测试入口和历史报告不等于本轮已执行或真实发布验收。
