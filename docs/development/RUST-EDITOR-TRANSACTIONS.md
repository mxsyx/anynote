# Rust 文本事务与输入内核

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 状态所有权与事务

`transaction::Editor` 独占 `Document`、选区、内存 undo/redo 和 composition，只提供文档的共享引用。编辑视图、源码入口和后续结构命令都应向同一 owner 提交 `Transaction`，不能在外层再建立正文历史。独立 `Document` 的源编辑接口继续用于模型/导入等无编辑会话场景。

`TextRange` 携带 generation、范围和单位；`Editor::replace` 支持插入、删除与替换，并把光标放在替换内容末尾。`Transaction` 含同一基础 generation 的有序 `Patch`，每个 patch 保留原范围、expected 原文字节和 replacement；可指定结果源码坐标中的选区，选区仍带基础 generation。没有显式选区时按 `ChangeMap` 和 affinity 映射两个端点，保留反向选择。

一批 patch 按基础源位置递增排列，不允许重叠或共用边界（相邻操作先合成一个 patch）；倒序应用。所有范围、UTF-8 标量边界、expected、generation 和结果选区先校验，失败不改变正文、选区、历史或 redo。`Document::replace_sources` 完成解析与身份准备后一次发布，generation 只递增一次。空改动不增加版本/历史。`Applied` 返回按应用顺序排列的 change maps 及受影响的旧 BlockId；跨块结构变化后消费者须重新读取当前投影。

沿用 RM15 全量重解析来保证 reference/fence 的跨块一致性。未受影响源字节保持不变；块边界插入同时考虑原范围平移与块内扩张，避免插入新段时丢失未变块的身份。本组未增加 rope、解析缓存或后台视图接线，也未验证大文档输入延迟。

## 坐标与选区

`selection` 提供 UTF-8 byte、UTF-16 code unit、extended grapheme 的精确转换；超界、反序、拆开 UTF-8 标量或 UTF-16 surrogate 的范围直接拒绝，不隐式舍入。`unicode-segmentation = 1.13.3` 复用现有锁定依赖。`deletion_range` 只接受 grapheme 边界，返回整个相邻 cluster，覆盖 ZWJ、组合音标、旗帜和 CRLF。

`Selection` 带 generation，anchor/head 各自保留 `Before/After` affinity。权威定位使用原文 byte offset，以表示空文档和无所属块的 separator；`Position::from_block`/`block_position` 与当前 `BlockId + local byte offset` 互转。失效 generation 不重新解释为新文档位置。历史恢复源位置后重新解析所属块，不强行复活已删除块的旧 ID。视觉 bidi、软换行、shaping cluster 和平台范围修正策略由 RM18/32 接入。

## 富文本命令

`InlineContent::for_block` 从 RM15 的 mdast 投影取得可编辑 paragraph、heading、list/quote 内段落和 table cell。范围按**解码后的逻辑文本**计算，与原文坐标分开；每份投影保留 generation 和原文前置条件。`format` 支持 strong/emphasis/strike/code 的添加与局部移除，以及 link 设置/更新/移除；`replace` 接受字面文本和明确的 `Marks`，不会把输入的 `*`、链接括号等误当作用户插入的格式。空选区格式不在内核中建立第二份输入状态，返回 `UnsupportedInline`；视图可在后续输入时传入明确的 marks。

命令在最小 inline 容器内拆分并合并相同 marks 的 runs，序列化后裁掉相同前后缀，只提交实际不同的源码区间。未编辑容器/分隔不变化；容器内部可规范化 Markdown 拼写。边界字符与语法标点使用数字实体，避免相邻强调分隔符歧义及现有 backslash-escape 安全降级；不会保留所有原始 mark 分隔符拼写。代码 span 选择不与内容冲突的 backtick 长度，表格代码中的管道单独转义，链接目标/标题保留实体解码语义，硬换行沿用当前 CRLF/LF 风格。

生成语法必须重新解析为同样的 text/marks/link/break runs，否则命令失败。链接构造拒绝控制字符和未知 scheme，允许 http/https/mailto/tel/anynote/anynote-resource 及相对链接；现有未知源内容仍保持原文。opaque、directive、未支持的 inline atom 不进入这个修改器，后续业务按各自任务接入。格式无变化时保留原文字节、generation 和历史。

## 撤销与预算

历史仅保存 changed-byte patches 及前后选区，不保存每步完整 `Document`/AST 快照。一个事务是一笔 undo；同块、光标连续、时间单调且间隔不超过配置窗口的普通源码插入/前删/后删可以合并。换行、移动选区、跨块、粘贴、格式、IME commit 和 undo/redo 打断合并。调用方使用单调毫秒时间；逆序时间不合并。

默认最多 500 步、8 MiB 记账字节、750 ms 合并窗口，均可通过 `HistoryBudget` 配置。字节记账包含片段 capacity 与条目/patch 元数据，不等于进程 RSS；undo/redo 共用预算。超限丢弃最旧 undo，单条超过预算则不保留该条，正文始终完整保留。新实质修改清空 redo；取消组合、失败或空改动不清空 redo。

undo/redo 在临时源缓冲验证并重放整组正/反 patch，再一次发布文档与选区，产生新的 generation。临时事务准备和全量重解析仍可能分配正文缓冲；“增量历史”不表示所有执行阶段零拷贝。内存撤销不改变数据库 revision、不可变资源或远端状态。

## 组合输入

`begin_composition` 冻结基础源范围与选区，返回递增 token；`update_composition` 更新独立 preedit 和其内部选区。`display_source` 仅按需组装显示 overlay，`document().serialize()` 始终返回已提交正文。预编辑不增加文档 generation/历史，也不执行格式转换、保存或网络副作用。组合期间拒绝普通修改、选区移动、undo/redo 和重复 begin。

`commit_composition` 将最终源文字（可覆盖最后的 preedit）提交为一个事务；富文本适配层使用冻结 `InlineContent` 生成字面文本事务，再交 `commit_composition_transaction`，由同一 owner 强制作为独立 composition 历史。提交失败保留 preedit；成功后旧 token 不能再次提交。`cancel_composition` 丢弃 overlay、保持原正文/选区和 redo。空字符串 commit 可删除原选区。

RM18 应使用同一 token 协调平台 marked range 与视图几何，富文本预览由其逻辑投影呈现；不能把源码 overlay 当作已完成的富文本 IME 视图。RM19 在 composition 活跃时必须延后 flush，等平台确认 commit/cancel 后再保存或关闭，不能因已有 committed source 就跳过尚未结束的组合。这里没有平台事件、候选窗、焦点或保存行为的验收证据。

## 验证方法

```sh
cargo test -p anynote-core -p anynote-editor --offline --locked
cargo clippy -p anynote-core -p anynote-editor --all-targets --offline --locked -- -D warnings
python3 scripts/check-rust-workspace.py
```

结果按实际运行记录；设备、云端、性能及最终候选的剩余验收统一见 [TODO](TODO.md)。
