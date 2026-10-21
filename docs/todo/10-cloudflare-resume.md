# G10 · Cloudflare 中断续传

[返回总入口](../../TODO.md)

类型：内核实现。目标：可恢复分块/下载进度与遗留上传清理。

前置：先定义源切点、持久进度和遗留上传生命周期；复用现有分块协议。

并行边界：与云盘 Provider 实现可隔离并行；涉及维护协议时与 G09 串行。

## 建议入口

- [packages/backup/src/cloud-archive.ts](../../packages/backup/src/cloud-archive.ts)
- [packages/backup/src/restore-task.ts](../../packages/backup/src/restore-task.ts)
- [packages/protocol/src/file-chunks.ts](../../packages/protocol/src/file-chunks.ts)

## 执行顺序

1. 明确复用已验证应用分块和厂商 multipart 的边界，决定持久进度格式。
2. 实现中断、取消、切点变化与重启后的正确复用，补遗留上传清理。
3. 先自动回归，再交 G07 实测吞吐与故障；不以 16MiB 分块宣称字节续传。

## 待办

### T024 · 原 §4

- [ ] **P2 — 中断字节续传**：评估复用已验证分块/下载进度及可选 multipart 的续传和遗留上传清理，补充中断、取消、源切点变化测试；当前重试重新捕获或下载，16MiB 应用分块不等于厂商 multipart 或字节续传。

## 验证与完成条件

- [tests/cloud-stream.test.mjs](../../tests/cloud-stream.test.mjs)
- [tests/cloud-recovery.test.mjs](../../tests/cloud-recovery.test.mjs)
- `pnpm run test:cloud:stream`

完成条件：重启后的续传确实复用数据，源变化不拼接旧进度，取消与清理可恢复。

人工 / 外部资源：真实服务复测使用 G07 环境；实现与模拟故障不需要先准备账号。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
