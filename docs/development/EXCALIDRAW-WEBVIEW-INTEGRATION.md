# 系统白板接入

2026-11-14，用户在[隔离可行性验证](EXCALIDRAW-WEBVIEW-FEASIBILITY.md)后授权开始替换。桌面白板入口现使用 Excalidraw 0.18.0 + 系统 WebView；原 GPUI 白板绘图、命中、属性面板、工具和独立 PNG 渲染实现已移除。F004/F005 改为系统白板的集成与设备验收，未标记全部完成。

## 实现边界

- `apps/desktop-rust/whiteboard/`：React 19.1.1、Excalidraw、Vite 6.3.6，独立锁文件。编辑、选区、图形关系和 undo/redo 由 Excalidraw 管理；宿主不逐操作同步另一份可编辑场景。
- `apps/desktop-rust/src/board/view.rs`：复用现有 GPUI WebView/Wry。每次打开创建独立 origin 和令牌，消息只接受该文档及匹配的快照请求，限制 IPC 大小；页面只加载内嵌资源，禁止外部导航、新窗口、嵌入页面和下载。CSP 不开放 CDN。
- `board/session.rs`：保留正文先保存、revision 校验、资源上传、原子提交及未知结果的原请求重试。保存时先结束文本编辑，再冻结场景，用同一份 Excalidraw JSON 生成 PNG。取消不提交，明确拒绝后保留可编辑草稿；提交结果未知时保留冻结快照并禁止继续编辑，复制场景不需要重新执行隐藏页面脚本。
- `board/persistence.rs`：沿用真实 Rust 后端保存事务与修订资源闭包。`anynote-editor::board::Scene` 用于场景数据校验，不参与活动视图的图形编辑或撤销历史。
- 原生工具栏提供保存、取消、复制场景、导出 `.excalidraw` 和 PNG。PNG 最长边 1280px；完整场景导出包含嵌图。文件导出复用图片导出的临时文件写入、同步与重命名路径。

Excalidraw 恢复场景时会规范化空绑定数组等字段；快照先使用同版本公开 `restoreElements` 规范化，再序列化和生成预览。测试严格比较保存与重开的元素，不通过忽略字段来掩盖差异。

嵌图在 WebView 中使用 data URL，存储时分离为不可变资源。Excalidraw 不必保留 Anynote 的自定义 `resourceId`：只有原场景中同一文件 ID 且字节相同的图片才复用原修订资源；网页传来的任意资源 ID 不作为授权依据。新图重新分配 UUID。场景上限 2 MiB，图片最多 128 张，单次新增最多 30 张，资源总量上限 100 MiB。

## 构建与发行

构建机器需要 Node.js 24/npm。Cargo 的 `build.rs` 自动按锁文件安装前端依赖并执行 Vite；首次构建需要 npm 网络或已完整缓存的依赖，`cargo --offline` 只约束 Cargo，不承诺首次 npm 安装离线。依赖与构建产物放在 Cargo OUT_DIR，npm 缓存在仓库 `tmp/npm-cache`，无需在生产目录运行开发服务器。

JS、CSS、字体和第三方许可证通过生成的静态资源索引编入 Rust 二进制。npm 包未携带的 Excalidraw 许可证及字体声明保存在 `whiteboard/licenses/`，构建时合并进内嵌 `THIRD_PARTY_NOTICES.txt`。运行时只依赖各平台的系统 WebView，不包含 Node/Electron。发行检查新增内嵌白板资源检查，CI 和发行构建安装 Node。Excalidraw 的字体声明仍有被 CSP 阻止的远程回退；本地字体随包，未放开远程字体地址。

Linux 使用项目现有 X11/XWayland 宿主。Windows 的临时白板窗口也遵循 `GPUI_DISABLE_DIRECT_COMPOSITION=1` 启动约束。WebView 在保存等待时隐藏，在失败后重新显示；复制场景后显式归还原生输入焦点。

## 验证

生产入口集成驱动为 `scripts/test-whiteboard-webview.py`，其 Rust example 打开真实 `DocumentEditor`、`BoardSession`、系统 WebKitGTK 和隔离后台笔记本。绘制、撤销、重做、文字及剪贴板使用 X11 输入；GPUI 工具栏操作通过生产控件事件触发。没有用浏览器替身或静态页面模拟保存成功。

```sh
python3 scripts/test-whiteboard-webview.py
cargo test --locked -p anynote-desktop --lib board::session::tests
cargo test --locked -p anynote-desktop --test board_persistence
cargo clippy --locked -p anynote-desktop --all-targets --all-features -- -D warnings
```

本次 Linux 系统 WebKitGTK + Xvfb 生产入口验证通过 **18 项检查**（`tmp/whiteboard-session/20261114-200503/report.json`）：正文先保存、资源加载、原生拖绘、撤销/重做、取消不提交、空场景预览、正在输入的文本直接 Ctrl+S 保存、保存重开严格一致、系统剪贴板导入绑定图形与图片、嵌图分离/复用/恢复、冲突不覆盖且保留草稿、正常退出。早期运行暴露的复制后原生焦点问题及空绑定字段重开差异已修正；驱动的控件状态和分块读取错误也已修正。

定向单元与后台保存测试、桌面 all-targets/all-features Clippy（零警告）、Rust 格式与依赖边界、13 项发行脚本测试和 18 项发行验收脚本测试均通过；本地 `--release-check` 返回 `whiteboard=passed`。这些是本地构建与合成发行测试，不代表签名发行包或三平台设备验收。

运行报告、截图及隔离笔记本位于 `tmp/whiteboard-session/`，可删除；该目录不是长期记录。后台定向测试覆盖原子提交、精确重试、历史图片、资源冲突、复制、归档及 Markdown 导出。新增单元测试验证自定义资源 ID 丢失后的正确复用与伪造 ID 不被采纳。

## 尚待验收

- macOS WKWebView、Windows WebView2；真实桌面中文 IME、焦点、跨应用剪贴板、拖放、触控笔、多屏 DPI 与无障碍。
- 复杂大场景、全部 Excalidraw 工具、长时间编辑和全进程内存；Xvfb 不代表 GPU 加速或物理设备验收。
- GPUI 菜单/弹窗覆盖原生子 WebView 的平台限制；当前白板占用整个内容区，原生工具栏位于其外。
- 图库跨会话持久化、SVG/选区导出及更多导出设置尚未接入。外部链接、在线图库、在线协作与 AI 服务未接入。
- 系统引擎崩溃后的未保存草稿恢复，以及最终签名发行包的三平台离线验收。

当前真实桌面 200% 缩放自动输入的缺口保留在原型验证记录中，不能以本次 Xvfb 结果宣称已解决。
