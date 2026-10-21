# G04 · 卷适配与 Windows 实盘验证

[返回总入口](../../TODO.md)

类型：内核实现 / 平台验收。目标：Windows 卷适配 → NTFS；物理设备映射与提示。

前置：实现可立即开始；NTFS 验收需要 Windows 与对应磁盘。

并行边界：与云盘、导入组并行；同一 volume.ts 及 fixture 修改串行。

## 建议入口

- [packages/backup-local/src/volume.ts](../../packages/backup-local/src/volume.ts)
- [packages/backup-local/src/filesystem.ts](../../packages/backup-local/src/filesystem.ts)
- [apps/desktop/src/LocalBackup.tsx](../../apps/desktop/src/LocalBackup.tsx)

## 执行顺序

1. 先完成 Windows 稳定卷信息、解析和失败降级，与既有 macOS/Linux 接口对齐。
2. 具备 Windows 后立即执行 NTFS 验收，不等待 P2 的 Linux 物理设备枚举。
3. 后续子任务补 Linux 物理设备映射、未知设备降级和 UI 提示，再把结果交给 G03 的设备组合验收。

## 待办

### T014 · 原 §3

- [ ] **P1 — Windows 卷适配代码**：补齐稳定卷标识、挂载状态、磁盘名称、文件系统类型、网络挂载与 FAT32 限制识别，提供输出解析、错误降级及 fixture 测试。macOS 已按此要求完成（`df -P` 定位设备节点 + `diskutil info -plist` 取 `VolumeUUID`/卷名/可移动介质，`mount` 表回退，纯函数解析与 fixture 覆盖，见 §2.3）；Windows 仍只返回 statfs 基础信息，是 §2.2 实盘验收的前置条件。

### T017 · 原 §3

- [ ] **P2 — 物理设备枚举与提示**：实现 Linux 文件系统到物理设备的映射、未知/虚拟设备降级及 UI 提示，并提供其他平台适配接口与 fixture。`stat.dev` 只能识别文件系统/任务期间设备变化，不能证明两个分区属于独立物理设备，也不等于持久卷 UUID。

### T011 · 原 §2.2

- [ ] **P1 — Windows/NTFS 实盘验收**：验证卷及物理设备信息、网络盘/FAT32 限制、替换失败、真实文件占用、有限重试、目录同步能力及完整恢复。

## 验证与完成条件

- [tests/backup-local.test.mjs](../../tests/backup-local.test.mjs)
- [tests/fixtures/volume](../../tests/fixtures/volume)
- `pnpm run test:desktop:local-backup`

完成条件：实现与实盘条目分别勾选；stat.dev、卷 UUID 和物理设备身份的语义明确。

人工 / 外部资源：Windows 真机与 NTFS/网络盘/FAT32 测试介质；fixture 开发无需等待。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
