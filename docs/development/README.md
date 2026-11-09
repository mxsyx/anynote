# 开发

供 Agent 接续实施使用。先核对当前源码和任务范围，实施后更新已交付范围、剩余事项与已知失败；不把历史测试结果当作当前通过结论。

- [TODO：唯一未完成任务清单](TODO.md)，含 [Rust 桌面迁移 RM01–RM38 执行组](TODO.md#rust-migration)、依赖、并行范围与验收条件。
- [实施记录与接续入口](IMPLEMENTATION.md)，含 [RM10 云传输、恢复与统一调度契约](IMPLEMENTATION.md#rm10)、[RM11 writer、保留与维护恢复契约](IMPLEMENTATION.md#rm11)。
- [Rust 迁移基线与语料使用](RUST-MIGRATION-BASELINE.md)：固定旧提交、操作/功能归属、黄金文件、生成和自校验方法及实测边界。
- [Rust 桌面开发入口](RUST-DESKTOP-DEVELOPMENT.md)：五个工程、固定依赖/native 许可证、平台探针，以及 RM03 后端通信、任务/资源/调度与诊断接入契约。
- [Rust 文本事务与输入内核](RUST-EDITOR-TRANSACTIONS.md)：RM16 的坐标/选区、原子 patch、marks/link、增量历史、composition 和后续视图/保存接入契约。
- [Rust 结构编辑内核](RUST-EDITOR-STRUCTURE.md)：RM17 的列表/表格/块命令、复杂粘贴、atom 与跨块选区、序列化边界及 RM18 接续契约。
- [Rust 连续编辑视图](RUST-EDITOR-VIEW.md)：RM18 的原生草稿、Kit 几何/输入、共享历史、可访问性原型、测试证据及未完成验收项。
- [Rust 静态内置业务](RUST-BUILTIN-BUSINESS.md)：RM20 声明块、阅读命令、原子回执、静态偏好与已知样例/未知脚本验收边界。
- [Rust 源码模式与保存会话](RUST-DOCUMENT-SESSION.md)：RM19 的源码工具、共享历史、串行 CAS、断线核对、资源版本绑定和窗口生命周期边界。
- [Rust 图片阅读与版本](RUST-IMAGE-MEDIA.md)：RM21 的有界解码、图片块、上传与修订绑定、矩形批注、复制/导出和设备验收边界。
- [Rust schema v5 只读存储](RUST-READONLY-STORAGE.md)：RM04 的 schema/catalog/read/search、历史资源范围读取、WAL/路径拒绝边界和 TS 差分复现。
- [Rust schema v5 写存储](RUST-WRITE-STORAGE.md)：RM05 的写队列/租约/LRU/pin、核心事务、历史资源与提案，以及 RM06 跨库闭包、幂等回执和 TS 双向互通复现。
- [Rust 导入、下载与媒体重试](RUST-IMPORT.md)：RM07 的 HTML 差分、预览租约、目录授权、下载边界、采集回执和 TS/Rust 互通复现。
- [Rust 快照、归档、开放导出与清理](RUST-SNAPSHOT-ARCHIVE.md)：RM08 的冻结切面、ZIP/ZIP64 双向互通、开放导出、完整性保全、清理恢复及复现。
- [Rust 本地备份 v3](RUST-LOCAL-BACKUP.md)：RM09 的卷预检、增量发布、任务回执、全量验证、新库恢复及 TS 互通复现。
- [Rust 配对、采集消费与云浏览](RUST-CLOUD-CAPTURE.md)：RM12 的配对/claim/事务回执、同切面投影、RM10 接续顺序和保留扩展本地闭环。
- [Rust 配置与凭据读取器](RUST-CONFIG-MIGRATION.md)：RM13 的 LevelDB 副本、平台凭据原型、插件状态保全、逆映射与复现方法。
- [Rust 数据接管与回退演练](RUST-MIGRATION-TAKEOVER.md)：RM14 的完整保全、可重入 journal、原路径租约、最新数据回退、故障演练及正式激活缺口。
- [Rust 白板兼容契约与差分方法](RUST-BOARD-COMPATIBILITY.md)：scene/事务边界、0.18 默认入口与快捷键矩阵、裁剪/路径/组框层级差分及完整兼容门槛。
- [Rust 原生白板视图与交互](RUST-BOARD-VIEW.md)：RM23 原生绘制/交互、93 个冻结动作接线缺口，以及 RM24 显式保存、原子资源闭包、历史/跨库/归档互通与复现。
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
