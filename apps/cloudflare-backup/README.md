# Anynote 自托管逻辑备份

此 Worker 是单用户自托管服务：D1 记录分支、提交状态与实体增量；R2 保存已验证的不可变逻辑对象、附件和每个版本的完整实体映射。每个 generation 都是可独立恢复的逻辑 checkpoint，未变化对象不再上传。不是 SQLite 文件镜像，也不提供实时同步。

验收部署可以在仓库根目录直接运行：

```sh
pnpm run cloud:deploy
```

脚本使用 Wrangler 登录创建独立 D1/R2、应用迁移、生成 APP_TOKEN 并部署，自动获取地址与执行真实云场景；不需要填写 `ANYNOTE_CF_ENDPOINT` / `ANYNOTE_CF_TOKEN`。部署状态与 Token 保存在被 git 忽略的 `.cloudflare-acceptance/`；重复运行复用同一套资源。使用方式及真实验收结果见 [云验收说明](../../docs/CLOUD-ACCEPTANCE.md)。

手动生产部署时，先在 Cloudflare 创建 D1 数据库与私有 R2 bucket，填入 `wrangler.jsonc` 的数据库 UUID 和 bucket 名称：

```sh
cd apps/cloudflare-backup
npx wrangler d1 migrations apply anynote-backup --remote
npx wrangler secret put APP_TOKEN
npx wrangler deploy
```

APP_TOKEN 是独立应用 token，不使用 Cloudflare 管理凭据。所有接口要求 Bearer token。桌面配置 Worker 的 HTTPS URL 与 token。不要将 token 放入配置文件或 Notebook。

对象上限 20MiB、控制请求上限 5MiB。服务端公布 `chunked-assets-v1` 能力，正式云任务将大附件按 16MiB 内容分块，仍保存完整文件的大小与 SHA-256；旧未分块版本继续可恢复。实现、预算及真实 112MiB 验收见 [大文件云备份](../../docs/STREAMING-CLOUD-BACKUP.md)。上传时服务端验证真实 SHA-256 与长度；staging 版本对恢复列表不可见；最终使用带 CHECK 约束的事务 guard、分支 CAS 和 D1 batch 原子发布。失败或响应丢失可重试同一 generation；旧 committed 版本继续可恢复。新设备以新的 lineage 建立独立分支。

目前提供完整 checkpoint + D1 实体 delta、显式确认的数量/日周月保留与分批 GC、设备接管、恢复 pin，以及旧维护锁的只读诊断与受限释放（`maintenance-admin-v1`）。分块引用参与 GC 保护。尚未提供自动设备接管、动态租户管理或 E2EE；维护边界见 [远端维护](../../docs/REMOTE-MAINTENANCE.md)。真实 Cloudflare 上传/恢复、去重、客户端中断与响应丢失、幂等和并发 CAS 场景已通过，报告见 [cloudflare-acceptance.json](../../docs/cloudflare-acceptance.json)。本地合约测试使用 SQLite/R2 内存适配器；厂商级断网或区域故障演练尚未覆盖。

## 全新设备版本发现

Worker 公布 `backup-discovery-v1` 能力。认证的 `GET /v1/backups` 跨 Notebook/lineage 列举已提交且未退役的版本，返回 `backups`、`warnings` 和下一页 `cursor`，每页最多 10 个版本；用 `?cursor=…` 继续。接口读取并验证 R2 清单，不修改远端写入身份或版本。

升级现有 Wrangler 部署即可，无需新增数据库迁移。客户端入口为「设置 → 从云端恢复」，见 [使用与验收](../../docs/CLOUD-RECOVERY.md)。
