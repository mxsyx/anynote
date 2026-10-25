# P0：备份可靠性与发布验收

> 状态归属：本文维护验收步骤和历史证据，任务完成状态只在 [灾难恢复](../TODO.md#v004)、[真实 Cloudflare](../TODO.md#a007)、[卷适配](../TODO.md#f001) 维护。旧格式报告不构成当前 schema v5/独立附件协议验收；维护规则见 [文档维护](../DOCUMENTATION.md)。

更新：2026-10-08。这里区分代码完成、本机隔离实测和仍需外部设备的发布门槛；不会把不同临时目录当作另一台物理设备。

## Cloudflare 维护中断恢复

新增 `MaintenanceCoordinator` Durable Object，每个远端 Notebook 使用一个全局唯一协调器。已确认清理仍持有 Notebook 锁，按原计划和持久化游标分批执行；同一协调器的请求和闹钟通过队列串行，等待删除完成后才进入下一批，不使用时间过期来抢占活跃删除请求。

D1 `0003.sql` 为执行锁记录协调器实例身份。协调器实例被平台终止并重新创建后，新的全局唯一实例可清除旧实例所拥有的单批执行锁，再继续原计划；Notebook 锁不被清除。确认请求开始前保存闹钟，失败或中断后继续处理已经进入 `deleting` 的计划，完成后取消闹钟。预览不会自动变成删除任务。

升级：`pnpm run cloud:deploy`。自动生成的 Wrangler 配置和仓库配置均包含 `MAINTENANCE` 绑定、SQLite Durable Object 迁移 `maintenance-v1` 及 D1 迁移。能力标记为 `maintenance-recovery-v1`。

旧版遗留且没有协调器身份的执行锁仍安全保留，需要管理员确认旧请求已经停止后处理；不会通过期限猜测其是否仍在运行。处置入口为只读诊断 `/retention/diagnostics` 与受限释放 `/retention/legacy-lock/release`，并提供 `pnpm run cloud:legacy-lock` 管理员工具：仅清除被确切观测、无协调器身份且属于同一 Notebook 的执行锁，保留 Notebook 锁并写入审计记录，详见 [远端维护](../../features/REMOTE-MAINTENANCE.md) 的旧维护锁处置。新协议解决的是被协调器持有的执行锁。对象变更、保护清单损坏等错误仍保持锁，不能通过重启绕过。

生命周期依据：[Cloudflare Durable Object 生命周期](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)、[全局唯一与并发规则](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)。队列串行覆盖外部 I/O，避免长时间使用 `blockConcurrencyWhile` 引起 30 秒重置。

## 可携带的跨设备恢复验收包

```sh
pnpm run test:recovery:portable prepare /path/to/new-kit
# 把完整验收包目录复制到另一台干净设备，在已构建的仓库运行：
pnpm run test:recovery:portable verify /path/to/kit
# 本机排练必须显式声明，报告仍标为排练：
pnpm run test:recovery:portable verify /path/to/kit --allow-same-host
```

准备过程仅创建独立临时 Notebook，包含 Markdown/图片/PDF、中文目录、未知块、自链接、标签收藏、历史、回收站、PDF 批注/文本及插件数据。包内仅有流式 `.anynote`、领域证据与使用说明，无账号凭据；源临时目录随后删除。

验证在全新临时工作区导入，核对归档大小/SHA-256、领域表行、所有附件哈希、恢复后的自链接及搜索。保留原始变更日志，并单独规范化导入产生的 Notebook 身份和名称。识别同一主机时拒绝正式跨设备验收；显式排练生成 `same-host-rehearsal` 报告。主机标识不同仍不能自动证明独立物理设备，需要人工记录设备和故障过程。

输出为 `tmp/reports/portable-recovery-acceptance.json`。本轮的独立物理设备、Windows/macOS、整机断电/磁盘丢失恢复尚未执行，不能标记 v1 全部发布门槛完成。验收包不是用户资料的备份工具，也不是自动触发整机故障的工具。

## macOS/APFS 实盘验收

```sh
pnpm run test:macos:volume
mkdir -p tmp/macos-desktop
node scripts/desktop-local-backup-acceptance.mjs --base-dir tmp/macos-desktop \
  --require-filesystem apfs --report-path tmp/reports/desktop-local-backup-apfs.json
```

脚本使用 `hdiutil` 建立 APFS/FAT32 磁盘镜像，核对卷身份、文件系统限制、复制与恢复、卸载/重挂载及同路径换卷拒绝。镜像和本地目录不能替代外接 exFAT、SMB/NFS、真实拔盘、断电和独立设备验证。报告写入 `tmp/reports/`，本轮执行结果需重新运行后记录；剩余平台任务见 [TODO](../TODO.md#platform-validation)。
