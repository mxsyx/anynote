# 功能说明

长期维护已实现功能的用法、接口、权限、预算及限制，为后续产品文档、技术文档和官网提供素材；不直接把研发测试结果写成产品承诺。

- [原生候选包安装条件](NATIVE-INSTALL.md)：平台依赖、离线资源、数据保留与安装升级边界。
- [工作区设置与管理页面](WORKSPACE-PREFERENCES.md)：设置、插件扩展和备份恢复的分组、作用范围与界面回归。
- [浏览器笔记采集](BROWSER-CAPTURE.md)：选区与对话采集、采集包、云端配对和归入边界。
- [全新设备从云端恢复](CLOUD-RECOVERY.md)
- [编辑器与扩展生态](EDITOR-ECOSYSTEM.md)
- [Cloudflare 远端维护](REMOTE-MAINTENANCE.md)
- [桌面流式归档](STREAMING-ARCHIVE.md)
- [SQLite 分块云备份与恢复](STREAMING-CLOUD-BACKUP.md)

## 旧桌面扩展与脚本参考

以下为旧客户端的机制和操作记录；Rust 通过 [静态内置业务](../development/RUST-BUILTIN-BUSINESS.md) 承接已知能力，不提供 SDK/通用插件宿主。源码退役进度见 [RM37](../development/TODO.md#rm37)。

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
