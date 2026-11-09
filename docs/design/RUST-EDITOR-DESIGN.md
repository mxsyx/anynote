# Rust 原生编辑器与媒体文档设计

状态：迁移设计，尚未实施或通过运行验收。调研日期：2026-11-08。本文是 [桌面迁移总方案](RUST-DESKTOP-MIGRATION.md) 的编辑器子方案；阶段编号 M0–M9 与总方案一致。

结论：保留 Markdown + `:::anynote` + 不可变资源引用作为持久化契约；用独立 Rust 编辑内核承载文档、操作、选区和撤销，用 GPUI/GPUI-Kit 承载原生呈现。参考 quiet-md 的分层与输入实现，不引入其 DocxXML 持久化模型。Tiptap、CodeMirror、ReactMarkdown、React NodeView、Excalidraw React 组件全部退出桌面运行包；系统 WebView 只按总方案的受限媒体边界使用。

## 1. 调研基线与证据边界

- AnyNote 调研基于工作区源码，当前 HEAD 为 `1b0a52bd431a3f3f13707214cdbf59bf957185ad`。源码链接相对于本文所在目录；行号说明定位调研时的位置，不作为未来稳定接口。
- quiet-md 调研位置为 `/Users/mxsyx/workspace/quiet-md`，HEAD 为 `b9bed5513a222292d92601c50bbd4e6850882dea`。该项目不在当前图索引中，已直接读取相关 Rust 源码；本文的 quiet-md 链接是本机参考路径，不是 AnyNote 构建依赖。
- AnyNote 使用 codebase-memory Tier 2：查符号、调用关系、关键源码，并逐文件检查 coverage。所依赖编辑器/协议/测试源码均返回 `no_recorded_issue / metadata_match`；`apps/desktop/src` 范围只有 `styles.css:2–6` 的 CSS 语法 coverage 缺口，已直接读取。图 generation 为 `2026-11-08T02:17:54Z`，watch 关闭；入口和未接线结论另经源码引用搜索确认。
- 本次没有启动 Electron、编译 Rust 或执行 UI/性能用例。下文“已有测试”仅指测试源码存在；不等同于当前环境通过、原生 IME 通过或跨平台通过。
- 上游技术信息于 2026-11-08 查阅。目标使用总方案锁定的 GPUI-Kit 版本；上游 `main` 文档只提供能力依据，M1 必须以实际锁定版本编译确认 API，不能用更新的在线文档代替兼容性验证。

## 2. 当前能力及迁移边界

| 能力                               | 当前代码事实                                                                                                                                                                                                                                                                                           | Rust 对应方案与不可丢失项                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连续 WYSIWYG                       | [main.tsx](../../apps/desktop/src/main.tsx) 第 2853 行挂载 `DocumentEditor`；[DocumentEditor.tsx](../../apps/desktop/src/DocumentEditor.tsx) 第 183–336 行通过 Tiptap StarterKit、TableKit、TaskList、Markdown 执行命令                                                                                | 连续原生文档视图，跨段光标/选择、输入规则、剪切粘贴、撤销重做；不能以 Markdown 预览 + 文本框替代                                                                        |
| 统一插入命令                       | [editor-commands.ts](../../packages/types/src/editor-commands.ts) 第 2–26 行包括正文、H1–H6、粗体、斜体、删除线、行内代码、链接、无序/有序/任务列表、引用、代码块、表格、分隔线、硬换行、图片、白板、视频                                                                                              | 同一 Rust `EditorCommand` 同时驱动原生菜单、斜杠菜单和选区工具条；保留命令名、快捷操作语义和插入后的焦点                                                                |
| 斜杠与选区菜单                     | [DocumentEditor.tsx](../../apps/desktop/src/DocumentEditor.tsx) 第 260–336、407–492 行：查询过滤、上下键、Enter、Esc、光标附近定位；粗体/斜体/删除线/链接浮条                                                                                                                                          | 复用 Kit Popover/Menu/定位能力；菜单按需创建，打开时保留选区；IME 预编辑期间不触发命令                                                                                  |
| 表格与列表                         | 同文件第 234–245、495–533 行：嵌套任务列表、3 行 2 列含表头的初始表格、增加/删除行列                                                                                                                                                                                                                   | 原生表格单元格编辑、Tab 导航、粘贴、行列操作、任务勾选及嵌套；不将 quiet-md 的合并单元格等额外能力误列为本项目当前需求                                                  |
| Markdown 原样保留                  | [document-model.ts](../../apps/desktop/src/document-model.ts) 第 5–95 行：不支持块用原始 source；单节点块以语义签名判断是否沿用旧拼写                                                                                                                                                                  | 对未编辑内容保留字节；编辑范围内有明确序列化规则。当前 `.join("\n\n")` 会重建块间分隔，不能宣称旧实现已保证全文字节无损                                                 |
| 语法安全边界                       | [rich.ts](../../packages/protocol/src/rich.ts) 第 17–168 行：CommonMark + 指定 GFM；脚注、转义、HTML、引用链接、对齐表格、代码 meta、复杂/超预算块降为不可富编辑；正文超过 500000 JS UTF-16 code units 整体降级                                                                                        | 保留安全边界和原文，提供原生源码处理入口。不要把这些情况无声转换成近似富文本；500000 是现状阈值，不是 UTF-8 字节数                                                      |
| 已实现但未接入当前入口的旧编辑能力 | [RichEditor.tsx](../../apps/desktop/src/RichEditor.tsx) 第 378–742 行保留逐块编辑、上下移动、拖放、源码降级入口；[SourceEditor.tsx](../../apps/desktop/src/SourceEditor.tsx) 第 32–108 行保留源码高亮、行号、折叠、搜索替换和格式包裹。`apps/desktop/src` 未发现二者的入口引用；当前主编辑器无模式切换 | 按“保留已有实现能力”纳入 M4：源码入口放在文档菜单及 opaque 块操作，默认仍是连续 WYSIWYG；块移动采用连续视图中的操作。明确这是接线任务，不声称当前用户已能访问这些旧入口 |
| 本地图片                           | [ImageBlockEditor.tsx](../../apps/desktop/src/ImageBlockEditor.tsx)、[image.ts](../../packages/protocol/src/image.ts) 第 25–125 行：独立 `anynote-resource:` 图片或 `core.image` v1；显示宽度 32–4096 整数/自适应；未知属性与字段保留                                                                  | Rust 图片解析、解码、显示与尺寸编辑；原图字节不重压缩；资源绑定到 note/revision；混排图片、未来版本等仍保留原文                                                         |
| 链接与搜索定位                     | [DocumentEditor.tsx](../../apps/desktop/src/DocumentEditor.tsx) 第 281–291、338–376、431–466 行：Ctrl/Cmd 点击，允许 http(s)/anynote/mailto，搜索结果首个文本命中后选择并滚动                                                                                                                          | typed link action + 原生安全打开；映射正文文本位置与源位置；跨段命中/Unicode 偏移通过内核测试，不直接复用 JavaScript string offset                                      |
| 媒体与未知块                       | [DocumentView.tsx](../../apps/desktop/src/DocumentView.tsx) 第 36–348 行：本地资源图片、白板预览、视频缓存和点击播放、未知块下载                                                                                                                                                                       | Rust 内置 block enum 分派；未知类型/版本仍可保留、复制/导出原始块，不能删除或当成空段落                                                                                 |
| 采集卡片                           | [chatgpt-components.ts](../../packages/capture/src/chatgpt-components.ts) 第 1–160、456–477 行：仅 `data-anynote-card="1"` 标记卡片经过标签/样式白名单再显示                                                                                                                                           | Rust 将受支持卡片解析为原生受限树；保持标记、原文、颜色/尺寸预算与媒体缺失说明。任意 HTML 不成为可执行网页                                                              |
| 插件声明块                         | [PluginBlock.tsx](../../apps/desktop/src/PluginBlock.tsx) 第 6–107 行：callout/details、字符串字段编辑、2000 字符限制；依赖启用且授权的 manifest 定义                                                                                                                                                  | 已有功能转为编译期内置类型或一次性数据化呈现信息，详见总方案；删除 runtime manifest 查找、插件启停和注册。不能将所有现有声明块都降成未知块后宣称功能等价                |
| 保存                               | [main.tsx](../../apps/desktop/src/main.tsx) 第 329–435 行：串行队列、650 ms debounce、expectedRevision、保存中新增修改继续保留、失败保留草稿、失焦 flush；[DocumentEditor.tsx](../../apps/desktop/src/DocumentEditor.tsx) 第 392–405 行等待 compositionend 最终更新                                    | Rust `DocumentSession` 与持久化服务的串行提交协议，见第 7 节；编辑内核不直接操作数据库                                                                                  |

普通 Markdown 仍由 Rust 公共协议模块统一解析。浏览器扩展和 Cloudflare 保留 TypeScript；同一兼容夹具由 Rust 和保留的 TypeScript 实现分别验证，不将浏览器代码链接进桌面进程。

## 3. quiet-md 可借鉴部分与禁止照搬部分

| 已读取参考                                                                                                                                                                        | 借鉴内容                                                                            | AnyNote 必须调整的内容                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [crates/core/Cargo.toml](/Users/mxsyx/workspace/quiet-md/crates/core/Cargo.toml)；[model.rs](/Users/mxsyx/workspace/quiet-md/crates/core/src/model.rs) 第 1–60、197–214、718–757 行 | GPUI 无关 core、稳定 BlockId、带 marks 的文本、未知内容容器                         | 参考模型围绕 DocxXML，不能用它替换 AnyNote Markdown；不增加 DocxXML 数据库字段或先转 XML 再转 Markdown                                                              |
| [editor/core.rs](/Users/mxsyx/workspace/quiet-md/crates/core/src/editor/core.rs) 第 1–64、322–338、406–417、603–680 行                                                             | `(BlockId, UTF-8 byte offset)`、核心层校正选区、编辑合并、独立 undo/redo            | quiet-md 撤销保存整篇 document 快照，500 步/约 256 MiB 且至少 20 步；不直接复制这个内存策略。AnyNote 用可逆 patch，预算超限仅裁剪历史，不裁剪文档                   |
| [editor/view.rs](/Users/mxsyx/workspace/quiet-md/src/editor/view.rs) 第 247–263、2535–2665 行                                                                                      | `EntityInputHandler`、UTF-16/UTF-8 转换、marked range、光标坐标到输入法候选窗       | 使用目标 Kit/GPUI API 重写；UTF-16 code unit 落在代理对中、grapheme 边界和跨块选区须有明确策略；不得假设代码能原样编译到另一 GPUI 版本                              |
| [editor/text.rs](/Users/mxsyx/workspace/quiet-md/src/editor/text.rs) 第 1–46、692–1050 行；[editor/render.rs](/Users/mxsyx/workspace/quiet-md/src/editor/render.rs) 第 17–126 行    | 文本 layout/prepaint/paint 分工；布局结果用于命中、选区和光标；按块虚拟化、稳定身份 | 先复用 Kit editor_host/文本布局；仅实现已证明缺失的编辑几何。quiet-md 的尺寸缓存策略有其性能背景，不直接复制其相同长度文本近似缓存                                  |
| [editor/fuzz_tests.rs](/Users/mxsyx/workspace/quiet-md/crates/core/src/editor/fuzz_tests.rs) 第 1–85 行                                                                            | 固定 seed 随机编辑、模型不变量、undo/redo 重放                                      | 改用 AnyNote Markdown/directive/资源夹具；验证原始 source 与资源闭包，不用 XML roundtrip 代替                                                                       |
| [markdown.rs](/Users/mxsyx/workspace/quiet-md/crates/core/src/markdown.rs) 第 1–43 行；[docxml.rs](/Users/mxsyx/workspace/quiet-md/crates/core/src/docxml.rs) 第 1–4、80、300 行    | 未识别内容显式保留的设计思路                                                        | Markdown 是该项目从 DocxXML 导出的格式，导出会处理标题、空行和尾换行；不具备 AnyNote source-preserving serializer 所需契约                                          |
| [Cargo.toml](/Users/mxsyx/workspace/quiet-md/Cargo.toml) 第 24–81 行；[README.md](/Users/mxsyx/workspace/quiet-md/README.md) 第 126–133 行                                          | 可评估单个算法、测试方式                                                            | quiet-md 使用 vendored GPUI 0.2.2 及 Taffy 补丁；目标按总方案的 Kit 配套 GPUI 锁定。代码 MIT 不表示其商业图标、品牌和所有素材可复制；仅在需要时逐项记录许可证与来源 |

该参考证明原生富编辑器的实现路径，不证明 AnyNote 的功能、性能或三平台输入法已可直接满足。

## 4. 模块职责与技术选择

在总方案的 Rust workspace 中保持两个明确边界，不为每种 block 建 crate 或通用插件框架：

```text
anynote-core::protocol: Markdown/directive/resource/link/PDF contracts
                     ↓
editor core: source + model + transactions + selection + history
                     ↓
desktop editor view: Kit controls + GPUI input/layout/accessibility
                     ↓ typed save/asset/media commands
application services: revision/CAS/assets/import/media/storage
```

依赖方向上 editor core 只依赖 anynote-core 的协议模块和纯 Rust 数据库外工具；不得依赖 GPUI、WebView、Tokio runtime、SQLite connection 或系统文件对话框。view 通过应用服务读取资源与提交快照；媒体解码和正文解析任务只返回与版本绑定的结果。

| 决策          | 选择及理由                                                                                                                                                             | 备选与取舍                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown 解析 | `pulldown-cmark` 候选基线 0.13.6，采用 `into_offset_iter` 的 source ranges，显式开与现状匹配的 CommonMark/GFM 选项；外层复用 Rust 移植的 `:::anynote` fence-aware 扫描 | 自写完整 CommonMark 解析器成本高；`comrak` 可作为夹具显示解析差异时的评估备选，但不同时维护两套生产解析器。无论解析器选哪一个，raw source/separator 保存由应用负责   |
| 源文本缓冲    | 优先复用 Kit 源码控件的编辑缓冲；core 的 source buffer 使用成熟 `ropey`，不自建 rope/piece table；正文节点局部文本采用 `String`                                        | 大文档编辑与撤销不得每次克隆整个正文。若基线证明较小 `String` 版本已满足全部预算，可在 M1 定案时简化；不得在未测量前叠加 CRDT、多级自制缓存                          |
| WYSIWYG 渲染  | 首先验证 `gpui_kit::base::text::editor_host` + `TextView`/`BlockNode` 投影，复用 shaping、wrap 和叶节点几何；文档模型与编辑行为由 AnyNote 持有                         | Kit `Editor` 是源码编辑控件，不是 Tiptap 替代品；TextView 也不提供完整编辑事务。若跨块/双向文本/表格命中缺口经 PoC 确认，局部增加 GPUI `Element`，不重做整套通用控件 |
| 源码编辑      | Kit `Editor`，只启用 Markdown 所需语法特性；复用行号、折叠、查找替换、滚动。通过变更事件接入同一 document session                                                      | 不引入 Monaco/CodeMirror WebView，也不为源码另造一个原生代码编辑器。版本 0.9.0 的 `InputEditsEvent` 可提供编辑批次，须验证 source offset、历史和程序化更新抑制       |
| 输入边界      | GPUI 原生输入接口；`unicode-segmentation` 负责 grapheme/word 边界；使用 Kit/GPUI 的平台剪贴板和字体 shaping                                                            | 不按 Rust `char` 或 JavaScript `.length` 推断视觉光标；不把所有 keydown 当作字符输入；不自行实现字体 shaping                                                         |
| 撤销          | 可逆文本/结构 patch + before/after selection，按用户命令组合；每个 session 一个权威历史                                                                                | 不引入协作 CRDT；现状无协作编辑证据。持久化 revision 历史与内存 undo 是两种职责，不能互换                                                                            |

`pulldown-cmark` 官方文档明确其 offset iterator 产出事件及对应源范围；它没有承诺保留所有格式拼写，因此原文保留仍是本方案自己的责任。[Parser 文档](https://docs.rs/pulldown-cmark/latest/pulldown_cmark/struct.Parser.html)、[0.13.6 发布信息](https://docs.rs/crate/pulldown-cmark/0.13.6)。`ropey` 提供 UTF-8、字符与 UTF-16 code unit 转换，所有外部范围先验证再调用可失败接口。[Rope 文档](https://docs.rs/ropey/latest/ropey/struct.Rope.html)。

Kit 将外部富文本宿主定义为渲染边界，应用仍负责 identity/revision、selection、commands、history、native input 和 accessibility；尤其不能把屏幕外叶节点没有几何视为文档已删除。具体 API 与未覆盖的双向文本/光标 affinity 等限制需在锁定版本核对。[Kit 架构说明](https://github.com/longbridge/gpui-kit/blob/main/docs/ARCHITECTURE.md)、[Kit Editor 文档](https://github.com/longbridge/gpui-kit/blob/main/website/component/editor.md)、[Kit 0.9.0](https://github.com/longbridge/gpui-kit/releases/tag/v0.9.0)。

## 5. 文档模型与原文保留

### 5.1 唯一持久化格式

`body` 仍是现有 Markdown UTF-8 文本，directive 的 `type/version/id`、JSON 载荷、`anynote-resource:` 与 `anynote://` 不改名。Rust 内存模型和临时 BlockId 不写入 body，不替换 note ID、resource ID、revision ID，也不以 GPUI AST/JSON 作为第二份持久化真相。

内存上一个 `Document` 包含：

- `source`：权威源文本缓冲；记录原始 LF/CRLF、空行、开头/末尾空白及已有 BOM 的实际内容。
- `segments`：覆盖全文、不重叠的原始范围，包括 Markdown 块、directive 和块间分隔；不能仅保存解析器产生的 AST 节点而丢掉空白。
- `blocks`：用于编辑的 block tree，带 session-local `BlockId`、`source_span`、语义内容和 dirty generation；普通块包括 paragraph、heading、list/item/task、quote、code、rule、table；媒体/声明块为静态内置 enum；不支持内容为 `Opaque { reason, raw_span }`。
- `inline`：带 marks 的文本 runs、hard break、合法链接；资源图像和其他 atom 明确占位，避免出现不可定位的零宽“伪字符”。
- `selection`：`anchor/head = (BlockId, UTF-8 byte offset, affinity)`，表格 cell scope、atomic block selection 单独建模；affinity 表示软换行/双向文本边界的视觉侧，不能用一个整数代替。
- `generation`：内存编辑版本，与数据库 `revision` 区分；只用于布局、异步任务及过期响应判断。

标题继续是 note 的独立字段，不像 quiet-md 那样把文档 title 自动输出成 `# title`；编辑正文中的 H1 也不自动重命名笔记。

### 5.2 解析及序列化规则

1. 先按 [markdown.ts](../../packages/protocol/src/markdown.ts) 第 25–88 行的契约识别 directive，保护反引号/波浪 fence 内的同名文本；无效 JSON、未知版本和未闭合内容保留原文，不能丢弃后重新生成空对象。
2. Markdown 分段经 parser 构建语义视图，并用 source range 记录原始分隔。当前 unsupported 判定单独实现兼容测试，不因 Rust parser “能够读取”就允许有损富编辑。
3. 未修改文档保存必须 byte-for-byte 相等；未修改块/未触及分隔直接读取 source，不执行“parse → 全文 pretty print”。这是迁移的数据保护验收，强于当前 `join` 的实现。
4. 普通段内文本操作优先改最小受影响范围；涉及 list/quote/table 结构时重写最小安全祖先范围。该范围内可规范化 Markdown 表达，范围之外必须逐字节相等；操作返回明确 change map 修正后续 source spans。
5. 新内容遵循光标所在段的换行风格，文件没有可推断风格时用 LF；保留未编辑的混合换行。代码 fence 自动选择不与正文冲突的长度，正确转义 Markdown、链接目标、表格管道、硬换行；不以字符串拼接猜语法。
6. directive 已知字段通过保留未知属性/JSON 字段的更新器修改。未改动整个 directive 返回原始字节；改动后允许载荷范围内 JSON 排版变化，但 unknown 值及类型不丢失。不能反序列化到窄 struct 后重新序列化而删除未来字段。
7. 原始 Markdown、HTML、脚注等可进入受限源码模式；仅对当前版本 source span 做 CAS patch。源码修改使段失去可富编辑资格时，保留原文并显示原因；不阻止合法源文档保存。
8. 全文引用定义影响屏幕外内容：可保存文档级轻量 reference map；引用定义编辑触发依赖块重新解析。增量重解析不能只取当前可视段，破坏列表/fence/reference 的跨块语义时扩大到安全祖先或整个 segment。

本文不承诺将脚注、任意 HTML、对齐表格等旧降级语法全部升级成富编辑。这些语法的可读性、原文保存、源码修改和导出必须保留；原本支持富编辑的集合不可降级。

### 5.3 源码与连续视图的状态一致性

所有正文修改最终进入同一个 `DocumentSession`。Kit 源码控件的变更批次转换成 core patch，带 session generation 和 origin；core 回写控件时用 origin/epoch 防止回声循环。文档级 Undo/Redo 由 core 统一路由，源码控件不得同时消费同一个撤销 action；M1 必须验证 Kit 快捷键覆盖、程序化回写和内部历史清理接口。若锁定版本无法做到，先将源码作为显式“应用/取消”的临时编辑会话，以一次原子 patch 提交，并在 M4 验收前解决实时保存及历史一致性，不能留下两个相互覆盖的 autosave 写入者。

保留主文档默认连续编辑；源码作为文档菜单和 opaque 块的二级操作按需创建，避免重新引入覆盖整页的双编辑器常驻布局。切换前结束/取消 IME、应用当前事务、记录源范围到语义位置的映射，切回后恢复可用选区与滚动锚点。

## 6. 编辑事务、渲染及输入

### 6.1 事务

`EditorCommand -> validate -> prepare patch -> apply -> normalize affected subtree -> map selection -> history -> notify` 是唯一变更路径。命令不能绕开 core 直接修改 GPUI 展示树。

每笔事务包括 `base_generation`、文本替换/结构操作、正反 patch、前后选区、受影响 block ID、必要的 source span precondition。过期范围、错误 char boundary、非法 JSON/资源身份不产生部分编辑。多段粘贴、表格行列变更、拖动块、将图片转为尺寸 directive 都是一个可撤销单元。只对相邻普通输入/删除按时间和同一 block 合并；跨光标、粘贴、格式操作、IME commit 和媒体操作必须打断合并。

撤销仅恢复文档和选区，不恢复旧数据库 revision、不删除已提交的不可变资源、不发起网络播放。撤销产生新 dirty state，再按正常 CAS 写成新 revision。历史有步数与累计字节上限，超限丢弃最旧 undo 条目并保留当前正文；不得借“内存保护”截断用户输入。

### 6.2 命中、布局和滚动

优先将 model 投影为 Kit 外部富文本宿主支持的 `BlockNode`；以 `BlockId + leaf key` 保持身份。布局缓存仅由内容 generation、可用宽度、字体/字号/主题、DPI 等实际依赖失效。每帧仅测量和绘制可视区域及小范围预取；长列表展开为独立可视行，避免一个超大父 block 让虚拟化失效。

几何在 prepaint 后收集并携带 generation。hit-test、选区 rect、链接命中、光标和 IME 候选窗使用同一几何快照；窗口 resize、缩放、字体回退、异步图片尺寸到达时旧快照不得继续定位。屏幕外搜索命中先依据 BlockId 滚入、完成布局，再精确定位。表格横向滚动、代码块滚动和正文纵向滚动各有独立 handle，遵循边界滚动传递，不能共用全局 scroll state。

当 Kit 缺少必需几何时只实现一个编辑文字 element 适配器，参考 quiet-md 的 `request_layout/prepaint/paint` 分层，仍调用 GPUI text system。M1 必须先验证中英文混排、emoji、软换行、RTL/BiDi 边界和表格内选择；如无法覆盖现状可用交互，应记录为阻塞，不因“画出了正文”通过 PoC。

### 6.3 IME、剪贴板和无障碍

- 原生输入通过 `EntityInputHandler`/目标版本等价接口处理 surrounding text、selection、marked range、replace、bounds。平台 UTF-16 范围先按约定修正到合法标量边界，再映射 UTF-8；视觉左右/删除按 grapheme 和 shaping cluster 处理，不能拆开 emoji ZWJ、变音符、代理对。
- `Composition { before_snapshot/patch, marked_range, generation }` 是会话状态。preedit 仅影响当前编辑显示，不能触发 slash、格式转换、autosave 或网络；commit 合成一笔最终事务；cancel 恢复组合开始前正文与选区。失焦、切换笔记、关闭窗口时请求平台结束组合，收到结果再 flush；未结束时保持原会话，不能通过“return Ok”跳过保存后继续关闭。
- 剪贴板至少覆盖纯文本、多段富文本、Markdown、HTML 表格/列表和本地图片/文件拖入的现有可达行为。HTML 经 Rust 受限解析再映射，未知内容保留文本或提示，不执行脚本；本地资源走应用资源服务，剪贴板内不能带任意路径读取权。
- GPUI accessibility tree 提供文档/段落/标题/列表/表格/链接/图片 alt/checkbox 语义；暴露文本范围、选区变化与焦点。Kit 的控件可访问性只覆盖自身，不能自动证明自绘正文可被屏幕阅读器读取。
- 原生菜单、上下文菜单、工具条和快捷键统一指向同一 focused session；弹窗只在打开时创建，关闭释放订阅并恢复调用者焦点。深浅主题、纸张背景、系统字号/DPI 保留可读性，禁用状态不丢失键盘焦点顺序。

## 7. 保存、版本与资源生命周期

`DocumentSession` 持有 `notebook_id / note_id / base_revision / head_revision_id / generation / saved_generation / composition / pending_save`。读取资源始终使用当时的 note/revision 身份，不能在回调中重新拿当前选中的笔记。

1. 有效事务后标 dirty，以当前 650 ms debounce 为初始行为；Ctrl/Cmd+S、失焦、切换笔记、打开需要正文一致性的媒体动作、退出调用同一个 `flush`。
2. 每个 note 串行提交 `SaveDraft { expected_revision, title, body, tags, favorite, session_epoch, generation }`。数据库写入仍由总方案的单写入者服务执行；编辑视图不持有 connection。
3. ack 同时带新 revision/head revision 和发送时 generation。若发送期间又输入，更新 base_revision 但保留最新正文与 dirty，继续提交下一批；绝不用较早 ack 的正文覆盖当前 buffer。
4. 窗口/笔记切换后到达的响应按 session epoch 过滤，只更新它所属会话。关窗必须等待 flush 确认；失败留在可恢复会话并提供明确状态，不把“请求已发出”视为已保存。
5. CAS 冲突不能强制覆盖。保存本地 draft 和服务端新 revision，提供恢复/比较/重试路径；是否自动三方合并由总方案决定，本文不新增协作协议。
6. 图片/白板保存由应用服务一次提交资源及正文 revision。先冻结 media snapshot、计算/验证资源闭包，再提交；失败不修改 body 引用、不把半成品当成成功资源，未引用 staging bytes 按存储策略回收。
7. 编辑器销毁时取消本 session 的解析、资源解码和菜单订阅；对象 URL/纹理/文件句柄/临时资源按 RAII 释放。外部动作已提交数据库事务不得因关闭 UI 被误判为回滚；必须查询其最终状态。

白板保存前先 flush 正文，冻结 block ID/expected revision；白板窗口中的修改默认仅在“保存”时提交，保持现状显式保存语义。只要正文或目标白板在后台变化，白板提交即检查 CAS；不可用旧 scene 覆盖新 scene。

## 8. 媒体与 WebView 的具体边界

WebView 平台选型、可信本地页面、bridge schema、会话 token、origin、navigation、资源访问和销毁协议以总方案为准。下面列出不能被通用 WebView 包装省略的业务契约。

### 8.1 PDF

现有 [PdfReader.tsx](../../apps/desktop/src/PdfReader.tsx) 第 59–112、133–138、208–438、452–580 行提供：range 分块读取、页面/文本层、分页、缩放、适页/适宽、懒加载缩略图、文内搜索、密码解锁、后台文本索引、选区高亮、批注、创建回链 Markdown 阅读笔记、旧 asset hash 批注的显式重锚定。必须逐项迁移，不能只验收 PDF 首屏图片。

首选总方案的 `pdfium-render` + 原生 Pdfium + GPUI：Pdfium 处理解析/页面栅格/文本坐标，Rust 负责批注、索引和资源授权，GPUI 负责文本选区、工具条和批注层。Pdfium 是 native library，并非 JavaScript runtime；需验证发行包的动态库、架构和平台支持。Rust 绘制文本选择不可以通过简单拼接字符宽度推算 PDF 原始 glyph 坐标。

M1/M6 对原生方案验证真实 PDF 的字符顺序、旋转、CropBox、混合语言、密码、连续选择以及当前 normalized rect 坐标；如原生选区/无障碍代价明显过高，可按总方案启动单独的系统 WebView 技术验证，核心注释/版本/索引逻辑仍在 Rust。不能未经验证直接保留 `pdfjs-dist` 并宣称桌面已无 JS 业务依赖；若任何候选依赖被用户禁止的应用 JS 运行时，则不能成为最终路线。

保留 [pdf.ts](../../packages/protocol/src/pdf.ts) 的 500 页、4500000 字符索引预算及 complete/partial/scanned 状态；兼容计数时注意旧值按 JS code units 计数。扫描 PDF 当前提示 OCR 未启用，迁移不凭空承诺 OCR。索引任务取消不发布部分正文，过期 asset hash 不接受新批注；`pdf-page-N`、`pdf-annotation-UUID` 和回链保持原样。

### 8.2 白板

[WhiteboardEditor.tsx](../../apps/desktop/src/WhiteboardEditor.tsx) 第 3、36–95、130–143 行实际嵌入 `@excalidraw/excalidraw` 0.18.0，关闭了 loadScene/saveToActiveFile/export，启用主题切换；应用保存 `elements`、精选 `appState`（背景色、scrollX/Y、zoom）、files，并生成 PNG preview。它不是单纯图片批注组件。

**不能把现有 Excalidraw React 放进 WebView 来满足去 React 的要求。** 目标先做 Rust scene core + GPUI 绘制/交互；如果 GPUI canvas/嵌入媒体实现成本经 PoC 证实过高，再评估仅将 Rust 渲染模块编译 WASM、由系统 WebView canvas 呈现的无 React 方案。原生 Rust 持有唯一权威 scene/事务，页面只接收版本化绘制快照并发送输入意图；WebView 不拥有第二套 scene、undo、binding、导入/导出或保存逻辑，不引入 Node、QuickJS、V8 sidecar。两条路线均需要实现 Excalidraw 格式兼容，不存在“换个容器即可迁移”的低成本等价替换。

M0/M1 固定 0.18.0 格式与当前暴露动作矩阵。至少按上游 [0.18.0 元素类型](https://github.com/excalidraw/excalidraw/blob/v0.18.0/packages/excalidraw/element/types.ts) 检查矩形/菱形/椭圆、文字、线/箭头、自由绘制、图片、frame 及 iframe/embeddable 等持久化类型；箭头 binding/elbow/fixed segment、自由绘制压力、文字 container 绑定、图片 crop/scale 都不能丢字段。类型存在不代表 AnyNote 当前 UI 暴露其全部创建动作；需在冻结矩阵中区分“存量格式可读/可保留”“当前可创建/编辑”“未暴露或依赖外部服务”，不新增没有依据的在线 AI/协作能力。

执行路线：

1. 保存一套每种已暴露工具、选择/多选、拖动、缩放旋转、分组、层次、复制粘贴、撤销重做、连线绑定、文本编辑、图像文件、滚动/缩放、主题的旧版 fixture 与操作序列。当前组件自动提供的菜单/工具同样计入清单，不能只统计 wrapper 中的按钮。
2. Rust 用 typed known fields + unknown JSON 保留读写 scene；保持 element ID、file ID、resource ID、绑定关系、排序字段及未知字段。先通过旧场景无修改保存一致性，再逐类实现编辑操作；禁止把所有数据扁平化成 PNG。
3. 图形几何、手绘风格、文本字体布局、连接点和导出 PNG 作为独立兼容风险测量；不要以“JSON 能反序列化”视为图形/操作等价。复用 Rust 路径/文本/图像基础库，避免自写通用 GPU 引擎。
4. scene JSON、内嵌文件资源、PNG preview 和 note revision 一起提交，复用 [first-party contracts](../../packages/first-party-adapters/src/contracts.ts) 第 11–62 行所表达的闭包语义；读取历史 revision 必须得到其原有图像，不能解析到最新 files。
5. 仅只读预览、未知图形保留或一部分工具支持属于中间里程碑，**不满足最终功能一致性**。当前可用场景无法无损继续编辑时，M6 和整体验收保持未通过；不得以此退役旧桌面或要求用户接受默认降级。

### 8.3 视频和卡片

视频业务按 [video.ts](../../packages/protocol/src/video.ts) 第 81–142 行迁入 Rust：只接受无凭据 HTTPS；YouTube/Vimeo/Bilibili ID 重新验证后从固定模板生成 embed URL，普通链接仍是 link card；不能信任存储的任意 iframe src。卡片、标题/缩略图缓存、刷新元数据、外部打开由 GPUI 提供。播放才创建隔离系统 WebView，关闭/切笔记时销毁；保留 Notebook 的 remote embed 偏好，移除插件启停并不意味着自动启用远程网络。

远程播放器有自身网页脚本，这是用户允许的系统 WebView 外部媒体内容边界，不能获得文件路径、SQLite、资源任意读取或应用命令 bridge。若平台 WebView 不支持该 provider 的真实播放，外链只作为明确的失败恢复操作，不能据此把原有嵌入播放验收标为通过。

本地采集卡片使用 Rust 原生白名单呈现；未知 HTML 保留源码。不得为了少量卡片把整个 Markdown 文档放入 WebView，也不得为卡片重新引入通用插件注册表。

## 9. 实施任务及验收顺序

本表是总方案 M4/M6 的可执行分解，不是已完成清单。任务交付包括源码、夹具、测试和必要的现有文档更新；本次仅制定计划。

| 任务                       | 前置条件                 | 实际产出                                                                                                                                  | 验收出口                                                                                                   |
| -------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| E0 基线与夹具（M0）        | 当前源码可读取           | 导出/构造无用户敏感数据的 Markdown、directive、资源、表格、采集卡片、whiteboard、PDF 夹具；记录当前可达 UI 与未接线实现；修订测试入口映射 | 每个当前能力在矩阵中有源路径、数据样本、操作序列和断言；旧 UI smoke 的失配明确标记                         |
| E1 原生编辑 PoC（M1）      | Kit/GPUI 锁定            | 一段文本、嵌套列表、表格、atom、跨段选区；Kit editor_host/源码 Editor 接入；三平台 IME、剪贴板、字体/DPI、a11y 探针                       | 无 React/JS 内核；真实输入法可以组合/撤销/切换焦点；关键 API 缺口有已验证可行补齐方案；仅截图不足以通过    |
| E2 协议与模型（M2 可并行） | E0                       | fence-aware directive parser、source segment、已知/opaque block、源范围转换、source-preserving serializer                                 | 未修改全文逐字节相等；局部修改外部字节不变；所有 unknown 字段/资源闭包保留；与 TS 夹具语义对照通过         |
| E3 事务核心（M4.1）        | E2、M3 写入契约          | selection、文本/结构命令、list/table/marks/link、undo/redo、源码 patch、composition 状态机                                                | 随机编辑不变量与完整 undo/redo 重放；非法/过期范围不产生部分修改；任何命令只有一个权威历史                 |
| E4 连续视图（M4.2）        | E1、E3                   | Kit 原生工具条/菜单，GPUI 内容渲染、虚拟滚动、命中、拖放、搜索定位、源码二级入口                                                          | 重放 `test:document` 的用户行为；现有支持语法均可编辑；原生菜单与 slash 等价；源码/opaque 操作有可访问入口 |
| E5 保存接线（M4.3）        | E3、M3 CAS/资源服务      | 串行 autosave、ack generation、冲突保留、关闭/切笔记 flush、取消与资源清理                                                                | 保存中继续输入、CAS 冲突、IME 结束、错误 ack、切换笔记、退出及资源失败注入全部无丢字/错写                  |
| E6 内置块（M5）            | E2、总方案插件功能映射   | 图片宽度、视频卡、采集卡、原声明式块的内置编辑/呈现                                                                                       | 旧数据继续显示/编辑，字节/字段/资源保留；桌面运行时无 manifest 注册、授权宿主和插件生命周期                |
| E7 PDF（M6.1）             | M3 资源和任务、E5        | Pdfium 原生 reader、批注层、文本选区、搜索/索引、密码、历史锚点                                                                           | 真 PDF 图像/文本/选区验证；partial/scanned/cancel/stale-hash 测试与真实平台行为都通过                      |
| E8 白板（M6.2）            | E0/E1 格式与路线、M3、E5 | Rust scene/命令/绘制、resources+preview 原子保存、历史打开                                                                                | 冻结矩阵所有当前可达动作可用，旧场景可无损编辑；不能把只读 preview 算完成                                  |
| E9 回归与切换（M8/M9）     | E4–E8、总方案数据接管    | 原生 UI/性能/a11y 测试、兼容报告、最终桌面依赖清理                                                                                        | 本文矩阵未通过项为零；不需要 React/Electron/Node/QuickJS；保留 TS 端的协议回归通过                         |

E2 可以在只读数据层期间推进；E3/E4 与 PDF、白板技术验证可以分工并行，但 `DocumentSession`、公共 block/schema、保存协议的变更必须由单一负责人协调。不能在 schema 和字体/输入法 PoC 未定时并行重写多个不兼容内核。

## 10. 验证方法与通过门槛

### 10.1 现有测试的使用方式

| 现有证据                                                                                                                     | 迁移用途                                                                         | 不能推导的结论                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [document-model.test.ts](../../tests/document-model.test.ts)                                                                 | 未改拼写、未知块、编辑后不恢复旧快照、尾部可写段                                 | 当前测试的 `toContain` 不保证空行/CRLF/全文完全一致                                   |
| [document-editor-smoke.mjs](../../scripts/document-editor-smoke.mjs)                                                         | 当前连续文档入口，标题/标记/表格/任务/媒体命令、opaque、模拟 composition、持久化 | synthetic DOM composition 不等于真实 OS IME；该脚本没有覆盖 Excalidraw 的所有内置动作 |
| [native-menu-smoke.mjs](../../scripts/native-menu-smoke.mjs)                                                                 | 原生菜单到当前编辑焦点的行为                                                     | Electron 菜单测试不能直接证明 GPUI 原生菜单集成                                       |
| [editor-ecosystem.test.mjs](../../tests/editor-ecosystem.test.mjs)                                                           | rich syntax 边界、CRLF 局部 patch、块移动、图片宽度/未知字段、资源保存与导出     | 其中插件宿主生命周期测试随机制退役，不应继续移植已删除功能                            |
| [editor-ecosystem-smoke.mjs](../../scripts/editor-ecosystem-smoke.mjs)、[desktop-smoke.mjs](../../scripts/desktop-smoke.mjs) | 提取旧源码/逐块编辑动作作为保留实现能力的案例                                    | 两者仍查找“富文本 Beta”“源码”旧入口，当前 main 已改；不能直接列为当前 GUI 已通过      |
| [pdf-reader.test.mjs](../../tests/pdf-reader.test.mjs)                                                                       | PDF 索引覆盖、批注 hash、回链、取消/失败                                         | 多数夹具是存储协议输入，不能验证真实 PDF 排版、字体和密码渲染                         |
| [whiteboard-assets.test.ts](../../tests/whiteboard-assets.test.ts)                                                           | 记录当前白板按需加载和资源路径需求                                               | React 动态 import/font path 机制不移植；新测试改验原生字体/纹理生命周期及场景兼容     |

### 10.2 数据与内核

- 夹具覆盖 LF、CRLF、混合换行、前后空白、BOM、空文档、末尾媒体、未闭合 fence、fence 内 directive、非法/未知 directive、reference definitions、脚注、转义、HTML、alignment/meta、深层 list、Unicode、代码内反引号/管道。
- 对每份原始 body 断言 `save(load(body)) == body` 的实际字节；对每种命令断言受影响范围之外相等、resource IDs/unknown JSON 仍存在，序列化后重新 parse 的已编辑语义符合预期。
- property/fuzz 检查 BlockId 唯一、span 覆盖且不越界、UTF-8/UTF-16/grapheme 边界、selection 指向现存节点、marks 有序不重叠、表格矩阵有效、逆操作恢复；失败 seed 必须可重放。
- 跨格式 clipboard 及源/富视图切换不产生额外未编辑变化；同一动作执行撤销重做 N 次得到同一结果；未来字段不得在窄 struct、复制笔记、归档导入/导出时消失。

### 10.3 原生 UI 与跨平台

必须在 macOS、Windows、Linux 的目标发行组合上用真实窗口验证。M1 与 M9 均覆盖中文拼音、日文输入、Windows 微软拼音/实际目标输入法、macOS 系统输入法、Linux IBus/Fcitx 及项目最终承诺的 X11/Wayland 路线；没有实际机器证据的平台保留未验收。

用键盘/鼠标/剪贴板和 accessibility automation 验证文字选择、Home/End/上下键/word navigation、Ctrl/Cmd+A/C/X/V/Z、双击/三击、跨段/跨表格边界、链接、任务 checkbox、slash/menu/popup 焦点、拖放、文件对话框和高 DPI。字体与截图允许平台栅格差异，但断行、可选文本、光标命中、菜单可操作和无丢字必须有语义断言。屏幕阅读器至少核对 VoiceOver、NVDA 和目标 Linux 辅助技术的焦点/文本/表格读取；Kit 编译成功不替代这些检查。

### 10.4 性能与资源

沿用总方案基线硬件与测量方法。E0 固定 10 KiB、100 KiB、500000 UTF-16 code units 边界、大于旧富编辑预算的源码文档，以及长表格/列表、图片密集文档和真实多页 PDF。新增目标是拟定验收预算，**不是本次测得的结果**：普通 100 KiB 文档持续输入的 key-to-present p95 ≤ 50 ms、p99 ≤ 100 ms；滚动 p95 frame ≤ 16.7 ms（60 Hz 基线）；任何由编辑引起的主线程连续阻塞 > 100 ms 必须消除或解释并保持该项未通过。超旧富编辑阈值允许沿用原生源码模式，不能卡死或丢字。

测量打开/解析/首帧、每键延时、滚动 frame、源/富切换、save ack、资源解码、undo bytes、RSS/VRAM、PDF 当前页与缩略图缓存；与同机旧版可达能力比较。完成 100 次开关笔记/白板/PDF、反复 zoom/resize/主题切换后检查存活任务、订阅、句柄、纹理和 WebView 实例归零，稳定内存不得随循环无界增长。只对实际瓶颈增加局部索引/缓存，数据脱离可视区即可释放可重建解码/布局；原始源和未保存 draft 不可释放。

## 11. 风险与决策出口

| 风险                              | 应对                                                                        | 阻止放行的条件                                                   |
| --------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Markdown 规范化造成无声改写       | raw segments + 局部 serializer + byte fixtures；Rust/TS parser 差异显式记录 | 无编辑保存改了原文，或普通编辑损坏相邻 opaque/引用定义           |
| Kit 文本宿主不是完整编辑器        | M1 验证输入/几何边界；局部补 GPUI element；依赖 exact lock                  | 只有预览，没有可靠选区/IME/撤销/a11y                             |
| 源码与富文本拥有两个历史          | 单 session/core 路由 undo；InputEditsEvent 接线和 echo guard 验证           | 任意一次模式切换或 undo 导致正文/持久化不同步                    |
| 新输入法实现丢字                  | composition 独立状态、UTF 单位映射、真实平台用例                            | preedit 被保存、commit 重复、候选窗错位、关窗跳过未保存内容      |
| Excalidraw 兼容成本远高于容器替换 | M0 动作/字段矩阵；M1 Rust 路线证明；M6 分类型实现与旧场景编辑对照           | 保留 React、只读降级、丢 bindings/files/未知字段、当前工具不可用 |
| PDF 图像可看但文本/批注错误       | 真 PDF fixtures、原始 glyph 坐标、asset hash 绑定、index budgets            | 选区/回链/重锚定/密码/取消之一失效，或部分索引被宣称完整         |
| 插件删除连带内容丢失              | 先完成静态内置映射/数据化内容，再删除宿主                                   | 原有已用声明块功能只剩 unknown/raw 导出                          |
| 性能/生命周期被小样本掩盖         | 旧预算边界 + 大文档 + 100 次循环 + 版本化异步结果                           | 无实际目标平台数据，存在持续增长/过期回写/未取消任务             |

编辑器、媒体、存储迁移共同达到上述出口后，才能在总方案中将桌面切换与旧依赖退役标为完成；设计文档、原型、局部截图或单个解析测试均不能代替最终功能一致性验收。
