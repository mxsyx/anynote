# 卷适配与物理设备识别

[返回功能任务入口](03-feature-logic.md) · [返回总入口](../../TODO.md)

更新：2026-10-25。

F001、F002 共用卷探测、文件系统属性与本地备份测试，作为一个执行组，分阶段串行实施。本地实现和 fixture 不依赖真实 Windows 设备。

## 任务

<a id="f001"></a>

### F001 · Windows 卷适配代码

- [ ] **P1 — Windows 卷适配代码**：补齐稳定卷标识、挂载状态、磁盘名称、文件系统类型、网络挂载与 FAT32 限制识别；与既有 macOS/Linux 接口对齐，提供输出解析、错误降级及 fixture 测试。实现和本地 fixture 可先完成，Windows/NTFS 实盘验收归 [V009](01-platform-validation.md#v009)。

<a id="f002"></a>

### F002 · 物理设备枚举与提示

- [ ] **P2 — 物理设备枚举与提示**：实现 Linux 文件系统到物理设备的映射、未知/虚拟设备降级及 UI 提示，并提供其他平台适配接口与 fixture。`stat.dev` 只能识别文件系统/任务期间设备变化，不能证明两个分区属于独立物理设备，也不等于持久卷 UUID。

## 执行顺序与验收

1. 先明确稳定卷标识、文件系统设备号、物理设备映射的不同语义及未知状态，保持平台接口一致。
2. 完成 F001 的 Windows 输出解析、挂载/网络/FAT32 识别和错误降级；补齐 fixture、单元测试和相关文档。
3. 在同一接口上完成 F002 的 Linux 物理设备映射、未知/虚拟设备降级、其他平台接口及 UI 提示；补齐映射 fixture 和提示回归。UI 只消费已明确的设备状态。
4. 本地回归通过后，分别交给 [V009](01-platform-validation.md#v009) 做 Windows/NTFS 实盘验收、[V008](01-platform-validation.md#v008) 做设备组合验证；本组不复制实机复选框。

## 代码与验证入口

- [卷适配](../../packages/backup-local/src/volume.ts)、[本地备份测试](../../tests/backup-local.test.mjs)、[卷 fixture](../../tests/fixtures/volume)。
- 构建后运行 `pnpm exec vitest run tests/backup-local.test.mjs`，补充受影响的类型和 UI 回归；新增探测开销需测量，不能拖慢备份启动。
- 与 F005 涉及本地备份类型的批次串行；与签名实现可独立推进。实际文件清单确定后再安排并行。

完成与交接遵循[统一规则](03-feature-logic.md#handoff)。阶段完成不等于整项完成；未满足完整验收条件时保留未勾选。
