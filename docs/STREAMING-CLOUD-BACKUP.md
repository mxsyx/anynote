# SQLite 分块云备份与恢复

正式任务使用原生 SQLite 一致性快照及 1MiB 物理分块。统一存储布局、预算和格式见 [存储与备份设计](SQLITE-STORAGE.md)。不构造内存 ZIP，附件按完整文件哈希增量上传，不重建逻辑实体表。

Cloudflare 清单为 `anynote.sqlite` v1，schemaVersion 4；客户端要求 `sqlite-assets-v1`。清单包含远端 Notebook 身份、数据库内 sourceNotebookId、整库哈希/大小、有序块列表和完整附件集合。单次控制请求最多 5MiB，数据库与附件合计 20GiB，最多 20480 个块；Worker 验证对象长度和哈希，完整数据库哈希在捕获/恢复端验证。

上传只发送服务端 plan 返回的缺失数据库块和附件。大附件使用 32MiB R2 multipart 传输，完整文件在私有对象上校验后发布；传输片段不进入备份清单。全部对象完成后，通过 staging、分支 CAS、writer epoch 和 D1 batch 发布版本；提交响应丢失使用同一 generation 查询确认。维护流程同时提取数据库块和附件引用，保护保留版本、分支、staging 和恢复 pin。

恢复下载到私有临时目录，按清单顺序拼接；逐块及整库校验后，独立校验线程检查 SQLite/schema/外键及附件文件与引用闭包，重映射身份并重建搜索，再登记新 Notebook。缺块、损坏、pin 续约失败或取消会停止恢复并清理临时目录。

旧 BLOB schema、旧逻辑协议和旧清单均不兼容。新 Worker 使用新的数据库结构，不提供历史 D1 格式迁移。真实云环境需要匹配部署；本地适配器测试不能代替生产云端验收。

```sh
pnpm exec vitest run tests/cloud-stream.test.mjs tests/recovery.test.mjs tests/remote-maintenance.test.mjs
pnpm run test:cloud:local
pnpm run test:cloud:stream
```

112MiB 流式测试验证分块恢复、整库和资源哈希、历史/回收站/未知内容、修改切点、取消与 GC 保护。历史真实云验收报告使用旧协议，应在新环境重新执行；本次不自动部署或触碰已有云端数据。
