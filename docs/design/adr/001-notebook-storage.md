# ADR-001 · Notebook 独立 SQLite 与目录排序

状态：已采纳（当前实现追认）。核对：2026-10-21，源码基线 `e975c1c`。

[返回 ADR 索引](README.md)

## 背景

Notebook 必须能单独携带、备份与恢复。设计曾推荐 better-sqlite3 和引导 JSON；G14 已对目录查询与排序作出当前决策。

## 决定

每库使用 `notebook.sqlite`（schema v4）与 `assets/sha256/`，身份以 `notebook_meta` 为准，不生成 `notebook.json`。设备配置放应用 `_local/`。

使用 Node 内置 `node:sqlite` 的 `DatabaseSync` 和 `backup`，由存储进程串行访问；要求 Node 24+。当前主数据库连接以 EXCLUSIVE 锁、WAL、FULL 同步及外键保护写入，关闭/LRU 回收时释放，不另建 `.anynote-lease.sqlite`。

目录保留 `INTEGER sort_key`，按 `sort_key,id` 排序。普通移动通过索引读取邻居并取整数中点；间隙不足时在同一事务按 1024 步长重排同级。`listNodes` 返回完整元信息快照，前端虚拟渲染。

## 取舍与边界

不采用额外原生驱动、字符串分数排序或子目录分页迁移。运行时升级需要验证 SQLite；大目录重排仍有线性成本，G19 的真实负载证据可触发后续调整。独占连接不是网络文件系统兼容保证。

## 证据与验证

[运行时封装](../../../packages/types/src/runtime.ts)、[schema](../../../packages/storage-sqlite/src/schema.ts)、[写锁](../../../packages/storage-sqlite/src/workspace.ts)、[目录移动](../../../packages/storage-sqlite/src/organization.ts)、[Storage](../../../packages/storage-sqlite/src/index.ts)。

[存储测试](../../../tests/storage.test.mjs)、[目录测试](../../../tests/organization.test.mjs)；[G14 决策与本机基准](../NAVIGATION.md)、[存储契约](../SQLITE-STORAGE.md)。

本轮执行结果统一见 [G18 核对报告](../../development/history/todo-2026-10-24.md#g18)；测试入口和历史报告不等于本轮已执行或真实发布验收。
