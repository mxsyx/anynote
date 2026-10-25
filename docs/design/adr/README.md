# 架构决策记录

本目录记录已在当前源码中实现的选择，补齐 [设计 §25](../Anynote-Design.md#25-架构决策记录adr)。2026-10-21 核对基线为 `e975c1c`。ADR-001–010 是对既有实现的追认；后续实施决策按各项记录的日期与基线核对，不新增产品批准或发布验收结论。

| ADR                                            | 当前决定                                     |
| ---------------------------------------------- | -------------------------------------------- |
| [ADR-001](001-notebook-storage.md)             | Notebook 独立 SQLite 与目录排序              |
| [ADR-002](002-markdown-source.md)              | Markdown 真源与连续编辑边界                  |
| [ADR-003](003-immutable-assets.md)             | 不可变 Asset、Resource 身份与历史闭包        |
| [ADR-004](004-backup-not-sync.md)              | 备份与同步分离及远端写入身份                 |
| [ADR-005](005-generation-publication.md)       | Cloudflare staging 与原子发布                |
| [ADR-006](006-complete-checkpoints.md)         | 每代完整 checkpoint 与物理分块增量           |
| [ADR-007](007-extension-runtimes.md)           | 扩展信任等级与公共 SDK                       |
| [ADR-008](008-archive-compatibility.md)        | 完整归档、安全导入与版本拒绝                 |
| [ADR-009](009-ai-proposals.md)                 | AI 提案、显式应用与条件撤销                  |
| [ADR-010](010-native-reading-layout.md)        | 原生阅读布局、设计 token 与辅助面板          |
| [ADR-011](011-extension-module-boundaries.md)  | 扩展契约、工具与存储实现的依赖方向           |
| [ADR-012](012-backup-service-composition.md)   | 备份服务装配、Storage 单向依赖与快照边界     |
| [ADR-013](013-remote-maintenance-lifecycle.md) | 远端维护生命周期、永久重放证据与手动保留配置 |
| [ADR-014](014-cloudflare-transfer-resume.md)   | Cloudflare 持久上传、范围下载与遗留会话回收  |

每项记录背景、决定、替代方案/取舍、源码和验证入口。变化时保留 ADR 编号及旧决定背景，注明替代日期和新证据；若彻底改换方案，新增 ADR 并双向标记替代关系。待产品确认的首发范围归 G00，不伪装成已采纳决定。

ADR 维护设计取舍，功能说明维护当前行为，任务复选框统一在开发目录 [TODO.md](../../development/TODO.md) 维护。既有架构核对证据见 [G18 报告](../../development/history/todo-2026-10-24.md#g18)，G17 批次实施结果见 [历史实施证据](../../development/history/todo-2026-10-24.md#g17)，统一维护规则见 [文档与任务维护](../../development/DOCUMENTATION.md)。
