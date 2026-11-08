# 设计

记录架构、功能、存储格式与设计取舍。

- [Rust + GPUI + GPUI-Kit 桌面迁移方案](RUST-DESKTOP-MIGRATION.md)：目标架构、技术选型、WebView 边界、迁移阶段与验收门槛；仅设计，尚未实施。
- [Rust 迁移现状与功能清单](RUST-MIGRATION-INVENTORY.md)：现有功能与操作入口、插件能力内置、保留及退役范围。
- [Rust 数据与协议兼容方案](RUST-DATA-COMPATIBILITY.md)：SQLite、用户文件、配置凭据、归档、备份和 Cloudflare 协议的兼容与回滚。
- [Rust 原生编辑器设计](RUST-EDITOR-DESIGN.md)：参考 quiet-md 的编辑内核与 GPUI 渲染，独立保持 AnyNote 文档格式和编辑体验。
- [Anynote 产品与技术设计文档](Anynote-Design.md)
- [本地磁盘备份设计](Anynote-Local-Disk-Backup-Design.md)
- [浏览器笔记采集设计](BROWSER-CAPTURE.md)：网页选区、ChatGPT 对话、媒体采集包与 Cloudflare 采集/只读浏览；待实施方案。
- [搜索、导航与目录设计](NAVIGATION.md)
- [SQLite 与不可变附件的增量备份](SQLITE-STORAGE.md)
- [视觉组件与交互设计](UI.md)

- [架构决策 ADR](adr/README.md)
