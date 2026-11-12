# SQLite 分块云备份与恢复

正式任务使用原生 SQLite 一致性快照及 1MiB 物理分块。统一存储布局、预算和格式见 [存储与备份设计](../design/SQLITE-STORAGE.md)。不构造内存 ZIP，附件按完整文件哈希增量上传，不重建逻辑实体表。

Cloudflare 清单为 `anynote.sqlite` v1，schemaVersion 5；正式任务要求 `sqlite-assets-v1` 和 `transfer-resume-v1`，部署应用全部迁移至 `0007.sql`。清单包含远端 Notebook 身份、数据库内 sourceNotebookId、整库哈希/大小、有序块列表和完整附件集合。单次控制请求最多 5MiB，数据库与附件合计 20GiB，最多 20480 个块；Worker 验证对象长度和哈希，完整数据库哈希在捕获/恢复端验证。

上传只发送服务端 plan 返回的缺失数据库块和附件。大附件使用 32MiB R2 multipart 传输，完整文件在私有对象上校验后发布；传输片段不进入备份清单。全部对象完成后，通过 staging、分支 CAS、writer epoch 和 D1 batch 发布版本；提交响应丢失使用同一 generation 查询确认。维护流程同时提取数据库块和附件引用，保护保留版本、分支、staging 和恢复 pin。

恢复下载到私有临时目录，按清单顺序拼接；逐块及整库校验后，独立校验线程检查 SQLite/schema/外键及附件文件与引用闭包，重映射身份并重建搜索，再登记新 Notebook。缺块、损坏、pin 续约失败或取消会停止恢复并清理临时目录。

失败、取消与重启后的重试会读取设备侧持久传输槽。上传重新捕获并核对源切点，完全一致时沿用 generation 和冻结身份，已上传整对象由 plan 去重；Worker 无 list-parts API 时，multipart 片段按同一编号幂等重发；切点改变则新建 generation。下载按完整 manifest 隔离，数据库复用已校验的 1MiB 块，附件复用已落盘的 16MiB HTTP 范围；重新校验本地范围及完整附件哈希后才发布。未完成的当前请求会重发，并非任意单字节偏移恢复。成功删除本地进度，取消保留进度供任务中心重试。续传规则见[云端备份与维护](../design/CLOUD-BACKUP.md#续传与重试)，Rust 传输身份和重试边界见 [数据与迁移设计](../design/RUST-DATA-COMPATIBILITY.md)。

Worker 登记传输和服务端复制的 multipart 会话。当前分支过期 staging 的会话随手动确认的维护计划终止；已提交或无 generation 的遗留会话登记满 24h 后可预览回收。abort 失败可续跑，不删除同名已发布附件。创建与登记间的空会话窗口由 R2 桶生命周期兜底；部署须保留未完成 multipart 到期清理规则。

旧 BLOB schema、旧逻辑协议和旧清单均不兼容。新 Worker 使用新的数据库结构，不提供历史 D1 格式迁移。真实云环境需要匹配部署；本地适配器测试不能代替生产云端验收。

验证方法见 [Rust 云验收](../development/RUST-CLOUD-ACCEPTANCE.md)，真实故障、老化与容量范围见 [TODO](../../TODO.md#f011)。
