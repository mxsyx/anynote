# 系统 PDF 预览

本文提供系统 PDF 查看器的运行边界、复现方法和验收判据。产品边界以 [媒体阅读](../design/MEDIA-READING.md) 为准。

## 实现与生命周期

- `apps/desktop-rust/src/pdf/view.rs` 保留一个查看器实体，提供重新加载、加载/失败反馈和原件导出。翻页、缩放、文内查找、文字选择及密码界面由系统查看器提供。查看器可能自带临时编辑工具，AnyNote 不将其保存到笔记或写回 PDF；导出入口始终导出原件。
- `pdf/reader.rs` 复用后台 `AssetCommand`，按笔记、修订和资源身份取得经过校验的读取句柄。历史修订不会读取最新文件。
- `pdf/server.rs` 仅绑定 `127.0.0.1` 的随机端口，每个会话使用随机 URL，只提供一个 PDF；校验 Host、路径、Origin、方法和 Range。不提供业务 API、目录浏览或跨域权限。关闭后撤销 URL，后台线程释放资源句柄。
- 使用 HTTP 原因：系统查看器直接接受 PDF 响应，无需内嵌阅读器脚本；普通响应与 Range 响应均按 64 KiB 分块读取，不将整个 PDF 复制进 Rust 内存。单文件上限沿用 2 GiB。系统引擎自身的内存使用不受此缓冲上限约束。
- WebView 采用临时会话，不安装业务 IPC；仅允许当前 PDF 的导航与页内片段，不自动打开链接、新窗口或任意下载。查看器主动下载在页面加载后转到应用原件导出入口；无法内嵌的首次下载反馈为预览失败。
- 原件导出复用 `asset_writer::export_reader`，后台分块读取，成功后发布文件；读取失败或取消清理临时文件，不改变已有目标或原资料。

## 复现

```sh
cargo test --locked --offline -p anynote-desktop --lib pdf::server
cargo test --locked --offline -p anynote-desktop --test pdf_webview
cargo test --locked --offline -p anynote-desktop --lib asset_writer
cargo build --locked --offline -p anynote-desktop --bin anynote-desktop --example pdf_webview_probe
# 参数：报告位置、tests/fixtures/pdf 内的文件名、加载后保留窗口秒数
# Linux 无头环境可在命令前加 xvfb-run -a；真实桌面直接执行。
target/debug/examples/pdf_webview_probe tmp/pdf-webview/manual.json geometry.pdf 180
```

探针使用合成 PDF、独立后台和 `tmp/` 状态目录。只监听 WebView 加载结束并输出状态；该事件不能证明 PDF 页面已正确绘制，必须同时观察窗口内容。所有一次性日志和截图保存在 `tmp/pdf-webview/`。

## 验收步骤与判据

1. 打开 `geometry.pdf`，应显示 8 页，并检查中文、混合字体、裁剪和旋转文字。通过系统工具栏查找 `Anynote`，确认匹配文字高亮；翻到第 2 页，改变缩放，再重新加载。每步保存截图，并记录系统 WebView 版本。
2. 对 `encrypted.pdf` 验证密码输入、错误密码重试和取消；对无效文件验证恢复提示与导出原件。应用不持久化密码。
3. 使用真实系统文件选择器导出原件，核对字节与原文件相同；取消或模拟读取失败时，原文件和已有导出目标不应改变。
4. 验证文本复制、键盘查找、焦点进入/退出、读屏、窗口缩放和多屏 DPI；关闭后重新打开，确认不残留旧视图或可用资源 URL。探针可用第三参数缩短保留时间，正常退出报告中的 `closed` 记录关闭路径；仍需观察实际窗口和进程退出。
5. 使用代表性复杂/超大文件观察加载、取消及长期内存/句柄变化；Rust 分块缓冲上限不代表系统引擎的总内存上限。

数据源单元测试验证完整字节、区间/尾部 Range、HEAD、非法范围/方法/来源/路径与关闭撤销；真实后台集成测试比对原文件字节。流式导出单元测试验证读取失败、取消保留目标和成功导出。它们不验证系统文件选择器或 PDF 实际呈现。

Linux 可用 Xvfb 复现系统 WebKitGTK 页面及交互，但不作为物理设备、GPU 性能或无障碍验收。Windows WebView2、macOS WKWebView 与目标 Linux 设备分别执行以上流程。未完成项统一记录在 [F022](../../TODO.md#f022)、[F025](../../TODO.md#f025) 和 [F029](../../TODO.md#f029)，不以加载事件或编译成功代替实际验证。

发行包不再下载、签名或携带 PDFium。`--release-check` 的 `pdfViewer=system-webview` 是实现声明，不是 PDF 呈现通过标记。最终候选仍须按 [发行复核](RUST-RELEASE-ACCEPTANCE.md) 验证。
