# 大文件云备份与恢复

正式 `startBackup` / `restoreRemoteBackup` 任务已使用文件快照和分块传输，覆盖 S3 兼容 API（阿里云 OSS）与 Cloudflare D1/R2。无需先构造内存 ZIP，也无需恢复时生成中间 ZIP。手动备份与既有自动调度器使用同一实现。

## 一致性和发布

备份在存储队列内创建原生 SQLite 一致性快照，并固定源 Notebook，防止资源清理或工作区移出破坏切点。文件哈希与网络传输在队列外进行，用户可以继续编辑。成功游标采用快照的 `content_seq`，后续编辑留待下一次备份。失败或取消不确认游标；提交响应丢失仍通过固定 generation 查询恢复确认。

新附件和 S3 数据库按 16MiB 分块，记录每块 SHA-256、大小，以及完整文件的 SHA-256、大小。重复块按内容哈希去重。读取、下载与校验均有对象预算；没有 Content-Length 的响应也逐次检查实际字节。单次分块大小不等于进程内存峰值，SDK、校验与编码可能持有多份缓冲。

S3 使用普通 Put/Get/Head API：对象校验完成后上传版本清单，最后发布 COMMITTED。小文件仍写兼容 v1 的描述，大文件使用协议 v2 的 `chunks`。不依赖厂商 multipart API。

Cloudflare 保持逻辑协议 v1，新增可选附件 `chunks`，能力标识为 `chunked-assets-v1`。Worker 在 plan、上传与 commit 使用统一对象描述校验，缺块或分块大小不匹配无法提交。D1 head CAS、writer epoch、幂等和 staging 保持现有规则。Worker 校验每块的哈希和大小；完整文件的聚合哈希由客户端备份和恢复校验，不在一次 Worker 请求中重读整个大文件。远端保留/GC 同样通过统一描述保护分块，涵盖保留版本、其他分支、staging 与恢复 pin。

恢复先下载到私有临时目录，检查每块与完整文件，重建 SQLite。独立校验线程检查 schema、完整性、外键、目录、资源清单，改写副本身份并重建搜索，然后原子登记新 Notebook。损坏、缺块或取消都清理临时目录；Cloudflare 恢复 pin 在结束时释放。凭据、设备游标和工作区配置不进入远端快照。

## 预算与兼容

- 新备份的本地数据库与附件总量预算 20GiB；S3 最多 99998 个附件。
- Cloudflare 清单最多 5MiB、200000 个实体、10000 个附件，实体/对象仍最多 20MiB，分块引用总量最多 200000。因此某些 Notebook 可能先触及清单或数量限制。
- S3 清单最多 16MiB。恢复旧版未分块对象保留 100MiB 单对象下载上限；新分块一般为 16MiB。
- 恢复前预估临时文件与数据库校验空间，重建数据库后再检查实际预算。预估不是磁盘预留，执行期间磁盘不足仍会失败并清理。
- 新客户端可恢复既有 S3 v1 和 Cloudflare 未分块版本。旧客户端不能恢复带 chunks 的新版本。
- Cloudflare 大附件备份前检查能力；旧 Worker 会明确提示升级。运行 `pnpm run cloud:deploy` 部署新源码，复用已有专用资源，无需手填 Endpoint/Token。
- 浏览器/旧 base64 完整归档 API、本地快照仍为 100MB；单文件界面导入仍为 50MB，跨库转移仍受原预算限制。本次不扩大这些路径。

## 验证与重跑

`pnpm test` 包含 10 项新增测试：112MiB S3/Cloudflare 正式任务、上传时编辑后的切点、旧 S3 恢复、元数据校验、取消清理、Worker 缺块拒绝提交、大 SQLite 数据库分块恢复，无 Content-Length 的下载预算、旧 Cloudflare 清单恢复及旧 Worker 能力拒绝。S3 测试使用真实 HTTP 与磁盘对象服务，Cloudflare 合约测试使用本地适配器；另外运行官方 workerd/D1/R2 验证同一 112MiB 正式任务。

真实 Cloudflare 与阿里云 OSS 均通过 112MiB 文件备份、恢复、全文件 SHA-256、未知内容/历史/回收站保留、无变化跳过及临时文件/本地 pin 清理。报告见大文件真实云验收。验收附件由随机 64KiB 块重复组成，用于验证去重和超出旧预算的完整恢复；不代表随机 112MiB 上传吞吐，更不代表满 20GiB 负载已验收。

最新 Linux 打包版的既有桌面流程也通过真实云复验：Cloudflare 12 项（含维护/接管）、OSS 9 项，涵盖 UI 配置、GNOME Keyring 加密、正式自动调度、手动备份、旧新版本恢复和重启凭据/游标读取。见 Cloudflare 桌面报告与 OSS 桌面报告。这两份桌面报告采用原有小资源 fixture；112MiB 验收通过同一存储公开任务接口执行。

```sh
pnpm run cloud:deploy
pnpm run test:cloud:stream
# 也可仅选择一个已配置提供方
pnpm run test:cloud:stream --provider s3
pnpm run test:cloud:local
```

工具读取 `.env.cloud` 的既有 OSS 配置和 Wrangler 托管的 Cloudflare 配置。仅创建独立 Notebook/lineage/S3 前缀，保留远端验收数据，报告不记录凭据。缺少配置会报告失败，不把未执行的服务记为通过。实时报告写入 `test-results/cloud-stream-acceptance.json`。
