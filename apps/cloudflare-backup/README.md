# Anynote 自托管 SQLite 分块备份

此 Worker 是单用户自托管服务：D1 记录分支、提交状态与实体增量；R2 保存已验证的不可变逻辑对象、附件和每个版本的完整实体映射。每个 generation 都是可独立恢复的逻辑 checkpoint，未变化对象不再上传。不是 SQLite 文件镜像，也不提供实时同步。

验收部署可以在仓库根目录直接运行：

```sh
pnpm run cloud:deploy
```

脚本使用 Wrangler 登录创建独立 D1/R2、应用迁移、生成 APP_TOKEN 并部署，自动获取地址与执行真实云场景；不需要填写 `ANYNOTE_CF_ENDPOINT` / `ANYNOTE_CF_TOKEN`。部署状态与 Token 保存在被 git 忽略的 `.cloudflare-acceptance/`；重复运行复用同一套资源。使用方式及真实验收结果见 [云验收说明](../../docs/validation/CLOUD-ACCEPTANCE.md)。

手动生产部署时，先在 Cloudflare 创建 D1 数据库与私有 R2 bucket，填入 `wrangler.jsonc` 的数据库 UUID 和 bucket 名称：

```sh
cd apps/cloudflare-backup
npx wrangler d1 migrations apply anynote-backup --remote
npx wrangler secret put APP_TOKEN
npx wrangler deploy
```

APP_TOKEN 是独立应用 token，不使用 Cloudflare 管理凭据。所有接口要求 Bearer token。桌面配置 Worker 的 HTTPS URL 与 token。不要将 token 放入配置文件或 Notebook。

单次缓冲上传上限 20MiB、控制请求上限 5MiB。当前协议是 `anynote.sqlite` v1（schema v4），正式任务要求能力 `sqlite-assets-v1` / `transfer-resume-v1`，并应用全部迁移至 `0006.sql`；数据库按 1MiB 分块，包含有序块列表和整库 SHA-256，附件作为独立的完整内容哈希文件与数据库共用一份清单。大附件使用 32MiB R2 multipart 传输，私有对象整文件校验通过后才发布。客户端持久保存切点、multipart 回执及 16MiB 下载范围，重启可复用已校验进度；遗留上传和复制会话经手动维护 abort。R2 桶必须保留未完成 multipart 生命周期规则，以兜底创建后登记前的空会话窗口。旧逻辑协议、实体 delta 与旧备份兼容已移除。上传验证真实哈希/长度，staging 对恢复列表不可见；使用事务 guard、分支 CAS 和 D1 batch 原子发布。失败可重试同一 generation，GC 保护保留版本、有效 staging 与恢复 pin。详见 [分块备份](../../docs/guides/STREAMING-CLOUD-BACKUP.md)。此次 D1 结构面向新环境，已有旧格式部署不自动迁移。

G09 的 `maintenance-lifecycle-v1` 需要 D1 迁移至 `0005.sql`，支持过期上传/孤立 manifest/临时对象的手动回收和维护证据归档，目标保留配置可持久化并预估空间。不会自动定时删除，真实老化及容量复测见 [历史实施证据](../../docs/history/todo-2026-10-24.md#g09)。

目前提供完整 SQLite 快照清单、显式确认的数量/日周月保留与分批 GC、设备接管、恢复 pin，以及旧维护锁的只读诊断与受限释放（`maintenance-admin-v1`）。分块引用参与 GC 保护。尚未提供自动设备接管、动态租户管理或 E2EE；维护边界见 [远端维护](../../docs/guides/REMOTE-MAINTENANCE.md)。真实 Cloudflare 上传/恢复、去重、客户端中断与响应丢失、幂等和并发 CAS 场景已通过，报告见 [cloudflare-acceptance.json](../../tmp/reports/archive/cloudflare-acceptance.json)。本地合约测试使用 SQLite/R2 内存适配器；厂商级断网或区域故障演练尚未覆盖。

## 全新设备版本发现

Worker 公布 `backup-discovery-v1` 能力。认证的 `GET /v1/backups` 跨 Notebook/lineage 列举已提交且未退役的版本，返回 `backups`、`warnings` 和下一页 `cursor`，每页最多 10 个版本；用 `?cursor=…` 继续。接口读取并验证 R2 清单，不修改远端写入身份或版本。

使用匹配的新 Worker 数据库和客户端部署。客户端入口为「设置 → 从云端恢复」，见 [使用与验收](../../docs/guides/CLOUD-RECOVERY.md)。
