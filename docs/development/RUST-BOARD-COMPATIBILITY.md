# Rust 白板兼容契约与差分方法

本文件定义 RM22 的 scene 边界、旧版动作证据和复现方法；进度只在 [TODO](TODO.md#rm22) 维护，实际运行结论在[实施记录](IMPLEMENTATION.md#rm22)。RM23 负责原生绘制/输入，RM24 负责资源、预览及 revision 原子保存。当前内核尚不能替换完整 Excalidraw 编辑器。

## 数据与事务边界

实现位于 [`anynote-editor::board`](../../crates/anynote-editor/src/board/mod.rs)，没有 GPUI、数据库、浏览器或文件读取依赖。继续保存现有 `elements/appState/files` JSON，不引入另一种白板持久格式。

- `Scene::parse/serialize`：没有有效编辑时返回原始 JSON 字节，包括空白、字段顺序和数字拼写；撤销到初始状态也恢复原字节。有效编辑后 JSON 格式可以变化，未知字段、未知元素、files/resourceId、绑定和未改的业务值保留。非法 JSON、重复 ID、已知元素缺失或非法几何明确报错，不清空场景。未知类型可以保留，但直接修改被拒绝。
- `Element`：原始字段是唯一权威值，`ElementKind`、`Geometry`、`world_points` 提供类型化读取。图形/文本/图片的局部矩形绕中心旋转；线/箭头/手绘按实际点集中心旋转，支持负局部坐标。已有 `crop/scale`、压力、箭头 fixed segment、elbow、未知 binding 属性照原值保留；保留字段不代表已实现编辑算法。
- `Board`：唯一草稿、selection 和历史 owner。选择展开组、容器文字和 frame 子元素；`apply_batch` 是一次可撤销事务，失败保持 scene、selection、redo 和原字节不变。调用者把一次拖动合并成一次提交，不把每个 pointer move 都写历史。`EditStamp` 由调用者提供时间和 nonce；同一事务每个变化元素只递增一次 version。
- 历史按调用者指定的条数限额保留，使用 `Arc` 共享未修改元素和 scene 字段。插入/复制不重复编码同一 file；插入遇到文件 ID 内容冲突或缺失引用会整笔回滚。没有做长场景内存/性能验收，也没有磁盘草稿日志。
- `Text` 接受测量后的几何；`BindText/BindArrow` 只提交双向引用关系，不自动测量文字、选择吸附点或重新路由线。后续布局必须与关系变更放在同一事务；当前未支持的绑定几何操作会返回错误。`Geometry::local_to_world` 用于矩形局部空间，路径应调用 `Element::world_points`。
- 层级操作以数组顺序为权威，结构编辑后重建符合 Excalidraw base-62 fractional index 格式的正整数键。无修改读写保留原 index。此策略不等于上游最小化 `syncMovedIndices`，不宣称协作/合并算法等价。

## 冻结依据与可达性

[参考语料](../../tests/fixtures/rust-board/actions.json) 固定本地安装的 `@excalidraw/excalidraw@0.18.0`、全部开发 bundle 的 SHA-256、元素类型声明及字段名、[`WhiteboardEditor.tsx`](../../apps/desktop/src/WhiteboardEditor.tsx) 摘要和 91 个注册 action 名。依赖/宿主配置漂移使参考检查失败。字段清单来自发行包 `.d.ts`，不是从 Rust 当前支持集合反推。

宿主设置 `loadScene:false`、`saveToActiveFile:false`、`export:false`、`toggleTheme:true`；应用自己读取 scene、选取背景/scroll/zoom、保存 files 并生成 PNG。**菜单项关闭不自动证明同名快捷键或上下文动作不可达**。91 个 action 是注册库存，尚未逐项实际执行 AnyNote 菜单、上下文菜单、快捷键及条件入口；这部分仍是 RM22.1 的缺口。

| 类型 / 操作族                   | 旧版来源与暴露证据                                                            | 当前 Rust 证据与限制                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| rectangle / diamond / ellipse   | 0.18 默认 SHAPES 工具栏；类型声明                                             | 字段保真、输入完整元素的插入、独立几何修改、样式、对齐/分布/翻转；尚无绘制/拖动宿主                                         |
| text                            | 默认文字工具；容器文字由 action 提供                                          | 原文/字体/容器字段保留，提交外部测量结果；字体切换、换行、autoResize、容器排版未完成                                        |
| line / arrow                    | 默认工具；线编辑及箭头类型 action                                             | 点集、端点引用、箭头类型/固定段字段保留；无绑定路径点编辑及封闭绑定集合平移；开放绑定更新、elbow 路由、点编辑完整语义未完成 |
| freedraw                        | 默认手绘工具                                                                  | 点与压力更新、长度/有限值校验；实际采样、简化、手绘笔迹渲染与缩放差分未完成                                                 |
| image                           | 默认图片工具与粘贴/导入路径                                                   | file/resource ID 保留、完整元素插入、独立矩形缩放/旋转、翻转 scale；crop、粘贴解析、解码/纹理交付未完成                     |
| frame                           | 更多工具及 frame actions                                                      | frameId 关系、选择展开与整体平移；跨框层级、包裹选择、resize 的成员重算未完成                                               |
| iframe / magicframe             | 持久类型存在，生成能力依赖宿主回调/条件                                       | 保留数据；当前 AnyNote 未提供完整 AI 回调，不能从类型声明推断可创建。实际入口待核验                                         |
| embeddable                      | 存在更多工具 action；内容可用性受 URL/网络影响                                | 保留 link/未知内容，不读取 URL、不执行 HTML；真实可达性与渲染另验                                                           |
| selection、未来类型             | 类型存在或未知数据                                                            | 按 opaque JSON 保留，不当作已完成的持久图形编辑支持                                                                         |
| 选择、组、层级、删除、锁定      | 默认 actions/context menu/key handlers 源码                                   | 普通组展开、嵌套组字段、双向解绑、墓碑删除、锁定；组编辑模式、跨其他组/框逐层移动仍未完成                                   |
| 复制/粘贴、库、搜索、链接、导出 | 注册库存分别存在 copy/paste/cut、library、search、hyperlink、copyAsPng/Svg 等 | 已有提供 ID 映射的复制原语；系统剪贴板、库导入、搜索 UI、链接交互、SVG/PNG 导出未完成，不能把 JSON 克隆当作全部粘贴通过     |
| 缩放、平移、主题/网格/禅模式    | 宿主持久子集与默认 view actions                                               | `View` 更新持久背景/scroll/zoom；主题、网格等瞬态输入与展示交 RM23，不写入第二份权威 scene                                  |

## 操作差分口径

[`rust-board-reference.mjs`](../../scripts/rust-board-reference.mjs) 将锁定发行包的内部 `actions` 和真实 `Scene` 暴露给隔离 Chromium，只在测试进程执行 JS。全部网络请求阻断；没有改产品依赖、把 React 放入 Rust 或访问真实用户库。它执行真实 `action.perform`，没有以 Rust 算法生成预期值。

当前串行轨迹为 26 步：描边、背景、填充、线宽、线型、粗糙度、透明度、组、置顶/置底/前移/后移、解组、水平/垂直分布、六种对齐、水平/垂直翻转、锁定/解锁、删除。随机 group ID 映射为固定测试 ID；粗糙度的 seed 保留在期望和命令中，不能像时间戳一样剔除。夹具同时包含文字、线、箭头、手绘、图片、frame、iframe/embeddable，证明这些未受影响字段不会被其他操作清空，不证明它们全部可编辑。

Rust 对每一步所有业务 JSON 值和数组顺序做比较，并按每个有效编辑逐步 undo/redo。仅忽略 `version/versionNonce/updated/index` 的具体值：前三者由 Rust 的事务 stamp 单独测试，index 单独验证顺序与合法格式策略。整数与浮点数字用 JSON 数值语义比较；未知大整数另有精确保留断言。没有忽略 `seed`、几何、绑定或图像字段。

此轨迹不是全部 action 矩阵，也没有旧版 pointer、旧版历史引擎、剪贴板或像素差分。复杂 scene 和所有当前可达操作完整验证仍是 RM22.3 门槛，不能由这 26 步替代。

## 复现

```sh
cargo test --locked --offline -p anynote-editor --test board
cargo clippy --locked --offline -p anynote-editor --all-targets -- -D warnings
node scripts/rust-board-reference.mjs
```

参考引擎需要已安装的 pnpm 依赖和本地 Chromium；优先读取 `RM22_CHROMIUM`，否则使用 Playwright 缓存。受限沙箱若拒绝 Chromium 的 socket/进程启动，应在允许本地浏览器测试的环境运行。默认只核对夹具；审阅依赖、宿主或轨迹变化后才用 `node scripts/rust-board-reference.mjs --write` 更新。运行日志与临时 bundle 在 `tmp/rm22/`，不是产品资产。无需网络、Node 服务或 Notebook 数据库来运行 Rust 测试。
