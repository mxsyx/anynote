# Rust 连续编辑视图（RM18）

状态：2026-11-09 已落地可运行的原生草稿视图和输入适配，RM18.1–.3 均为部分完成。锁定依赖的几何/剪贴板缺口与尚未接通的行为列在下方；不关闭 E1/E4、M1/M4 或 V/A/F，不替代旧桌面。

## 入口与所有权

`cargo run -p anynote-desktop --locked` 启动后选择“新建草稿…”。窗口标题明确标为“未保存”；这是由调用者传入 Markdown 的临时 `DocumentEditor`，尚未读取笔记或建立保存会话。RM19 继续拥有 DocumentSession、CAS、650ms debounce、切笔记及关闭 flush。

实现位于 `apps/desktop-rust/src/document_editor/`：

- `state.rs`：复用 RM16 `Editor` 的文档、source selection、事务、composition 和唯一撤销历史；将正文命令映射到 RM17。
- `projection.rs`：将结构树展平为可虚拟化的段落、列表行、表格行和 atom，映射解码后的正文 UTF-8 与源 Markdown。实体、CRLF、marks、代码和 opaque 块均有独立边界。
- `element.rs`：Kit `editor_host` 内容承载、prepaint 几何、命中、光标/选择绘制、键盘和指针输入。
- `input.rs`：`EntityInputHandler` 的 surrounding text、UTF-16/UTF-8、marked range、组合提交/取消与候选窗落点。
- `accessibility.rs`：按模型生成段落/标题及 table/row/header/cell/TextRun 语义，包括未渲染单元格；将读屏选择回映到正文位置。
- `mod.rs`：实体、Kit 控件、菜单/浮条、源码原型、剪贴板及视图组合；`tests.rs` 为纯状态及 GPUI 行为测试。

没有第二套保存器或 JS 编辑器。新增桌面对已锁定 `markdown = 1.0.0`、`unicode-segmentation = 1.13.3` 的直接依赖；Kit/GPUI 版本和功能开关未升级。

## 已实现的交互契约

连续正文直接接受原生输入。标题、段落、列表/引用、任务、代码、表格单元格和原文 atom 使用同一 source/history；并非在预览下放置输入框。Kit 提供排版与控件，宿主负责可编辑行为。

标题/引用/列表前缀、slash、插入菜单、工具条、选区浮条和快捷键共用 `RunCommand`。支持 marks/link、任务勾选、表格行列/Tab/TSV、段落替换、块移动、撤销/重做、搜索和原文入口。正文跨普通顶层段落替换为一笔事务；opaque 保留原始字节，可整块复制、移动、删除或进入原文。块拖放携带宿主 entity 与 generation，拒绝跨文档及过期拖动；块菜单提供键盘可用的上移/下移。

变动源文档后重建投影并保留逻辑滚动锚点。列表/表格按行虚拟化，未测量的屏幕外搜索目标先按行索引滚入，再从下一帧取得几何。几何携带 view revision、rem 和 DPI；光标、命中、选区着色和候选窗使用同一 Kit 叶节点几何。当前 1200 段测试只证明可见几何数量受控与目标滚入，不是输入延迟或内存性能验收。

GFM 没有可重解析为 task 的空 `- [ ] `。空任务意图只存在视图中，首次实际文字或组合提交时一次生成合法任务；取消组合保持空项，第二次 Enter 退出，undo 可取消尚未提交的空任务。不会把占位字符写入 Markdown。空引用复用结构树的虚拟空段落，避免首次输入跑到引用外。

原生 UTF-16 非空范围遇到代理对时向外取整，光标取前一标量边界，超尾范围截至结尾；RM16 对源范围的严格验证不变。组合开始冻结逻辑/源位置，preedit 不改文档或历史；支持 marked 区域内局部替换及选区更新，commit 一笔、cancel 保留 source/redo。越出冻结范围的组合更新明确拒绝。源码 preedit 活跃时阻止模式切换和共享 undo，避免程序化更新丢失未提交文字。

源码二级入口使用 Kit `EditorState`，消费 `InputEditsEvent` 的逐步 edit/snapshot，不读取可能已超前的当前值来解释旧范围。程序化 `set_value` 不回发 edits；源码 undo/redo 被路由到同一 RM16 owner。这里只验证共享历史及回声抑制；完整源码查找替换、折叠、选区/滚动恢复和保存生命周期仍归 RM19。

原生剪贴板支持纯文本、应用自身 Markdown 元数据和表格 TSV。复制单一富文本范围会生成平衡的 marks，opaque 复制保留原文；未知外部图片/文件条目显示未接入提示，不假装已创建资源。

内核的配套扩展为：合法空任务物化、前缀转换、文本块类型/代码编辑、顶层跨块替换、平衡片段复制，以及 `RichTyping` 的相邻输入历史合并。插入格式切换打断合并。无效操作继续沿用原子失败语义。

## 验证与复现

macOS、本机锁定 Rust 1.99.1 与 Kit 0.9.0 / GPUI 0.3.11，使用合成文档与隔离临时数据：

```sh
mkdir -p tmp/rm18
cargo test -p anynote-desktop --features ui-tests --lib document_editor --offline --locked
TMPDIR="$PWD/tmp" cargo test -p anynote-core -p anynote-editor -p anynote-desktop --features anynote-desktop/ui-tests --offline --locked
cargo clippy -p anynote-core -p anynote-editor -p anynote-desktop --all-targets --features anynote-desktop/ui-tests --offline --locked -- -D warnings
cargo fmt --all --check
python3 scripts/check-rust-workspace.py
```

16 项编辑器测试包括 6 项 GPUI 测试：标题/slash/任务/表格、正文及源码输入/共享撤销、组合输入/局部替换/取消、UTF-16 代理对、marks/entity/Unicode/opaque 保全、空任务、引用退出、表格可访问树/反向选区、块移动、1200 段搜索与字号变化。断言源文本、结构、历史和几何，未以截图替代可编辑结果。

联合回归 107 项通过，另有 1 项被测试父进程调用的 subprocess fixture 按原设计 ignored：core/editor 77，desktop lib 19（编辑器 16、wire 3），backend 7、platform 2、既有 UI 2。Clippy、rustfmt 和依赖 guard（5 工程、839 个锁定包）通过。

联合运行曾暴露白板 JSON 比较器误将对象键顺序当作语义：桌面依赖开启 `serde_json/preserve_order` 后出现差异。测试改为比较键集合；数组顺序、字段值、历史和字节保全断言不变。macOS 默认临时路径超过 Unix socket 长度限制，改用仓库 `tmp/`；本地 socket 在沙箱内遭拒，获准后回归通过。

原生二进制实际启动并显示平台壳；桌面操作工具随后返回 `noWindowsAvailable`，没有完成真实编辑窗口输入、系统剪贴板、中文输入法或读屏操作。GPUI 测试与真实 OS 输入不能互相替代。临时日志在 `tmp/rm18/`，不作为长期唯一证据。

## 尚未达到验收的项目

| 范围                     | 已有证据                                                                                | 剩余工作与通过条件                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RM18.1 / M1 几何         | Kit paragraph/list/table/atom 叶几何、命中、输入、源码 edits/history 原型               | 补充软换行边界、RTL/BiDi 视觉 affinity、跨行范围矩形、窗口 resize/字体变化的几何实测。锁定 Kit 只公开单一 index/position 映射，尚未证明能覆盖双向边界；不能标记 PoC 通过。                                                                               |
| RM18.2 连续交互          | 虚拟正文、常用结构命令、选区、菜单、搜索、内部块移动                                    | 完成跨嵌套结构/跨单元格选区替换与格式操作；保留复杂选择的 marks；补齐表格横向及代码独立滚动、持续边缘拖选、真实拖放回放。当前不支持的复杂替换明确失败，不做破坏性降级。                                                                                  |
| RM18.3 原生与 a11y       | 字符串/本应用 Markdown/TSV 剪贴板、候选窗位置、源码 composition 防护、模型文本/表格语义 | 锁定 Kit `ClipboardEntry` 只有 String/Image/ExternalPaths，未提供 HTML MIME 读取，需在 Kit/平台适配层补充后复用 RM07 HTML 转换；图片/文件资源会话与后续模块接线。补齐 native range rectangles、链接/列表等完整语义与实际焦点/读屏验证；真实设备归 RM32。 |
| `test:document` 行为覆盖 | 标题、段落、任务勾选、表格增行、opaque 保全、组合提交、引用、marks、h4/h6 的命令路径    | 保存断言归 RM19；视频/图片/白板仍分别依赖 RM20/21/23/27。尚未完整重放旧脚本，不修改旧脚本以缩减验收。                                                                                                                                                    |

下一步优先解决 M1 文字几何/平台剪贴板缺口，再完成复杂选区与独立滚动，最后与 RM19 会话和媒体模块联合重放旧文档行为。临时草稿入口不可作为日常资料编辑入口。
