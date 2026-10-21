# 单 SQLite Notebook 与分块备份

## 数据边界

每个 Notebook 的可迁移数据只有 `notebook.sqlite`：正文、元数据、历史、回收站、资源、批注、链接和扩展持久化状态均存于 schema v3。资源按 SHA-256 去重，`assets` 保存身份、大小和 MIME；`asset_chunks` 按 1MiB 保存 BLOB，支持有界范围读取和流式完整性校验。资源写入使用 SAVEPOINT，与正文和历史引用一起提交或回滚。

使用 WAL、外键和 FULL 同步。运行时可能存在 SQLite 自身的 WAL 文件；正常关闭应用、完成检查点后只需携带数据库。不要在应用写入期间仅复制主文件：应用备份通过 SQLite Online Backup 得到包含已提交 WAL 内容的一致性副本。主连接持有独占锁，同一个库不能被两个 Storage 实例同时写入。

不再生成 `notebook.json`、目录型附件、独立 Notebook 锁库或旧 schema 迁移。设备快照、恢复证据位于工作区 `_local/notebooks/<UUID>/`；账号、凭据、目标、游标和授权也留在设备目录，不进入 Notebook。

## 物理分块

本地磁盘、Cloudflare、Google Drive、Dropbox、OneDrive 共用 1MiB 固定分块布局。先捕获 SQLite，再顺序计算每块 SHA-256 与整库 SHA-256；清单记录整库大小、哈希和有序块列表，相同块可在列表中重复引用。实际存储和上传按块哈希去重，未变化块复用。捕获后可继续编辑；下一次备份包含后续事务。

不执行 VACUUM 或删除临时副本中的无引用资源，以避免重排页面破坏增量复用，并保留全部登记数据。小幅编辑通常只改变部分块；大量页面重排可能导致较多块变化，不保证每次修改只上传固定数量。

总数据库预算 20GiB，最多 20480 个块。分块缓冲有界，但捕获和恢复仍需完整数据库的临时磁盘空间。普通本地任务可根据版本和文件身份 token 跳过捕获或哈希；只有完整校验操作会重读全部块。

## 提交与恢复

- 本地：写入并读回验证新增块，持久化后原子替换 `.backup/manifest.json`。发布前失败保留原清单；发布后清理旧块失败只标记待重试。`.backup/pending.json` 记录本次写入，下一次任务仅清理登记的残留块和临时文件，不扫描删除未知文件。
- Cloudflare：完整清单加 staging/committed、分支 CAS 和 writer epoch；远端 GC 保护保留版本、上传中版本、其他分支与恢复 pin。没有实体 delta 或逻辑表重建。
- 云盘：上传/校验所有缺失块及清单，再条件更新设备槽的 current 指针。清理保留 current 引用的每个块。

恢复在私有临时目录按顺序拼接，检查块大小/哈希和整库大小/哈希，再校验 schema、SQLite 完整性、外键及库内资源。身份重映射和索引重建完成后登记新的 Notebook。任何缺块、损坏或取消都不得注册不完整库。

## 格式

| 内容       | 当前格式                                                                          |
| ---------- | --------------------------------------------------------------------------------- |
| Notebook   | schema v3                                                                         |
| 完整归档   | `anynote.notebook` v1，schemaVersion 3；ZIP 仅含 manifest.json 与 notebook.sqlite |
| 本地备份   | `anynote.local-backup` v2                                                         |
| Cloudflare | `anynote.sqlite` v1；能力 `sqlite-chunks-v1`                                      |
| 云盘清单   | `anynote.cloud-backup-manifest` v2                                                |

旧目录格式、旧 schema、旧备份清单均不兼容，也不自动迁移。旧云端资源不通过新格式复用；部署应使用匹配的新客户端和新 Worker 数据库。历史验收与基准报告不代表此格式已完成真实云端、跨平台或断电验收。
