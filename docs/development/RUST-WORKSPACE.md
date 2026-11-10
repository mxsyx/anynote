# Rust 工作区与阅读接续

对应 [RM28](TODO.md#rm28)。默认原生窗口进入工作区；平台探针仍使用独立检查壳。书橱、目录、搜索、阅读、设置由 `apps/desktop-rust/src/workspace/` 持有，管理页继续由 RM29 独立窗口持有，两者共用 BackendSession、菜单与现有保存会话。

## 业务与所有权

- `core::workspace` 定义私有类型化命令与 DTO；`backend/workspace` 负责会话、取消和工作线程；`services::workspace` 只适配既有组织服务。UI 不打开数据库、不实现存储排序或跨库提交。
- 建库、名称/封面、笔记/目录、标签/收藏、回收站、排序、历史恢复均进入 RM05 WriteQueue。跨库复制/移动进入 RM06，保留稳定 operation ID；超时不推定失败或盲目重复创建，只有有幂等回执的 transfer 显示重试。
- 外部库登记原目录，移出只释放连接并删除登记，不删除文件。离线库显示不可用；原路径恢复后刷新，也可先移出再登记新的目录。书橱按最近阅读排序，封面图标/颜色可以修改。
- 目录每次读取 200 项，在 Kit Tree 中虚拟展示；支持拖入目录、拖到节点前、移动/排序对话框及方向键/Home/End/Enter。存储继续拒绝循环、无效目标和过期修订。
- 历史索引每页 100 条，只读取元数据；点选时读取正文。恢复通过 CAS 生成新版本，不改旧版本。反向链接复用存储链接索引。

## 导航、阅读与资源

前进/后退在成功打开后更新栈；失败保留旧导航位置。标签页最多 30 个，最近记录和阅读位置各最多 100 条。切笔记、切库和组织变更先调用 `flush_for_navigation`：等待现有编辑器及白板提交，遇到错误保留内存草稿并停止切换，不关闭编辑器窗口。系统强制退出的 RM19 限制仍然有效。

普通 Markdown 使用 Kit TextView。阅读投影复用内置块解析器：提示/阅读卡片、可折叠详情、图片和白板预览；未知块保留可见源码。投影不会回写正文。白板、PDF、图片批注及视频交互继续打开已实现的专业视图，视频同意规则仍由 RM27 控制。

本地图片只通过 document/revision/resource 作用域读取；历史预览绑定历史修订，缩略图在进入视口时加载，释放时取消并回收纹理，不自动读取远程图片。长文档解析异步完成后再定位内部锚点、恢复阅读位置，迟到的笔记/历史响应按 generation 拒绝。外链只交给系统处理 HTTP、HTTPS、mailto。

## 搜索与原生入口

搜索支持当前/所有笔记本、标签、文本/PDF/图片及最近 7/30/90 天筛选；输入防抖、显式取消和 token 检查抑制过期结果，命中显示片段，PDF 命中沿原有锚点进入阅读器。

每页最多 200 条，以更新时间降序、笔记本/笔记 ID 升序作为游标。数据未变化且所有库成功扫描时可稳定翻页；离线、错误或扫描预算耗尽会显示未完整扫描并禁用继续翻页。取消是协作式检查，不承诺打断正在执行的单条 SQLite 查询。写队列占有独占 WAL 连接时，搜索/反链复用该连接，避免另开只读连接要求不存在的 SHM 文件。

菜单与快捷键共用 Actions：Cmd/Ctrl+N 新建、K/P 搜索、逗号设置、Shift+O 导入、工作区内 O 导入、macOS Cmd+[ / ] 或其他平台 Alt+Left / Right 导航、R 刷新。系统编辑菜单、Services、Hide/About/Quit 保留，管理入口共存；窗口重开优先恢复工作区。文件选择/拖入走现有 ImportService 的文件预览与提交服务。

偏好保存为 `workspace.preferences`，包含系统/浅色/深色主题、75%–200% 字号缩放、标签页开关、最近记录和阅读位置；纸张颜色集中在 theme 模块。设置使用动态 Dialog，树/按钮/输入/状态区有 Kit 可访问性语义；后端断开后刷新可重连。

## 验证与边界

本机 macOS arm64，临时合成资料库：

```sh
cargo test -p anynote-desktop --locked --features ui-tests --test workspace --test workspace_ui
cargo test -p anynote-desktop --locked --features ui-tests --lib workspace::
cargo test -p anynote-storage --locked
cargo test -p anynote-desktop --locked --features ui-tests --test ui --test management_ui --test board_session_ui
cargo clippy -p anynote-desktop -p anynote-storage -p anynote-services -p anynote-core --locked --all-targets --features anynote-desktop/ui-tests -- -D warnings
python3 scripts/check-rust-workspace.py
```

RM28 专项 14 项：6 项真实后端、3 项生产控件与真实后端 UI、5 项导航/阅读/长树测试。覆盖创建、标签/收藏、排序/循环拒绝、复制回执重放、搜索分页/取消/离线标记、反链重命名、历史恢复、文件导入、外部库失联/恢复、偏好重启、草稿保存、动态弹窗、万节点虚拟化和 200% 缩放，以及长文档锚点和阅读位置。长树测试证明可导航与按视口展示，不等于帧率/低配性能验收。

macOS 隔离测试应用实际通过原生菜单新建笔记本、创建笔记、进入目录/阅读页并返回有封面的书橱。AX 控件激活存在未触发的情况，原生菜单与输入值操作可完成上述流程；不能据此关闭读屏或真实键盘/IME 验收。三平台、跨屏 DPI、实际设备/用户库、强制退出和性能预算仍交 RM31/32；V/A/F 不变。完整回归中的既有/并行失败与重跑结果记录在 [实施记录](IMPLEMENTATION.md#rm28)。原始日志及隔离应用均位于可删除的 `tmp/rm28-*`。
