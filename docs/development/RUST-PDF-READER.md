# Rust PDF 引擎与阅读视图

RM25.1–RM25.3 的接续契约。任务状态统一见 [TODO](TODO.md#rm25)；文字选择、批注、索引及阅读笔记属于 RM26。

## 所有权与接入

- `apps/desktop-rust/src/pdf/engine.rs` 封装 Pdfium；`NativeDocument` 不暴露原生句柄，打开、页面/文本/渲染和销毁共用操作锁。实际发现 7350 的字体加载在并行用例中触发 `CFX_FontMapper` 原生分配器崩溃；绑定的 `sync/thread_safe` 不足以保护完整调用序列。现在串行化完整操作，空闲文档不占锁，多个阅读会话仍可存在。并行默认测试已通过。
- `worker.rs` 在命名后台线程持有原生文档和受控 reader；单槽请求队列、generation 与关闭标记共同拒绝迟到结果。关闭解除租约、销毁文档；全局 native library 保留至进程退出。
- `view.rs` 的 `PdfView` 持有页码、缩放、输入实体和纹理，复用 Kit Button/Input，支持按钮、Tab 和页面区的左右键/PageUp/PageDown/Home/End、+/−、0、Escape。图像转换也在后台执行。加载状态置于固定高度状态栏，避免改变适页视口；测量同时检查显示缩放变化。页面区支持滚动查看放大后的内容。
- PDF 笔记通过 `OpenDocument` 返回 `DocumentSnapshot.primary_pdf`，`DocumentEditor` 直接打开只读阅读视图，切笔记/释放时关闭旧会话。原文保存接口仍拒绝 PDF，避免把 PDF 笔记当 Markdown 写回。目录与完整历史导航仍由 RM28/RM26 接线。
- 新增 `anynote-core::asset::{AssetScope, AssetCommand, AssetReply}`，私有桌面协议升为 v3。`asset_reader.rs` 的租约实现由 PDF 与既有 ImageCommand 共用；笔记/修订/资源绑定、CAS hash、文件身份及范围校验继续由 RM04/05 的 `VerifiedAsset` 执行。没有新数据库格式或历史兼容分支。

## 范围读取、预算与取消

PDF 使用 `Read + Seek` 接入原生 custom-file callback，每个后端范围最多 256 KiB。文档字节不全量缓存于 UI/worker；存储层的首次完整性验证可能流式读完整个 CAS 文件，这与原生按需读取/内存预算不同。

当前限制：单 PDF 最大 2 GiB，单页最长边 4096 像素（RGBA 最坏 64 MiB），单页文本最多 100000 glyph；超限显式报错。主页面持有一张纹理和文本几何，打开缩略图后只加载当前五页分组，最多另持有五张 160 像素缩略图。切页/缩放/关闭释放旧纹理；没有全书解码缓存。原生 bitmap、RGBA 转换和 GPU 上传期间有临时副本，不将 64 MiB 宣称为进程峰值内存。

取消会清空排队请求、拒绝旧 generation、在 glyph 遍历和原生渲染前后检查。当前 Pdfium 一次同步渲染不能中途抢占，关闭时正在执行的调用完成后释放；不是硬超时隔离。资源读取失败具有 sticky 标记，原生返回部分图像也不会发布成功结果。用户可重试资源/密码错误；密码只驻留当前进程，不写配置、日志或 IPC。

## 文本与坐标

`PageGeometry` 从与页面 bitmap 完全相同的 `PdfRenderConfig` 调用 native `pixels_to_points` 取得仿射基，提供页面点与左上角原点 normalized 坐标双向转换。CropBox、页面旋转与 raster 缩放统一处理，不拼接字符宽度。

`Glyph` 保留原生字符 index、Unicode 文本、UTF-16 范围、native tight bounds 和文字角度；无法取得 bbox 的字符保留文本且 bbox 为 None，不伪造矩形。`PageRaster` 提供文本、glyph 与几何；UI 上传纹理后不再保留重复的 CPU 像素。RM26 必须复用这些坐标，并绑定当前 scope/hash；尚未实现用户文字选择、搜索、高亮或批注。

## Native 安装与 ABI

绑定固定 `pdfium-render 0.8.35`、`pdfium_7350,sync`（含 thread_safe），`libloading 0.8.9`；桌面默认开启 media，`--no-default-features` 保留显式不可用提示。

`apps/desktop-rust/native/pdfium.json` 固定五个 no-V8 归档及各动态库 SHA-256。安装脚本校验归档大小与摘要，并保留 `LICENSE`、第三方 notices、VERSION 和来源清单；运行时再次验证 VERSION build=7350 与编译时清单的动态库摘要，然后解析绑定符号。不搜索系统 PDF 库，不从当前工作目录猜测库。

```sh
python3 scripts/install-pdfium.py --output "$PWD/tmp/pdfium"
export ANYNOTE_PDFIUM_DIR="$PWD/tmp/pdfium"
```

离线可加 `--archive /absolute/path/pdfium-mac-arm64.tgz`，仍验证相同 pin。输出目录必须不存在。开发目录必须使用绝对路径。未设置环境变量时，macOS 在可执行文件相邻的 `../Resources/pdfium` 读取，Linux/Windows 在 `pdfium` 子目录读取；Windows 归档 DLL 位于 `bin/pdfium.dll`。

这次五个平台归档均实际下载并验证摘要，只有 macOS arm64 实际装载、解析和渲染。Linux/macOS x64/Windows 的 ABI、字体和显示仍归 RM32；签名、包内布局、更新后的漏洞版本与最终重分发清单归 RM36。锁定 7350 是复现基线，不代表生产安全准入。没有采用 WebView 后备，也不新增 RM27 依赖。

## 验证与复现

2026-11-09：macOS 26.2 arm64，Rust 1.99.1，`b23aa64` 工作树。

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo clippy -p anynote-desktop --no-default-features --lib --locked -- -D warnings
cargo test -p anynote-desktop --all-features --test pdf --test pdf_backend --test pdf_ui --test image_backend --test image_ui --locked
TMPDIR=/private/tmp cargo test --workspace --all-features --locked
python3 scripts/check-rust-workspace.py
cargo build -p anynote-desktop --bin anynote-desktop --example pdf_probe --locked
cargo run -p anynote-desktop --example pdf_probe --locked
```

上述 native 测试需先设置 `ANYNOTE_PDFIUM_DIR`。Linux CI 已加入锁定库安装步骤；本次没有远端 CI 运行证据。

- 4 项原生测试覆盖 0/90/180/270°、非零 CropBox、Helvetica/Times/CJK、倾斜文字、glyph 黑色像素命中、红色图形坐标、normalized 逆变换与主图/缩略图一致性、UTF-16 范围、密码、损坏文件、页越界及取消。100 MiB 稀疏 PDF 的未引用 stream 不被解码，原生读取量小于 1 MiB；这不是完整进程性能验收。
- 2 项真实后端测试覆盖 PDF snapshot、修订授权、范围、越界、取消、失效 token、密码重试、最后请求获胜、关闭与连续 20 次租约释放。
- 2 项生产视图 UI integration tests 覆盖连续下一页、键盘到末页、输入跳页、连续帧稳定性、适宽/缩放、按需缩略图、关闭时迟到结果、错误密码及 DocumentEditor 入口；另 4 项既有图片后端/视图测试通过。
- 完整工作区 313 passed / 0 failed，3 个 ignored 是既有显式调用的子进程 fixture。首次遇默认临时目录 SUN_LEN，改短目录后遇沙箱 socket EPERM；允许本机 IPC 后整套通过。fmt、全 features Clippy、无 media Clippy 和依赖边界通过（5 工程 / 844 包）。最终适配层小改后另复跑上述 PDF/图片 12 项与 Clippy。
- 原生 `pdf_probe` 使用临时 SQLite/CAS 和真实子进程，实际 macOS 窗口检查了首屏、中文/混合字体、五页缩略图与第 2 页旋转显示；AX 可见页码、页面和各按钮。截图在 `tmp/rm25/window-rotated.png`。裸二进制最初在沙箱中因系统剪贴板服务不可用退出，隔离 `.app` 正常运行。该 probe 不是签名发行包或三平台验收。

语料：`tests/fixtures/pdf/geometry.pdf` / `encrypted.pdf` 由 `scripts/pdf-fixtures.py` 使用 reportlab 4.4.5、pypdf 6.1.1 生成；解锁测试密码为 `rm25-test`。保留 RM01 的 `three-pages.pdf`，并加入 [W3C 公开 Dummy PDF](https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf)，断言实际文字 `Dummy PDF file`。生成器只用于测试，不进入产品依赖。临时日志、安装产物、截图和大 PDF 均放 `tmp/rm25/`。

本组仅交付 E7 的原生引擎与页面/几何前段，不关闭 RM26、RM32/36 或任何 V/A/F 真实验收项。
