# 开发

供 Agent 接续实施使用。先核对当前源码和任务范围，实施后更新已交付范围、剩余事项与已知失败；不把历史测试结果当作当前通过结论。

- [TODO：唯一未完成任务清单](TODO.md)
- [实施记录与接续入口](IMPLEMENTATION.md)
- [开发工作流](DEVELOPMENT-WORKFLOW.md)
- [文档维护与临时文件规则](DOCUMENTATION.md)
- [类型编译与边界](TYPESCRIPT-MIGRATION.md)
- [发布矩阵](RELEASE-MATRIX.md)
- [发行凭据](RELEASE-CREDENTIALS.md)

## 验证方法

验证方法长期保留，单次执行结果写入 `tmp/reports/`，截图写入 `tmp/screenshots/`。清空 `tmp/` 后需要重新生成，不能以其中报告的存在与否推断任务状态。

- [真实云备份验收](validation/CLOUD-ACCEPTANCE.md)
- [真实云桌面验收](validation/DESKTOP-CLOUD-ACCEPTANCE.md)
- [功能回归入口](validation/FEATURES.md)
- [P0：备份可靠性与发布验收](validation/P0-BACKUP-READINESS.md)
- [性能与界面验收](validation/PERFORMANCE-UI-ACCEPTANCE.md)
- [插件公网端点验收](validation/PLUGIN-NETWORK-ACCEPTANCE.md)
- [客户端故障恢复演练](validation/RECOVERY-DRILLS.md)

## 阶段交接

- [旧任务编号与实施摘要](history/todo-2026-10-24.md)
- [Cloudflare、插件公网、发行凭据与类型边界接续](history/todo-progress-2026-10-25.md)

持续运行的老化样本状态与服务凭据不属于可丢弃报告，沿用专用状态目录；接续时先检查实际状态，勿从日期或历史摘要推断完成。
