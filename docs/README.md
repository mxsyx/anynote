# 文档导航

当前待办与任务状态统一见 [TODO](../TODO.md)。文档归属、归档和产物规则见 [文档维护](DOCUMENTATION.md)。

了解项目可先读 [产品设计](design/Anynote-Design.md) 和 [存储契约](design/SQLITE-STORAGE.md)；开始开发看 [开发工作流](development/DEVELOPMENT-WORKFLOW.md)，查询具体功能再按下面的分类阅读。

## 设计与存储

整体方案、存储格式与本地备份设计。

- [Anynote 产品与技术设计文档](design/Anynote-Design.md)
- [本地磁盘备份设计](design/Anynote-Local-Disk-Backup-Design.md)
- [SQLite 与不可变附件的增量备份](design/SQLITE-STORAGE.md)

## 功能说明

编辑器、归档、备份恢复和远端维护。

- [全新设备从云端恢复](guides/CLOUD-RECOVERY.md)
- [编辑器与扩展生态](guides/EDITOR-ECOSYSTEM.md)
- [Cloudflare 远端维护](guides/REMOTE-MAINTENANCE.md)
- [桌面流式归档](guides/STREAMING-ARCHIVE.md)
- [SQLite 分块云备份与恢复](guides/STREAMING-CLOUD-BACKUP.md)

## 扩展开发

扩展制作、权限、运行时、分发及数据协议。

- [插件数据显式清理](extensions/EXTENSION-CLEANUP.md)
- [扩展数据迁移与恢复](extensions/EXTENSION-DATA-MIGRATIONS.md)
- [扩展开发工具](extensions/EXTENSION-DEVELOPMENT.md)
- [扩展目录浏览](extensions/EXTENSION-DIRECTORY.md)
- [签名扩展的远程分发与手动更新](extensions/EXTENSION-DISTRIBUTION.md)
- [首方扩展宿主](extensions/EXTENSION-HOST.md)
- [声明式扩展设置](extensions/EXTENSION-SETTINGS.md)
- [扩展签名与来源信任](extensions/EXTENSION-SIGNING.md)
- [扩展自动检查更新](extensions/EXTENSION-UPDATE-CHECKS.md)
- [受限异步宿主搜索](extensions/SCRIPT-ASYNC-HOST.md)
- [受限插件网络代理](extensions/SCRIPT-NETWORK-PROXY.md)
- [受限正文转换脚本](extensions/SCRIPT-RUNTIME.md)
- [受限脚本搜索上下文](extensions/SCRIPT-SEARCH-CONTEXT.md)
- [受限脚本的 Notebook 状态](extensions/SCRIPT-STATE.md)

## 开发与发布

开发环境、构建测试、类型边界和发行准备。

- [开发工具与 GitHub CI/CD](development/DEVELOPMENT-WORKFLOW.md)
- [发行凭据准备与验收](development/RELEASE-CREDENTIALS.md)
- [公共包发布矩阵](development/RELEASE-MATRIX.md)
- [TypeScript 迁移](development/TYPESCRIPT-MIGRATION.md)

## 验收与恢复演练

复现步骤、证据范围和平台限制；历史通过不代表当前版本通过。

- [真实云备份验收](validation/CLOUD-ACCEPTANCE.md)
- [真实云桌面验收](validation/DESKTOP-CLOUD-ACCEPTANCE.md)
- [P0：备份可靠性与发布验收](validation/P0-BACKUP-READINESS.md)
- [性能与界面验收](validation/PERFORMANCE-UI-ACCEPTANCE.md)
- [插件公网端点验收](validation/PLUGIN-NETWORK-ACCEPTANCE.md)
- [客户端故障恢复演练](validation/RECOVERY-DRILLS.md)

## 架构决策

记录已采纳方案的背景、取舍和约束。

- [架构决策索引（ADR-001–014）](adr/README.md)

## 历史记录

按记录日期理解实施结果和已知限制，不用于维护当前任务状态。

- [G08 本地备份规模与响应验证](history/G08-local-backup-performance.md)
- [G14 搜索、导航与目录契约](history/G14-navigation-decision.md)
- [G20 · 视觉组件与截图验收](history/G20-visual-review.md)
- [实施记录](history/IMPLEMENTATION.md)
- [待办重编与历史实施证据](history/todo-2026-10-24.md)
- [待办合并前的阶段进展与证据](history/todo-progress-2026-10-25.md)

## 本地产物

截图和图集位于项目 `tmp/screenshots/`；旧 JSON 报告位于 `tmp/reports/archive/`；新验收及基准报告写入 `test-results/`。这些目录不提交 Git，不参与格式化和 lint。历史报告中的版本、环境与结果保持原有范围。
