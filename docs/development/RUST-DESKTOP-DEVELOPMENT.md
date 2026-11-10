# Rust 桌面开发入口

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 工程边界

| 工程               | 目录                      | 当前责任 / 后续入口                                                                                                         |
| ------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `anynote-desktop`  | `apps/desktop-rust`       | Kit 原生窗口、菜单/Actions、输入、动态 Dialog、文件选择、单实例及平台探针；媒体可选依赖在此锁定                             |
| `anynote-core`     | `crates/anynote-core`     | 无 GPUI/数据库/网络依赖；`environment` 保留电量、在线、计费网络和恢复事件的数据接口                                         |
| `anynote-storage`  | `crates/anynote-storage`  | SQLite 依赖及编译能力测试；schema/资源读写交 RM04/05                                                                        |
| `anynote-services` | `crates/anynote-services` | 任务历史、资源租约、调度许可与诊断；后端进程装配在 desktop                                                                  |
| `anynote-editor`   | `crates/anynote-editor`   | 纯 Rust `model/source` 原文模型与局部 serializer（RM15）；`board` 白板 scene/操作原型（RM22 部分）；正文事务/视图交 RM16–19 |

不增加第六个 crate。`scripts/check-rust-workspace.py` 检查五个单元、内部依赖方向、Kit/GPUI 版本和禁止的 JS 宿主；使用 Cargo 实际激活的依赖树区分 optional 候选和编译闭包。Cargo metadata 中未激活的 `gpui-fast` 弱可选边不能作为运行依赖判断依据。

## 构建与启动

Rust 固定为 `rust-toolchain.toml` 中的 **1.99.1**，同时安装 rustfmt/clippy。`Cargo.lock` 必须提交，日常构建使用 `--locked`。

```sh
rustup show
cargo fetch --locked
python3 scripts/check-rust-workspace.py
cargo run -p anynote-desktop --locked
```

首次下载需要网络。启动 Rust 二进制不需要 Node、pnpm 或 Python；Python 仅用于仓库验证脚本。退出 Rust 壳不会修改旧 Electron 数据。

Linux 需图形会话及可用 Vulkan 驱动；编译依赖参见 [Kit 安装说明](https://gpui-kit.com/docs/installation/)。本机 Fedora 44 使用：

```sh
sudo dnf install clang cmake fontconfig-devel wayland-devel libxkbcommon-x11-devel libX11-devel libxcb-devel openssl-devel libzstd-devel vulkan-loader-devel
```

Ubuntu 24.04 的开发包和检查入口写在 `.github/workflows/rust.yml`。该工作流仅为 Linux 开发基线，尚未在托管 CI 执行，不代表 RM36 原生发行 CI 已完成。macOS/Windows 需各自原生 SDK/编译器，交 RM32/36 实测。

## Markdown 内核（RM15）

`anynote-core::protocol::markdown` 提供 fence-aware directive 源范围和 JSON 投影；`protocol::rich` 保留现有 CommonMark/GFM 富编辑安全边界。`anynote-editor::model::Document` 持有唯一源文、BlockId、全文 source segments 与派生树；`source::SourceEdit` 在 generation/原文前置条件通过后只替换指定 UTF-8 范围，`ChangeMap` 映射其余源位置。块内位置也是 UTF-8 字节，UTF-16/grapheme 选区与事务见 [RM16 输入内核](RUST-EDITOR-TRANSACTIONS.md)；MarkdownNode 的内部位置相对于 `Content::Markdown::source_base`。BlockId 不写入正文，完整重载产生新会话身份。

`serialize()` 返回权威原文；不运行全文格式化。`set_directive_field` 只更新对象载荷中的指定字段，保留未知字段和数字精度；非法/超解析深度或含孤立 surrogate 的 JSON 保留源码并拒绝字段更新。普通源码替换可修复它们。所有 directive 的媒体/声明块业务编辑仍待 RM20/21；当前 parser 不动态注册插件。每次源编辑先全量重建派生视图以保持跨块 reference/fence 语义，增量优化和性能门槛另验。

```sh
cargo test -p anynote-editor --test markdown_source --offline --locked
cargo clippy -p anynote-core -p anynote-editor --all-targets --offline --locked -- -D warnings
node_modules/.bin/vitest run tests/rust-markdown.test.ts
```

Rust/TS 共读 `tests/fixtures/markdown/rm15.json` 的 54 份语料；Rust 另验证 RM01 冻结 Markdown、未知 JSON/资源、局部字节保留和固定 seed 源编辑不变量。

RM16 已增加 `transaction::Editor` 作为正文/选区/undo/composition 的唯一会话内核，`InlineContent` 提供逻辑文本范围的 marks/link 命令。后续编辑接线遵循[文本事务契约](RUST-EDITOR-TRANSACTIONS.md)，不直接修改已交给 Editor 的 Document 或另建历史。

## 平台壳契约

- 所有窗口用 Kit `open_window` 安装 Root，使用系统主题、语义颜色与 rem 布局；可切换浅/深色、恢复系统主题和调整 12–24 的基准字号。物理窗口默认 800×560、最小 560×420，内容区拥有滚动；这两处窗口尺寸是平台像素边界。
- `Shell` 持有输入 Entity、订阅、文件选择任务；Dialog 草稿在打开时创建，由浮层持有，关闭后释放。取消不改原输入，应用才复制回窗口输入。当前全部为测试文本，不保存笔记。
- 菜单和快捷键使用同一组 Actions，按钮调用同一 owner 方法。macOS 使用系统菜单；Windows/Linux 使用 Kit `AppMenuBar`，为其显式提供高度。编辑菜单复用 Kit 的 Copy/Cut/Paste/Undo 等动作与系统剪贴板，不实现第二套输入引擎。
- `Ctrl/Cmd+O` 选择文件，`Ctrl/Cmd+Shift+E` 编辑测试文本，`Ctrl/Cmd+Shift+T` 切换主题，`Ctrl/Cmd+=/-/0` 缩放，`Ctrl/Cmd+W` 关闭窗口，`Ctrl/Cmd+Q` 退出。Dialog 支持 Escape、Tab、取消/应用按钮。
- 文件选择通过 GPUI `prompt_for_paths`，禁止同时开启多个请求；成功、取消、通道关闭与平台错误均回到可重试状态。Linux 原生选择器依赖 desktop portal；组件测试的模拟选择不证明真实 portal 可用。
- 单实例使用 OS 文件锁与本地 socket/Windows named pipe；第二实例只请求唤醒，不转发任意路径或业务命令，不监听 TCP。只允许锁持有者删除崩溃残留 socket；正常退出唤醒并回收监听线程。锁文件保留，避免删除锁文件后出现双 owner。
- 独立状态目录由 `directories::ProjectDirs("app", "anynote", "anynote-rust")` 确定；探针可用 `ANYNOTE_RUST_STATE_DIR` 指向隔离目录。文件键为 `desktop.instance.lock` / `desktop.instance.sock`。这不是 RM14 的旧用户路径接管，也不是 RM05 的 Notebook 写租约。
- 显式退出模式保留 macOS 关闭最后窗口后继续运行、Dock 激活重建窗口的语义；其他平台最后窗口关闭后退出。macOS 分支尚未真机验证。
- `EnvironmentEvent` 保留 PowerChanged / NetworkChanged / Resumed 接口，未知值为 `None`；恢复事件使睡眠前的观察失效。RM02 未安装真实 OS 电量/网络/恢复订阅，后续调度接线须提供观察来源，不能把未知值当作联网且接电。

## 依赖、native 库与许可证

| 依赖 / native 边界                   | 固定组合与 features                                                                                                                               | 许可证与交付边界                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GPUI Kit / Base / Component / assets | `0.9.0`；顶层仅 `component,assets`，显式关闭默认 features；测试额外 `test-support`                                                                | Apache-2.0；图标资产还须保留分发包内第三方 notices                                                                                                                                                     |
| GPUI 原生系列                        | `gpui-pre* =0.3.11`，由 Kit 引入配套 platform；`gpui-pre-reqwest 0.12.15` 是独立版本的 HTTP 包                                                    | Apache-2.0；平台库启用 font-kit、X11、Wayland、runtime shaders；未启用 `gpui-fast` 或 `gpui-shell`                                                                                                     |
| 系统 WebView                         | `gpui-webview =0.9.0` / `lb-wry =0.53.3`，不启用 inspector                                                                                        | Apache-2.0；macOS WKWebView、Windows WebView2、Linux WebKitGTK/GTK3；实验能力和设备边界见 [RM27 契约](RUST-WEBVIEW-VIDEO.md)                                                                           |
| SQLite                               | `rusqlite 0.37.0`，`bundled,backup`；`libsqlite3-sys 0.35.0` 内置 SQLite **3.50.2**                                                               | Rust 绑定 MIT；SQLite public domain；当前测试只证明 STRICT、FTS5 trigram、Online Backup 编译能力                                                                                                       |
| 图片                                 | `image 0.25.8`，png/jpeg/gif/webp/bmp/ico/tiff                                                                                                    | MIT OR Apache-2.0；media feature 可选，未完成 RM21 格式/像素预算验收                                                                                                                                   |
| SVG                                  | 直接可选 `resvg 0.45.1`，text/system-fonts/memmap-fonts；GPUI 还引入 `resvg 0.46.0`                                                               | MIT OR Apache-2.0；此处不读取用户 SVG，不证明外部资源限制已实现                                                                                                                                        |
| PDF 绑定                             | `pdfium-render 0.8.35`，`pdfium_7350,sync`（含 thread_safe），桌面默认启用 media，无默认 image feature；lock 固定 `libloading 0.8.9`              | MIT OR Apache-2.0；该版绑定对 `libloading = "0"` 的宽范围会误选不兼容的 0.9.0，升级 lock 必须重跑全 features                                                                                           |
| Pdfium native                        | `apps/desktop-rust/native/pdfium.json` 固定 `chromium/7350`、Linux x64 / macOS x64+arm64 / Windows x64+arm64 归档 URL、大小、归档与动态库 SHA-256 | BSD-3-Clause 与其 THIRD_PARTY notices；使用不带 V8 的 `pdfium-*` 资产。RM25 已核验五个平台归档和动态库字节、macOS arm64 装载/渲染；其余平台、漏洞修复版本和随包许可证交 RM32/36，当前 pin 不是生产准入 |
| 文本与字体                           | GPUI 的 `freetype-sys 0.20.1`、`yeslogic-fontconfig-sys 6.0.1`；Linux 系统 FreeType/fontconfig                                                    | 绑定 MIT；FreeType FTL/GPL 双许可，fontconfig MIT；系统字体许可证不由 crate 许可证覆盖                                                                                                                 |
| Linux 窗口与 GPU                     | 系统 Wayland、X11/XCB、xkbcommon、Vulkan loader/驱动；本机 pkg-config：1.26.0 / 1.8.13+1.17.0 / 1.13.1 / 1.4.341                                  | Wayland/X11/XCB/xkbcommon 为 MIT 类许可，Vulkan loader Apache-2.0；驱动和发行打包另核对                                                                                                                |
| macOS / Windows                      | 系统 AppKit/Metal/CoreText 或 Win32/DirectWrite/DirectComposition                                                                                 | 使用目标平台 SDK/运行库条款，ABI 与重分发条件须按目标平台核验                                                                                                                                          |
| TLS native 实现                      | GPUI 间接依赖 `ring 0.17.14`                                                                                                                      | Apache-2.0 AND ISC；没有为 RM02 新建业务网络服务                                                                                                                                                       |
| 单实例和平台目录                     | `interprocess 2.2.3`、`async-channel 2.5.0`、`directories 6.0.0`                                                                                  | MIT OR Apache-2.0；仅本地激活与标准用户目录                                                                                                                                                            |

完整激活包的 name/version/license/source/native-links 清单由 `python3 scripts/check-rust-workspace.py` 重建于 `tmp/rm02/dependency-inventory.json`；清单包含测试及非当前平台依赖，不能视作发行包大小。`Cargo.lock` 保存完整 checksum；该开发清单不替代 RM36 最终二进制/动态库/字体/资产的重分发审计。每次升级应同时核对官方源码及发布记录，并重跑本节测试，尤其 Kit/GPUI 不可单独换版。

## 验证方法

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
cargo build -p anynote-desktop --locked
target/debug/anynote-desktop --platform-probe
```

```sh
xvfb-run -a -s '-screen 0 1280x900x24' python3 scripts/rust-platform-smoke.py
```

结果按实际运行记录；设备、云端、性能及最终候选的剩余验收统一见 [TODO](TODO.md)。

## RM03 后端与公共接入契约

入口为 `apps/desktop-rust/src/backend.rs` 与 `backend_client.rs`；同一二进制的 `--backend` 分支在初始化 GPUI 和单实例窗口服务之前返回。正常桌面由 `BackendSession` 保留客户端，启动/重连在工作线程执行，UI 只调用 `submit` 并 await `RequestHandle::receive`。`receive_blocking` 仅供进程测试和窗口事件循环启动前使用。菜单退出和最后窗口关闭先请求后端排空再退出；OS 强制结束仍按断线恢复，不视作成功。

- 后端拥有一个 Tokio runtime；匿名 stdin/stdout 管道的读写线程各接容量 **16** 的有界队列，满队列等待，客户端普通请求最多 **14** 个，另保留 **2** 个取消/退出控制请求名额（总计 16），`submit` 满额返回 `Busy`。客户端按 deadline 返回 `Timeout`，丢弃随后到达的结果；丢弃等待句柄会撤销等待，不等于撤销业务任务。任务取消使用独立 `CancelTask`。
- 线格式为 `kind:u8 + length:u32 big-endian + body`。kind 1 为最长 **16 MiB** 的 serde JSON（RM19 私有协议 v2，覆盖正文预算的 JSON 转义）；kind 2 为 `headerLength:u32 + StreamHeader JSON + bytes`，header 最长 **512 B**，二进制单块最长 **256 KiB**。先校验长度再分配。未知帧/命令、额外字段、截断帧返回结构化错误并关闭该会话；没有 HTTP/TCP、SQL、任意方法调用或插件命令。
- `anynote_core::backend` 固定 `Request/Command/Reply/ServerMessage/ServiceError`。Ready 给出 `version=1` 与随机 `epoch`；每个请求含同一 epoch 和递增 `request_id`。旧 epoch、重复/倒序 ID 拒绝；客户端按 epoch/ID 配对，仅接受与命令匹配的结果类型。`TaskRecord` 的 ID 不随重启变化，sequence 只递增，过期事件不覆盖当前状态。
- 当前静态命令仅有 Ping、健康检查任务、取消/等待/列举任务、诊断设置/查询/清空/导出、读取/释放资源及 Shutdown。健康检查是可取消的进程连通性任务，最长 60 秒，不是备份、保存或导入实现。后续业务在此枚举中显式加类型并接 services，不增加通用 RPC。
- `anynote_services::tasks::TaskHistory` 是唯一任务历史 owner。最多 **8** 个活动任务、**200** 条历史；状态变更先持久化再回复/发事件。重启把 running/committing 转为 interrupted；已终结任务不能被旧完成事件复活。显式退出取消只读健康任务并发送终态与所有等待结果，最后回复 Ack；处于 committing 时返回 Busy，业务提交接入后须先完成其提交协调，不能用退出取消冒充回滚。
- `RecoveryPolicy` 与 `anynote_core::recovery::reconcile` 冻结断线后的处理规则：已有持久回执的操作先按原 operation ID 查询，明确未提交才允许同 ID 重试；普通保存重新取得相同 Notebook/node 的权威 revision 和正文摘要。只有 revision 已推进且匹配待保存内容才确认成功，否则保留草稿并报冲突。这里不创建业务回执，不读取 Notebook；RM05/06/19 提供真实事务、摘要核对与草稿 UI。
- `anynote_services::resources::Resources` 只接受后端可信字节，不接受前端路径。随机 token 绑定当前后端进程，**60 秒**后失效，最多 **8** 份资源、每份 **4 MiB**。Range 通过 offset/length 拉取，每次最多一块，header 回传 offset/end；消费者只有收到完整声明长度才组装完成。释放、过期或重连均不能继续读取。当前用诊断导出验证二进制链路；RM04/08 大附件与归档接入时扩展为文件/快照租约，不能把完整文件塞进此内存接口。
- `anynote_services::scheduler::background_decision` 复用 core `Environment`，未知电量/网络/计费观察返回等待，恢复事件清除旧观察；没有另建调度器。真实平台订阅、重试策略与备份调度由 RM09/10 接入。

### 持久化与诊断

`anynote_storage::runtime_state::RuntimeState` 只持有独立状态目录中的 `backend.owner.lock` / `backend.state.sqlite`。OS 锁阻止两个后端同时重写任务历史；SQLite FULL 同步事务保存服务记录，单条读取/写入最多 **1 MiB**，数据库限制为 **1024 页**（默认 4 KiB 页约 4 MiB，回滚日志另计）。它不打开 Notebook schema v5，不替代 RM05 的 Notebook 写租约。

存储键为 `tasks.history.v1`、`diagnostics.state.v1`、`diagnostics.damaged.v1`。诊断沿用旧 `off/minimal/full` 级别、最多 **300** 条事件和丢弃计数；minimal 聚合次数并保留异常/生命周期事件，full 保留全部枚举事件，off 停止采样。输入只允许枚举事件/错误码和数值统计，从类型边界排除正文、文件路径、URL、凭据及任意 detail 文本；反序列化拒绝附加字段。

诊断设置与清空先落盘再改变内存；写入失败返回 Storage，不虚报设置成功。普通业务结果不因附属诊断写入失败改报失败，避免诱发重复提交。损坏配置保留首份原始记录到 damaged 键，恢复 minimal；原 Electron `_local/diagnostics.json` 与冻结基线均不读取/覆盖。导出返回短时资源 token，由同一二进制流取回有界 JSON。RM29 接这一服务，不另造日志存储。

### RM03 验证入口

```sh
cargo test -p anynote-core -p anynote-desktop --lib --locked
cargo test -p anynote-services --test runtime -p anynote-desktop --test backend --locked -- --test-threads=1
```

进程测试启动实际 `anynote-desktop --backend`（清除 DISPLAY/WAYLAND_DISPLAY），覆盖并发、背压、超时/取消、流截断、旧会话、强制结束后重连、任务 interrupted、父管道 EOF 与退出排空。服务测试覆盖日志重启/清空/损坏/写失败/千条采样预算、历史修剪、资源 Range/失效与未知环境；客户端单测覆盖旧响应 epoch 和旧事件 sequence。短时 IPC p95 样本重建于 `tmp/rm03/ipc-latency.json`，仅测暖态 debug Ping 往返（含运行状态诊断开销），不代表完整保存提交预算。

这些是 Linux 本地服务与进程证据。真实保存、资源文件/归档、业务长任务、任务管理 UI、macOS/Windows 生命周期及系统强制退出确认分别随 RM04–12/19/29/32 补齐，不改变 V/A/F 或 M1 三平台放行状态。

RM25 原生 PDF 测试需先安装锁定库并设置 `ANYNOTE_PDFIUM_DIR`，见 [PDF 阅读契约与复现](RUST-PDF-READER.md#native-安装与-abi)。
