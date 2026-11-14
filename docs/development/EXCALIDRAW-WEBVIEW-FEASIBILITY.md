# Excalidraw + 系统 WebView 可行性验证

2026-11-14：**Linux 上的加载、编辑引擎、Rust 消息桥与文件保存重开链路可行；尚不能据此宣布三平台替换完成。** 本次没有发现必须重写白板内核的技术阻断。真实桌面的自动输入检查未通过，仍需实际鼠标键盘与输入法验收。

本文记录最初的隔离技术验证。用户随后授权正式替换，当前实现与新增验证见[系统白板接入](EXCALIDRAW-WEBVIEW-INTEGRATION.md)；下述原型结果保留原有证据边界。

## 原型与职责

- Rust 宿主：`apps/desktop-rust/examples/excalidraw_webview_probe.rs`。复用现有 `gpui_webview::WebView::build`、GPUI 窗口和 Wry，自定义本地资源协议及受限消息桥。
- 前端与驱动：`scripts/excalidraw-webview/`。Excalidraw 0.18.0、React/React DOM 19.1.1、Vite 6.3.6，独立 npm lockfile；安装和构建产物只进入 `tmp/excalidraw-webview/`。
- Excalidraw 独占活动场景、选区和 undo/redo；Rust 接收完整保存快照，写入隔离 JSON 文件，并在重建 WebView 时重新读取。没有在 Rust 同步实现第二套编辑内核。
- HTML、JS、CSS 和字体均在本地；运行原型无需 Node、开发服务器、Electron 或远程页面。Node 只用于构建。前端构建目录本次约 21 MiB，含未按功能裁剪的动态块与字体，不是安装包增量或运行内存测量。
- 本次使用合成数据，不打开日常库。JSON 文件写入不代表已接通 AnyNote 正式保存事务、附件闭包、冲突和历史版本。

## 环境与结果

Linux x86_64；GPUI Kit / gpui-webview 0.9.0；lb-wry 0.53.3；WebKitGTK 2.54.2。项目使用 GPUI pre 后端；Linux 宿主显式选择 X11，在当前 Wayland 桌面下通过 XWayland 运行。

| 验证项                                   | Xvfb + 系统 WebKitGTK    | 当前桌面 XWayland，200% 缩放   |
| ---------------------------------------- | ------------------------ | ------------------------------ |
| 本地资源加载、真实 Canvas、JS → Rust IPC | 通过                     | 通过                           |
| 鼠标拖绘矩形，键盘输入并提交英文文本     | 原生 X11 事件通过        | 自动输入未通过，不能视为已验收 |
| 键盘撤销/重做，系统剪贴板复制粘贴        | 原生 X11 事件通过        | 未完成                         |
| Ctrl + 滚轮缩放，原生窗口 resize         | 通过                     | 未完成                         |
| 绑定箭头、中文文本、嵌图显示             | API 构造场景，通过       | API 构造场景，通过；截图核对   |
| PNG 导出，经 IPC 返回 Rust 写入          | 通过                     | 通过                           |
| 场景和图片写入，再销毁/重建三次          | 元素和文件 JSON 严格相等 | 元素和文件 JSON 严格相等       |
| 隐藏/显示，重开后继续鼠标绘制            | 通过                     | 显隐 API 通过；输入未完成      |
| 深色主题、捆绑 Virgil 字体               | 通过                     | 通过；截图核对                 |
| 退出与报告                               | exit 0，closed=true      | API 专项 exit 0，closed=true   |

完整 Xvfb 驱动通过 19 个检查；真实桌面 API 专项通过 11 个检查。二者都是实际系统 WebKitGTK，未用 Chromium/Playwright 页面代替。Xvfb 的输入事件并非 JavaScript `dispatchEvent`，但它仍不代表物理设备、输入法或真实桌面输入验收。

本次临时证据位于 `tmp/excalidraw-webview/`：

- `run-20261114-193022-xvfb/`：从独立 lockfile 重建后的 19 项完整检查、截图、场景与 PNG。
- `run-20261114-192725-desktop-api/`：真实桌面 11 项 API 专项与截图。
- `run-20261114-192431-desktop/`、`run-20261114-192511-desktop/`：保留真实桌面自动输入失败记录。

以上目录可删除；本文保留结论与边界，源码和 lockfile 用于重现。

## 已观察到的集成问题

1. **资源初始化时机。** `EXCALIDRAW_ASSET_PATH` 应在模块执行前设置，原型通过 WebView initialization script 指定本地协议地址。仅在模块的静态 import 之后赋值太晚。
2. **CDN 字体回退。** Excalidraw 0.18.0 即使设置本地资源，仍声明 esm.sh 字体回退 URL。CSP 会记录这些被阻止的 `font-src` 声明。原型保留这些记录，只将明确的字体回退单独分类；其他 CSP 或 JS 错误仍使检查失败。Virgil 的 loaded 状态和导出图像证实本地字体能工作，未为通过测试放开 CDN。
3. **生成场景的规范化。** `convertToExcalidrawElements` 生成的箭头可能在恢复时调整局部原点、宽度及空绑定数组。合成 fixture 先经公开 `restoreElements` 规范化，再保存并严格比较重开结果。没有修改 Excalidraw 源码或放宽正式快照比较。
4. **输入焦点与时序。** Xvfb 中激活父窗口后需先点击 WebView；显隐恢复后也验证点击再编辑。拖拽包含实际的按下、移动与释放间隔。
5. **当前真实桌面自动输入仍有缺口。** 200% 缩放换算及显式窗口激活后，矩形检查仍失败，页面 `activeElement` 保持 BODY。额外诊断中窗口原点为 `(628,390)`，请求窗口内 `(1600,1000)`，鼠标回读却为根窗口 `(2820,1181)`。这说明自动输入定位结果不符合预期，但还不足以断言原因只在驱动，也未证明真实用户输入失败。需在目标桌面手动或用适配该 compositor 的工具验证。
6. **平台日志。** 真实桌面出现 GDK frame-clock critical 日志，但 API 专项完成并正常退出；Xvfb 出现 DRI3 提示。不能据此宣称 GPU 加速、资源无泄漏或性能达标。

## 尚未覆盖

- macOS WKWebView、Windows WebView2；当前探针在 Windows 应沿用项目的 `GPUI_DISABLE_DIRECT_COMPOSITION=1` 启动约束。
- 当前桌面的真实输入、中文 IME 候选窗/组合输入、跨应用剪贴板、文件拖放、触控笔及压力。
- GPUI 菜单/弹窗覆盖 WebView、裁剪、应用级快捷键和焦点往返。当前 gpui-webview 在未启用 GPUI Fast 时明确存在原生子视图覆盖 GPUI 内容的限制；本原型只有一块完整白板视图，没有验收混合叠层。
- 全部工具、复杂大场景、长期编辑、全进程内存与启动性能对照，以及崩溃恢复。
- 正式库的附件版本、冲突检查、预览与正文原子保存。探针的开发控制文件和诊断消息协议不能直接作为产品接口。

因此可以继续评估产品接入，无需先实现另一套完整图形编辑内核；正式替换决策仍应以真实桌面输入、目标平台和保存契约验证为条件。

## 重现

准备需要 npm 包访问；原型运行只使用本地资源。Linux 需要项目现有的 GTK/WebKitGTK 开发与运行依赖，以及 `Xvfb`、`xdotool`、ImageMagick `import`。

```sh
python3 scripts/excalidraw-webview/probe.py prepare

# 隔离 X11 显示器：真实系统引擎与 X11 输入，不是物理设备验收。
python3 scripts/excalidraw-webview/probe.py run --xvfb

# 当前桌面：会激活窗口、移动鼠标、操作键盘和剪贴板。
python3 scripts/excalidraw-webview/probe.py run

# 输入受自动化环境限制时单独验证 API；报告明确标记 API only。
python3 scripts/excalidraw-webview/probe.py run --api-only

# 手动检查白板，使用独立临时输出目录。
target/debug/examples/excalidraw_webview_probe \
  tmp/excalidraw-webview/dist tmp/excalidraw-webview/manual
```

驱动会输出报告目录，失败退出非零；`failure=null` 必须结合 `display`、`input_mode`、检查列表及关闭状态解读。源码检查另通过 Cargo locked/offline 构建、定向 Clippy 和 Rust workspace 依赖边界检查。
