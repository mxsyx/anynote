# G11 · 云盘上传续传与索引成本

[返回总入口](../../TODO.md)

类型：内核 / 性能。目标：跨进程上传会话、查询分页与缓存。

前置：先测 Provider 请求量和重启行为；真实收益通过 G01 的账号环境验证。

并行边界：与 Cloudflare 传输可隔离并行；共享 backup-core/Provider 的改动与 G12/G13 串行集成。

## 建议入口

- [packages/cloud-backup-common/src/plan.ts](../../packages/cloud-backup-common/src/plan.ts)
- [packages/cloud-backup-common/src/upload.ts](../../packages/cloud-backup-common/src/upload.ts)
- [packages/backup-core/src/capture.ts](../../packages/backup-core/src/capture.ts)
- [extensions/backup-google-drive/src/provider.ts](../../extensions/backup-google-drive/src/provider.ts)

## 执行顺序

1. 先处理源切点和临时副本生命周期，补跨进程上传会话恢复与失效重建。
2. 再独立测量 exists/listCurrentBackups 查询量，实施收益明确的分页、批量索引或缓存。
3. 同一 Provider 的两个步骤串行；范围过大时按这两个步骤续会话，不混入账号 UI。

## 待办

### T035 · 原 §5

- [ ] **P2 — 上传会话跨进程续传**：当前崩溃或重启后重新捕获并开启新会话（正确但浪费上传量）。评估在源切点未变时保留数据库临时副本以恢复会话，并补齐「源切点变化不得拼接旧会话」的回归。

### T036 · 原 §5

- [ ] **P2 — 分页与索引成本**：`plan` 的 `exists` 逐个查询 file ID、`listCurrentBackups` 逐槽读取清单。评估分页索引、`appProperties` 批量查询与对象缓存的收益与实现成本。

## 验证与完成条件

- [tests/cloud-backup.test.mjs](../../tests/cloud-backup.test.mjs)
- [tests/cloud-dropbox.test.mjs](../../tests/cloud-dropbox.test.mjs)
- [tests/cloud-onedrive.test.mjs](../../tests/cloud-onedrive.test.mjs)

完成条件：源变化不会复用旧上传，索引优化保持一致性，成本收益有前后数据。

人工 / 外部资源：厂商账号性能/限流实测复用 G01；本地协议回归可先做。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
