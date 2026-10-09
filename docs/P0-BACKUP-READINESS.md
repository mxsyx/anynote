# P0：备份可靠性与发布验收

更新：2026-10-08。这里区分代码完成、本机隔离实测和仍需外部设备的发布门槛；不会把不同临时目录当作另一台物理设备。

## Cloudflare 维护中断恢复

新增 `MaintenanceCoordinator` Durable Object，每个远端 Notebook 使用一个全局唯一协调器。已确认清理仍持有 Notebook 锁，按原计划和持久化游标分批执行；同一协调器的请求和闹钟通过队列串行，等待删除完成后才进入下一批，不使用时间过期来抢占活跃删除请求。

D1 `0003.sql` 为执行锁记录协调器实例身份。协调器实例被平台终止并重新创建后，新的全局唯一实例可清除旧实例所拥有的单批执行锁，再继续原计划；Notebook 锁不被清除。确认请求开始前保存闹钟，失败或中断后继续处理已经进入 `deleting` 的计划，完成后取消闹钟。预览不会自动变成删除任务。

升级：`pnpm run cloud:deploy`。自动生成的 Wrangler 配置和仓库配置均包含 `MAINTENANCE` 绑定、SQLite Durable Object 迁移 `maintenance-v1` 及 D1 迁移。能力标记为 `maintenance-recovery-v1`。

旧版遗留且没有协调器身份的执行锁仍安全保留，需要管理员确认旧请求已经停止后处理；不会通过期限猜测其是否仍在运行。处置入口为只读诊断 `/retention/diagnostics` 与受限释放 `/retention/legacy-lock/release`，并提供 `pnpm run cloud:legacy-lock` 管理员工具：仅清除被确切观测、无协调器身份且属于同一 Notebook 的执行锁，保留 Notebook 锁并写入审计记录，详见 [远端维护](REMOTE-MAINTENANCE.md) 的旧维护锁处置。新协议解决的是被协调器持有的执行锁。对象变更、保护清单损坏等错误仍保持锁，不能通过重启绕过。

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

输出为 `test-results/portable-recovery-acceptance.json`。本轮的独立物理设备、Windows/macOS、整机断电/磁盘丢失恢复尚未执行，不能标记 v1 全部发布门槛完成。验收包不是用户资料的备份工具，也不是自动触发整机故障的工具。

## macOS/APFS 实盘验收（2026-10-08）

开发环境切换到 macOS 后，先补齐备份层的 macOS 卷适配（`packages/backup-local/src/volume.ts`：`df -P` 定位设备节点，`diskutil info -plist` 取文件系统类型、用户可见卷名与稳定 `VolumeUUID`，`mount` 表回退并负责网络挂载判定；解析为纯函数，工具缺失或输出损坏时降级为 statfs 基础信息），并修复 macOS 符号链接前缀（`/var`、`/tmp` → `/private/*`）导致 `safePath` 与 `assertLocalPath` 拒绝合法临时路径的问题；该问题此前使全部 macOS 用例与本地备份验收无法运行。

```sh
pnpm run test:macos:volume
mkdir -p artifacts/macos-desktop
node scripts/desktop-local-backup-acceptance.mjs --base-dir artifacts/macos-desktop \
  --require-filesystem apfs --report-path artifacts/macos-desktop/desktop-local-backup-apfs.json
```

`scripts/macos-volume-acceptance.mjs` 用 `hdiutil` 创建并挂载真实 APFS/FAT32 卷（免 root，结束自动卸载并删除镜像），验证卷身份与 `diskutil` 报告一致且能与源卷区分、替换/读回/目录 fsync 探测、复制与覆盖替换、完整校验与完整恢复（恢复后数据库与全部附件哈希核对）、卸载后 `TARGET_OFFLINE` 且不发布、重挂载后清单与卷身份一致、同一路径换上另一块卷被拒绝、FAT32 单文件限制按计划拒绝超限。报告 `test-results/macos-volume-acceptance.json`：5 项通过、1 项跳过。桌面端在真实 APFS 上以真实 Electron 41.9.1 与 Utility Process 通过 9 项验收，报告 `artifacts/macos-desktop/desktop-local-backup-apfs.json`；本机单元测试 376 项全部通过。

仍未完成：本机系统拒绝创建 exFAT 镜像（`hdiutil` 返回「操作不被允许」），exFAT 单文件限制识别目前只有解析层 fixture 覆盖；SMB/NFS 真实网络盘挂载未验收；外接物理盘的真实拔盘、真实断电、独立物理设备与整机灾难恢复仍见 §1/§2 的独立条目，不能由磁盘镜像或本地目录替代。

## 本轮验收结果（2026-10-04）

- 严格 TypeScript 与生产构建通过，Linux 应用目录打包通过；最终完整回归 233 项通过，失败为零。
- Cloudflare 已通过 Wrangler 部署协调器与 D1 迁移，真实云 13 项检查通过，见 `docs/cloudflare-acceptance.json`。官方本地 workerd 另通过备份 7 项、维护 5 项、流式传输 5 项、硬中断恢复 4 项，见 `test-results/cloud-worker-local.json`。硬中断确实在 D1 执行身份锁已持有时向服务进程组发送 SIGKILL，重启后仅由持久化闹钟继续原计划；这不是主动终止 Cloudflare 公网运行实例的测试。
- 便携恢复包位于 `artifacts/recovery-kit/`，本机隔离排练 4 项通过；正式模式已验证拒绝同一主机。见 `test-results/portable-recovery-acceptance.json`。包不含云凭据。独立物理设备及整机故障验收仍待完成。

两个 P0 的代码与自动化验收入口已交付，但发布验收尚未全部闭环：独立物理设备/整机灾难实测仍未执行。
