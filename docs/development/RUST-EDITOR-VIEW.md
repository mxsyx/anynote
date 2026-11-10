# Rust 连续编辑视图（RM18）

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 入口与所有权

`cargo run -p anynote-desktop --locked` 启动后选择“新建笔记…”或“继续编辑…”。RM19 已接独立目录的持久笔记和 `DocumentSession`；`DocumentEditor::new` 仍可作为不持久化的测试宿主。保存、源码及生命周期契约见 [RM19](RUST-DOCUMENT-SESSION.md)。

实现位于 `apps/desktop-rust/src/document_editor/`：

- `state.rs`：复用 RM16 `Editor` 的文档、source selection、事务、composition 和唯一撤销历史；将正文命令映射到 RM17。
- `projection.rs`：将结构树展平为可虚拟化的段落、列表行、表格行和 atom，映射解码后的正文 UTF-8 与源 Markdown。实体、CRLF、marks、代码和 opaque 块均有独立边界。
- `element.rs`：Kit `editor_host` 内容承载、prepaint 几何、命中、光标/选择绘制、键盘和指针输入。
- `input.rs`：`EntityInputHandler` 的 surrounding text、UTF-16/UTF-8、marked range、组合提交/取消与候选窗落点。
- `accessibility.rs`：按模型生成段落/标题及 table/row/header/cell/TextRun 语义，包括未渲染单元格；将读屏选择回映到正文位置。
- `mod.rs`：实体、Kit 控件、菜单/浮条、源码原型、剪贴板及视图组合；`tests.rs` 为纯状态及 GPUI 行为测试。

没有第二套保存器或 JS 编辑器。新增桌面对已锁定 `markdown = 1.0.0`、`unicode-segmentation = 1.13.3` 的直接依赖；Kit/GPUI 版本未升级；RM19 随后启用 Kit 的 Markdown 高亮特性。

## 交互契约

连续正文直接接受原生输入。标题、段落、列表/引用、任务、代码、表格单元格和原文 atom 使用同一 source/history；并非在预览下放置输入框。Kit 提供排版与控件，宿主负责可编辑行为。

标题/引用/列表前缀、slash、插入菜单、工具条、选区浮条和快捷键共用 `RunCommand`。支持 marks/link、任务勾选、表格行列/Tab/TSV、段落替换、块移动、撤销/重做、搜索和原文入口。正文跨普通顶层段落替换为一笔事务；opaque 保留原始字节，可整块复制、移动、删除或进入原文。块拖放携带宿主 entity 与 generation，拒绝跨文档及过期拖动；块菜单提供键盘可用的上移/下移。

变动源文档后重建投影并保留逻辑滚动锚点。列表/表格按行虚拟化，未测量的屏幕外搜索目标先按行索引滚入，再从下一帧取得几何。几何携带 view revision、rem 和 DPI；光标、命中、选区着色和候选窗使用同一 Kit 叶节点几何。当前 1200 段测试只证明可见几何数量受控与目标滚入，不是输入延迟或内存性能验收。

GFM 没有可重解析为 task 的空 `- [ ] `。空任务意图只存在视图中，首次实际文字或组合提交时一次生成合法任务；取消组合保持空项，第二次 Enter 退出，undo 可取消尚未提交的空任务。不会把占位字符写入 Markdown。空引用复用结构树的虚拟空段落，避免首次输入跑到引用外。

原生 UTF-16 非空范围遇到代理对时向外取整，光标取前一标量边界，超尾范围截至结尾；RM16 对源范围的严格验证不变。组合开始冻结逻辑/源位置，preedit 不改文档或历史；支持 marked 区域内局部替换及选区更新，commit 一笔、cancel 保留 source/redo。越出冻结范围的组合更新明确拒绝。源码 preedit 活跃时阻止模式切换和共享 undo，避免程序化更新丢失未提交文字。

源码二级入口使用 Kit `EditorState`，RM19 将每个 `InputEditsEvent` 的不可变最终 snapshot 映射为一次 core patch，不读取可能已超前的当前值来解释旧范围。程序化 `set_value` 不回发 edits；源码 undo/redo 被路由到同一 RM16 owner。本节记录 RM18 的共享历史与回声抑制证据；完整源码与保存进展见 [RM19](RUST-DOCUMENT-SESSION.md)。

原生剪贴板支持纯文本、应用自身 Markdown 元数据和表格 TSV。复制单一富文本范围会生成平衡的 marks，opaque 复制保留原文；未知外部图片/文件条目显示未接入提示，不假装已创建资源。

内核的配套扩展为：合法空任务物化、前缀转换、文本块类型/代码编辑、顶层跨块替换、平衡片段复制，以及 `RichTyping` 的相邻输入历史合并。插入格式切换打断合并。无效操作继续沿用原子失败语义。

## 验证方法

```sh
mkdir -p tmp/rm18
cargo test -p anynote-desktop --features ui-tests --lib document_editor --offline --locked
TMPDIR="$PWD/tmp" cargo test -p anynote-core -p anynote-editor -p anynote-desktop --features anynote-desktop/ui-tests --offline --locked
cargo clippy -p anynote-core -p anynote-editor -p anynote-desktop --all-targets --features anynote-desktop/ui-tests --offline --locked -- -D warnings
cargo fmt --all --check
python3 scripts/check-rust-workspace.py
```

结果按实际运行记录；设备、云端、性能及最终候选的剩余验收统一见 [TODO](TODO.md)。

## 验收约束

软换行、RTL/BiDi 视觉 affinity、跨行范围矩形、resize/字体变化须有几何断言；单一 index/position 映射不等于完整双向文本几何。复杂选区覆盖跨嵌套结构、跨单元格替换与格式、marks、持续边缘拖选及独立滚动。

平台剪贴板 HTML MIME 经受控转换进入同一事务；native range rectangles、链接/列表/表格语义及真实焦点和读屏单独验收。保存和媒体路径须联合重放文档行为，不能删减旧业务断言以通过测试。剩余工作见 [RM18](TODO.md#rm18)。
