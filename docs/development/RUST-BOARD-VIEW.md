# Rust 原生白板视图与交互

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 使用入口与责任

```sh
cargo run --locked --offline -p anynote-desktop -- --board-window
cargo run --locked --offline -p anynote-desktop -- --board-window tests/fixtures/rust-migration/corpus/scene-input.json
```

入口是独立的「白板临时草稿」窗口；只读参数指定的 scene JSON（最多 16 MiB），关闭丢弃，没有自动保存、笔记 revision 或数据库写入。笔记中的白板块通过下文 [RM24 保存会话](#rm24) 接入同一视图，提供正文 flush、保存/取消、原图及预览闭包。CLI 不启动后端，也不接管原资料。`BoardView::new(Scene, Window, Context)` 和 `scene()` 提供后续宿主接入边界。

实现位于 `apps/desktop-rust/src/board/`：`BoardInput` 拥有唯一 RM22 `Board`，`view` 拥有 focus/Kit 控件及异步资源任务，`geometry` 给绘制/命中提供共同轮廓，线条/箭头复用内核 seeded cubic strokes，`paint` 直接生成 GPUI 路径/纹理，`text` 以系统字体排版生成字形轮廓，`assets` 复用 RM21 有界解码，`clipboard` 用 RM22 Duplicate 重映射关系。新增直接依赖是锁文件已有的 `base64 0.22.1`，未新增 crate。

## 交互契约

- 工具栏：选择、平移、矩形、菱形、椭圆、线条、箭头、手绘、文字、图片。V/H/R/D/E/L/A/P/T 与 1–8 对应常用工具；图片由文件选择器或系统图片剪贴板插入。没有 frame/嵌入工具的完成声明。
- 同一世界/视口坐标转换处理负坐标、缩放和窗口原点。空心图形按轮廓命中，填充图形/文字/图片按面积命中；选择从顶层命中开始，Shift 增减展开后的组，双击逐层进入组内编辑、Escape 退出，预览继承编辑组范围；框选包含完整轮廓。锁定和删除元素不命中，frame 外被裁剪部分不命中，箭头头部参与命中。
- 一次拖动：预览使用临时 `Board` 调用相同 RM22 命令，不改权威场景/历史；释放一次提交，Escape 或失焦丢弃预览；失败保留原 scene 与 redo。Shift 约束移动、图形比例及角度；零距离绘制不插入不可见元素。
- 矩形/菱形/椭圆/图片提供四角缩放与旋转柄，frame 四角通过 `ResizeFrame` 修改。缩放保持旋转后的对角锚点。非 elbow 路径点通过 `MovePoints` 编辑，支持旋转和首点归一化；预览与提交共用命令。带文字绑定仍由内核拒绝，elbow 不展示不可用控制点。尚无边中点、组级变换、完整路径/文字缩放与旋转交互。
- 文字使用 Kit Textarea 的原生输入/组合能力，应用时按实际字体测量写 RM22 Text/Insert，支持多行及中文；关闭对话框恢复画布焦点。旧 scene 的宽高不会在打开时被重新写入。系统字体替代不等于 Excalidraw 字体一致；彩色 emoji 的位图字形尚未绘制。
- 图片复用 RM21 字节检查与有界解码；显示已有 crop、翻转、任意角度、透明度。更多 → 图形 → 裁剪图片接入 `CropImage`，使用已解码自然尺寸；四角拖动、Shift 固定比例、释放提交一次、Escape 取消。资源解析仅接受 scene files 内嵌 base64，不访问 scene URL/文件路径，缺失/损坏显示占位和原因；笔记会话由 RM24 按冻结 note/revision 解析 resourceId，临时窗口仍只接收内嵌图片。预览单图最大 1280 边、总计 16MP；变换过程中图片纹理尚未做到逐帧重采样。
- 后台字体/图片任务带 generation 和取消标记，旧回调不能覆盖新请求；释放纹理时调用 GPUI drop_image。资产输入只依赖字体文本/图片几何与文件内容，平移、选择、普通图形变化不会重做图片解码。
- 撤销/重做、剪切/复制/粘贴/复制副本、组合/解组、层级、部分对齐/分布/翻转/锁定经同一命令入口调用 RM22。剪贴板保留未知 JSON、组、绑定、文件，粘贴重映射元素/组/文件 ID；非法或缺文件不发布半笔插入。尚未做与真实旧版系统剪贴板的互通终验。
- 平移、缩放与主题为视图状态，不消耗内容 undo；临时视口不写 `appState`。画布坐标、字形和图片尺寸是数据像素，命中容差/手柄是屏幕像素；工具栏、对话框、状态栏沿用 Kit 的 rem 和主题色。

## 绘制边界与后续顺序

线条/箭头的 seeded cubic strokes 复用 F004 `linear_strokes`（RoughJS 4.6.4 算法），由原生画布、PNG 和命中共用离散路径；支持圆滑曲线和旋转。矩形/菱形/椭圆仍使用理想路径加第二条扰动线和排线填充，**尚非完整 RoughJS 像素等价实现**。箭头可区分开放、实心/空心三角、圆、菱形和 bar；头部尺寸和曲线切线还需旧版对照。frame 成员采用共同裁剪边界，原生绘制、PNG 与命中一致；标题、渲染选项和复杂 frame 几何仍待补齐。压力笔刷、图形 roundness、未知类型的明确阅读呈现、完整主题转换和字体超出旧盒子的范围仍需补齐。

属性对话框已接入任意描边/填充颜色、描边宽度、不透明度、线型、纯色/排线/交叉排线；无效输入不提交，修改字段合并为一次内核事务。样式复制/粘贴、六方向对齐、双轴分布、清空、文字复制、搜索定位、适应全部/选中图形与保持中心锚点的重置缩放已有入口。图库复用 `Library`，支持本窗口添加/插入/移除和 `.excalidrawlib` 导入/导出，关闭窗口前需显式导出；场景 JSON 和有界 PNG 导出、复制 PNG 在后台执行，不消耗 scene undo。PNG 沿用保存预览的最大 1280 边限制，目前导出整个场景。搜索与图库一次最多显示 100 项，图库分页/预览及应用级持久化仍待完成。更多菜单按排列、图形、文件、视图分组。

继续依赖 F004 的完整绑定/文字/路径布局，再接完吸附、frame 创建/包裹、路径中段及完整属性面板；补图库分页/预览、SVG、导出选项/选中范围、链接、网格/吸附/禅模式等冻结入口。当前裁剪在手势期间复用旧图片纹理，尚需准确实时裁剪预览。逐项建立旧版输入序列及像素/几何对比；不能以本地交互或 headless 测试关闭整个 F005。

## 验证方法

```sh
cargo test --locked --offline -p anynote-desktop --lib board::tests
cargo test --locked --offline -p anynote-desktop --features ui-tests --test board --test board_ui --test board_f005 --test board_f005_ui
cargo test --locked --offline -p anynote-editor --test board
cargo clippy --locked --offline -p anynote-desktop --all-targets --features ui-tests -- -D warnings
```

本轮增加 `board_f005` 的组范围/旋转路径/裁剪/曲线命中/frame PNG 裁剪回归及 `board_f005_ui` 的属性校验→搜索→图库插入流程。测试平台输入与 PNG 像素断言不等于原生 GPU 截图、真实系统剪贴板或完整 RoughJS 对照。

结果按实际运行记录；设备、云端、性能及最终候选的剩余验收统一见 [TODO](TODO.md)。

## 冻结动作逐项接线盘点

以下 93 行来自 `tests/fixtures/rust-board/reachability.json` 的运行时 action 名称。它是**覆盖缺口盘点，不是 93 项通过报告**；“局部接线”只表示存在所列入口，不表示上游条件/像素/历史序列全覆盖。默认工具的八项旧版创建证据另见该 fixture 的 `creations`，frame 交互仍有缺口。

| 冻结 action                    | 当前状态    | 入口或缺口                                                               |
| ------------------------------ | ----------- | ------------------------------------------------------------------------ |
| `addToLibrary`                 | 局部接线    | 更多 → 将选中图形加入图库；本窗口 Library，导入/导出/插入/移除           |
| `alignBottom`                  | 局部接线    | 更多 → 排列 → 底端对齐；RM22 Align                                       |
| `alignHorizontallyCentered`    | 局部接线    | 更多 → 水平居中；RM22 Align                                              |
| `alignLeft`                    | 局部接线    | 更多 → 左对齐；RM22 Align                                                |
| `alignRight`                   | 局部接线    | 更多 → 排列 → 右对齐；RM22 Align                                         |
| `alignTop`                     | 局部接线    | 更多 → 顶端对齐；RM22 Align                                              |
| `alignVerticallyCentered`      | 局部接线    | 更多 → 排列 → 垂直居中；RM22 Align                                       |
| `autoResize`                   | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `bindText`                     | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `bringForward`                 | 局部接线    | 更多 → 上移一层                                                          |
| `bringToFront`                 | 局部接线    | 更多 → 置于顶层                                                          |
| `changeArrowhead`              | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeArrowType`              | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeBackgroundColor`        | 局部接线    | 属性 → 任意颜色/transparent；内核 Style                                  |
| `changeExportBackground`       | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeExportEmbedScene`       | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeExportScale`            | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeFillStyle`              | 局部接线    | 属性 → 纯色/排线/交叉排线；zigzag 未接                                   |
| `changeFontFamily`             | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeFontSize`               | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeOpacity`                | 局部接线    | 属性 → 不透明度（0–100）                                                 |
| `changeProjectName`            | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeRoundness`              | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeSloppiness`             | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeStrokeColor`            | 局部接线    | 属性 → 任意颜色；无效输入留在对话框                                      |
| `changeStrokeStyle`            | 局部接线    | 属性 → 实线/虚线/点线                                                    |
| `changeStrokeWidth`            | 局部接线    | 属性 → 描边宽度（0–100）                                                 |
| `changeTextAlign`              | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeVerticalAlign`          | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `changeViewBackgroundColor`    | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `clearCanvas`                  | 局部接线    | 更多 → 文件 → 清空画布；解锁+Delete 同一事务，可撤销                     |
| `copy`                         | 局部接线    | 系统剪贴板 Excalidraw JSON；未做旧版跨应用实测                           |
| `copyAsPng`                    | 局部接线    | 更多 → 文件 → 复制为 PNG；全场景、有界 1280 边，尚非完整导出契约         |
| `copyAsSvg`                    | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `copyElementLink`              | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `copyStyles`                   | 局部接线    | 更多 → 图形/主修饰键+Shift+C；六项通用样式                               |
| `copyText`                     | 局部接线    | 更多 → 图形 → 复制文字；按 scene 顺序连接选中文字                        |
| `cropEditor`                   | 局部接线    | 更多 → 图形 → 裁剪图片；四角/Shift/Escape，旧纹理实时预览仍待完善        |
| `cut`                          | 局部接线    | 复制成功后 RM22 Delete；锁定元素拒绝删除                                 |
| `decreaseFontSize`             | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `deleteSelectedElements`       | 局部接线    | Delete/Backspace/菜单 → RM22 Delete                                      |
| `distributeHorizontally`       | 局部接线    | 更多 → 水平分布；核心拒绝开放绑定                                        |
| `distributeVertically`         | 局部接线    | 更多 → 排列 → 垂直分布；RM22 Distribute                                  |
| `duplicateSelection`           | 局部接线    | 主修饰键+D；调用 RM22 Duplicate                                          |
| `exportWithDarkMode`           | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `finalize`                     | 局部接线    | 指针释放提交一次事务；不含多段线/绑定线编辑完成语义                      |
| `flipHorizontal`               | 局部接线    | 更多 → 水平翻转；沿用 RM22 的类型限制                                    |
| `flipVertical`                 | 局部接线    | 更多 → 垂直翻转；沿用 RM22 的类型限制                                    |
| `goToCollaborator`             | 未实现/未验 | 条件入口尚未证明实际可达                                                 |
| `gridMode`                     | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `group`                        | 局部接线    | 主修饰键+G/菜单；沿用 RM22 组/frame 限制                                 |
| `hyperlink`                    | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `increaseFontSize`             | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `linkToElement`                | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `loadScene`                    | 未实现/未验 | 原宿主关闭；CLI 只读装载测试场景不等于该动作                             |
| `objectsSnapMode`              | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `paste`                        | 局部接线    | Excalidraw JSON 与系统图片；无富文本/文件列表粘贴                        |
| `pasteStyles`                  | 局部接线    | 更多 → 图形/主修饰键+Shift+V；同一 Style 事务                            |
| `redo`                         | 局部接线    | 主修饰键+Shift+Z/工具栏；本地 UI 通过                                    |
| `removeAllElementsFromFrame`   | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `resetZoom`                    | 局部接线    | 重置缩放保留画布中心锚点；不再重置平移                                   |
| `saveFileToDisk`               | 局部接线    | 更多 → 文件 → 导出场景；JSON 原文/未知字段保留，另有 PNG 导出            |
| `saveToActiveFile`             | 未实现/未验 | 原宿主关闭；RM24 独占保存责任                                            |
| `searchMenu`                   | 局部接线    | 工具栏/主修饰键+F → 文字搜索；结果选择并适应视口                         |
| `selectAll`                    | 局部接线    | 主修饰键+A；跳过锁定/删除元素                                            |
| `selectAllElementsInFrame`     | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `sendBackward`                 | 局部接线    | 更多 → 下移一层                                                          |
| `sendToBack`                   | 局部接线    | 更多 → 置于底层                                                          |
| `setEmbeddableAsActiveTool`    | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `setFrameAsActiveTool`         | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `stats`                        | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `toggleCanvasMenu`             | 局部接线    | 更多菜单，不是原右键菜单                                                 |
| `toggleEditMenu`               | 局部接线    | 更多菜单；未复现全部原菜单条件                                           |
| `toggleElementLock`            | 局部接线    | 菜单锁定；已选锁定元素仍可保留选择                                       |
| `toggleEraserTool`             | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `toggleHandTool`               | 局部接线    | H/平移工具/空格/中键                                                     |
| `toggleLinearEditor`           | 局部接线    | 非 elbow 路径点含旋转与首点归一化；最多 128 个柄，中段/追加/删除入口未接 |
| `toggleShortcuts`              | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `toggleTheme`                  | 局部接线    | 更多 → 切换主题；仅展示，不重写 scene 色值                               |
| `unbindText`                   | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `undo`                         | 局部接线    | 主修饰键+Z/工具栏；本地 UI 通过                                          |
| `ungroup`                      | 局部接线    | 主修饰键+Shift+G/菜单；当前最外层组                                      |
| `unlockAllElements`            | 局部接线    | 更多 → 解锁所有图形                                                      |
| `updateFrameRendering`         | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `viewMode`                     | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `wrapSelectionInFrame`         | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `wrapTextInContainer`          | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `zenMode`                      | 未实现/未验 | 尚无原生完整入口及差分验收                                               |
| `zoomIn`                       | 局部接线    | 主修饰键+=/菜单/修饰键滚轮，0.1–8 倍                                     |
| `zoomOut`                      | 局部接线    | 主修饰键+-/菜单/修饰键滚轮，锚点不漂移                                   |
| `zoomToFit`                    | 局部接线    | 更多 → 视图 → 适应全部图形；不修改 scene/history                         |
| `zoomToFitSelection`           | 局部接线    | 更多 → 视图 → 适应选中图形；未完成旧版缩放策略差分                       |
| `zoomToFitSelectionInViewport` | 未实现/未验 | 尚无原生完整入口及差分验收                                               |

<a id="rm24"></a>

## 白板保存与历史资源闭包

笔记的插入菜单/斜线命令提供「白板…」，已有块提供「编辑白板…」。插入先创建 `core.whiteboard@1` 空块；打开前等待 RM19 正文保存与 IME 完成，再固定笔记、head revision、正文 generation 和 directive ID。白板编辑期间正文视图被会话替代；独立 `--board-window` 仍是临时草稿，不接数据库。

`BoardSession` 拥有编辑会话、加载/上传任务和冻结请求；`BoardView` 只拥有 scene 交互与历史。读取 scene 和所有嵌图均使用原笔记/原 revision，后台完成 JSON/base64 处理，不按全局最新 resource 读取。取消丢弃白板编辑、不创建白板 revision；新插入空块在打开前的正文 flush 是独立正文提交。保存按钮与 Cmd/Ctrl+S 调用同一路径，提交期间冻结白板并禁止重复保存。复制场景始终保留一个可导出的草稿入口。

### 原子提交与重试

私有协议新增 `SaveBoard`，输入只包含冻结 `DocumentSnapshot`、directive ID、规范 scene JSON、新 scene/PNG resource ID 和本次新嵌图 ID。图片仍走 RM21 的有界分块暂存和 RAII 释放；不新增上传协议或持久表。后端校验块唯一性、note revision/head、完整图片上传、PNG 类型、fileId/files 引用及旧嵌图在原 revision 的授权范围。

保存准备从同一个冻结 scene 生成 PNG，抽出新增/改变的嵌图；未变嵌图继续使用原 resourceId。持久 scene 的 files 保留未知字段、created 等元数据，以 resourceId 引用原图，不写回临时 dataURL。directive 只替换 JSON payload 中的 scene/preview ID，保留其他字段、外围正文和换行。PNG 复用原生几何、排线、扰动线、箭头、字体轮廓与图片裁剪/旋转，不包含选择框/工具栏，最长边 1280。预览采用文档背景/颜色，不把深色 UI 的显示反色写入资源；其视觉精度仍受 RM23 已列渲染边界约束。

`persistence::commit` 经唯一 `WriteQueue` 调用既有 `save_note`：scene、PNG、嵌图、笔记正文、不可变 revision 与递归资源 pin 在同一 SQL 事务发布。资源写入失败允许留下不可引用的 CAS 孤立字节，但不能留下新 resource 绑定、部分正文或 revision。缺失图片、非法 scene 或过期 CAS 在发布前拒绝。

超时/断线保留同一次请求和字节，重连安装新后端客户端后重传。仅当当前 revision 恰为 base+1、正文以及 scene hash/preview ID 匹配时确认重复请求，不再次写 revision；出现后续编辑则拒绝旧请求。可确定的失败/冲突恢复草稿交互，允许复制或取消；结果未确认时保持重试状态，不把关闭当作保存成功。父编辑器还核对 epoch、head 与正文 generation，过期回调不能覆盖另一笔记或新正文。

应用内关窗/退出和切笔记等待显式白板提交确认，再完成正文生命周期；未保存白板关闭仅取消。RM19 的不可取消系统退出回调限制仍保留，不能保证 Dock/OS 强退时内存草稿留窗或跨进程恢复。

### 预算与版本

- scene JSON 最大 2 MiB，files 最大 128 项；限制超出时报错并保留草稿。
- 每次最多新增/改变 30 张嵌图，再加 1 张 PNG；上传与读取总预算 100 MiB、单图 50 MiB，沿用 RM21 分块和解码限制。
- 预览解码保留 RM23 单图 1280 边和总 16MP 限制；缺失/损坏的可见图片拒绝生成不完整预览。
- schema v5、`core.whiteboard@1`、Excalidraw JSON 和现有 scene MIME 不变；未知 scene/元素/files 字段继续保留。此处未宣称 RM22/23 全部动作或渲染兼容完成。

### 验证与复现

验证覆盖：打开前未保存输入 flush；取消不写白板 revision；实际绘制、按钮/快捷键保存、重开/复制场景；冲突保留草稿；保存中关窗；scene/原图/PNG 历史读取；同 ID 被其他笔记重绑后仍使用旧 pin；跨库复制/移动；完整归档导入；开放导出 `.excalidraw.json` 重建内嵌原图；资源写入失败回滚、缺资源拒绝、已提交请求重启重试和后续正文防覆盖。

```sh
cargo test -p anynote-core -p anynote-editor -p anynote-storage --locked --offline
TMPDIR=/tmp cargo test -p anynote-desktop --features ui-tests --locked --offline
cargo test -p anynote-services --test archive --test transfer --locked --offline
cargo clippy -p anynote-desktop --all-targets --features ui-tests --locked --offline -- -D warnings
python3 scripts/check-rust-workspace.py
```
