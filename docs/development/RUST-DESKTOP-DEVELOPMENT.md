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

首次下载依赖需要网络。桌面运行不需要 Node、pnpm 或 Python；Python 用于仓库验证和发行脚本，Node/pnpm 用于保留 TS 构建与隔离旧版参考工具。

## 可选的 Relax 测试迭代

[Relax](https://github.com/makepad/relax) 是实验性的 Rust JIT，可用于纯 Rust 核心逻辑的局部测试迭代。函数体修改适合保持 `test --live` 常驻，保存后热更新并重跑受影响测试；类型布局、宏和导入等修改可能需要重启。首次 JIT、无修改重跑和 `relax check` 不保证比 Cargo 快，不能据小范围热更新推断完整桌面的构建收益。

首次准备时，从仓库根目录将工具源码和缓存放入可清理的 `tmp/`。下面固定一个试用版本；升级时重新验证所需目标：

```sh
mkdir -p tmp/relax-evaluation
git clone https://github.com/makepad/relax.git tmp/relax-evaluation/relax
git -C tmp/relax-evaluation/relax checkout 436868926ffae73495a4b1eab8382024368d6663
cargo build --release --manifest-path tmp/relax-evaluation/relax/Cargo.toml -p relax-runner --bin relax
```

从仓库根目录开启独立终端会话：

```sh
relax_bin="$PWD/tmp/relax-evaluation/relax/target/release/relax"
export RELAX_HOME="$PWD/tmp/relax-evaluation/relax-home"
export MAKEPAD_HOME="$PWD/tmp/relax-evaluation/makepad-home"
export CARGO_TARGET_DIR="$PWD/tmp/relax-evaluation/anynote-target"
export RELAX_OFFLINE=1
cd crates/anynote-core
"$relax_bin" test --live anynote-core --lib
```

依赖需先由 `cargo fetch --locked` 准备；保留 Relax 源码目录，其运行时会读取其中的标准库。编辑器可从 `crates/anynote-editor` 运行 `"$relax_bin" test anynote-editor --test text_transactions`，需要保存后重跑时加 `--live`。`--lib` 只覆盖库单元测试，`--test` 只覆盖指定集成测试；live 模式还会跳过未受影响的测试。退出后仍按下文使用 Cargo 执行改动所需验证，发行继续使用 rustc。

桌面的 GTK/WebKit、tree-sitter 等原生依赖需要系统开发库，并要求 Relax 使用 `--allow-c` 调用 Cargo/C 编译器。先确认普通 Cargo 构建通过，再评估桌面 JIT；纯 Rust 测试成功不代表 GPUI 窗口、原生库和桌面热更新已兼容。受限环境若拒绝本地 socket，`relax inspect` 不可用，应以测试输出单独判断已执行范围。

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

Pdfium 版本、平台、下载地址和摘要由 `apps/desktop-rust/native/pdfium.json` 锁定。按 `python3 scripts/install-pdfium.py --help` 的说明安装，测试时设置 `ANYNOTE_PDFIUM_DIR` 指向已校验的对应平台动态库目录。

绑定使用的 ABI 子集不代表其他原生版本可直接替换；更新 pin 后需重跑 IO 失败、字体、装载/渲染与目标平台验证。相关入口为 `apps/desktop-rust/tests/pdf_io.rs`，最终包另按 [发行复核](RUST-RELEASE-ACCEPTANCE.md) 验收。

根 `Cargo.toml` 的 GPUI 路径补丁位于 `vendor/gpui-pre-0.3.11` 和 `vendor/gpui-pre-macos-0.3.11`，提供可取消预退出和结束组合输入接口。升级 Kit/GPUI 时须保留所需接口并重跑生命周期回归；不能直接移除路径补丁。

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
