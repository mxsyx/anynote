# Rust 源码模式与保存会话（RM19）

2026-11-09：RM19.1/.2 已实现，RM19.3 的应用内流程已接线，系统退出与真实输入验收仍未完成。任务状态以 [TODO](TODO.md#rm19) 为准；不关闭 RM18、RM32 或 E5 整体门槛。

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

opaque 块入口定位其源范围，全文原文入口保留源选区方向。无内容变化时恢复各模式自己的滚动位置；内容变化后按当前映射选区滚入。预编辑活跃时拒绝切换、格式或共享撤销，关闭/flush 等待组合提交或取消，预编辑不写数据库。源码视图填满文档剩余高度。

## 保存与恢复

有效 generation 变化启动 **650 ms** 防抖；单纯移动光标不重置计时。Cmd/Ctrl+S、保存按钮、失焦、切换笔记、关窗及应用菜单退出调用同一 flush。已有请求未确认时不能再提交；继续输入保留最新正文，ack 只推进 base revision 和对应 saved generation，随后保存新一批。

保存请求固定 notebook/note、expected revision、head revision、session epoch、generation 和 title/body/tags/favorite。存储核对 revision/head，调用 RM05 CAS，ack 必须匹配请求身份、generation、下一 revision 和内容。过期或其他会话响应不能改当前正文或笔记身份。切换在原会话保存成功且 IME 结束后才建立新会话并重置其历史。

断线、超时或错误后不盲目重放：读取原 notebook/note，只有下一 revision 与待提交内容完全一致才确认原保存成功；权威快照仍等于原 base 时允许用户重试；其他情况保留双方快照并报冲突。明确未提交的失败不自动循环重试。重连先结束旧后端、等待重新取得租约，再核对。界面提供复制草稿、只读查看已保存版本以及“另存草稿”（创建新笔记保存当前正文，RM21 同时复制当前修订图片及待提交资源），不覆盖冲突版本。

`resource_request` 在发起读取时冻结原 note/head revision；后端通过 `ResourceScope::note(...).with_revision(...)` 读取有界资源字节。回调不得重新取当前选中的笔记；RM21 已接入图片媒体 generation、资源批量提交与 hash ack，见[图片契约](RUST-IMAGE-MEDIA.md)；其他媒体仍由对应组接线。

草稿保留指**当前进程内存**，没有跨进程崩溃草稿日志。保存失败或冲突时正常窗口关闭和应用内退出不会继续完成。不可取消的系统终止入口仍有下述缺口。

## 私有协议及依赖

私有协议升到 v2，新增 Create/Open/OpenLast/SaveDocument 和按修订 DocumentResource。serde 强类型及 unknown-fields 拒绝不变。正文的存储预算仍为 2,000,000 UTF-16 单元；为覆盖 JSON 转义后的最大正文，控制帧上限改为 **16 MiB**，仍先校验长度再分配，队列/请求数上限不变。资源单次最多 256 KiB。runtime state 单条 1 MiB 的限制不变，正文不进入该库。

新增锁定包：tree-sitter 0.26.13（MIT）、tree-sitter-md 0.5.4（MIT）、tree-sitter-json 0.24.8（MIT，Kit feature 的共同依赖）、tree-sitter-language 0.1.9（MIT）、streaming-iterator 0.1.9（MIT OR Apache-2.0）。未升级 Kit/GPUI 或增加 crate。完整依赖和许可证以 Cargo.lock 与依赖清单脚本为准。

## 验证与剩余门槛

本机 macOS / Rust 1.99.1，合成语料、隔离 Notebook 和真实后端子进程：

```sh
TMPDIR=/private/tmp cargo test -p anynote-desktop -p anynote-editor -p anynote-core --features anynote-desktop/ui-tests --locked --offline
cargo clippy -p anynote-desktop -p anynote-editor -p anynote-core --all-targets --features anynote-desktop/ui-tests --locked --offline -- -D warnings
cargo fmt --all -- --check
python3 scripts/check-rust-workspace.py
```

联合回归 **118 项通过**，另有 1 项由父测试调用的 ignored 子进程夹具。包含新增 4 项保存状态测试、5 项 GPUI 测试、2 项真实后端测试：650 ms 边界/串行及迟到 ack、保存中输入、失联核对、冲突和未提交重试、源码批量替换单步撤销/反向选区/退出控件的迟到事件隔离、视口高度/Markdown 折叠候选/滚动恢复、IME 阻止关闭、切笔记屏障，以及丢弃保存响应后原笔记重开、超过旧控制帧预算的 Unicode/CRLF 正文、历史资源不漂移/跨笔记拒绝。原有内核、平台壳和 IPC 回归保持通过。Clippy、rustfmt、依赖边界（5 工程 / 844 包）通过。

macOS 默认临时目录使既有平台 socket 用例超过 SUN_LEN，改用短 TMPDIR；沙箱随后拒绝 socket，获准在沙箱外重跑通过。新后端测试目录先 canonicalize，复用 RM05 的严格路径契约，不放宽存储校验。原始日志在可删除的 `tmp/rm19/`。

原生 UI 实际打开隔离测试壳、新建持久笔记并切到源码模式，观察到行号和保存状态；发现单行高度后补上视口布局回归。后续输入操作先报应用状态变化、再报 `timeoutReached`，未完成可归因的输入→关闭→重开验证，不能用截图宣称真实保存/输入法通过。

剩余：锁定 GPUI 的 `App::on_app_quit` 明确不可取消，平台 `on_quit` 直接 shutdown；系统 Dock/OS 退出无法复用可失败留窗的应用内屏障，需 Kit 平台预退出接口。尚未取得请求 OS 结束组合输入的公开接口，目前只能等待平台 commit/cancel 并保留窗口；真实 IME、系统退出、读屏及跨平台生命周期继续验收。RM18 未完成的几何/输入缺口不因本组测试关闭；没有真实云、媒体保存、性能或发行验收结论。
