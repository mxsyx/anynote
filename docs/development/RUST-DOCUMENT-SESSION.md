# Rust 源码模式与保存会话（RM19）

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 入口与所有权

平台检查壳提供“新建笔记…”和“继续编辑…”。笔记在 Rust 独立状态目录的 `workspace/` 下创建，默认 Notebook ID 记录于 `document.default.notebook`，最近打开的身份记录于 `document.last.identity`。环境变量 `ANYNOTE_RUST_STATE_DIR` 可指定隔离目录；未接管旧资料，目录/书橱导航仍归 RM28。重复打开同一笔记激活已有窗口。

- `document_editor/state.rs::DocumentSession` 持有唯一 RM16 `Editor`、选区、composition、派生投影及保存控制器。正文和撤销历史只有一个所有者。
- `source_mode.rs` 按需创建 Kit `EditorState`，提供 Markdown 高亮、行号、折叠、内置搜索替换和格式包裹。启用锁定 Kit 0.9.0 的 Markdown / inline grammar，不新建源码编辑器。
- `session.rs::SaveController` 只拥有已确认的数据库快照、发送中的不可变快照、generation/epoch、保存状态和冲突版本；不拥有第二个当前正文。
- `saving.rs` 负责 GPUI debounce/异步请求、失焦和窗口关闭、应用内退出、切换屏障、重连与草稿恢复入口。`from_snapshot` / `switch_document` / `resource_request` 是后续工作区和媒体接入点。
- `document_store.rs` 只在后端实例化 RM05 `WriteQueue`，所有笔记/资源操作通过同一 FIFO/写租约；等待 ticket 在后台，GPUI 不读写 SQLite。

标题、标签和收藏沿用打开时的权威值，正文 H1 不改变标题。界面当前只编辑正文；新增元数据 UI 需接入同一 dirty/save owner。

## 源码与历史

每次 `InputEditsEvent` 使用该批次不可变最终快照，计算合法 UTF-8 边界上的最小共同前后缀，一笔事务提交变化范围；替换全部和多光标批次不会拆成多个撤销步骤。切换退出前先提交仍在排队的控件快照，再按控件 entity 身份拒绝迟到事件。程序化 `set_value` 不回发编辑事件，所有用户 Undo/Redo 路由到 RM16。工具条格式包裹同样走 core patch。

opaque 块入口定位其源范围，全文原文入口保留源选区方向。无内容变化时恢复各模式自己的滚动位置；内容变化后按当前映射选区滚入。预编辑活跃时拒绝切换、格式或共享撤销，macOS 关窗/退出主动请求结束当前组合输入，普通 flush 仍等待提交或取消；预编辑不写数据库。源码视图填满文档剩余高度。

## 保存与恢复

有效 generation 变化启动 **650 ms** 防抖；单纯移动光标不重置计时。Cmd/Ctrl+S、保存按钮、失焦、切换笔记、关窗及应用菜单退出调用同一 flush。已有请求未确认时不能再提交；继续输入保留最新正文，ack 只推进 base revision 和对应 saved generation，随后保存新一批。

保存请求固定 notebook/note、expected revision、head revision、session epoch、generation 和 title/body/tags/favorite。存储核对 revision/head，调用 RM05 CAS，ack 必须匹配请求身份、generation、下一 revision 和内容。过期或其他会话响应不能改当前正文或笔记身份。切换在原会话保存成功且 IME 结束后才建立新会话并重置其历史。

断线、超时或错误后不盲目重放：读取原 notebook/note，只有下一 revision 与待提交内容完全一致才确认原保存成功；权威快照仍等于原 base 时允许用户重试；其他情况保留双方快照并报冲突。明确未提交的失败不自动循环重试。重连先结束旧后端、等待重新取得租约，再核对。界面提供复制草稿、只读查看已保存版本以及“另存草稿”（创建新笔记保存当前正文，RM21 同时复制当前修订图片及待提交资源），不覆盖冲突版本。

`resource_request` 在发起读取时冻结原 note/head revision；后端通过 `ResourceScope::note(...).with_revision(...)` 读取有界资源字节。回调不得重新取当前选中的笔记；RM21 已接入图片媒体 generation、资源批量提交与 hash ack，见[图片契约](RUST-IMAGE-MEDIA.md)；其他媒体仍由对应组接线。

草稿保留指**当前进程内存**，没有跨进程崩溃草稿日志。保存失败或冲突时正常窗口关闭、应用内退出及 macOS 可取消的系统退出不会继续完成。强制退出、崩溃或断电不在此保存保证内。

## F002 系统退出与输入结束

macOS 上 `BackendSession` 注册 `App::on_quit_requested`（其他适配仍在不可取消阶段通知退出，暂不挂接该拦截器，以免阻断既有清理）。首次系统请求返回拒绝并启动原有 flush；重复请求不启动第二条保存/排空链路。只有所有文档完成保存且后端排空结束，`quit_ready` 才允许下一次平台退出。保存失败、冲突或后端 Busy 取消本次退出，同时清除仍存活文档的 `closing` 意图，用户可以继续编辑、复制草稿或重连重试。

macOS 的适配从 `applicationWillTerminate:` 移到 `applicationShouldTerminate:`，返回 `NSTerminateCancel` 或 `NSTerminateNow`。可取消检查发生在 GPUI 清除窗口和调用不可取消的 `on_app_quit` 之前；应用菜单、Dock 和系统终止请求共享此原生入口。异步保存期间不阻塞 AppKit 主线程。

`Window::finish_composition` / `PlatformWindow::finish_composition` 是异步请求：macOS 在前台执行器释放 App/实体借用后，调用当前输入 owner 的 `unmark_text` 提交显示中的预编辑，再通知原生 `NSTextInputContext` 丢弃候选会话。关闭的原生窗口不再访问。保存仍以 marked range 实际消失为屏障。源码控件结束组合时可能没有新的 `InputEditsEvent`，因此保存前同步其最终快照；失败时标为保存错误并保留控件内容。

当前原生实现及设备验证范围为 **macOS**。测试平台提供合成的结束输入适配；其他平台默认返回不支持并保留组合输入，不伪造原生提交。Windows/Linux 的可取消系统预退出和原生组合输入结束适配仍是 F002 实现缺口；完成后再进入 F025 的三平台实际 IME、候选窗、注销/关机交互验收，不能把本次 macOS 结果扩展为三平台功能完成或验收。

### 锁定依赖补丁

Kit 保持 0.9.0，GPUI 原生系列保持 0.3.11。根 `Cargo.toml` 通过 `[patch.crates-io]` 使用仓库 `vendor/gpui-pre-0.3.11` 和 `vendor/gpui-pre-macos-0.3.11`；没有修改机器的 Cargo registry。两份原始发布包及 Apache-2.0 许可证随源码保留，源包 checksum 分别为 `9303c771abf2acff2a96d706f69d9a82088c4770173a07cce88f0002431d887d`、`d7410cfdaa1fa55a414346cc492d18ce340e3a8b6d0ac3213b984ed690c82b92`。

相对发布包只修改六个文件：核心 `src/app.rs`、`src/window.rs`、`src/platform.rs`、`src/platform/test/window.rs`，以及 macOS `src/platform.rs`、`src/window.rs`。分别提供可取消预退出、异步结束组合输入、合成适配及 AppKit 接线；其余依赖源码保持发布包原样。后续升级 Kit 时必须重放这些接口和生命周期回归，不能直接删除路径补丁。

### 本轮验收（2026-11-11）

- 自动化：4 项 `document_lifecycle` 回归覆盖重复预退出、保存完成后才停后端、跨进程重开、CAS 冲突留窗留草稿留连接；新增源码组合输入关闭测试通过。编辑器相关筛选共 52 项通过（含新增源码测试）。
- macOS 26.2 原生窗口：使用独立 `tmp/f002-native/state`，实际键盘输入 `F002 native close reopen 7319` 后点关窗，重开快照包含该文本；再输入 `native quit 8421` 并经 `cx.quit` 进入 AppKit 系统退出，重开快照包含新增文本。
- 原生故障恢复：探针在打开快照后断开测试后端，输入 `fault9532`，系统退出被取消且窗口保留；继续输入 `after-cancel` 可进入同一会话。Cmd+S 重连保存后再次退出，重开持久化快照包含两段草稿。探针的系统退出入口不调用应用 `request_quit`，故实际经过平台预退出钩子。
- 设备输入是已提交的键盘文本；合成 marked-text 测试不等于真实中日韩 IME 候选窗通过。Dock 的独立菜单操作、真实 OS 注销/关机和跨平台设备矩阵仍归 F025。

原生复现使用 `apps/desktop-rust/examples/document_lifecycle_probe.rs`，需显式传入 `ANYNOTE_LIFECYCLE_STATE_DIR`（隔离目录）和 `ANYNOTE_LIFECYCLE_BACKEND`（桌面后端可执行文件）。设置 `ANYNOTE_LIFECYCLE_DISCONNECT=1` 可验证断线留窗；`opened.md`、`observed.md` 只用于该探针检查，不是产品草稿日志。临时日志和原生验证副本位于 `tmp/f002-*`，以上结论不依赖这些文件长期保存。

## 私有协议及依赖

私有协议升到 v2，新增 Create/Open/OpenLast/SaveDocument 和按修订 DocumentResource。serde 强类型及 unknown-fields 拒绝不变。正文的存储预算仍为 2,000,000 UTF-16 单元；为覆盖 JSON 转义后的最大正文，控制帧上限改为 **16 MiB**，仍先校验长度再分配，队列/请求数上限不变。资源单次最多 256 KiB。runtime state 单条 1 MiB 的限制不变，正文不进入该库。

新增锁定包：tree-sitter 0.26.13（MIT）、tree-sitter-md 0.5.4（MIT）、tree-sitter-json 0.24.8（MIT，Kit feature 的共同依赖）、tree-sitter-language 0.1.9（MIT）、streaming-iterator 0.1.9（MIT OR Apache-2.0）。未升级 Kit/GPUI 或增加 crate。完整依赖和许可证以 Cargo.lock 与依赖清单脚本为准。

## 验证方法

```sh
TMPDIR=/private/tmp cargo test -p anynote-desktop -p anynote-editor -p anynote-core --features anynote-desktop/ui-tests --locked --offline
cargo clippy -p anynote-desktop -p anynote-editor -p anynote-core --all-targets --features anynote-desktop/ui-tests --locked --offline -- -D warnings
cargo fmt --all -- --check
python3 scripts/check-rust-workspace.py
```

结果按实际运行记录；设备、云端、性能及最终候选的剩余验收统一见 [TODO](TODO.md)。
