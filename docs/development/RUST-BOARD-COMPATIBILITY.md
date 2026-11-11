# Rust 白板兼容契约与差分方法

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 数据与事务边界

实现位于 [`anynote-editor::board`](../../crates/anynote-editor/src/board/mod.rs)，没有 GPUI、数据库、浏览器或文件读取依赖。继续保存现有 `elements/appState/files` JSON，不引入另一种白板持久格式。

- `Scene::parse/serialize`：没有有效编辑时返回原始 JSON 字节，包括空白、字段顺序和数字拼写；撤销到初始状态也恢复原字节。有效编辑后格式可以变化，未知字段、未知元素、files/resourceId、绑定和未改的业务值保留。非法 JSON、重复 ID、已知元素缺失或非法几何明确报错。未知类型可保留，但直接修改被拒绝。
- `Element`：原始字段是唯一权威值，`ElementKind`、`Geometry`、`world_points` 提供类型化读取。矩形绕中心旋转；线/箭头/手绘按实际点集中心旋转，支持负局部坐标。保留 `fixedSegments/elbowed` 等字段不代表实现其编辑算法。
- `Board`：唯一草稿、selection 和历史 owner。选择展开组、容器文字和 frame 子元素；`apply_batch` 是一次可撤销事务，失败保持 scene、selection、redo 和原字节不变。调用者将一次拖动合并为一次提交；`EditStamp` 提供时间和 nonce，同一事务每个变化元素只递增一次 version。
- 历史按调用者指定的条数限额保留，使用 `Arc` 共享未修改元素和 scene 字段。插入/复制不重复编码同一 file；文件冲突或缺失引用整笔回滚。没有做长场景性能验收，也没有磁盘草稿日志。
- `Text` 接受测量后的几何；`BindText/BindArrow` 只提交双向引用，不自动测量文字、选择吸附点或重新路由线。非 elbow 箭头的开放绑定在目标平移、`Geometry` 和图片裁剪后，按 focus/gap、目标轮廓及相交关系更新端点；同时移动目标时按 scene 顺序更新，随选区直接变换的箭头不重复移动。带文字的连接布局和 elbow 重路由仍返回错误。矩形使用 `Geometry::local_to_world`，路径使用 `Element::world_points`。
- `CropImage` 按八个手柄计算源图 crop 和场景几何，支持旋转、两个方向翻转、比例约束、最小裁剪尺寸、源图边界以及恢复完整图片后 `crop:null`。调用者提供实际解码的 natural dimensions 与世界坐标 pointer；不接受非法 crop/scale/dimensions，不读取图像字节。已有未知 crop 字段保留。图片上的非 elbow 箭头绑定随裁剪更新；带文字布局仍拒绝。
- `ResizePath` 对 line/arrow/freedraw 点集按实际范围缩放，接受目标位置和旋转，保留压力、开放箭头绑定和未知属性。对应上游 `rescalePointsInElement(..., false)`；不会自行按指针重新吸附或解绑，不能替代全部 pointer resize。拒绝 elbow、需要文字布局和从零跨度凭空扩张的维度。
- `MovePoints { id, updates }` 接受 `(点索引, 新局部坐标)` 列表，拒绝重复索引、越界及非有限坐标；首点位移归零并修正原点/旋转中心，保留压力和未知字段。非曲线路径使用锁定 RoughJS 的带 seed 贝塞尔边界修正，包含默认 roughness=1；不替代完整曲线/控制点增删或 elbow 段编辑。
- `Flip` 支持无绑定、无组/frame 的普通 line/arrow/freedraw，保留压力；路径宽高与点集跨度不同时沿用旧版缩放及共同中心修正。仅选中带绑定箭头时按旧版交换两端 arrowhead，保持绑定和路径不变。混合绑定选区、文字及曲线路径翻转仍未闭合。
- 对齐/分布按最外层组的共同边界移动，重叠时采用 0.18 的中心间距规则；普通线段路径复用共同边界计算；仍拒绝曲线路径、frame 或需要绑定布局的组合。
- 层级移动保留连续选择段、跨组、frame 范围、容器文字对和选择间墓碑。0.18 多个 frame 各选部分子项时，置顶/置底最终只保留最后一个 frame 的排列；Rust 明确保留该已差分行为。`Board::edit_group` 提供瞬态组内编辑上下文：选择仅展开当前组以下的子组，层级操作不越过编辑组边界，新分组插入当前组之前，复制只重映射子组并保留父组。切换组不写 scene 或增加历史；场景修改的 undo/redo 同时恢复选区和组上下文。原生入口由 RM23 接线。
- `ResizeFrame` 只改变未旋转 frame 的几何，按包含/相交、完整组和原有成员关系重算 `frameId`，容器文字随容器加入或退出；不会缩放/移动成员图形。选中的 frame 同步更新展开选择。未知几何与曲线成员不能可靠判定时整笔拒绝，包裹创建和完整复杂场景仍待补齐。
- 数组顺序为层级权威，结构编辑后重建符合 Excalidraw base-62 fractional index 格式的正整数键。无修改读写保留原 index；不宣称上游最小 index 更新或协作合并等价。移植算法的 MIT 许可保留在 [EXCALIDRAW-LICENSE](../../crates/anynote-editor/src/board/EXCALIDRAW-LICENSE)。RoughJS 4.6.4 的线段随机扰动及贝塞尔极值仅用于内核几何，许可见 [ROUGHJS-LICENSE](../../crates/anynote-editor/src/board/ROUGHJS-LICENSE)，不代表 RM23 手绘绘制完成。

## 冻结依据与实际入口

[动作语料](../../tests/fixtures/rust-board/actions.json) 固定 `@excalidraw/excalidraw@0.18.0`、全部开发 bundle 的 SHA-256、元素类型声明及字段名、[`WhiteboardEditor.tsx`](../../apps/desktop/src/WhiteboardEditor.tsx) 摘要和 91 个注册 action。字段来自发行包 `.d.ts`；依赖或宿主漂移使检查失败。

[入口矩阵](../../tests/fixtures/rust-board/reachability.json) 在隔离 Chromium 中挂载真实 Excalidraw，使用 AnyNote 的四个 `canvasActions` 配置，分别记录默认主菜单、更多工具、空选择及图形/文字/线/箭头/图片/frame 的属性和右键菜单。运行时另注册 undo/redo，总计 93 个 action。

快捷键以固定 `MacIntel` 平台探测字母、数字、方向键和常用标点的 Ctrl/Meta/Shift/Alt 组合，经真实 `ActionManager.handleKeyDown` 分派；拦截 action 的副作用，仅记录路由。矩阵中的 `keyboard/panel/predicate` 是结构属性，`entries` 才是该状态实测入口。未匹配的 action 不等于不可达；copy/paste 等还会经过独立 DOM 处理器，编辑模式及弹窗条件入口未穷尽。默认菜单文字以 en-US 固定，产品仍使用 zh-CN。

实测确认：`loadScene:false`、`saveToActiveFile:false` 阻断其分派；`export:false` 不阻断 `saveFileToDisk` 快捷键，也不关闭默认 `saveAsImage` 菜单或右键 `copyAsPng/copyAsSvg`。不能把这类动作从迁移清单删除。探针使用完全拦截的 localhost 安全上下文，使剪贴板相关菜单可见；未访问系统剪贴板或真实文件。

| 类型 / 操作族                   | 现有入口证据                                        | Rust 实现与剩余边界                                                                                               |
| ------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| rectangle / diamond / ellipse   | 默认工具栏；真实创建/undo/redo                      | 保真、插入、独立几何、样式、组级对齐/分布及独立翻转；原生绘制归 RM23                                              |
| text                            | 默认工具与属性；真实创建/undo/redo                  | 字体/原文/容器字段保留，提交外部测量结果；真实字体、换行和容器排版未完成                                          |
| line / arrow                    | 默认工具、线编辑/箭头属性、右键；真实创建/undo/redo | 普通路径缩放/控制点移动/翻转、非 elbow 开放绑定端点更新；elbow、曲线及带文字连接布局未完成                        |
| freedraw                        | 默认工具；真实创建/undo/redo                        | 点/压力更新、缩放和翻转；实际采样简化与手绘渲染未完成                                                             |
| image                           | 图片工具、属性 cropEditor、右键裁剪/复制            | file/resource 保留，插入、矩形变换、scale 翻转及八手柄裁剪，更新普通箭头绑定；完整导入/粘贴、带文字连接布局仍待验 |
| frame                           | 更多工具及 frame 右键；真实创建/undo/redo           | frameId、选择展开、整体平移、跨框层级和 resize 成员重算；包裹创建与复杂曲线成员未完成                             |
| iframe / magicframe             | 持久类型存在；依赖宿主回调/条件                     | 保留数据；没有实际创建证据，不能由类型声明推断可创建                                                              |
| embeddable                      | 更多工具实际显示 Web Embed                          | 保留 link/未知内容；不执行 URL/HTML，创建、内容可用性及渲染另验                                                   |
| selection、未来类型             | 类型存在或未知数据                                  | opaque JSON 保留，不作为已完成编辑支持                                                                            |
| 选择、组、层级、删除、锁定      | 属性/右键/快捷键分派                                | 普通/嵌套组与组内选择、组级对齐/分布、组框层级、解绑、墓碑、锁定；组内原生入口归 RM23                             |
| 复制/粘贴、库、搜索、链接、导出 | 注册库存与默认菜单/右键/分派分别记录                | 有 ID 映射复制原语；完整剪贴板、库、链接、搜索与导出未完成                                                        |
| 缩放、平移、主题/网格/禅模式    | 默认控件及快捷键/右键                               | `View` 更新持久背景/scroll/zoom；瞬态输入展示归 RM23                                                              |

## 操作差分口径

[`rust-board-reference.mjs`](../../scripts/rust-board-reference.mjs) 只在测试 Chromium 中执行锁定发行包的真实 `action.perform`、几何函数和 Scene；不把 React/JS 加入 Rust 产品。外部网络全部阻断，localhost 页面由路由直接返回，不启动服务器或访问用户 Notebook。

- 主轨迹 30 步：原有样式、组、层级、解组、分布、六种对齐、翻转、锁定、删除，新增组级对齐/重叠分布。随机 group ID 固定映射；粗糙度 seed 保留，不像时间戳一样剔除。
- [层级语料](../../tests/fixtures/rust-board/ordering.json)：14 条序列，共 84 步，覆盖嵌套组、frame 内外/多框部分选择、绑定文字、墓碑和非连续选择。逐步比较所有业务 JSON 与数组顺序，逐步 undo/redo，并恢复初始字节。
- [几何语料](../../tests/fixtures/rust-board/geometry.json)：145 例，其中 128 个八手柄/旋转/翻转/比例组合，8 个原图/已有 crop 的边界拖动，9 个 line/arrow/freedraw 的负坐标、多点与零跨度缩放。预期直接来自上游函数；每例验证 Rust undo/redo。只对几何浮点使用 `1e-9 × max(1, |a|, |b|)` 容差，字段集合、数组、字符串和布尔值仍精确匹配。
- [连接和结构语料](../../tests/fixtures/rust-board/bindings.json)：95 条序列、364 步。覆盖默认 roughness=1 下的开放绑定目标移动/旋转/缩放、图片裁剪、开放绑定路径缩放、带绑定箭头翻转、双目标/重叠/多点连接、首点和中间点移动、路径翻转、组内层级与 frame 成员变化。预期由锁定旧版函数/action 真实执行产生；Rust 逐步对照业务字段并 undo/redo 到原始字节。几何浮点沿用 `1e-9` 相对容差，不放宽以容纳 RoughJS 修正差异。
- 入口探针另以真实指针创建 rectangle/diamond/ellipse/line/arrow/freedraw/text/frame，逐项通过旧版键盘 undo/redo。它证明这些入口可创建，未将浏览器回退字体视为原生字体验收，也不是这些操作的完整 Rust/旧版历史双向差分。

业务差分仅剔除 `version/versionNonce/updated/index`：前三者由事务 stamp 单独测试，index 单独验证格式与顺序策略。未知大整数另有精确保留测试。没有剔除 seed、绑定、图片 crop/scale、压力或未知字段。

上述语料仍未覆盖完整条件入口、文字布局、elbow、带文字/曲线的开放绑定、全路径操作、剪贴板/库/导出和完整旧版历史引擎。新增连接语料调用场景函数，不等于已经绘制并建立 ShapeCache 后的完整指针交互重放；该路径须与 RM23 的实际几何共同核对。像素、原生字体、资源闭包保存、三平台及性能另验；RM22.1–.3 不据此勾选。

## 复现

```sh
cargo test --locked --offline -p anynote-editor --test board
cargo clippy --locked --offline -p anynote-editor --all-targets -- -D warnings
node scripts/rust-board-reference.mjs
```

使用 Node >=24、已安装的 pnpm 依赖和本地 Chromium。优先读取 `RM22_CHROMIUM`，其次已有 Linux Playwright 缓存、本机 macOS Chrome、Playwright 默认浏览器。沙箱若拒绝浏览器进程，应在允许本地浏览器测试的环境运行。默认只核对夹具；审阅依赖、宿主或轨迹变化后才用 `--write` 更新。日志与 bundle 位于可删除的 `tmp/rm22/`，不是产品资产。Rust 测试不需要网络、浏览器或 Notebook 数据库。
