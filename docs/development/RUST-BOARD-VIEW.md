# Rust 原生白板视图与交互

本轮是 [RM23](TODO.md#rm23) 的可运行原型与局部交付，**不能替换完整旧白板，RM23.1–.3 均未完成**。前置 [RM22](RUST-BOARD-COMPATIBILITY.md) 的开放绑定、文字布局、frame 和路径操作仍有缺口。未引入 React/WebView/WASM 或新的场景格式。

## 使用入口与责任

```sh
cargo run --locked --offline -p anynote-desktop -- --board-window
cargo run --locked --offline -p anynote-desktop -- --board-window tests/fixtures/rust-migration/corpus/scene-input.json
```

入口是独立的「白板临时草稿」窗口；只读参数指定的 scene JSON（最多 16 MiB），关闭丢弃，没有自动保存、笔记 revision 或数据库写入。笔记中的白板块通过下文 [RM24 保存会话](#rm24) 接入同一视图，提供正文 flush、保存/取消、原图及预览闭包。CLI 不启动后端，也不接管原资料。`BoardView::new(Scene, Window, Context)` 和 `scene()` 提供后续宿主接入边界。

实现位于 `apps/desktop-rust/src/board/`：`BoardInput` 拥有唯一 RM22 `Board`，`view` 拥有 focus/Kit 控件及异步资源任务，`geometry` 给绘制/命中提供共同理想轮廓，`paint` 直接生成 GPUI 路径/纹理，`text` 以系统字体排版生成字形轮廓，`assets` 复用 RM21 有界解码，`clipboard` 用 RM22 Duplicate 重映射关系。新增直接依赖是锁文件已有的 `base64 0.22.1`，未新增 crate。

## 已交付的交互

- 工具栏：选择、平移、矩形、菱形、椭圆、线条、箭头、手绘、文字、图片。V/H/R/D/E/L/A/P/T 与 1–8 对应常用工具；图片由文件选择器或系统图片剪贴板插入。没有 frame/嵌入工具的完成声明。
- 同一世界/视口坐标转换处理负坐标、缩放和窗口原点。空心图形按轮廓命中，填充图形/文字/图片按面积命中；选择从顶层命中开始，Shift 增减展开后的组，框选包含完整轮廓；锁定和删除元素不命中。
- 一次拖动：预览使用临时 `Board` 调用相同 RM22 命令，不改权威场景/历史；释放一次提交，Escape 或失焦丢弃预览；失败保留原 scene 与 redo。Shift 约束移动、图形比例及角度；零距离绘制不插入不可见元素。
- 非绑定矩形/菱形/椭圆/图片提供四角缩放与旋转柄。缩放保持旋转后的对角锚点。路径提供无旋转控制点；禁止以绕过内核的方式编辑开放绑定/elbow。尚无边中点、组级变换、完整路径/文字缩放与旋转交互。
- 文字使用 Kit Textarea 的原生输入/组合能力，应用时按实际字体测量写 RM22 Text/Insert，支持多行及中文；关闭对话框恢复画布焦点。旧 scene 的宽高不会在打开时被重新写入。系统字体替代不等于 Excalidraw 字体一致；彩色 emoji 的位图字形尚未绘制。
- 图片复用 RM21 字节检查与有界解码；显示已有 crop、翻转、任意角度、透明度。资源解析仅接受 scene files 内嵌 base64，不访问 scene URL/文件路径，缺失/损坏显示占位和原因；笔记会话由 RM24 按冻结 note/revision 解析 resourceId，临时窗口仍只接收内嵌图片。预览单图最大 1280 边、总计 16MP；变换过程中图片纹理尚未做到逐帧重采样。
- 后台字体/图片任务带 generation 和取消标记，旧回调不能覆盖新请求；释放纹理时调用 GPUI drop_image。资产输入只依赖字体文本/图片几何与文件内容，平移、选择、普通图形变化不会重做图片解码。
- 撤销/重做、剪切/复制/粘贴/复制副本、组合/解组、层级、部分对齐/分布/翻转/锁定经同一命令入口调用 RM22。剪贴板保留未知 JSON、组、绑定、文件，粘贴重映射元素/组/文件 ID；非法或缺文件不发布半笔插入。尚未做与真实旧版系统剪贴板的互通终验。
- 平移、缩放与主题为视图状态，不消耗内容 undo；临时视口不写 `appState`。画布坐标、字形和图片尺寸是数据像素，命中容差/手柄是屏幕像素；工具栏、对话框、状态栏沿用 Kit 的 rem 和主题色。

## 绘制边界与后续顺序

原型使用理想路径加 seed 稳定的第二条扰动线和排线填充，**并非 RoughJS 像素等价实现**。曲线路径、roundness、压力笔刷、完整箭头头型、frame 裁剪/标题、未知类型的明确阅读呈现和完整主题转换仍需补齐。理想轮廓命中尚未包含全部粗糙边界、箭头头部与字体超出旧盒子的范围。

先补 RM22 的绑定/文字/路径布局，再接完控制点、吸附、frame、组内编辑、图片裁剪交互及完整属性面板。随后补库、搜索、链接、清空、导出/复制 PNG/SVG、网格/吸附/禅模式等冻结入口；逐项建立旧版输入序列及像素/几何对比。不能以本地矩形或 headless 测试关闭整个 RM23。

## 验证与复现

```sh
cargo test --locked --offline -p anynote-desktop --lib board::tests
cargo test --locked --offline -p anynote-desktop --features ui-tests --test board --test board_ui
cargo test --locked --offline -p anynote-editor --test board
cargo clippy --locked --offline -p anynote-desktop --all-targets --features ui-tests -- -D warnings
```

本轮新增 5 项资源/剪贴板/字体测试、6 项坐标/手势/历史测试和 3 项真实生产视图的 GPUI UI integration tests。后者以指针/快捷键/Kit 菜单验证绘制、undo/redo、移动、复制粘贴、删除、取消、文字焦点、图片和组合，包含 headless resize/2× scale/深色主题。它们不等于操作系统 IME、真实 DPI 或全部原动作兼容。

macOS 真窗口已用 RM01 scene 打开并绘制矩形；发现并修复 `LastResort` 优先匹配导致中文缺字的问题。去掉伪全字集字体后，真实字形 PNG 已人工检查中文及转义文本，最终 macOS 窗口再次确认中文显示正常；彩色 emoji 仍未完成。RM01 示例图片字节本身损坏，原生窗口明确显示损坏提示，没有伪造成功。

本地系统窗口在沙箱中因 NSPasteboard 返回空值而无法启动，在允许 macOS 窗口服务的环境可运行。临时 app 包/字形 PNG 位于可删除的 `tmp/rm23/`。跨平台、真机 DPI/字体、设备输入和性能属于 RM32，未关闭任何 V/A/F 条目。

## 冻结动作逐项接线盘点

以下 93 行来自 `tests/fixtures/rust-board/reachability.json` 的运行时 action 名称。它是**覆盖缺口盘点，不是 93 项通过报告**；“局部接线”只表示存在所列入口，不表示上游条件/像素/历史序列全覆盖。默认工具的八项旧版创建证据另见该 fixture 的 `creations`，本轮 frame 仍缺。

| 冻结 action                    | 当前状态    | 入口或缺口                                            |
| ------------------------------ | ----------- | ----------------------------------------------------- |
| `addToLibrary`                 | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `alignBottom`                  | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `alignHorizontallyCentered`    | 局部接线    | 更多 → 水平居中；RM22 Align                           |
| `alignLeft`                    | 局部接线    | 更多 → 左对齐；RM22 Align                             |
| `alignRight`                   | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `alignTop`                     | 局部接线    | 更多 → 顶端对齐；RM22 Align                           |
| `alignVerticallyCentered`      | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `autoResize`                   | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `bindText`                     | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `bringForward`                 | 局部接线    | 更多 → 上移一层                                       |
| `bringToFront`                 | 局部接线    | 更多 → 置于顶层                                       |
| `changeArrowhead`              | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeArrowType`              | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeBackgroundColor`        | 局部接线    | 仅固定浅蓝填充/无填充；无任意色控件                   |
| `changeExportBackground`       | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeExportEmbedScene`       | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeExportScale`            | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeFillStyle`              | 局部接线    | 纯色/排线入口；其他图案未完成                         |
| `changeFontFamily`             | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeFontSize`               | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeOpacity`                | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeProjectName`            | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeRoundness`              | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeSloppiness`             | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeStrokeColor`            | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeStrokeStyle`            | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeStrokeWidth`            | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeTextAlign`              | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeVerticalAlign`          | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `changeViewBackgroundColor`    | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `clearCanvas`                  | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `copy`                         | 局部接线    | 系统剪贴板 Excalidraw JSON；未做旧版跨应用实测        |
| `copyAsPng`                    | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `copyAsSvg`                    | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `copyElementLink`              | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `copyStyles`                   | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `copyText`                     | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `cropEditor`                   | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `cut`                          | 局部接线    | 复制成功后 RM22 Delete；锁定元素拒绝删除              |
| `decreaseFontSize`             | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `deleteSelectedElements`       | 局部接线    | Delete/Backspace/菜单 → RM22 Delete                   |
| `distributeHorizontally`       | 局部接线    | 更多 → 水平分布；核心拒绝开放绑定                     |
| `distributeVertically`         | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `duplicateSelection`           | 局部接线    | 主修饰键+D；调用 RM22 Duplicate                       |
| `exportWithDarkMode`           | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `finalize`                     | 局部接线    | 指针释放提交一次事务；不含多段线/绑定线编辑完成语义   |
| `flipHorizontal`               | 局部接线    | 更多 → 水平翻转；沿用 RM22 的类型限制                 |
| `flipVertical`                 | 局部接线    | 更多 → 垂直翻转；沿用 RM22 的类型限制                 |
| `goToCollaborator`             | 未实现/未验 | 条件入口尚未证明实际可达                              |
| `gridMode`                     | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `group`                        | 局部接线    | 主修饰键+G/菜单；沿用 RM22 组/frame 限制              |
| `hyperlink`                    | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `increaseFontSize`             | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `linkToElement`                | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `loadScene`                    | 未实现/未验 | 原宿主关闭；CLI 只读装载测试场景不等于该动作          |
| `objectsSnapMode`              | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `paste`                        | 局部接线    | Excalidraw JSON 与系统图片；无富文本/文件列表粘贴     |
| `pasteStyles`                  | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `redo`                         | 局部接线    | 主修饰键+Shift+Z/工具栏；本地 UI 通过                 |
| `removeAllElementsFromFrame`   | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `resetZoom`                    | 局部接线    | 主修饰键+0/菜单；重置平移和缩放，与上游仅缩放语义不同 |
| `saveFileToDisk`               | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `saveToActiveFile`             | 未实现/未验 | 原宿主关闭；RM24 独占保存责任                         |
| `searchMenu`                   | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `selectAll`                    | 局部接线    | 主修饰键+A；跳过锁定/删除元素                         |
| `selectAllElementsInFrame`     | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `sendBackward`                 | 局部接线    | 更多 → 下移一层                                       |
| `sendToBack`                   | 局部接线    | 更多 → 置于底层                                       |
| `setEmbeddableAsActiveTool`    | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `setFrameAsActiveTool`         | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `stats`                        | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `toggleCanvasMenu`             | 局部接线    | 更多菜单，不是原右键菜单                              |
| `toggleEditMenu`               | 局部接线    | 更多菜单；未复现全部原菜单条件                        |
| `toggleElementLock`            | 局部接线    | 菜单锁定；已选锁定元素仍可保留选择                    |
| `toggleEraserTool`             | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `toggleHandTool`               | 局部接线    | H/平移工具/空格/中键                                  |
| `toggleLinearEditor`           | 局部接线    | 无旋转、无绑定非 elbow 路径控制点；最多展示前 128 点  |
| `toggleShortcuts`              | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `toggleTheme`                  | 局部接线    | 更多 → 切换主题；仅展示，不重写 scene 色值            |
| `unbindText`                   | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `undo`                         | 局部接线    | 主修饰键+Z/工具栏；本地 UI 通过                       |
| `ungroup`                      | 局部接线    | 主修饰键+Shift+G/菜单；当前最外层组                   |
| `unlockAllElements`            | 局部接线    | 更多 → 解锁所有图形                                   |
| `updateFrameRendering`         | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `viewMode`                     | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `wrapSelectionInFrame`         | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `wrapTextInContainer`          | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `zenMode`                      | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `zoomIn`                       | 局部接线    | 主修饰键+=/菜单/修饰键滚轮，0.1–8 倍                  |
| `zoomOut`                      | 局部接线    | 主修饰键+-/菜单/修饰键滚轮，锚点不漂移                |
| `zoomToFit`                    | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `zoomToFitSelection`           | 未实现/未验 | 尚无原生完整入口及差分验收                            |
| `zoomToFitSelectionInViewport` | 未实现/未验 | 尚无原生完整入口及差分验收                            |

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

2026-11-09，macOS arm64、Rust 1.99.1、锁定 GPUI Kit 0.9.0，基于 `884bd2b` 工作树（保留已有 RM23 改动）。新增 core directive 1 项、真实后端/存储闭环 1 项、生产控件 UI integration tests 2 项。后端测试使用真实子进程、SQLite/CAS 文件、重启与资源写入故障注入；UI 测试渲染真实控件并发送原生输入，不是模拟 RPC。

验证覆盖：打开前未保存输入 flush；取消不写白板 revision；实际绘制、按钮/快捷键保存、重开/复制场景；冲突保留草稿；保存中关窗；scene/原图/PNG 历史读取；同 ID 被其他笔记重绑后仍使用旧 pin；跨库复制/移动；完整归档导入；开放导出 `.excalidraw.json` 重建内嵌原图；资源写入失败回滚、缺资源拒绝、已提交请求重启重试和后续正文防覆盖。

```sh
cargo test -p anynote-core -p anynote-editor -p anynote-storage --locked --offline
TMPDIR=/tmp cargo test -p anynote-desktop --features ui-tests --locked --offline
cargo test -p anynote-services --test archive --test transfer --locked --offline
cargo clippy -p anynote-desktop --all-targets --features ui-tests --locked --offline -- -D warnings
python3 scripts/check-rust-workspace.py
```

结果：128 + 72 + 18 项通过，3 个 ignored 均为既有父测试调用的子进程 fixture；Clippy 和 5 工程/844 锁定包边界检查通过。macOS 单实例测试需短临时路径与本机 Unix socket 权限；初次默认路径触发 SUN_LEN，沙箱随后拒绝 socket，最终以短路径和允许本机 socket 的隔离环境重跑通过。依赖缓存缺失时先 `cargo fetch --locked`，不升级依赖。运行日志位于可删除的 `tmp/rm24-*.log`，隔离资料由测试清理。

本轮没有新的桌面人工视觉验收、三平台真实 IME/读屏、物理卷/断电、用户资料接管或性能终验；这些不由本地自动化代替。保存闭包状态见 [RM24](TODO.md#rm24)，完整白板状态仍以 [RM22](TODO.md#rm22)/[RM23](TODO.md#rm23) 为准。
