# Rust PDF 引擎与阅读视图

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 所有权与接入

- `apps/desktop-rust/src/pdf/engine.rs` 封装 Pdfium；`NativeDocument` 不暴露原生句柄，打开、页面/文本/渲染和销毁共用操作锁。实际发现 7350 的字体加载在并行用例中触发 `CFX_FontMapper` 原生分配器崩溃；绑定的 `sync/thread_safe` 不足以保护完整调用序列。现在串行化完整操作，空闲文档不占锁，多个阅读会话仍可存在。并行默认测试已通过。
- `worker.rs` 在命名后台线程持有原生文档和受控 reader；单槽请求队列、generation 与关闭标记共同拒绝迟到结果。关闭解除租约、销毁文档；全局 native library 保留至进程退出。
- `view.rs` 的 `PdfView` 持有页码、缩放、输入实体和纹理，复用 Kit Button/Input，支持按钮、Tab 和页面区的左右键/PageUp/PageDown/Home/End、+/−、0、Escape。图像转换也在后台执行。加载状态置于固定高度状态栏，避免改变适页视口；测量同时检查显示缩放变化。页面区支持滚动查看放大后的内容。
- PDF 笔记通过 `OpenDocument` 返回 `DocumentSnapshot.primary_pdf`，`DocumentEditor` 直接打开只读阅读视图，切笔记/释放时关闭旧会话。原文保存接口仍拒绝 PDF，避免把 PDF 笔记当 Markdown 写回。页面/批注回链已接原生窗口；目录与完整历史列表导航仍由 RM28 接线。
- 新增 `anynote-core::asset::{AssetScope, AssetCommand, AssetReply}`，RM25 私有桌面协议为 v3，RM26 增加 PdfCommand/PdfReply 后升为 v4。`asset_reader.rs` 的租约实现由 PDF 与既有 ImageCommand 共用；笔记/修订/资源绑定、CAS hash、文件身份及范围校验继续由 RM04/05 的 `VerifiedAsset` 执行。没有新增表或历史兼容分支；RM26 索引覆盖元数据复用 extension_data。

## 范围读取、预算与取消

PDF 使用 `Read + Seek` 接入原生 custom-file callback，每个后端范围最多 256 KiB。文档字节不全量缓存于 UI/worker；存储层的首次完整性验证可能流式读完整个 CAS 文件，这与原生按需读取/内存预算不同。

当前限制：单 PDF 最大 2 GiB，单页最长边 4096 像素（RGBA 最坏 64 MiB），单页文本最多 100000 glyph；超限显式报错。主页面持有一张纹理和文本几何，打开缩略图后只加载当前五页分组，最多另持有五张 160 像素缩略图。切页/缩放/关闭释放旧纹理；没有全书解码缓存。原生 bitmap、RGBA 转换和 GPU 上传期间有临时副本，不将 64 MiB 宣称为进程峰值内存。

取消会清空排队请求、拒绝旧 generation、在 glyph 遍历和原生渲染前后检查。关闭、索引取消和搜索取消不再中断 `ResourceReader` 的在途 custom-file 回调：锁定 Pdfium 7350 在读取 stream 失败时可能触发 `CPDF_SyntaxParser::ReadStream` 的 CHECK，翻页后立即关闭曾由此触发 SIGTRAP。取消检查保留在打开/解析/渲染操作边界，在途同步读取完成后再释放；不是硬超时隔离。资源读取失败仍具有 sticky 标记，原生返回部分图像也不会发布成功结果。

真实后台断连的 reader 错误已有独立测试，但它不证明原生解析中的真实 IO 失败安全；7350 的同一 CHECK 风险仍须升级原生库或隔离验证，上游对应修复见 [PDFium ReadStream 检查修复](https://pdfium.googlesource.com/pdfium/+/4bd20bd51662ef0ffca72ccd6d1ac41999f2d009)。本次没有改变五平台 pin。用户可重试资源/密码错误；密码只驻留当前进程，不写配置、日志或 IPC。

## 文本与坐标

`PageGeometry` 从与页面 bitmap 完全相同的 `PdfRenderConfig` 调用 native `pixels_to_points` 取得仿射基，提供页面点与左上角原点 normalized 坐标双向转换。CropBox、页面旋转与 raster 缩放统一处理，不拼接字符宽度。

`Glyph` 保留原生字符 index、Unicode 文本、UTF-16 范围、native tight bounds 和文字角度；无法取得 bbox 的字符保留文本且 bbox 为 None，不伪造矩形。`PageRaster` 提供文本、glyph 与几何；UI 上传纹理后不再保留重复的 CPU 像素。RM26 选择、搜索和批注复用这些坐标，并绑定当前 scope/hash。

## 选择、批注与阅读回链

`selection.rs` 按原生 normalized_quad 命中 glyph，保留原生文字顺序与 UTF-16 范围，按相邻几何合并矩形。支持拖选、Cmd/Ctrl+A/C/F、Shift+左右、Escape；批注最多 100 个矩形、引用/内容各 10000 UTF-16。页面只绘制当前 hash 的批注，白色 PDF 页面上的选区使用 Kit info 色、批注使用 warning 色；搜索与批注导航在放大视图中滚动至目标。

`view/interaction.rs` 持有输入实体、选区和可取消工作，`view/controls.rs` 提供搜索/批注工具条与每组 10 条的侧栏。`search.rs` 单独按需提取文字，不渲染整书，最多 500 页 / 4500000 UTF-16 / 1000 命中；达到预算明确提示结果不完整。搜索保留原文偏移，不用大小写转换后的字节位置猜测几何。

`notebook/pdf.rs` 复用既有批注与笔记事务。读写先核对笔记、修订、主资源及 hash；历史修订允许阅读/生成阅读笔记，禁止修改批注和发布索引。旧文件批注保留在侧栏并提示，用户确认重锚定时明确告知沿用原页码/坐标、没有自动文字匹配。文件被替换后，旧 hash 的正文索引与批注从当前 FTS 排除。

阅读笔记保存引用、批注和 `anynote://notebook/UUID/note/UUID#pdf-page-N` 或 `#pdf-annotation-UUID`。编辑器修饰键点击回链通过 OpenDocument 重新解析当前文档，激活已有或新建 PDF 窗口并导航；删除/失效批注显示错误，历史文件批注不静默套用当前页面。复制包含 PDF 和阅读笔记的树时同步映射节点与批注 ID。

## 索引任务与持久化

`index.rs` 在独立线程使用受控 ResourceReader 和 Pdfium 只提取文字，密码仅驻留当前进程。`IndexBuilder` 按页序接受数据，最多 500 页与 4500000 UTF-16，预算包含 `[第 N 页]` 标记；不得截断代理对。完成全量为 complete，触及预算但有文字为 partial，没有可用文字为 scanned；scanned 不推断 OCR 能力或自动运行 OCR。

`backend/pdf_index.rs` 创建真实 TaskHistory 并暂存提取结果，FinishIndex 必须收到全部允许页或显式预算截断。失败、取消、缺页及迟到完成不改 note_text/FTS/覆盖状态。提交先转 Committing，再通过单写队列原子更新三者；提交开始后的取消遵循既有 TooLate 语义。UI 关闭/切换释放提取任务；进程异常退出由既有任务恢复标记 Interrupted。native 同步调用仍不能强制中断。

覆盖元数据保存于 `extension_data(namespace=anynote.pdf.index, key=note.UUID, schema_version=1)`，值绑定 asset hash；数据库 schema v5 不变。完整快照、当前快照和复制保留覆盖状态；当前快照重建 FTS 同时包含当前 hash 的 PDF 提取文本与批注。完整/当前 `.anynote` 归档回读和开放导出的原 PDF 字节、批注 JSON 已验证；开放导出没有将批注烧录进 PDF。

## Native 安装与 ABI

绑定固定 `pdfium-render 0.8.35`、`pdfium_7350,sync`（含 thread_safe），`libloading 0.8.9`；桌面默认开启 media，`--no-default-features` 保留显式不可用提示。

`apps/desktop-rust/native/pdfium.json` 固定五个 no-V8 归档及各动态库 SHA-256。安装脚本校验归档大小与摘要，并保留 `LICENSE`、第三方 notices、VERSION 和来源清单；运行时再次验证 VERSION build=7350 与编译时清单的动态库摘要，然后解析绑定符号。不搜索系统 PDF 库，不从当前工作目录猜测库。

```sh
python3 scripts/install-pdfium.py --output "$PWD/tmp/pdfium"
export ANYNOTE_PDFIUM_DIR="$PWD/tmp/pdfium"
```

离线可加 `--archive /absolute/path/pdfium-mac-arm64.tgz`，仍验证相同 pin。输出目录必须不存在。开发目录必须使用绝对路径。未设置环境变量时，macOS 在可执行文件相邻的 `../Resources/pdfium` 读取，Linux/Windows 在 `pdfium` 子目录读取；Windows 归档 DLL 位于 `bin/pdfium.dll`。

既有验证下载过五个平台归档并验证摘要；macOS arm64 与 RM31 的 Linux x64 均已有实际装载、解析和渲染证据。macOS x64/Windows 的 ABI 及所有平台的完整字体/设备显示仍归 RM32；签名、包内布局、更新后的漏洞版本与最终重分发清单另验。锁定 7350 是复现基线，不代表生产安全准入。没有采用 WebView 后备，也不新增 RM27 依赖。

## 验证方法

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

结果按实际运行记录；设备、云端、性能及最终候选的剩余验收统一见 [TODO](TODO.md)。
