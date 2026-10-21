# G02 · 跨平台数据与凭据验收

[返回总入口](../../TODO.md)

类型：验收 / 实测。目标：平台数据闭环、系统凭据、Electron 底层能力。

前置：目标平台真实系统；Windows 卷能力部分接 G04；发行验收使用 G05 对应构建产物。

并行边界：不同平台可分批并行；同一平台的凭据锁定/重启与数据操作串行。

## 建议入口

- [apps/desktop/electron/storage.ts](../../apps/desktop/electron/storage.ts)
- [packages/storage-sqlite/src/database-snapshot.ts](../../packages/storage-sqlite/src/database-snapshot.ts)
- [docs/P0-BACKUP-READINESS.md](../../docs/P0-BACKUP-READINESS.md)
- [docs/CLOUD-RECOVERY.md](../../docs/CLOUD-RECOVERY.md)

## 执行顺序

1. 按 Windows/macOS 建立矩阵；Linux 凭据异常同批准备独立测试环境。
2. 复用已存在的 macOS/APFS 和 Electron 报告，确认版本适用性后只补缺失项。
3. 依次执行运行时能力、数据闭环及凭据异常，按 G00 决策处理版本拒绝边界。

## 待办

### T005 · 原 §2.1

- [ ] **P0 — 跨平台数据闭环**：macOS/Windows 真机验证离线创建/编辑/阅读、写锁与 LRU 重开、迁移、导入导出、云备份与恢复，以及旧客户端/新 Worker、新客户端/旧 Worker、旧插件/新桌面、新 schema/旧桌面的接受或明确拒绝行为。

### T006 · 原 §2.1

- [ ] **P0 — 凭据系统实测**：macOS Keychain、Windows 系统加密及 Linux keyring 在系统重启、锁定/解锁、服务缺失或不可用时验证；确认错误可操作、无明文持久化，凭据不进入日志、归档或 Renderer。现有 Linux 隔离 keyring 验收只覆盖应用重启。

### T007 · 原 §2.1

- [ ] **P1 — 各平台 Electron 底层能力**：在 macOS/Windows 的内嵌 Node 上验证 SQLite Online Backup、statfs、文件替换和同步；对不支持目录同步的平台验证实际降级行为。Linux 当前运行时已通过；macOS 已于 2026-10-08 在真实 Electron 41.9.1 内嵌 Node 上通过桌面端 APFS 验收（`node:sqlite` Online Backup 捕获、`statfs` 卷信息、同盘替换与目录 fsync 探测），Windows 仍待验证。

## 验证与完成条件

- `pnpm run test:desktop`
- `pnpm run test:desktop:local-backup`
- `pnpm run test:desktop:cloud`
- macOS Keychain、Windows 系统加密、Linux keyring 的重启和异常状态人工记录。

完成条件：每个平台、运行时和凭据异常有独立结果；沿用报告需注明版本与覆盖范围。

人工 / 外部资源：提供相应平台、系统重启/锁定/解锁和系统凭据操作。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
