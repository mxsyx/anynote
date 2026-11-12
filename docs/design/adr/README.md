# 关键设计决定

这里回答“为什么这样设计”。编号保留稳定，每篇只说明一个决定；完整使用规则见对应专题。

## 资料与编辑

- [ADR-001 · 每本笔记本独立保存](001-notebook-storage.md)：便于单独携带和恢复。
- [ADR-002 · 正文只有一份](002-markdown-source.md)：避免连续视图与源码互相覆盖。
- [ADR-003 · 附件更新不覆盖历史](003-immutable-assets.md)：旧版本始终使用当时的文件。
- [ADR-008 · 完整归档与安全导入](008-archive-compatibility.md)：分清保真恢复与开放导出。
- [ADR-009 · AI 先提案，再修改](009-ai-proposals.md)：用户决定是否应用，后续编辑受保护。
- [ADR-010 · 以正文为中心的阅读布局](010-native-reading-layout.md)：工具可达，正文优先。

## 备份与后台职责

- [ADR-004 · 备份与同步分开](004-backup-not-sync.md)：保存状态、设备权限与恢复各自明确。
- [ADR-005 · 完整后才发布备份](005-generation-publication.md)：半成品不出现在恢复列表。
- [ADR-006 · 每个版本都能独立恢复](006-complete-checkpoints.md)：复用数据，但不依赖历史变化链。
- [ADR-012 · 存储与备份各负其责](012-backup-service-composition.md)：长任务不牵制基本保存。
- [ADR-013 · 清理需要预览与确认](013-remote-maintenance-lifecycle.md)：保护有效资料，防止旧请求复活。
- [ADR-014 · 续传前重新确认内容](014-cloudflare-transfer-resume.md)：进度可复用，身份与内容仍要校验。

[返回设计索引](../README.md)
