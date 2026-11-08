# 实施记录

> 当前存储为 SQLite schema v5 + 不可变附件文件，数据库按块增量、附件按文件增量，统一清单提交与恢复，见 [存储设计](../design/SQLITE-STORAGE.md)。下文历史云端和平台验收不能作为新格式的验收结论。

历史摘要核对：2026-10-21，源码基线 `e975c1c`。实际决策见 [ADR](../design/adr/README.md)，本轮核对与验证见 [G18 报告](history/todo-2026-10-24.md#g18)。原始执行记录和数值报告已移到可删除的 `tmp/reports/documentation/`；本文件与阶段交接只保留长期开发所需摘要。任务状态只在 [分组清单](TODO.md) 维护，规则见 [文档维护](DOCUMENTATION.md)。

<a id="rm13"></a>

## 2026-11-08 · RM13 偏好、凭据与插件状态读取/转换

交付 `anynote-services::config_migration`，仅接关闭后的保全副本，不激活日常资料。偏好读取复用 Rust LevelDB MemEnv，新增有界物理完整性检查以阻止库迭代吞错；固定 file/dev origin 和七类旧键，Latin-1/UTF-16 解码、值验证、点分层布局、temp/flush 发布与逆映射。四份 Electron 41.9.1 / Chromium 146.0.7680.216 合成格式样本覆盖正常退出、已刷入 WAL 后 SIGKILL，源字节与冻结 SHA-256 不变；旧进程未落盘值不在恢复承诺内。

凭据实现 Linux Secret Service v11、macOS Keychain v10、Windows Local State/DPAPI/AES-GCM 的原生只读原型及 OS keyring 新条目。只在内存解密，原 secret ID/连接 ID 与密文保全；拒绝覆盖已有不同秘密，写后回读，成功仍等待 capability 检查，失败明确需重新认证，结果均暂停任务。Linux 使用独立 D-Bus/XDG/私有 GNOME Keyring 验证 Electron → Rust → 新 OS 条目闭环并扫描输出目录无 token 明文。最初 Xvfb 未提供 GNOME 桌面标记时 Electron 选择 basic_text，测试按预期拒绝；显式选择 GNOME 后通过，没有启用明文降级。

已知 garden.preferences/session 两个业务的 0.1.0/0.1.1 状态按冻结 manifest checksum、设置 checksum 和行版本映射；保留未知字段及 source revision，提供受限逆映射。未知包完整复制且逐文件摘要，未知/非法 JSON 状态按原 value_json、版本和 revision 内容寻址保全。未执行旧脚本，也未将未知插件功能视为已替代。

本机 Linux x64、Rust 1.99.1、Node 24.11.1。`cargo test -p anynote-services --lib --locked --offline` 10/10 通过，services 整包回归另含 5 项 runtime 测试通过；services 全 targets Clippy（`-D warnings`）、Rust 五 crate 边界、冻结 TS manifest/Node crypto 向量检查通过；平台凭据 smoke 使用隔离合成账号，不访问日常 keyring。原始测试/Clippy/smoke 报告在可删除的 `tmp/rm13/`，复现入口和布局见[配置迁移文档](RUST-CONFIG-MIGRATION.md)。Windows/macOS 原生分支尚未编译/真机验收，三平台用户资料、锁定、跨设备及目录 ACL/断电仍归 RM32/33；RM14 负责完整复制、journal、调度及回退发布，不关闭任何 V/A/F 验收。

<a id="rm03"></a>

## 2026-11-08 · RM03 后端进程、通信、任务与诊断

完成 RM03.1–RM03.4，复用 RM02 五个工程与现有诊断/任务历史语义，不改 Notebook schema v5、不接旧 Node 后端。协议与业务接入边界见 [Rust 开发入口](RUST-DESKTOP-DEVELOPMENT.md#rm03-后端与公共接入契约)。工作区中 RM13/15/22 的并行修改保留，本记录不将其成果计入 RM03。

- RM03.1：同一二进制 `--backend` 在 GPUI 初始化之前分流；版本/epoch/递增请求 ID、静态命令与对应结果类型、结构化错误；控制帧 1 MiB、二进制块 256 KiB、头部 512 B，分配前校验。随机资源 token 提供 Range、释放与 60 秒过期；没有默认 TCP/HTTP 或插件 RPC。
- RM03.2：容量 16 的双向队列、14 个普通请求加 2 个取消/退出名额，避免背压堵住取消；客户端 deadline 与过期结果丢弃、任务 ID/sequence/时间戳、终态不可复活。独立运行状态库先持久化再发结果，重启/父管道断线标记 interrupted；后台进程监护负责 kill/wait 和重连。区分持久回执查询/同 ID 重试与普通保存的 revision/摘要核对，未确定结果保留草稿，绝不自动重放写入。
- RM03.3：实际子进程覆盖并发、满额取消、超时、截断/中断流、强制终止/重连、资源 token 失效、旧请求与过期响应、父管道 EOF、退出排空。修复退出竞态：先读完 stdout 已写出的结果，再将未答请求标记断线。`TaskHistory/Resources/background_decision` 与 core 恢复证据契约供后续业务复用；菜单及最后窗口关闭等待异步后端关闭。
- RM03.4：off/minimal/full、300 条有界事件、统计/丢弃计数、持久查询/导出/清空；仅收枚举与数值，正文/路径/URL/凭据无可写字段。保留首份损坏 native 配置，旧 Electron 诊断文件不动。覆盖重启、损坏、设置/清空/任务终态写失败、1000 条日志预算；写失败不发布虚假成功，也不把附属日志失败改报为业务提交失败。

本机 Linux 新增 **16 项 RM03 测试通过**：7 项进程测试、5 项 services 测试、3 项 transport/client 单测、1 项恢复证据单测。`cargo test -p anynote-core -p anynote-storage -p anynote-services -p anynote-desktop --all-features --locked --offline` 共 **30 项通过**，含现有平台/UI/SQLite 与当时并行 services 测试；另 1 个 ignored 是被父测试显式执行的子进程 fixture。`cargo clippy --workspace --all-targets --all-features --locked --offline -- -D warnings`、RM03 文件 rustfmt、依赖 guard、文档链接与 diff whitespace 检查通过。完整 workspace 测试在并行 editor 的 `upstream_action_sequence_matches_and_undo_redo_replays_every_state` 因 `changeStrokeColor` 对象键顺序断言失败，未越界修复；全仓 fmt 检查也曾遇到并行白板文件尚未格式化，因此不宣称完整工作区回归全绿。单实例 socket 在沙箱先报 EPERM，允许本地 IPC 后平台/UI 回归通过。

独立 Xvfb/X11 原生窗口探针通过输入/剪贴板/Dialog/主题缩放/第二实例唤醒与关闭退出，验证正常壳已启动真实 Rust 后端。串行进程测试重建的 50 次暖态 debug Ping p95 为 **1.752 ms**，相当于 150 ms 保存总预算的约 **1.17%**；这只测管道往返与运行诊断开销，不包含正文验证/SQLite 业务提交，不可据此宣称保存性能达标。临时证据为 `tmp/rm03/ipc-latency.json` 与 `tmp/rm02/native-x11-report.json`。

边界：当前只有连通性健康任务和有界内存资源（以诊断导出验证），实际 Notebook 存储/保存/回执/文件租约/归档/业务长任务分别随 RM04–12/19 接入，管理页随 RM29 接入。真实 OS 凭据、三平台生命周期、IME、实际设备/云/发行不在本组验收，M1 与 V/A/F 状态不变。代码留在现有工作区，未创建提交。

<a id="rm22"></a>

## 2026-11-08 · RM22 白板 scene 与操作内核（部分完成）

新增 `crates/anynote-editor/src/board/`：`scene` 保留原 JSON 与未知字段，`geometry` 处理矩形/路径坐标，`command` 持有唯一草稿、选择和有界 undo/redo，`operation` 执行可回滚的纯 scene 事务。复用 RM01 原始/旧 reader scene，继续使用 Excalidraw JSON；files/resourceId 不解析为 URL 或新资源，不新增 crate、持久格式、UI、数据库或 JS 运行时依赖。editor 复用已锁定的 serde/serde_json。工作区其他组并发修改的正文模型、后端和配置代码均保留。

已实现完整元素插入与文件冲突检查、独立几何/外部测量文字提交、无绑定路径/压力更新、封闭绑定集合平移、样式、普通组合、层级、独立形状对齐/非重叠分布/翻转、锁定/墓碑删除、显式 ID 映射复制、frameId 与双向 text/arrow 引用、持久视口字段。事务失败不改任何 scene/history；无效或未支持的绑定几何组合明确拒绝。未改场景与撤销至初始状态返回原始字节；结构编辑重建合法 fractional index，但不宣称与上游最小 index 更新或协作合并等价。

`tests/fixtures/rust-board/actions.json` 冻结 Excalidraw 0.18.0 的 bundle/type/wrapper 摘要、91 个注册 action 及 26 步真实 `action.perform` 期望。`scripts/rust-board-reference.mjs` 在隔离 Chromium 使用真实上游 Scene、阻断网络，不修改产品构建；Rust 逐步比较业务 JSON，完整 undo/redo 回到每个有效编辑切点。仅排除独立验证的 version/nonce/time/index，不排除 seed、几何或绑定。差分修复了图片错误改变描边颜色、粗糙度不更新 seed；参考重跑先因内存对象的 undefined 与保存 JSON 不一致失败，统一按旧版实际 JSON 序列化口径后通过。

本机 Linux x64 / Rust 1.99.1 / Node 24.11.1，合成离线语料：`cargo test --locked --offline -p anynote-editor --test board` 19/19 通过；editor 全 targets Clippy（`-D warnings`）、新增 Rust 文件 rustfmt、脚本 ESLint/Prettier、夹具/文档格式和链接检查通过。`node scripts/rust-board-reference.mjs` 重跑 26 步及 91 个注册名/依赖摘要核对通过。 Rust 依赖边界 guard 通过（5 工程、800 个锁定包），`git diff --check` 通过。日志位于 `tmp/rm22/`，为避免其他组占用 Cargo target 锁，本轮 Rust 检查使用 `CARGO_TARGET_DIR=tmp/rm22/target`。沙箱首次阻止 Chromium socket；获准本地浏览器测试后复跑成功。

RM22.1–.3 均保留未完成：注册 action 不是实际可达矩阵，类型存在也不代表创建/编辑完成。尚缺默认菜单/快捷键完整实测、原生字体及复杂连接几何、开放 binding/elbow 路由、组编辑和复杂组/框层级、路径变换/图片裁剪、完整剪贴板/库等操作及对应旧版历史/序列差分。当前 26 步没有测旧版 pointer/history engine，也未验像素、性能、实际资源闭包保存或三平台。详细契约、按类型证据和复现见[白板兼容方法](RUST-BOARD-COMPATIBILITY.md)；不得据此关闭 E8/M6、推进旧白板退役或宣称 RM22 完成。

<a id="rm15"></a>

## 2026-11-08 · RM15 Markdown 模型与原文保留

交付 `crates/anynote-core/src/protocol/{markdown,rich}.rs` 和 `crates/anynote-editor/src/{model,source}.rs`。复用 workspace 已锁定的 markdown 1.0.0（CommonMark/GFM）、regex 1.13.1、serde_json 1.0.145；没有引入第六个 crate、UI/数据库依赖或另一种持久化格式。`Document` 持有唯一 Markdown 源文、覆盖全文的块/分隔 segments、session-local BlockId、字节范围和派生语义树；serializer 仅复制原文或 splice 指定范围。局部替换检查 generation、expected source、UTF-8 边界，重新解析引用/fence 影响，保留未受影响及仍对应同一范围的块身份。结构命令、选区、撤销和 IME 留给 RM16–19。

安全边界与现有 TS 一致：正文超过 500000 UTF-16 单元整体 opaque，单块超过 5000 节点降级，脚注/转义/HTML/reference/aligned-table/code-meta/图片混排等保留源码。directive 保留全部属性及原始载荷，字段更新只替换 JSON payload 并保留尾部换行；arbitrary_precision 保留未知整数/小数精度。serde 无法投影的深层 JSON 或孤立 UTF-16 surrogate 保留原始字节并拒绝字段更新，不替换为空对象；这类 directive 在两端都不是普通富编辑块。静态媒体/声明块业务接线仍由 RM20/21 等承担。

共用语料 `tests/fixtures/markdown/rm15.json` 固定 54 份输入和预期 byte spans、directive 属性/JSON、富编辑原因；Rust 和直接导入源码的 TS 测试读取同一文件，不更新 RM01 冻结快照。初次差分发现 TS remark 去除 BOM 后没有补偿原文 offset，已在 `packages/protocol/src/rich.ts` 修复；Rust 段落前导空格从 block span 分离到 separator。CR/LF/Unicode 行分隔的 directive 锚点按 JS 规则识别。修复后全部共用预期一致。

本机 Linux x64 / Rust 1.99.1 / Node 24.11.1，合成离线语料。验证：`cargo test -p anynote-editor --test markdown_source --offline --locked` 13/13，通过全文字节相等、局部范围外相等、RM01 原文、Unicode 源定位、非法/过期范围无修改、块身份、未知字段/大数/资源引用、引用定义重解析及固定 seed 200 次编辑。`vitest run tests/rust-markdown.test.ts tests/document-model.test.ts tests/editor-ecosystem.test.mjs tests/organization.test.mjs` 4 文件 71/71 通过，其中共用语料 54 项；协议 `tsc` 编译、core/editor 全 targets Clippy（`-D warnings`）、新增/修改源码的 rustfmt、ESLint/Prettier、依赖边界 guard（5 工程、800 个当时锁定包）和 `git diff --check` 通过。由于 serde_json feature 由 workspace 统一，另执行当时的 `cargo test -p anynote-core -p anynote-editor --offline --locked`，两个包合计 31/31 通过（含并行组已有测试）。原始日志在可删除的 `tmp/rm15/`。不声称整个 workspace 回归、原生 UI/IME、性能目标或 M1/M2 已放行。

执行期间其他组正在修改 Rust manifest；仅去掉重复依赖声明、保留双方依赖。一次在线 cargo 检查因 DNS 不可用失败，后续离线检查成功。`build-workspace.mjs packages/protocol` 因当前没有 `extensions/` 目录失败；改用 `tsc -p packages/protocol/tsconfig.json` 与已有 `build-backend.mjs` 编译发布协议测试模块，不修改无关构建脚本。

<a id="rm02"></a>

## 2026-11-08 · RM02 Rust workspace、Kit 与平台壳

完成 RM02.1–RM02.3，接续已有 RM01 工作区材料，不修改旧 Electron 业务或用户库。固定 `apps/desktop-rust` 与 `crates/anynote-{core,storage,services,editor}` 五个工程及 Rust 1.99.1；Kit/Base/Component/assets 0.9.0 与 GPUI 0.3.11 同组锁定，SQLite/图片/SVG/PDF bindings/features 和 Pdfium 7350 资产摘要见 [Rust 开发入口](RUST-DESKTOP-DEVELOPMENT.md)。依赖 guard 检查实际激活闭包（all-target/all-features 764 包），禁止 JS 宿主与错配 Kit。新增 Linux 开发 CI，未声称 hosted CI/发行通过。

平台壳提供主题/系统外观、字号缩放、动态草稿 Dialog、Actions/系统或 Kit 菜单、焦点/输入、GPUI 文件选择/剪贴板、本地单实例唤醒和显式退出语义。修复 AppMenuBar 的全高占位导致正文被推到视口外的问题；按钮与 Actions 共用 owner 方法，Dialog 使用 Kit 的关闭/应用组件并验证焦点回到原控件。core 环境观察保留未知值与恢复失效规则，真实 OS 电量/网络/恢复订阅尚未接入。services/editor 当前仅为工程边界，未冒充后端或编辑器完成。

本轮 Fedora 44 x86_64 验证：`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`、`cargo test --workspace --all-features --locked`、`cargo build -p anynote-desktop --locked`、依赖 guard 均通过。6 个顶层测试通过；另 1 个 ignored 测试是由进程测试显式启动的 child fixture，并非跳过验收。覆盖未知环境恢复、单实例跨进程唤醒/kill 后重启、无 DISPLAY 的原生子进程、Unicode/剪贴板/Dialog/主题缩放、模拟文件选择/取消、SQLite STRICT/FTS5 trigram/Online Backup。沙箱最初拒绝本地 socket（EPERM），在允许本地 IPC 的环境复跑通过。Pdfium 绑定的宽 libloading 约束曾误选不兼容的 0.9.0，最终 lock 固定 0.8.9 并通过全 features 编译。

实际 Wayland 会话启动了 GPUI 窗口，记录 scale factor 1.6666666；独立 Xvfb/X11 原生窗口探针通过键盘输入、剪贴板往返、Dialog Escape/焦点恢复、浅深主题、16→18→16 缩放、第二实例唤醒及 Ctrl+W 退出，截图已检查。探针脚本可重建 `tmp/rm02/` 报告。Xvfb 使用软件渲染，不能推断 GPU/性能；Unicode 模拟输入不证明真实 IME；系统文件选择器只做适配与模拟响应测试。macOS/Windows、真实输入法/读屏/多屏 DPI、原生文件选择器、Pdfium 字节与 ABI 装载、WebView 和发行均未验收，仍由 RM25/27/32/36 承接。

<a id="rm01"></a>

## 2026-11-08 · RM01 旧版基线与兼容语料

固定旧提交 `60a8c4b614b8831d2a16366a79d595942e7b87a1`，不改产品行为。RM01.1 冻结 146 个 renderer 操作（111 迁移、35 退役）、20 个内部/漏接线入口和 INV-01–24，保存源码 hash、校验/结果/错误分支及逐项 RM 归属。RM01.2 增加 `tests/fixtures/rust-migration/` 合成黄金语料、生成器和旧 reader 自校验，覆盖 schema/tracker、Markdown/directive、scene/嵌图历史、资源/批注/未知 JSON、完整/当前/ZIP64 归档、带图采集、本地备份、云快照/浏览/ack 和七类异常样本。RM01.3 取得当前 Linux 性能/交互样本，记录安装/数据路径、13 个已知插件来源及无法访问的用户插件清单。使用方式与完整边界见[基线与语料](RUST-MIGRATION-BASELINE.md)。

实际验证：`pnpm run build` 通过；6 个相关测试文件 56 项通过，补入采集图片/云浏览后单独重跑最终 RM01 15 项通过；新增脚本和测试的 ESLint/Prettier、文档链接与 `git diff --check` 通过。旧 `document-editor-smoke.mjs` 通过，含合成 composition，不等于真实 OS IME。`performance-ui-acceptance.mjs` 11 个检查通过；万篇搜索 benchmark 通过。原始结果位于 `tmp/reports/rm01/`、`tmp/reports/search-benchmark.json`、`tmp/reports/performance-ui-acceptance.json`；截图在 `tmp/screenshots/`。

设备为 Linux x64、AMD Ryzen 7 H 255（16 逻辑核）、约 29.2 GiB RAM；harness Node 24.11.1、Electron 41.9.1（内置 Node 24.17.0），开发构建、暖 OS cache、合成数据。旧版启动 p95 1220.54ms；50KB 文档打开 p95 41.50ms、保存提交 p95 18.31ms（不含 650ms 防抖）；万篇后端唯一短语/短中文搜索 p95 分别 8.47/33.33ms。UI 基准覆盖 100MiB 合成 PDF Range、大图及有限媒体循环；不是低配机、冷盘、真实复杂媒体或长期老化证据。性能脚本运行期间曾并行执行短时旧 smoke，以上数值只作开发环境参考；严格比较需按基线文档串行重测。

已知旧缺陷保留：`editor-ecosystem-smoke.mjs` 在 `富文本 Beta` 超时；`desktop-smoke` 旧选择器仅源码核对。实际 renderer `saveRemoteRetention` 返回“未授权请求”。本地拦截 iframe 的 CSP 探针确认 YouTube 放行、Vimeo/Bilibili 阻止，不声称三家真实视频播放通过。三平台凭据/偏好、真实用户插件、完整白板动作和外部设备/云/发行仍未验收，范围已归属后续 RM/V/A/F；不因 RM01 完成改变这些状态。

历史概述（2026-10-04）：依据 Anynote-Design.md 0.1，保留 Markdown 为唯一正文真源。已完成 P2/P3 和部分 P4 功能，已补充块级富文本、排序、跨库反链、元数据历史与本地清理；已补充外部 Notebook 目录打开与写锁；已补充全局搜索、筛选、连接 LRU 和万篇后端基准；已完成桌面真实云验收及跨 Notebook 复制/移动；已完成桌面流式 ZIP/ZIP64 归档及 Cloudflare 远端清理/设备接管；已补齐 UTC 日/周/月采样及核心 TypeScript 迁移；已完成大文件云备份/恢复分块及真实 Cloudflare 验收；已补充客户端硬中断重启与源目录不可用恢复演练；已实现独立云连接、分页发现及全新设备恢复向导；已补齐 Linux 性能与界面验收、范围读取 PDF、超大 Markdown 策略和键盘/缩放修复；仍为预览版，未将完整设计标记为已验收。

2026-10-24 范围调整：移除 Google Drive、Dropbox、OneDrive 云盘备份、OAuth 服务及专用 SDK 契约；当前保留本地磁盘与 Cloudflare 备份。相关未完成任务已取消，历史证据仅用于溯源。

## 架构与新增模块

- `apps/desktop/electron/`：安全窗口、IPC 允许列表、SQLite Utility Process、系统加密凭据代理；知识库服务与窗口生命周期分离。
- `packages/backend/`：Electron、预览 API 与验收工具共用的服务装配入口；向基础 Storage 注入备份操作，保持快照串行与远端并发策略，包依赖全仓无循环，见 [ADR-012](../design/adr/012-backup-service-composition.md)。
- `packages/storage-sqlite/`：schema v5（SQLite 元数据与不可变附件文件）、事务、资源版本引用闭包、批注、反链、导入报告、扩展状态、归档与开放格式导出。
- `packages/protocol/`：扩展块原文与位置、代码围栏保护、资源引用、YouTube 地址、HTML 编码识别及公共操作允许列表。
- `packages/importer/`：独立 Worker Thread 执行 Readability、DOMPurify、Turndown 和受控下载；完成后排入单个知识事务。
- `packages/backup/`：Cloudflare 数据库分块与完整附件对象、恢复、设备配置、凭据门面、自动备份调度。
- `apps/cloudflare-backup/`：单用户自托管 Worker、D1 migration、R2 内容对象、staging 校验与分支 CAS 发布。
- `packages/plugin-sdk/`：公共 API、命令注册、契约、QuickJS 执行器及搜索/网络/状态校验；Storage 权限门面和提案状态机归 `storage-sqlite`，依赖方向见 [ADR-011](../design/adr/011-extension-module-boundaries.md)。
- `packages/extension-host/`：首方独立进程、惰性激活、消息代理、Notebook 会话授权、超时/崩溃回收。
- `packages/extension-tools/`：共用清单/设置/迁移/签名校验、TypeScript 工程模板、本地 CLI 与隔离示例命令试运行。
- `packages/first-party-adapters/`：白板/视频/导入/备份首方适配器只依赖公开 SDK，独立打包并在干净外部项目安装运行验证。
- `apps/desktop/src/`：本地资源渲染、懒加载白板、PDF TextLayer/批注、HTML 导入表单、任务中心、扩展开关和备份配置/恢复。

Node 内置 `node:sqlite` 仍为实验 API；当前运行要求 Node 24，桌面使用 Electron 41。升级必须通过存储、归档和恢复测试。

## 一致性与恢复规则

当前 schema v5 不兼容旧 BLOB 数据库，也不自动迁移。SQLite 保存正文、历史、回收站和引用；图片、附件等二进制内容保存在同目录下的不可变内容哈希文件中。

白板场景、预览和图片按 SHA-256 保存不可变字节；每个正文版本冻结 resourceId→assetHash 映射，并递归保存场景图片引用。普通正文编辑继承未换绑的资源版本；恢复历史复制所选版本的引用；不物理删除资源，避免破坏历史。

导入任务的联网/解析与存储写入分离；资源先完成磁盘写入，笔记、引用、来源、报告及 changes 在一个事务中提交。失败文件最多形成未引用对象，不形成半成品笔记。

Cloudflare 远端维护支持按目标保存数量/日周月配置和手动空间预览；过期 staging、孤立 manifest 与临时对象经确认回收，维护回执/墓碑先归档再回收 D1。保护和预算见 [远端维护契约](../features/REMOTE-MAINTENANCE.md)，不执行定时删除。

Cloudflare 正式传输支持重启后复用已验证对象、multipart 回执及附件下载范围；源切点或 manifest 改变时隔离旧进度。`transfer-resume-v1` / `0007.sql` 将遗留上传会话接入手动维护，见 [持久续传决策](../design/adr/014-cloudflare-transfer-resume.md)。

Cloudflare 保存有序数据库块及完整附件文件，D1 保存版本元数据；每个版本包含完整清单，可独立恢复，不依赖增量版本链。staging 不进入恢复列表，最终事务 guard + head CAS 原子发布。

设备侧按目标保存 ack 游标及 pending generation，失败不推进游标；提交响应丢失后重试先查询固定版本状态，确认提交后修复本地游标。目标自动备份默认关闭，启用后仅应用运行时检查变更。同一目标不重复启动活动备份；远端列举和连接测试不占用知识修改队列。

完整归档保留批注、扩展状态、历史及回收站，不包含设备凭据、备份游标及缓存。Cloudflare 恢复按有序块组装本地 SQLite，下载对应附件，再复用完整归档的 schema、哈希、外键和目录校验，创建新 Notebook。

## 工作区与目录写锁

桌面设置页可选择含 notebook.sqlite 的原目录，在原位置打开，保留 Notebook UUID。目录登记保存在应用 `_local/notebook-directories.json`，不进入导出或远端备份。已登记但磁盘未连接的目录保留列表提示；重新连接后重新验证身份。数据库和 assets 目录共同构成持久化知识数据，不生成引导 JSON，也不迁移旧 schema。

当前直接由 `notebook.sqlite` 主连接持有 EXCLUSIVE 系统锁，不再使用独立 `.anynote-lease.sqlite`。另一存储实例拒绝打开，释放连接或进程退出后系统释放锁；正常关闭时切回 DELETE journal 以收拢 WAL。覆盖应用管理目录与外部目录；不支持把同一实体目录复制为同 UUID 的第二个可写位置。连接 LRU 回收可写连接时也释放该目录租约；下一次写入重新获取，冲突时拒绝写入并保留界面草稿。移出工作区不会删除原文件，活动任务或快照固定期间拒绝移出；未登记目录的自动备份不再启动，重新打开后恢复原配置。

Linux 历史与 macOS/APFS 镜像证据见 [P0 记录](validation/P0-BACKUP-READINESS.md)；这不构成真实网络盘、跨平台目录选择器或物理拔盘/断电验收。任务状态分别见 G02/G03/G06。

## 当前验收与未完成项

| 设计项                                            | 状态                                                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地 Notebook、目录、三类笔记、搜索、历史、回收站 | 已实现；1,000 层目录、冲突和批次恢复测试通过                                                                                                                                                                                     |
| 全局搜索与筛选                                    | 已实现跨库筛选、上下文及正文/PDF/批注定位、快速打开预览和失效链接修复；见 G14 决策                                                                                                                                               |
| 数据库连接 LRU                                    | 默认最多 8 个可写知识库连接和 4 个只读连接，租约连接数量随可写连接受限；SQLite 快照期间固定连接，可暂时超出可写缓存上限，完成后回收；多库搜索/反链使用只读连接                                                                   |
| 跨 Notebook 复制/移动                             | 已实现笔记/目录子树、历史、资源闭包、白板图片、PDF 批注/索引与内部链接重写；先提交目标库，移动再将源条目放入回收站，支持幂等重试及源/目标变更保护；单次 10000 条目、100MB 附件，扩展库级设置不复制                               |
| Markdown 真源、连续文档、未知块保留               | 已实现 Tiptap 连续编辑；未修改块保留原文，复杂语法/未知块不展示源码；边界见 ADR-002                                                                                                                                              |
| 内联图片、白板、YouTube                           | 已实现；白板资源闭包、历史恢复和开放格式场景测试通过                                                                                                                                                                             |
| 网页/HTML 导入                                    | 已实现；后台任务、清洗、本地化、报告、编码识别、受控 URL；不支持登录会话抓取、浏览器脚本执行或 OCR                                                                                                                               |
| PDF 文字选择、密码、文内搜索、批注与全文索引      | 已实现；扫描 PDF 提示 OCR 未启用；文本提取/搜索最多 500 页                                                                                                                                                                       |
| 首方扩展 SDK                                      | 有限公开接口及合约测试已实现；随应用受信工厂可用，声明式第三方安装、每库授权及命令/节点贡献已实现；通用 JS/React 宿主未开放；受限正文转换脚本、持久化状态、设置表单与显式数据迁移/备份恢复已接入                                 |
| 首方功能独立发布                                  | 白板/视频/导入/备份适配器经公开 SDK 接入，独立 tarball 在干净离线项目安装、编译并运行通过；真实首方插件完整功能的外部运行待后续                                                                                                  |
| AI 工具接口                                       | 提案/显式应用/幂等/版本条件撤销已实现；模型 Provider 未接入                                                                                                                                                                      |
| 本地快照与 Cloudflare 备份/恢复                   | 当前为 schema v5、数据库分块与完整附件清单；本地契约有测试，旧真实云报告不覆盖当前格式，验收归 G07                                                                                                                               |
| 自动备份                                          | 可按目标启用，约每分钟检查变更；不作为系统常驻服务                                                                                                                                                                               |
| 凭据安全                                          | 桌面系统加密，Linux keyring 缺失时拒绝；浏览器开发仅内存；真实隔离 GNOME Keyring 的加密与应用重启已验证；Windows/macOS 和系统重启未验证                                                                                          |
| 连续文档编辑                                      | 已实现斜杠命令、Markdown 输入转换、任务与表格；复杂语法保留，不承诺任意 Markdown 全文无损往返；当前入口见 EDITOR-ECOSYSTEM                                                                                                       |
| Notebook 外部路径                                 | 桌面原目录打开与工作区登记已实现；系统目录选择器授权、数据库结构/完整性、资源路径/大小/SHA-256 校验，拒绝重复 UUID 指向不同目录；移出工作区释放连接与写锁并保留原目录                                                            |
| 包级 monorepo 发布                                | 已建立 pnpm workspace、包级构建与发布矩阵；SDK 通过独立离线消费验证，最终发行矩阵仍归 V011                                                                                                                                       |
| 自定义同级拖拽排序                                | 已采纳稀疏整数 sort_key、索引邻居查询与事务内同级重排；完整元信息快照和虚拟树，见 ADR-001 / G14 决策                                                                                                                             |
| 大文件归档                                        | 桌面已实现后台流式 ZIP/ZIP64 完整归档、磁盘预算、进度/取消及独立线程数据库校验；20GiB/100002 条目预算（含清单、数据库及附件）；浏览器、旧归档 API和本地快照仍为 100MB；正式云任务已使用 1MiB 分块                                |
| 本地保留与资源清理                                | 已实现快照数量/天数预览及显式确认清理；只清理数据库未引用且超过 5 分钟的哈希文件，保护历史/回收站资源、最新快照和迁移快照；候选改变或新增引用则拒绝执行                                                                          |
| 远端保留/GC、设备接管                             | Cloudflare 已实现数量保留预览/确认、全分支/staging/恢复 pin 保护、24h 对象宽限、Notebook 锁与分批重试、epoch 条件接管及恢复副本身份映射；日/周/月抽样已实现，Cloudflare 新协调器支持硬终止后的自动恢复，旧版无身份锁仍需安全处理 |
| 跨 Notebook 反链汇总、元数据历史恢复              | 已实现已登记 Notebook 汇总与跳转，排除已删除来源；新版本记录标题/标签/收藏并事务恢复；旧版无元数据历史保留当前元数据，目录位置不回滚                                                                                             |
| 打包                                              | 已有三平台发行 workflow 与本地构建入口；应用签名/公证、真实 CI 和最终产物验收归 G05；扩展签名已实现，不与应用签名混同                                                                                                            |
| 性能/发布门槛                                     | Linux 生产页面与打包版验收见专门报告：启动、万节点虚拟树、万篇索引搜索、50KiB 编辑/保存、100MiB PDF 与流式备份 UI、三档窗口/主题、键盘、200% 缩放及自动 WCAG 检查；人工读屏器、复杂 PDF、跨平台/硬件和完整 v1 发布验收仍待完成   |

## 接续开发

- [2026-10-21 批次摘要](history/todo-2026-10-24.md)：备份、续传、目录导航、归档、模块边界与 UI 交付。
- [2026-10-24/25 阶段交接](history/todo-progress-2026-10-25.md)：Cloudflare 老化样本、插件公网资源、发行身份和类型边界。
- [TODO](TODO.md) 是唯一未完成任务清单；本摘要不代替当前源码检查，不沿用历史通过状态。

源码使用 Vitest；测试入口见 [开发工作流](DEVELOPMENT-WORKFLOW.md)。扩展及归档回归入口见 [功能验证](validation/FEATURES.md)。继续修改时先核对相关实现和契约，完成后记录交付范围与未解决的问题。

## 浏览器采集开发版本（2026-10-25）

配对接口故障核查：用户现有 `anynote-backup-acceptance-518ee6c2` 的真实 `/v1/capabilities` 返回 200、schema v4，未声明 `capture-v1`；远程 D1 只读查询确认迁移到 0006，有 93 个 committed、13 个 staging generation。此状态解释配对请求的“接口不存在”，不是 Token 失效。未改动该云端服务或数据。桌面三种采集设备操作现先检查能力，旧服务给出升级 Worker/迁移 0007 的明确提示，保留鉴权错误。后端构建、相关 ESLint、6 项云采集回归和 Worker dry-run 通过。因新版仅支持 schema v5，建议独立部署新服务，保留现有服务和旧备份；用户随后明确授权删除原资源并重建；已删除旧 Worker/D1/R2/维护状态，保留地址及 APP_TOKEN 同名部署 schema v5。9 项真实云采集协议检查通过，覆盖配对、目录/正文、图片与卡片上传、桌面后端归入/回执、防重复及撤销；用户 GUI 操作仍待验证。旧老化样本已失效，详见[重建与真实验证](validation/CLOUD-ACCEPTANCE.md#2026-10-25-重建与浏览器采集真实验证)。

新增 `apps/browser-extension` 与共享 `packages/capture`。桌面导入采用原生文件选择、受预算限制的 ZIP 流式解包、哈希校验、Markdown AST 资源重映射和 SQLite 事务回执。Notebook schema 升至 v5，发行矩阵、归档/恢复与 Cloudflare 能力保持一致；旧版本不自动迁移。

Cloudflare 新增受限设备配对、不可变浏览投影和独立采集箱。桌面备份任务先领取并归入，再从同一个 SQLite 切点导出浏览对象与待确认回执；只有 generation 原子提交能推进 backedUp。普通媒体逐个下载并验证；ChatGPT 搜索图片组可补充已渲染图片地址，其他尚未适配的多模态内容报告缺失。

已执行：`pnpm run check`、桌面与扩展构建、Worker dry-run 均通过。最终回归 `vitest run --exclude tests/icons.test.ts`：64 个文件、453 项通过、1 项跳过；图标模块未改动，其 3 项测试仍期望旧的 48×48 自绘图标，与当前 Lucide 实现不一致，单独排除并保留记录，不宣称全套通过。采集、云采集与网页导入聚焦回归 26 项通过，包含共享表格内的图片/链接、防重复、目标失效、回执丢响应、授权与清理中断。隔离 Chromium 153 扩展 smoke 通过实际 Range 选区转换、合成 ChatGPT API 分支与凭据过滤、采集包下载、草稿恢复和布局检查；截图已人工查看。沙箱不允许启动子进程/本地端口，相关测试在获准的隔离临时环境执行。

ChatGPT 缺失内容后续诊断：用户再次回报同一对话的两条未转换内容警告，原提示没有内容类型，无法判断是旧草稿、内部节点还是真实媒体。新增 `unsupportedTypes`：只携带最多 4 个、每个最多 48 字符的类型标识；缺失说明显示格式，不读取/保存特殊 part 的正文、附件指针或 session 凭据。适配器版本标识为 `web-experimental-2`，旧草稿需重新采集。10 项聚焦测试和扩展构建通过；用户随后确认这两条提示来自之前保存的记录；旧记录需重采，不扩大过滤范围或删除未知内容。

扩展界面后续更新：右上角设置入口切换 `#settings`，Cloudflare 配对、目录、笔记阅读及采集箱全部移入设置页；返回采集保留原草稿和当前目录，未连接时“导入云端”跳转设置。移除顶部操作提示及手动开启 ChatGPT 按钮，使用限定 chatgpt.com 的固定权限与静态注入，已打开页面在安装/启动时补挂载。增加本地 Lucide SVG 子集（ISC 许可，来源为项目已有 lucide-react 1.59.0，不引入 React 运行时）、自绘笔记 A Logo 及 16/32/48/128px PNG 工具栏/管理页图标；Logo SVG 源文件在 `apps/browser-extension/public/icons/logo.svg`。完整 `pnpm run check`、扩展构建、ESLint、隔离 Chromium smoke 通过；验证了默认注入、刷新后不重复、真实 content script → service worker → MAIN world 链路（合成 API）、设置切换保留草稿/表单、设置直接打开、未连接引导，以及导出和采集/设置两页 320px 布局。截图已人工检查。真实 Cloudflare 账号验收仍未执行。

ChatGPT 组件补充（适配器 `web-experimental-3`）：按消息 ID 提取实际搜索图片组，支持新 `data-dil-message-id` 页面结构；图片进入现有下载、哈希校验与采集包管线。共享 `chatgpt-components.ts` 使用 parse5 白名单解析及 Markdown AST 转换，将用户提供的四步卡片变为带内联样式的受限 HTML；桌面 `DocumentView` 仅重新校验并渲染带采集标记的卡片，普通 HTML 行为不变。卡片中的图片组移到其后供资源重映射；其他内嵌媒体明确提示缺失，代码示例保持原样。测试覆盖样式、代码保留、伪造标记、危险标签/CSS、图片组缺失/歧义及含媒体采集包的桌面导入。隔离 Chromium smoke 覆盖实际扩展消息链路、合成图片下载与完整包导出，卡片截图已检查。用户授权的“总结版本更新”页面已核对图片和消息 DOM，未将合成 API 测试声称为新版真实媒体采集验收。本轮最终 `pnpm run check`、桌面与扩展构建通过；采集包、组件转换、文档模型和网页导入 4 个文件共 32 项回归通过。安装 ZIP 已更新。

临时扩展安装包：`tmp/browser-capture/anynote-browser-extension.zip`；解压后加载目录，或直接加载 `apps/browser-extension/dist`。2026-10-25 已连接用户 Chrome 并点击指定对话的采集按钮；用户回传的 Markdown 证实真实历史接口返回正文、表格和代码块。首次结果包含空消息、内部特殊消息及原始 Cite 标记，且导出因未确认缺失而受阻，提示位于侧栏末尾不可见。随后过滤已知 thoughts/reasoning_recap、工具定向消息与空文本；保留真正未知媒体缺失提示；正文引用标记替换为“引用来源见原对话”（代码示例保持原样，不虚构来源 URL）；导出操作旁显示状态并聚焦缺失确认框。切换草稿重置确认，冻结包也重新检查确认。修正后聚焦采集回归 10 项通过，隔离 Chromium smoke 覆盖缺失确认阻止导出、就地提示、确认后下载及冻结包取消确认后再次阻止导出；扩展构建通过。用户随后确认新版真实对话采集与 `.anyclip` 导出正常；这是用户操作回报，扩展侧栏未由工具直接读取。专有媒体与分支切换不计为通过。按用户最新要求，扩展侧栏与 ChatGPT 注入按钮改为白色背景、扁平化样式：移除渐变与阴影，统一浅灰边框、蓝色主操作、两列采集操作及键盘焦点状态。样式更新后扩展构建、相关 ESLint 和隔离 Chromium smoke 通过；440px 与 320px 侧栏截图已人工检查，320px 无横向溢出，导出与草稿恢复通过。没有部署或改变现有真实 Cloudflare 数据。

`node scripts/capture-benchmark.mjs` 对 4×20 MiB 合成附件实测：Node 流式导出约 194 ms、导入约 118 ms、RSS 基线 73 MiB / 峰值 98 MiB。该测量不代表浏览器最终 Blob 内存或真实云性能。临时报告与截图在 `tmp/browser-capture`、`tmp/capture-benchmark`。后续状态统一见 [F025](TODO.md#f025)。
