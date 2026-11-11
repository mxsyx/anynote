# Rust 结构编辑内核

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 所有权与调用

`anynote-editor::structure` 只准备 `Transaction`。`transaction::Editor` 仍独占正文、generation、选区、composition 和唯一 undo/redo；调用方通过 `Editor::apply` 一次提交。结构操作不创建另一份持久 AST、历史、保存者或资源服务，不依赖 GPUI、数据库、网络或平台剪贴板。

`Structure::for_block(document, id)` 取得一个可富编辑块的临时投影；`for_blocks(document, first, last)` 取得连续顶层块，允许混合不可编辑 atom；`at_caret(document, selection)` 在空文档、块边界或空白分隔中创建新的段落落点。其 `root()` 是合成 `Root`，路径均从它开始：单段是 `[0]`，列表第二项正文是 `[0, 1, 0]`，表格第二行第三格是 `[0, 1, 2]`。路径是当前 generation 的位置，不是持久 ID。

```rust
use anynote_editor::{
    structure::Structure,
    selection::TextUnit,
    transaction::Editor,
};

fn insert_table(editor: &mut Editor) {
    let id = editor.document().blocks()[0].id();
    let structure = Structure::for_block(editor.document(), id).unwrap();
    let transaction = structure
        .insert_table(&[0], 0..0, TextUnit::Utf8, (3, 2), 0)
        .unwrap();
    editor.apply(transaction).unwrap();
}
```

实际宿主须处理结果，示例的 unwrap 只展示接线。交易冻结 base generation/expected bytes；过期交易或 composition 活跃时，`Editor::apply` 拒绝且保留原正文与历史。提交后重新获取投影、BlockId 和路径；移动、拆分、合并及相邻块边界重解析可能产生新 ID，不能将旧路径/ID 当作新布局坐标。返回的源选区和新 generation 是重新定位入口。

## 命令覆盖

| 范围           | 入口与语义                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 段落/标题      | `split` 按解码文本的 UTF-8/UTF-16/grapheme 位置拆分，保留两侧 marks/link；`join` 合并前一同级段落或列表，选区落在连接点                                                                                                                |
| 列表           | `set_list` 创建/转换无序、有序、任务列表；`split_item` 拆项并将新任务重置为未勾选；空项 Enter 调用退出；`indent` 缩进到前一项；`outdent` 提升一层，外层退出时分开前后列表并保留嵌套内容；`set_checked` 修改任务状态                    |
| 引用           | `set_quote` 包裹/解除引用，可包含列表、代码和表格；不把 opaque payload 当普通内容重写                                                                                                                                                  |
| 富/纯文本粘贴  | `paste` 处理 Markdown 多段、嵌套列表/引用、表格和顶层 opaque/directive，保留原选区两侧 marks；`paste_plain` 对字面文本编码，空行分段，星号/列表标记不会成为命令；`paste_blocks` 在块边界或整块选区粘贴原文                             |
| 表格           | `insert_table` 在段落内选区插入表格并保留两侧正文，当前入口使用 `(3, 2)`；`create_table` 是显式替换目标块，不能用来替代光标插入；`replace_text` 编辑含空格在内的单元格逻辑文字                                                         |
| 表格导航       | `CellAddress` 用零起点行/列；`adjacent_cell` 支持前后/上下；`tab` 普通跳格只改选区，末格 Tab 新增一行并形成一个撤销单元；首格 Shift-Tab 返回边界错误，由 RM18 决定移出表格                                                             |
| 行列和矩阵     | `insert_row/delete_row/insert_column/delete_column` 保持矩阵，删表头后首行成为表头，删除最后一行/列后留下空段落落点；`paste_cells` 接矩形字面文本数组，按需扩行/列，一次提交                                                           |
| 选择/atom/移动 | `select_nodes`、`cell_selection`、`block_selection` 返回带 generation 的源选区，支持反向及跨块/跨单元格范围；`atom_position` 给出 opaque/directive/分隔线前后 affinity；`move_blocks` 移动连续顶层块；`delete_blocks` 显式删除整块选区 |

细粒度的行内 marks/link 继续复用 RM16 `InlineContent`；结构内的 `replace_text` 复用同一 runs 编码器。没有新增表格合并、rowspan/colspan 或复杂单元格矩形选择状态。`select_nodes` 是节点范围选择，字符级命中和方向键几何由 RM18 映射到 RM16 `Selection`。

## 序列化与安全边界

结构命令重建受影响顶层块/所选连续块的 Markdown，历史只记录该范围前后共同前缀/后缀之外的字节差异。未触及的正文与分隔不重新打印；转换块所属的行首缩进纳入编辑范围。新语法沿用所在位置换行风格，代码逻辑行统一后再输出本地换行，code fence 长度避开正文冲突。列表、引用嵌套使用实际容器缩进；相邻独立列表交替使用等价标记，避免空退出段落没有 Markdown 节点时被自动合并。

提交前先重解析局部序列化结果并比较结构、文字、marks、links、任务和表格语义，再在完整源文中检查相邻块没有被 fence/list/reference 吞并。GFM 列表对尾部空白的 span 归属会随上下文变化，检查允许尾部空白归属变化，源 splice 仍保持未编辑字节。缺少必要空行的边界在改动范围内补齐。块移动保留 payload 原文，分隔位置必要时增加空行。

短表格行补齐逻辑空格；多余单元格扩展逻辑列宽，编辑时补齐其他行，不能直接丢弃额外文字。未物化的空格没有独立源 span，导航以该行末尾作为临时源落点，宿主应继续持有当前 `CellAddress`；后续单元格编辑会物化完整矩阵。空段落在 Markdown 中没有持久节点，末段拆分/退出或删空表格后以源选区落点表达，RM18 需投影可输入的空段落，不新增私有占位字符。

RM15 的脚注、转义、HTML、引用、对齐表格、代码 meta、复杂/超预算等边界不变。不可富编辑块按 atom 边界复制、移动、删除或整块替换，未知 JSON、资源 URI、版本及原文不经 JSON 再序列化。将 unclosed fence 移到会吞并后文的位置、把原始 directive 塞入会改变它含义的嵌套容器、或产生无法保持块语义的拼接时返回 `SemanticMismatch`，不部分提交、不修改原文来猜测修复。原始源码编辑仍走 RM16；这种拒绝不是将原本支持的整个结构类型降级为仅源码。

超过 500000 UTF-16/5000 节点等富编辑预算的结构输出返回 `Budget`，不截断正文，也不无声生成新的 opaque 大块。表格维度在分配前做溢出/节点预算检查。结构命令使用独立历史单位，不与相邻普通输入合并；无语义变化的勾选/引用设置保留原始拼写且不增加历史。

## 跨结构范围与富片段

`replace_between`、`paste_between` 和 `copy_between` 使用同一组版本内叶节点路径及 UTF-8 端点。文字端点保留选区外 runs；atom/分隔线端点只允许 U+FFFC 两侧，原始内容整块保留或替换。`with_blank_boundary` 仅接受所选块外的空白源间隔，把没有持久 Markdown 节点的段落纳入当前事务，不写占位符。

`copy_between` 生成平衡容器与 marks，部分表格只保留选中的单元格文字，其他格清空。`paste_between` 先在临时结构中裁剪范围，再插入富片段，最终只调用一次 `finish`；所有准备失败都保留原文、选区及 redo。单元格富文本保留 marks，表格矩阵复用 `paste_cells` 的矩形扩容与预算检查，被矩阵覆盖的结束单元格未选后缀移到片段末尾；不支持的嵌套块原子拒绝。opaque 片段进入列表/引用时拆分周围容器，将原文保持在顶层，避免缩进改变解析分类。

## 验证方法

```sh
cargo test -p anynote-core -p anynote-editor --offline --locked
cargo clippy -p anynote-core -p anynote-editor --all-targets --offline --locked -- -D warnings
python3 scripts/check-rust-workspace.py
```

结果按实际运行记录；设备、云端、性能及最终候选的剩余验收统一见 [TODO](TODO.md)。
