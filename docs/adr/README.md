# 架构决策记录

本目录记录已在当前源码中实现的选择，补齐 [设计 §25](../Anynote-Design.md#25-架构决策记录adr)。2026-10-21 核对基线为 `e975c1c`。这是对既有实现的追认，不新增产品批准或发布验收结论。

| ADR                                      | 当前决定                              |
| ---------------------------------------- | ------------------------------------- |
| [ADR-001](001-notebook-storage.md)       | Notebook 独立 SQLite 与目录排序       |
| [ADR-002](002-markdown-source.md)        | Markdown 真源与连续编辑边界           |
| [ADR-003](003-immutable-assets.md)       | 不可变 Asset、Resource 身份与历史闭包 |
| [ADR-004](004-backup-not-sync.md)        | 备份与同步分离及远端写入身份          |
| [ADR-005](005-generation-publication.md) | Cloudflare staging 与原子发布         |
| [ADR-006](006-complete-checkpoints.md)   | 每代完整 checkpoint 与物理分块增量    |
| [ADR-007](007-extension-runtimes.md)     | 扩展信任等级与公共 SDK                |
| [ADR-008](008-archive-compatibility.md)  | 完整归档、安全导入与版本拒绝          |
| [ADR-009](009-ai-proposals.md)           | AI 提案、显式应用与条件撤销           |
| [ADR-010](010-native-reading-layout.md)  | 原生阅读布局、设计 token 与辅助面板   |

每项记录背景、决定、替代方案/取舍、源码和验证入口。变化时保留 ADR 编号及旧决定背景，注明替代日期和新证据；若彻底改换方案，新增 ADR 并双向标记替代关系。待产品确认的首发范围归 G00，不伪装成已采纳决定。

ADR 维护设计取舍，功能说明维护当前行为，任务复选框仅在所属 `docs/todo/` 文件维护。证据与本轮命令结果见 [G18 核对报告](../G18-documentation-review.md)，统一维护规则见 [文档与任务维护](../DOCUMENTATION.md)。
