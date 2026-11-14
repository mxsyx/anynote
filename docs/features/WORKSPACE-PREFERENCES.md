# 工作区设置与管理

Rust 启动后直接进入笔记本内容，顶部栏提供笔记本切换、新建、打开及设置；工作区提供目录、搜索、阅读和历史入口；任务、诊断、本地/云备份、恢复与采集管理通过原生管理窗口访问。整体布局见 [桌面设计](../design/RUST-DESKTOP-MIGRATION.md)，服务与持久化约束见 [数据与迁移设计](../design/RUST-DATA-COMPATIBILITY.md)。

当前笔记本与外观偏好在设备侧保存；Notebook 名称、图标、封面等知识库数据随数据库与备份携带。媒体和阅读业务使用静态偏好，不提供插件安装、授权或更新页面。

备份状态、连接凭据、暂停策略和任务进度分别呈现；恢复、删除与云 writer 接管须按对应业务确认。动态对话框按需创建，关闭后恢复焦点。

原生菜单、键盘、读屏、窄窗口、主题与跨屏 DPI 的实际验收见 [平台任务](../../TODO.md#p3)。

## 笔记本工作区验证

2026-11-14 移除独立书橱页，顶部菜单统一切换、新建、打开与设置笔记本；设备偏好 `workspace.preferences` 保存 `active_book`。切换复用草稿保存屏障，清理目录、搜索及阅读状态；标签栏只呈现当前笔记本的文档。启动选择和目录/概览使用相同的笔记本与分类状态。

本地验证覆盖真实 Rust 后端的 6 项工作区测试、3 项 GPUI 交互测试，以及 4 项工作区单元/无头测试：创建与搜索、草稿保存后切换、重开恢复、菜单键盘选择与 Escape 焦点、目录拖动、不可用笔记本回退、万节点目录与 200% 缩放。隔离 Xvfb 中检查了实际生产窗口的亮/暗主题、切换菜单及 800×560 布局，并修正默认资源包缺少图标和侧栏标签居中的问题。临时日志与截图存于 `tmp/`；该证据不代表三平台实机、真实 IME 或读屏验收。

验证命令：`cargo test --locked --offline -p anynote-desktop --features ui-tests --test workspace --test workspace_ui`；`cargo test --locked --offline -p anynote-desktop --features ui-tests --lib workspace::tests`。另运行定向 Clippy、工作区依赖边界检查和 `git diff --check`。
