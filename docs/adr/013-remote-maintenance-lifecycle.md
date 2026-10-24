# ADR-013 · 远端维护生命周期与手动保留配置

状态：已采纳。日期：2026-10-21；G09，基于 `9834141` 工作树。补充 [ADR-005](005-generation-publication.md)。

[返回 ADR 索引](README.md)

## 背景

永久保留 staging 和维护记录会阻塞规划；直接丢弃墓碑又会允许旧 UUID 重放。保留窗口只存在于对话框中，重复设置容易产生不同清理结果。

## 决定

- 活动 staging 以服务端活动时间维护，当前分支 7 天无活动后可进入手动预览。客户端 createdAt 不决定上传过期；head、其他分支、有效恢复 pin 继续受保护。确认使用 revision CAS，入场使用仅随维护完成递增的 maintenance epoch CAS；提交还必须找到原 staging 行，避免迟到请求跨墓碑归档复活版本。
- D1 是活动工作集。清理计划、过期接管回执、已删除版本墓碑先写 R2 按身份归档，再删 D1。每类每批最多 64 条，失败可重试；活动删除锁绝不按时间抢占。
- R2 墓碑和回执长期保留，查询按 UUID 定点读取，不扫描历史，也不计入活动 2000 项预算。完成计划在归档后仍可幂等确认；过期预览失去执行权。
- 每个目标保存数量及日/周/月窗口。预览提供实际对象大小的空间估算，保存配置与确认删除是独立操作；没有自动定时删除授权。

## 取舍与边界

选择永久归档而不是删除所有证据，换取不复活旧身份及可核对的历史；R2 证据仍随历史增长。活动身份达到 2000 时拒绝新版本，但清理可在上限执行；保护项超预算不削弱保护。运行时子请求/CPU 配额和满预算真实成本由 G07 验证。2026-10-21 由 [ADR-014](014-cloudflare-transfer-resume.md) 补充未完成 multipart 会话登记、abort 与续传；空间估算仍排除未完成片段。

## 实现与验证

[维护规划/确认](../../apps/cloudflare-backup/src/maintenance.ts)、[归档](../../apps/cloudflare-backup/src/maintenance-history.ts)、[迁移](../../apps/cloudflare-backup/migrations/0005.sql)、[客户端配置](../../packages/backup/src/manage.ts)。

[维护契约测试](../../tests/remote-maintenance.test.mjs)、[可复用本地/真实服务场景](../../scripts/cloud/maintenance-scenarios.mjs)、[浏览器交互](../../scripts/remote-retention-smoke.mjs)。结果与剩余外部验证见 [历史实施证据](../history/todo-2026-10-24.md#g09)。
