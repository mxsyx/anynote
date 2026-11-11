# RM27 系统 WebView 与视频

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 所有权与入口

- `apps/desktop-rust/src/webview/` 是唯一系统媒体宿主；依赖锁定 `gpui-webview =0.9.0`、`lb-wry =0.53.3`，Apache-2.0，复用 Kit 0.9.0 / gpui-pre 0.3.11。无 Node、React、独立 JS 运行时或第五个以上的 workspace 工程。
- `DocumentEditor` 的插入菜单与斜杠菜单提供“视频…”。静态 Notebook 偏好 `video` 控制插入、刷新和播放；播放另须 `remote_embed`。偏好从后端重新读取，失败不放行。插入/打开笔记不自动连接 provider。
- GPUI 呈现视频标题、已有缩略图、更新信息、播放和浏览器链接。未知版本仍走原文入口。URL 只接受无凭据 HTTPS；普通 URL 是不可嵌入链接卡。
- `MediaHost` 在显式播放后创建，最多一个活跃宿主。播放器占独立内容面，不放入正文虚拟滚动区域；Kit 更新原生 bounds。Kit Dialog/Sheet 出现时 prepaint 隐藏原生 child；编辑命令、切笔记、关闭、释放 Entity 时销毁宿主和任务，正文仍由 RM19 flush 决定关闭。
- `MediaHost::close` 先撤销本地能力和数据，显式隐藏 child，再释放 Entity/槽位；不保留 raw WebView handle，不执行保存。冻结/重建要新建 Binding，旧 epoch/token 不继承；本地页面仅允许首次导航，reload 不复用旧 bridge。

## 本地 bridge 与资源

本地模式与外部播放器使用不同 builder。当前本地模式提供固定的离线探针页面和复用接口，不是任意 HTML 执行器；PDF/白板继续原生实现。

控制消息为版本化 JSON：`protocolVersion/requestId/binding/token/message`。Binding 含 `viewId/epoch/document(notebook,note)/revision`。来源使用 Wry 提供的 URL，必须精确匹配该会话 `index.html`；不信任消息中声称的 origin。Windows 映射为 `http://anynote-view.<viewId>`，macOS/Linux 为 `anynote-view://<viewId>`。

- 只接受 ready、rendered、failed、viewport。未知字段、未知消息、错 token/修订、过期会话、重复请求均拒绝。没有 run、SQL、文件路径、业务写命令或凭据接口。
- 控制消息最多 64 KiB；每会话每秒最多 120 次控制/资源请求；接收通道 32 条，超额丢弃；重放集合最多 4096 个 ID，耗尽后需重建。
- `publish_resource` 只接受与 Binding 相同文档和修订的原生资源，签名和图像元数据校验后只开放 PNG/JPEG/WebP。调用方负责先通过现有 `AssetScope`/`DocumentResource` 获取受限修订字节，不能把页面提交的 scope 当授权。
- 页面只得到随机临时资源 URL，不得到原始 resource ID、绝对路径或后端租约。最多 16 个资源、8 MiB 合计；GET 单段 Range 支持闭区间、开放尾段和 suffix，每次最多 256 KiB，非法/多段范围 416，非 GET 405，越权/撤销 403。销毁清空资源并拒绝包括 HTML/脚本在内的后续请求。
- 本地 CSP：default-src none，script/style/img/connect 仅 self，frame/object/base/form 禁止。禁止下载、弹窗和拖入文件；只读打包脚本序列化 JSON 参数，没有用户文本脚本拼接。权限头禁用 camera/microphone/geolocation/clipboard。

窗口关闭取消 UI 异步任务；metadata 的 CancelWait 同时 abort 后端只读下载任务。原生资源响应有固定分块预算，无后台无界缓存。系统引擎最后一个帧/handle 的释放时点由 Kit/Wry 决定，100 次循环不是系统 WebContent RSS 或真实设备焦点验收。

## 视频保存与元数据

`anynote-core::video` 统一 provider/ID 和 URL 规则，RM07 HTML 导入复用它。`anynote-editor::video` 用既有 directive 字段序列化器产生一次事务，保留未知属性、未知 JSON、周边正文与撤销历史。

更新信息先 flush；取得 epoch、generation、block 后在有界后台请求中读取元数据。正文变化、切笔记、关窗或新命令使任务失效；迟到响应不写入新笔记。标题、`thumbnailResourceId`、`fetchedAt` 通过唯一编辑事务进入 SaveController，缩略图复用现有 image staging/upload，与正文同次 CAS 保存；失败保留未保存草稿。重交旧基线按 CAS 拒绝，断线沿用 RM19 权威快照核对，未引入新保存者或幂等回执假设。

下载复用 RM07 的 DNS 全答案校验、固定连接 IP、peer 校验、重定向/取消/超时和字节预算。元数据最多 1 MiB，缩略图最多 4 MiB，每次下载 6 秒；标题最多 240 UTF-16 单元。JSON 按 provider 字段解析，通用 HTML 只读 OG/Twitter/title。缩略图校验 provider CDN，再检查真实图片格式/尺寸，缓存为原生 CAS 资源；不下载视频。浏览器打开是明确恢复操作，不计嵌入播放通过。

私有 desktop 协议由 v4 升至 v5，新增类型化 `VideoMetadata` command/reply。schema v5 与旧正文 `core.video` v1 格式不变。

## Provider 与 CSP 约束

旧 `apps/desktop/index.html` 仅配置 `frame-src https://www.youtube-nocookie.com`，没有 Vimeo/Bilibili；旧文件作为迁移基线保持不改。

| Provider   | 重建 URL                                                         | 当前原生策略与证据                                  | 未验收                                     |
| ---------- | ---------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------ |
| YouTube    | `https://www.youtube-nocookie.com/embed/{11位ID}`                | 固定模板、仅该 embed 的 frame-src/导航              | WKWebView 实际播放、referrer/provider 限制 |
| Vimeo      | `https://player.vimeo.com/video/{6–12位数字}`                    | 原生 wrapper 使用独立 frame-src                     | 播放、重定向与受限视频                     |
| Bilibili   | `https://player.bilibili.com/player.html?bvid={BV号}&autoplay=0` | 原生 wrapper 使用独立 frame-src；校验 ID/模板与转义 | 播放、地区/登录/编解码差异                 |
| 通用 HTTPS | 无 iframe                                                        | 仅原生链接卡和显式元数据刷新                        | 公网端点验收归 RM35                        |

外部播放器没有 IPC handler、custom scheme 或业务 token；每次使用 incognito，iframe sandbox 仅 allow-scripts / allow-same-origin / allow-presentation，允许 fullscreen/encrypted-media，禁止弹窗、下载与父页面导航。父 wrapper 的 CSP 只控制该 frame，**不能替 provider 页面限制其内部 CDN/脚本请求**。禁止为未验证的 provider 故障扩大为任意 frame/script 源。

## 平台边界

依据锁定依赖源码及 [Kit WebView 官方指南](https://gpui-kit.com/docs/webview/) 核对：

| 平台        | 启动/依赖                                                                           | 验收要求                                                            |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| macOS arm64 | 系统 WKWebView；Kit gpui-pre child                                                  | 验证 bridge/Range、bounds、焦点、显隐和销毁循环                     |
| Linux       | 正常桌面入口显式 X11；Wayland 会话需 XWayland；WebKitGTK 4.1 与 GTK 3 开发/运行依赖 | 验证 X11/XWayland；纯 Wayland child 不支持                          |
| Windows     | WebView2；启动前设置 `GPUI_DISABLE_DIRECT_COMPOSITION=1`；否则宿主返回可见错误      | 源码约束与运行门控已接；未编译/真机验证；incognito 需 WebView2 ≥101 |

三平台真实系统焦点、Tab/Escape、浮层视觉/输入遮挡、跨屏 100/150/200% DPI、视频播放/编解码、子进程内存与故障恢复仍交 RM32；运行库发现/打包/签名交 RM36。原生探针中的三组 bounds 不冒充物理 DPI 验证；未改变 当前 F 任务 状态。

## 复现

```sh
cargo fmt --all -- --check
cargo test -p anynote-core -p anynote-editor -p anynote-storage --locked --offline
cargo test -p anynote-services --lib --test import --locked --offline
cargo test -p anynote-desktop --lib --test video_ui --features ui-tests --locked --offline
cargo clippy --workspace --all-targets --features anynote-desktop/ui-tests --locked --offline -- -D warnings
python3 scripts/check-rust-workspace.py
cargo build -p anynote-desktop --example webview_probe --locked --offline
target/debug/examples/webview_probe tmp/rm27/webview-probe-100.json 100
```

服务 socket 测试及原生探针需要本机 socket/AppKit 权限；环境错误须如实记录，不能计为应用通过。
