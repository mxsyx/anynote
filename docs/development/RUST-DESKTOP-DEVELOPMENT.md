# Rust 桌面开发入口

本文提供工具链、构建和验证入口。架构与模块职责见 [桌面设计](../design/RUST-DESKTOP-MIGRATION.md)，当前遗留问题见根目录 [TODO](../../TODO.md)。

## 工具链与构建

Rust 版本以根 `rust-toolchain.toml` 为准，安装 rustfmt/clippy；依赖以 `Cargo.toml` 和 `Cargo.lock` 为准，日常构建使用 `--locked`。

```sh
rustup show
cargo fetch --locked
python3 scripts/check-rust-workspace.py
cargo build -p anynote-desktop --locked
cargo run -p anynote-desktop --locked
```

首次下载依赖需要网络。构建桌面需要 Node.js 24/npm：Cargo 自动按 `apps/desktop-rust/whiteboard/package-lock.json` 构建并内嵌 Excalidraw 资源。桌面运行不需要 Node、pnpm 或 Python；Python 用于仓库验证和发行脚本，pnpm 用于其他保留的 TS 工程。白板职责与验证见[系统白板接入](EXCALIDRAW-WEBVIEW-INTEGRATION.md)。

## 平台依赖与隔离目录

Linux 需要图形会话、可用 Vulkan 驱动及窗口系统开发包。Fedora 安装入口：

```sh
sudo dnf install clang cmake fontconfig-devel wayland-devel libxkbcommon-x11-devel libX11-devel libxcb-devel openssl-devel libzstd-devel vulkan-loader-devel
```

Ubuntu 的开发包清单见 `.github/workflows/rust.yml`；macOS/Windows 使用对应原生 SDK 和编译器。系统 WebView 分别依赖 WKWebView、WebView2 和 WebKitGTK/GTK3，发行环境要求见 [安装说明](../features/NATIVE-INSTALL.md)。

开发和验证使用 `ANYNOTE_RUST_STATE_DIR` 指定隔离状态目录。该目录不代表已接管旧资料；原路径接管和回退的剩余问题见 [F007](../../TODO.md#f007)。原生输入与生命周期探针也只使用隔离资料：

- `apps/desktop-rust/examples/editor_input_probe.rs`：编辑器实际窗口输入、结构、滚动与拖放；可用 `ANYNOTE_INPUT_PROBE_OUTPUT` 将源文本写到 `tmp/`。
- `apps/desktop-rust/examples/document_lifecycle_probe.rs`：关闭、重开、系统退出与断线恢复；显式设置 `ANYNOTE_LIFECYCLE_STATE_DIR` 和 `ANYNOTE_LIFECYCLE_BACKEND`，后者指向桌面后端可执行文件。`ANYNOTE_LIFECYCLE_DISCONNECT=1` 用于断线留窗验证。

探针的合成事件不能代替真实 IME、候选窗、读屏和系统注销/关机验收。

## 原生库与依赖维护

PDF 使用系统 WebView 自带查看器，不再安装或打包 PDFium。`apps/desktop-rust/tests/pdf_webview.rs` 验证真实后台资源读取；`pdf::server` 单元测试验证流式响应、Range 与 URL 撤销。实际 PDF 呈现和交互需运行 `pdf_webview_probe`，不能用 WebView 加载结束事件代替页面可读证明。复现与范围见 [系统 PDF 预览](PDF-SYSTEM-WEBVIEW.md)。

根 `Cargo.toml` 的 GPUI 路径补丁位于 `vendor/gpui-pre-0.3.11` 和 `vendor/gpui-pre-macos-0.3.11`，提供可取消预退出和结束组合输入接口。升级 Kit/GPUI 时须保留所需接口并重跑生命周期回归；不能直接移除路径补丁。

`vendor/gpui-pre-wgpu-0.3.11` 修复 Linux 可变字体字重传递：主字体和中文回退保留字重，字体度量与 Swash 栅格化使用相同的 variation 坐标，不同字重使用独立 FontId。系统 Noto Sans CJK 的默认 `wght=100`，原路径会将请求的 Regular 400 画成 Thin，造成中文笔画过细、发虚。2026-11-14 的固定字体回归在原实现上失败，补丁后通过主字体、中文回退、静态字体切换及度量一致性 4 项测试；覆盖 100%、166.7%、200% 栅格比例。桌面构建、补丁 clippy、工作区边界检查通过；隔离 Xvfb 的实际生产窗口已确认菜单和书橱中文恢复正常笔画。该证据确认字重缺陷，不代表与 GTK 字体渲染完全一致或跨平台视觉验收。运行 `cargo test --locked --offline -p gpui-pre-wgpu --test font_variations`；补丁范围及字体样本来源见 [补丁说明](../../vendor/gpui-pre-wgpu-0.3.11/ANYNOTE-PATCH.md)。

`python3 scripts/check-rust-workspace.py` 检查工程依赖方向、Kit/GPUI 版本及禁止的 JS 宿主，并在 `tmp/rm02/dependency-inventory.json` 生成依赖清单。发行时另核对原生库、字体、资产及第三方许可证；开发依赖清单不等于最终交付清单。

## 验证入口

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
python3 scripts/check-rust-workspace.py
target/debug/anynote-desktop --platform-probe
```

GPUI 测试需要对应平台环境。macOS 的本地 socket 测试可使用较短的 `TMPDIR=/private/tmp`；Linux 的无头冒烟入口为：

```sh
xvfb-run -a -s '-screen 0 1280x900x24' python3 scripts/rust-platform-smoke.py
```

专项回归与预算见 [原生回归](RUST-NATIVE-REGRESSION.md)，真实设备方法见 [设备验收](RUST-DEVICE-ACCEPTANCE.md)，打包命令见 [原生发行](RUST-NATIVE-RELEASE.md)。单次日志、截图和报告写入 `tmp/`；结果按实际运行范围记录。
