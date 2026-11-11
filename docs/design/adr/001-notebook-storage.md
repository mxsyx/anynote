# ADR-001 · Notebook 独立 SQLite 与目录排序

状态：采用。[返回 ADR 索引](README.md)

## 背景

Notebook 必须能独立携带、备份和恢复，目录操作须具备稳定顺序与原子性。

## 决定

每库使用 `notebook.sqlite`（schema v5）与 `assets/sha256/`，身份以 `notebook_meta` 为准，不生成另一份身份 JSON。设备配置放应用 `_local/`。

Rust 存储层持有 SQLite 写租约，由唯一写队列执行事务；UI 不持有数据库连接。保持 WAL、FULL 同步、外键及一致性快照规则，具体所有权见 [写存储契约](../../development/RUST-WRITE-STORAGE.md)。

目录使用 `INTEGER sort_key`，按 `sort_key,id` 排序。普通移动读取索引中的相邻节点，间隙不足时在同一事务重排同级；目录读取元信息快照，视图虚拟化，不加载全部正文。

## 取舍与边界

不为字符串分数排序引入格式迁移。大目录重排仍有线性成本，独占连接不是网络文件系统兼容保证。平台持久性、文件锁及实际卷验证见 [TODO](../../development/TODO.md#p3)。
