# 实施记录

> 当前存储为 SQLite schema v5 + 不可变附件文件，数据库按块增量、附件按文件增量，统一清单提交与恢复，见 [存储设计](../design/SQLITE-STORAGE.md)。下文历史云端和平台验收不能作为新格式的验收结论。

历史摘要核对：2026-10-21，源码基线 `e975c1c`。实际决策见 [ADR](../design/adr/README.md)，本轮核对与验证见 [G18 报告](history/todo-2026-10-24.md#g18)。原始执行记录和数值报告已移到可删除的 `tmp/reports/documentation/`；本文件与阶段交接只保留长期开发所需摘要。任务状态只在 [分组清单](TODO.md) 维护，规则见 [文档维护](DOCUMENTATION.md)。

<a id="rm26"></a>

## 2026-11-09 · RM26 PDF 选择、批注、索引与回链

- [x] RM26.1：基于 native glyph 的拖选、键盘选择/复制、跨页搜索与放大定位；高亮/批注/删除、持久阅读笔记和页面/批注回链进入原生 PDF 阅读器。
- [x] RM26.2：所有操作校验笔记/修订/主资源/hash，历史只读，旧 hash 批注显式提示且不绘制；确认后才将原坐标重锚定。替换文件后旧文本/批注不污染当前全文搜索。
- [x] RM26.3：500 页 / 4500000 UTF-16（含页标记）索引，complete/partial/scanned 覆盖状态、真实 TaskHistory、取消/失败不发布；复制重映射批注回链，完整/当前归档保留索引与批注，开放导出保留原 PDF 与批注 JSON。

复用 RM05 写队列、现有 annotation/note_text、RM03 任务和 RM25 资源/几何；新增 `anynote.pdf.index` 扩展元数据，键为 `note.UUID`，schema v5 不变，私有桌面协议升为 v4。索引原生提取与存储发布分离，后端只在全部预算内页面成功后原子发布；提交开始后沿用不可取消边界。实现及接续见 [PDF 阅读契约](RUST-PDF-READER.md)。

macOS 26.2 arm64 / Rust 1.99.1 / `95353f7` 工作树：新增 8 项测试通过，完整 workspace 321 passed / 0 failed，3 个 ignored 是既有子进程 fixture；全 features/no-media Clippy、fmt、依赖边界（5 工程 / 844 包）通过。完整测试需短 TMPDIR 和本机 socket 权限；初次沙箱 EPERM 后允许本机 IPC 的重跑通过。最终选区颜色/放大定位调整后重跑 3 项 PDF UI 测试及全 features Clippy。原生隔离 `.app` 使用临时 SQLite/CAS 与真实后端，验证搜索 8 处、8 页索引完成、保存批注、创建阅读笔记与修饰键点击回链。临时日志和 probe 在 `tmp/rm26/`。

本组完成 E7 本地语义，不代表 Windows/Linux、真实设备、签名发行或原路径接管验收；RM32/36、F017 OCR、F018 带批注 PDF 导出及其他 V/A/F 状态不变。

<a id="rm25"></a>

## 2026-11-09 · RM25 PDF 引擎、页面与文本几何

- [x] RM25.1：锁定 Pdfium 7350 的五个平台归档与动态库摘要，安装/运行时校验及 macOS arm64 ABI 装载；密码、旋转 CropBox、混合字体与受控修订资源原型通过。
- [x] RM25.2：默认原生 PDF reader，页图、五页分组按需缩略图、跳页/翻页/缩放/适页/适宽、256 KiB 范围读取、单槽队列与取消；不全量常驻 PDF 或解码全书。
- [x] RM25.3：native glyph、UTF-16 范围、页面双向 normalized 变换与统一渲染配置；真实 PDF、100 MiB 稀疏文件、迟到结果、切页/关闭、20 次租约释放及 UI 交互通过。

实际发现并修复 7350 并发字体加载原生崩溃：适配层串行化完整 Pdfium 操作，文档空闲不持锁。PDF 与图片共享修订资源租约实现，私有协议 v3、新增 snapshot primary_pdf；无持久格式变更。PDF 笔记打开进入只读页面视图，选择/批注/索引仍留 RM26。实现、预算、原生取消非抢占边界与复现见 [PDF 阅读契约](RUST-PDF-READER.md)。

macOS 26.2 arm64 / Rust 1.99.1 / `b23aa64` 工作树：8 项新增 PDF 测试、4 项图片回归通过，完整 workspace 313 passed / 0 failed；3 个 ignored 均为既有子进程 fixture。全 features/no-media Clippy、fmt、5 工程/844 包依赖边界通过。单实例回归需短 TMPDIR 和本机 socket 权限；调整测试环境后通过。实际隔离 `.app` 检查了页面、混合字体、缩略图和旋转页；截图/日志在 `tmp/rm25/`。CI 已接 native 安装，但未运行远端 CI；其他平台和签名/漏洞版本资格仍归 RM32/36，未关闭 V/A/F。

<a id="rm24"></a>

## 2026-11-09 · RM24 白板保存与历史资源闭包

笔记白板块已接原生插入/预览/编辑及显式保存/取消。打开前复用 RM19 flush，冻结 directive ID、note revision/head 和正文 generation；提交期间冻结白板，取消不写白板 revision，应用内关窗/切笔记等待显式提交确认。保存结果用 epoch/head/generation 校验回填，保存失败与冲突保留草稿，未确认响应重试原请求；重连使用新客户端，后续正文不能被旧请求覆盖。

scene、嵌图、PNG 预览通过 RM05 单写队列/既有事务与递归 pin 一起发布，复用 RM21 分块上传和预览资源加载。PNG 和画布共用轮廓/排线/扰动/箭头几何、字体与图片变换。没有新增持久格式、表或依赖，保留原 RM23 工作树内容。详细入口、预算与复现见[白板保存契约](RUST-BOARD-VIEW.md#rm24)。

新增 4 项测试：directive 局部更新；真实后端/SQLite/CAS 持久化、写入故障回滚、重启幂等重试、图片重绑下历史 pin、复制/移动、完整归档导入和开放导出原图；2 项生产控件 UI integration tests 覆盖打开前 flush、绘制/保存/取消/重开、冲突草稿及保存中关闭。macOS arm64 / Rust 1.99.1 / `884bd2b` 工作树最终 core/editor/storage 128 项、desktop 72 项、archive/transfer 18 项通过，3 个 ignored 是既有子进程 fixture。Clippy `-D warnings`、改动文件 rustfmt、diff 检查与依赖边界通过。单实例测试初次遇默认临时路径 SUN_LEN/沙箱 socket 拒绝，短路径并允许本机 socket 后通过；锁定跨平台缓存补齐后边界为 5 工程/844 包。

仅关闭 RM24 本地保存/资源闭包。RM22/23 完整动作与渲染、RM19 系统退出限制、真实三平台/物理设备/性能及 V/A/F 保持原门槛，本次不声称人工视觉验收或正式用户资料接管。

<a id="rm23"></a>

## 2026-11-09 · RM23 白板绘制与交互（部分完成）

新增 `apps/desktop-rust/src/board/` 与 `--board-window [scene.json]`，纯原生 GPUI 临时草稿；复用 RM22 原子命令/保真 scene/历史和 RM21 解码器，没有修改 RM22 格式、后端写事务或笔记保存责任。交付共享几何命中、九项工具选择、四角变换与路径控制点、框选/组选择、Kit 文字输入、字体轮廓、裁剪/旋转图片显示、系统剪贴板、菜单和快捷键。一次手势只发布一次历史，失败/取消保留原 scene；异步资源有取消/generation，资产未变不重复解码。

新增 5 项模块测试、6 项几何/手势测试、3 项生产视图 UI integration tests。修复实际测试暴露的 GPUI 空 dash 数组崩溃、关闭文字对话框后焦点丢失，以及真窗口 LastResort 抢先匹配导致中文缺字。检查了中文实际字形输出；测试平台覆盖主题、缩放/DPI、图片粘贴与组合，不宣称三平台、真实 IME 或性能终验。

最终检查：新增 14/14、既有 RM22 内核 23/23 测试通过；桌面构建、全 targets（含 ui-tests）Clippy `-D warnings`、改动文件 rustfmt 与 `git diff --check` 通过；93 个动作名称与冻结 fixture 逐行核对。最终 macOS 真窗口再次确认中文字形，并验证关闭临时窗口后进程退出。验证期间 Cargo 压缩包缓存被清空，按原锁文件恢复后完成复测，未升级依赖。

[原生白板契约](RUST-BOARD-VIEW.md) 记录入口、资源上限、接续责任及 93 项冻结 action 的逐项缺口。RoughJS 像素等价、全字体/彩色 emoji、开放绑定/elbow、frame、完整控件与库/搜索/导出等仍缺；RM23.1–.3 不勾选。临时窗口关闭丢弃，白板块/保存闭环留 RM24，不把预览作为产品持久化验收。

<a id="rm14"></a>

## 2026-11-08 · RM14 原路径接管与回退（副本原型，部分完成）

交付 `anynote-services::migration::Rehearsal` 和桌面副本校验入口，具体契约与剩余范围见 [Rust 数据接管与回退演练](RUST-MIGRATION-TAKEOVER.md)。复用现有 schema/catalog、FIFO 写队列、SQLite 独占租约、RM13 偏好读取/逆映射、RM08 归档及 RM09 卷预检，没有新增依赖或 Notebook 迁移表。保留并行 RM16 编辑器及文档修改。

- 完整复制文件和空目录，包含孤立附件、未知状态、用户文件和配置；托管及外部根独立保全。逐文件摘要、Unix device/inode、同卷/空间预检、原路径租约和固定 journal 共同约束重复运行。预检不安装备份 tracker；数据库归一化 checkpoint 后再取指纹。
- 独立配置发布有持久化意图，staging 不登记为正式库。保持 SQLite 租约至回退验证结束；针对 POSIX close 释放锁的问题复用预打开 DB 文件句柄。回退先停止本会话新写、FIFO 排空并冻结，再保存最新完整副本和 `.anynote`，由旧 TS 只读验证后释放原路径；共享云游标不回滚。
- UI 偏好逆映射仅输出待回填报告，尚未写回 Chromium；新凭据明确重新认证、任务暂停。GUI 仅选择并校验隔离副本，正式接管禁用；不存在自动定位/激活真实日常资料入口。

验证：11 项 RM14 Rust 专项通过；12 组 TS 原库 → Rust 原生进程退出/重启 → 新写入 → 最新保全/回退 → 旧 TS `validateDirectory` 与正文回读通过，含 7 个前向边界、4 个回退边界及无故障路径。完整 storage/services 回归 133 项通过、2 项既有子进程入口 ignored；桌面构建、三包 Clippy `-D warnings`、五工程边界和脚本 lint 通过；Linux Xvfb 原生窗口 smoke 通过并检查新增入口截图，原生目录选择器和完整向导未自动验证。临时结果位于 `tmp/rm14/`，窗口截图沿用 `tmp/rm02/`。

完整回归首次因沙箱禁止 loopback bind 导致既有网络测试 EPERM；在允许本地回环的环境重跑通过。真实旧安装单实例互斥、Windows 目录身份、所有后台任务排空、Chromium 偏好回填和三平台/真实克隆演练尚缺，RM14.1–.3 不勾选，M8 与 V/A/F 不变。

<a id="rm12"></a>

## 2026-11-08 · RM12 配对、采集消费与同切面浏览

完成 RM12.1–RM12.3 服务层与本地闭环，保留工作区已有及并行 RM04–11/15 改动，未创建 Git 提交。实现与接续顺序见 [Rust 配对、采集消费与云浏览](RUST-CLOUD-CAPTURE.md)。复用 RM07 ImportService/事务回执、RM08 FrozenSnapshot、RM10 CloudClient/TransferSession；没有新增外部接口、依赖、表或改变扩展/Worker 的 capture 协议。

- 配对、设备列表/撤销先检查能力；限时 claim 绑定 writer/epoch、claimId/targetVersion。已有 receipt 优先去重；无回执时校验父目录/祖先并下载 hash 校验资源，复用完整 `.anyclip` 导入，在 SQL 提交后才 ack applied。失效目录进入 needs-target，离线/损坏不误改远端状态。
- 上传从同一 FrozenSnapshot 生成树/正文/修订固定附件和 captureAcks，确认对象仅包含远端待确认 ID 在本切面中的回执。已有 pending 清单继续按原字节重试；Worker 在备份提交事务内判定 backedUp。browse 超本地预算或失败时可以省略，captureAcks 仍发布；取消继续返回取消。
- `prepare_upload_with_captures` 和云采集类型在既有 RM10 cloud 模块内接入；普通 `prepare_upload` 生成 browse/空回执。RM29 宿主仍须依次恢复 pending、消费、查询 pending-acks、冻结和上传；本组不宣称 Rust GUI/timer 已接通。

验证（Linux、本地合成资料）：

- Rust `cloud_capture` **4/4**：冻结后编辑不污染正文/回执，旧切面不带新回执，资源属于上传闭包，101 条树分页/删除祖先过滤，取消与错误输入不发布 pending，以及 30,001 节点触发 browse 降级但保留回执。相关 core/storage/services 三包回归通过；既有 2 个崩溃子进程入口由父测试调用，保持 ignored。
- `rust-cloud-reference.mjs --capture --workerd` **9 组**：一次性/过期配对，损坏下载不提交/ack，ack 丢响应后跨进程去重，提交前 applied/提交后 backedUp，附件 exact hash，needs-target、过期 claim/旧 ack/targetVersion，删除目录后回执重放，writer epoch/设备撤销；真实 Chromium MV3 扩展页面完成配对、上传选区、采集箱及正文回读。截图已检查。报告位于 `tmp/rm12/cloud-sqC8tj/`。
- 原 RM10 HTTP 故障代理回归 **14 组**通过，覆盖上传/恢复/续传；TS cloud-capture/capture/cloud-resume/cloud-recovery/cloud-multipart **29/29**；services/storage 全 targets Clippy `-D warnings`、五工程边界 guard、脚本 ESLint、格式与 diff 检查通过。

首次沙箱 loopback bind 被 EPERM 阻止，改在允许本地 socket/子进程的环境通过。local-workerd 代理遇到 Node fetch 自动解压的响应头失配，已删除过时编码/长度头后复测；默认 Playwright 浏览器不存在，改用已安装 Chromium，扩展 session 初始化移到扩展页面后通过。失败尝试未计作验收。真实 Cloudflare、三平台/用户库、容量/费用/老化、商店发布及 Rust GUI 未验；RM34/A007–A009 与其余 V/A/F 保持原状态。

<a id="rm11"></a>

## 2026-11-08 · RM11 writer、保留策略与维护恢复

完成 RM11.1–RM11.3 服务层及本地故障验收。保留已有 RM04–10 和并行 RM12 改动，未创建 Git 提交；没有部署或操作真实用户库。核心实现为 [`cloud/maintenance.rs`](../../crates/anynote-services/src/cloud/maintenance.rs)，沿用 RM10 `CloudClient`、上传槽独占租约/原子文件和 RM03 `RuntimeState`，不新增 crate、依赖或 schema。

- **Writer**：`remote_writer` 返回 head/device/epoch/lineage，`owns` 供宿主呈现当前写入权；`takeover_writer` 要求显式确认和 requestId/expectedHead/expectedWriterEpoch，CAS 输入在请求前持久化。`pending_takeover`/`resume_takeover` 跨进程复用原请求，未知网络结果不生成新身份。接管中的旧槽被 `WRITER_REBIND_REQUIRED` 阻止准备/上传，成功后创建新 epoch 槽，初始游标只有远端 head，ack 为 0、pending 为空；重复回执不覆盖新槽已推进的游标。返回 `autoBackup=false`，不会自动夺取 writer。
- **保留配置与预览**：`save_remote_retention`/`remote_retention_policy` 以目标 UUID 存入 `cloud.retention.<targetId>`；不读取凭据、不请求网络、不自动清理。数量和日/周/月窗口有明确上限。`preview_retention` 将策略交给保留的 TS Worker，返回保护版本、候选、UTC 采样理由、staging 和空间估算；日周月/未来时间/分支/head/pin/staging 规则只维护服务端一份。修正 `packages/protocol/src/operations.json` 遗漏 `saveRemoteRetention`，使旧 renderer 白名单能到达既有本地保存实现，冻结 RM01 库存不改。
- **确认与恢复**：本地 `maintenance.retention` 状态为 planned→confirmed→completed。`apply_retention` 只接受当前已预览的 planId 与显式确认，每次最多驱动一个服务端批次；请求前持久化 confirmed。`resume_retention` 仅恢复已确认计划，网络失败、取消或进程退出不撤销服务端删除，也不放开本地未解决状态；不得替换成新预览。`recover_retention` 可在本机回执丢失后显式接续同分支、已处于 deleting 的服务端计划。过期/保护变化/撤销 writer 等明确入场拒绝允许重新预览。服务端继续负责 revision CAS、保护闭包变化、墓碑永久归档、删除游标及协调器续跑。
- **诊断**：`remote_retention_state`/`maintenance_diagnostics` 查询活动计划、对象/版本游标和执行锁，不解锁。旧版无 owner 的执行锁必须用精确 planId/executionId 和“旧请求已停止”的明确确认调用 `release_legacy_maintenance_lock`；释放执行锁后 Notebook gate 仍保留，按原计划续跑。没有按时间抢锁。错误只接受已知协议码/既有固定中文错误的映射，未知响应文本继续脱敏。

local-workerd 暴露既有 Worker 协调器分派缺少 `await`：actor 的保护变化异常绕过外层协议 catch，变为 HTTP 500。`apps/cloudflare-backup/src/index.ts` 仅补上等待，使其回到既有错误 envelope；增加实际 coordinator 拒绝回归，没有更改路由或破坏外部协议。

### 接续契约

宿主须用同一上传 `TransferSession` 串行协调上传与维护，不另建绕过其独占租约的相同身份任务。接管后依据返回的新 identity 重新绑定目标，持久保存 `autoBackup=false` 并更新 scheduler binding；旧槽原冻结 manifest/对象保留，不修改成新 epoch 重传。业务 IPC、冲突文案/界面、任务中心、设置及该配置接线属于 RM29。同步本地状态读写放到服务工作线程；取消后等待任务结束，服务端已确认清理仍可能由协调器自动完成。每次 `resume_retention` 只推进一批，宿主按任务预算继续调用，不把网络取消显示为远端删除已撤销。

### 本地验证与限制

Linux x64 / Rust 1.99.1 / Node 24.11.1，隔离资料全部在 `tmp/rm11/`。`cargo test -p anynote-core -p anynote-storage -p anynote-services --locked --offline` **123/123** 通过（另 2 个 ignored 是既有父测试调用的崩溃子进程；包含当时工作区 RM12 的测试，不计为 RM11 交付）。RM11 新增 **2 项 Rust 测试**覆盖偏好隔离/持久化/边界和无确认、无预览、非法 epoch 在网络前拒绝。services 全 targets Clippy `-D warnings`、RM11 新增 Rust 文件及相关 TS/脚本格式、五工程 guard（839 锁定包）、相关脚本/TS ESLint、TS backend 构建及 diff 检查通过。

[`rust-maintenance-reference.mjs`](../../scripts/rust-maintenance-reference.mjs) 每次调用 [`maintenance_probe`](../../crates/anynote-services/examples/maintenance_probe.rs) 都启动独立 Rust 进程，经实际 HTTP 与保留 Worker 互通：**适配器故障 12 组**、**local-workerd/D1/R2/维护协调器 9 组**。覆盖保存配置零网络、预览零删除、head/其他分支/pin/活动 staging、日周月采样、保护变化拒绝、无确认拒绝、过期/归档预览拒绝、staging 活动变化、删除故障保留 gate、apply 丢响应/跨进程续跑/异地回执恢复、墓碑重放、接管丢响应/epoch冲突/自动备份关闭返回值、取消后确认原计划结果、脱敏和旧锁精确释放。过期、存储故障和旧锁注入只在 D1/R2 适配器层执行；不能将其声称为真实云老化或物理故障。最终报告随运行保存为 `tmp/rm11/maintenance-*/report.json`。

旧 `remote-maintenance`/`retention-policy`/`maintenance-recovery`/`cloud-resume`/`cloud-recovery`/`cloud-multipart`/`backup-policy` **55/55** 通过；包含 UTC 年界/闰日/时区/并列采样、保护资源/归档故障、协调器实例恢复和保存配置白名单回归。初次 HTTP 验证被沙箱 `listen EPERM` 阻断，后在允许本机 socket 的环境重跑；workerd 首轮代理解压头错误及随后暴露的协调器异常分派均修复后重跑，没有将失败计为通过。

复现：构建 TS backend 后执行 `cargo build -p anynote-services --example maintenance_probe --locked --offline`，再运行 `node scripts/rust-maintenance-reference.mjs` 和 `node scripts/rust-maintenance-reference.mjs --workerd`。没有访问真实 Cloudflare/用户资料、执行生产清理或验证三平台、老化、费用与规模容量；RM34/A008 和其余 V/A/F 未关闭。

<a id="rm10"></a>

## 2026-11-08 · RM10 Cloudflare 传输、恢复与统一调度

完成 RM10.1–RM10.3 的服务接口与本地协议验收。源码基线 `eadc715` 加未提交工作区，保留 RM04–09 的现有及并行改动，未创建 Git 提交。没有改变 Worker、云对象格式或 schema v5，没有连接真实云或打开真实用户库。

- [x] **RM10.1** [`cloud/client.rs`](../../crates/anynote-services/src/cloud/client.rs) 实现能力协商、HTTPS 默认/显式 HTTP 测试连接、禁止自动重定向、有限响应、超时与取消、Retry-After、错误代码脱敏；独立恢复连接通过 RM03 RuntimeState 持久化元数据，Token 只交 RM13 `SecretStore`，也支持仅会话内提供凭据。`Manifest::parse` 保留 Worker `JSON.stringify` 字节、未知字段与属性顺序，按 JS array-index key 规则和 `ryu-js` 处理数值；协议整数、大小与序列必须为 JS safe integer。`prepare_manifest` 可接收冻结 TS manifest 和 hash 命名对象，不重新推导旧 generation。
- [x] **RM10.2** [`cloud/session.rs`](../../crates/anynote-services/src/cloud/session.rs)、[`upload.rs`](../../crates/anynote-services/src/cloud/upload.rs)、[`restore.rs`](../../crates/anynote-services/src/cloud/restore.rs) 将连接/endpoint/notebook/lineage/方向及上传 device/epoch 绑定到独占 OS 文件租约；冻结对象、原始 manifest hash、pendingGeneration 与游标先 fsync/原子落盘再请求 plan。丢 plan/commit 响应不产生新身份；先查 generation，再核对已提交 manifest 字节后推进游标，旧 head/较小序列拒绝。下载逐次复核缓存 chunk/range，核对 Content-Range、整 DB/附件 hash、schema/源 Notebook/资源闭包后恢复新 UUID、lineage、自链接和索引；发布回执使同一恢复重试返回原新库，目标已变化时拒绝冒充原结果。无本地 Notebook 也可分页发现跨库/lineage 版本。pin 在开始/30 秒续租/结束维护，初始 pin 丢响应、取消或续租失败也尝试释放。
- [x] **RM10.3** [`scheduler.rs`](../../crates/anynote-services/src/scheduler.rs) 在同一持久准入/失败状态机下派发 Local/Remote executor，保留原 RM03 `background_decision`。支持离线、所启用的电池/计费网络策略、未知观察、大任务、磁盘/Notebook 缺失、interval/on-mount、Retry-After 优先的指数退避/jitter、取消及 auth/permanent/exhausted 显式修复。运行前持久 claim，重启将 running 标为 interrupted，executor 依据原传输身份接续；挂载事件不能绕过退避。本轮直接调用工作区 RM09 `LocalBackupService::backup` 和 Rust 云上传服务验证调度，没有重写本地备份引擎。

### 接续契约与限制

`prepare_upload` 只消费 RM08 `FrozenSnapshot::Full`，使用 1 MiB **有序** DB chunk 和整附件，拒绝覆盖未解决的 pending。宿主先调用 `resume_upload`，需要放弃旧 staging 时显式调用 `abandon_upload`；后者仍先查询是否已提交。新切面/新 writer 身份使用新 generation/传输槽，不复用旧切面数据。已提交对象清理仅涉及该 cut 的本地 owned object 文件；未完成传输、manifest/part 元数据和下载缓存保留供接续，不自动扫描删除其他文件，也没有提供磁盘缓存配额管理 UI。

Worker v1 无 list-parts API，不能只凭本地 ETag 宣称远端仍有片段：重试对片段执行幂等 PUT 并检查 partNumber/hash，最终由 Worker 校验整对象后发布。已上传整对象由 plan 去重；multipart 会话过期重新建立会话。该保守行为可能重传已确认片段，不能宣称零重传。

网络每次响应有界；普通请求 60 秒，multipart 请求最长 30 分钟。同步快照/文件状态操作必须在服务工作线程执行；恢复大文件复制、最终完整性/重映射在 blocking worker，缓存回放主动让出执行以维持续租。取消须传 token 并等待任务结束，不能仅丢弃 future；SQLite 同步检查可能延后观察取消。pin DELETE 失败时保留原操作结果，由 Worker TTL 最终释放，不能保证网络断开时立即远端释放。

Scheduler 的 executor 和可用性由宿主提供，须校验 `ScheduledTarget.binding` 对应的当前连接/卷身份，实际失败不应返回成功；取消后等待底层作业结束再更新状态。自动启动 timer、业务 IPC、任务中心/设置 UI 接线归 RM29；RM14 才迁移/接管真实配置路径，`prepare_manifest` 不等于自动读取旧 TS `_local/cloud.transfers`。RM11 负责 writer 接管/retention/维护；RM12 负责在同一冻结切面生成 browse/captureAcks，RM10 当时仅能读取这些字段，后续已由 [RM12](#rm12) 接入生成。

### 本地验证

Linux x64 / Rust 1.99.1 / Node 24.11.1；全部材料在 `tmp/rm10/` 隔离目录。`cargo test -p anynote-core -p anynote-storage -p anynote-services --locked --offline` **116/116** 通过（2 个 ignored 是既有父测试调用的崩溃子进程）；其中 RM10 **6 项**覆盖 JS 数值/顺序/清单边界、凭据分离、持久租约/身份、两类调度状态与真实 RM09 服务派发。services 全 targets Clippy `-D warnings`、修改文件 rustfmt、五工程 guard（839 个锁定包）、脚本 ESLint/Prettier 和 `git diff --check` 通过。原 TS cloud-resume/cloud-recovery/cloud-multipart/backup-policy **21/21** 通过。

[`rust-cloud-reference.mjs`](../../scripts/rust-cloud-reference.mjs) 经实际 HTTP 代理访问未改 TS Worker，分别使用合成 D1/R2（14 组）与 **local-workerd/D1/R2（16 组）**：丢 plan/commit 回包及跨进程续传、提交不重复、cursor 修复、旧 head/epoch 拒绝、范围响应拒绝、受损 chunk 重取、恢复新库逐表对比与自链接、同恢复回执、取消/初始 pin 丢回包、真实 30 秒续租与续租失败、33 MiB multipart 丢 part 回包和会话过期重建、TS manifest 字节完全相同、超过一页的跨库/lineage 发现。最终 local-workerd 报告为 `tmp/rm10/cloud-GlOxwe/report.json`；报告保存在每次 `tmp/rm10/cloud-*/report.json`，不将其作为长期唯一证据。

复现：先构建既有 TS 基线（`pnpm run build:backend`，已有 `.build` 可复用），再执行 `cargo build -p anynote-services --example cloud_probe --locked --offline`、`node scripts/rust-cloud-reference.mjs` 和 `node scripts/rust-cloud-reference.mjs --workerd`；后一入口需要本机端口及 workerd。首次受沙箱 `listen EPERM` 限制，已在允许本机 socket 的环境重跑通过；并行模块变动造成的过时构建元数据在刷新 lib 后重编译解决，未把失败计为通过。

没有进行真实 Cloudflare、三平台/物理设备、真实用户数据、20 GiB 压力、GUI、老化或费用容量验收；A007–A009 与其余 V/A/F 不变。下一步 RM11/12 使用本组云协议和冻结身份接口，RM29 接服务宿主和用户可见任务状态。

<a id="rm07"></a>

## 2026-11-08 · RM07 导入预览、下载边界与采集回执

完成 RM07.1–RM07.3；保留并行 RM06/RM08 改动，复用现有五工程、schema v5、RM05 写队列/资源发布/事务和 RM08 ZIP 中央目录预检。源码基线 `eadc715` 加未提交工作区，未创建 Git 提交。接口和复现见 [Rust 导入接续契约](RUST-IMPORT.md)，不修改旧 TS 产品实现或真实资料。

- RM07.1：dom_query/html5ever + dom_smoothie + 项目转换规则，17 份旧 Readability/DOMPurify/Turndown 逐字语料覆盖提取/清洗/代码/表格/列表/链接等；懒加载及响应式图片、媒体/附件和白名单视频卡另测。下载验证全部 DNS、固定连接地址和实际 peer、正常 TLS 根/主机名校验、逐跳重验、关闭代理、统一 deadline、流式预算和取消。目录 capability 核对 root/file 身份并防路径竞态，拒绝 FIFO/越界链接。
- RM07.2：URL、HTML、Markdown 和文件句柄预览、媒体选择/本地化、原 HTML pin、缺失报告；目标绑定、4 个预览/8 个目录授权、30 分钟 TTL 与临时目录生命周期。确认只使用已预览资源/正文，源文件变化不改变确认内容，原 HTML/图片字节可由旧 reader 验证。
- RM07.3：采集包目录预检、ZIP CRC/hash/预算/声明一致性、JS canonical 数值及 UTF-16 排序、Markdown 目的地重映射和代码/ChatGPT 卡片原文保留。正文/资源/报告/capture receipt 同事务，双端重复提交返回原 note；失败不留下半写 SQL。媒体重试核对当前报告、marker、整行上下文和 revision，保留后续正文编辑，支持表格同一行及分次重试，跳过被代码围栏包裹或修改的引用。

本机 Linux x64 / Rust 1.99.1 / Node 24.11.1，材料均在 `tmp/rm07/` 隔离目录。core/storage/services 回归 **95/95**（另 2 个 ignored 为父测试执行的既有崩溃 fixture），包含本组 **22 项**：15 个导入集成、5 个网络、2 个 staging/预览生命周期测试。新增 HTML 17 份、canonical 3 份是集成测试中的共享语料。提取既有 fenced-code range helper 后，editor Markdown/source **13/13** 回归通过。三包全 targets Clippy `-D warnings`、五工程依赖检查（839 个锁定包）、格式与脚本 lint/差异检查通过。

旧 web-import/capture/capture-components/extensions **48/48**。`rust-import-interop.mjs` **5 组**通过：canonical digest 与 TS 相同、旧 reader 读取 Rust 正文及 exact 图片 hash、旧 TS 消费 Rust 回执、Rust 重开消费同回执、旧 reader 读取缺失报告和被 pin 的原 HTML。网络测试以真实 loopback socket 验证流式字节/声明限制、固定地址和禁止自动跳转、慢响应/背压取消、写入故障、不受信 TLS 证书拒绝；没有把受控 fixture 当成真实公网验收。首次 socket bind 与 Node spawnSync 被沙箱 EPERM 阻断，已在允许本地 socket/子进程的环境重跑通过；并行模块短暂编译错误未计为成功。

边界：不是三平台/真实目录与用户资料、生产公网、GUI、负载或发行验收。17 份转换语料不证明任意网页的 Readability 等价；HTML/ZIP 同步阶段的取消会在阶段完成后观察，宿主必须在后台工作线程执行。进入写事务后的取消不撤销成功结果，取消重试在提交前释放 staging。沿用 RM05 的 CAS 发布语义，SQL 失败可能留下未引用 CAS，不能删除历史字节；没有可靠原占位上下文的旧失败报告安全跳过。报告仍需宿主做有界 IPC 投影，任务/IPC/UI 接线归 RM28/29、采集消费归 RM12、真实公网归 RM35，V/A/F 状态不变。

<a id="rm09"></a>

## 2026-11-08 · RM09 本地备份 v3、卷适配与新库恢复

完成 RM09.1–.3 本地与模拟卷范围，接续入口见 [Rust 本地备份](RUST-LOCAL-BACKUP.md)。新增 `anynote-services::local_backup`，复用 RM08 未裁剪冻结切面、完整性/资源闭包与新库身份重映射，保留 v3 根标记/manifest、1 MiB 有序分块及整附件，不改源库或 TS 格式。

目标目录/卷身份与根标记逐阶段复核，网络挂载/FAT32/空间预检、等待磁盘状态、Linux mountinfo 和 UUID、Windows 卷 API、macOS statfs/getattrlist 原型已接入。Rust 与旧 TS 共用 SQLite 目标租约，另有 Rust 文件锁保护同进程任务；不使用 PID/过期时间删除锁。通过能力目录及开放句柄检查路径替换，未知文件不纳入扫描清理。

发布使用 pending→写入/hash/fsync/读回→复核→manifest→cleanup。零捕获要求同实例、同写租约、完整 manifest 指纹相同以及文件 token/hash 匹配；重启、重开或外部 manifest 变化重新捕获/hash。验证报告不信任 token，恢复在私有 staging 装配并校验后发布新 UUID 库，源 DB 损坏仍可恢复。手动/分组备份、验证和分组恢复复用 RM03 TaskHistory/RuntimeState；回执 key 为 `backup.local.receipt.<operationId>`，中断不自动重放。

本机 Linux 验证：RM09 Rust **17/17**，既有 archive **14/14**；**8 组 TS↔Rust v3 互通**覆盖冻结历史资源/未知 JSON、双向验证与恢复、重启重新捕获、pending/文件写完/manifest 发布后的真实子进程退出与恢复、TS 目标锁排斥 Rust、损坏报告。额外 Rust 用例覆盖未引用 asset 保留、有序重复 chunk 声明、源 DB 损坏后恢复、manifest 篡改、发布前文件变化、目录替换/链接拒绝、取消、模拟磁盘满、发布前失败/提交后清理待重试、任务历史与回执、Linux/Windows 卷和 macOS UUID 响应 fixtures。

旧 `backup-local` / `backup-boundaries` **46 通过、1 既有跳过**。RM09 test/example targets Clippy `-D warnings`、修改文件 rustfmt、脚本 ESLint、五工程依赖 guard（839 个锁定包）和 diff 检查通过。初期原工作区被并行 cloud 模块未完成文件阻断，先在 `tmp/rm09/check` 副本隔离验证；最终原工作区构建、测试和 scoped Clippy 通过。Node 子进程在沙箱内出现 EPERM，互通和旧测试在允许本机子进程的环境重跑通过。临时报告在 `tmp/rm09/`，不作为长期证据依赖。

未验证 Windows/macOS 原生编译/API、真实 NTFS/exFAT/APFS、物理磁盘满/拔盘/断电、真实用户资料或 20 GiB/大规模性能；17 项 Rust 测试不能替代 RM32/33。完整白板/PDF 闭包随 RM24/26；GUI/IPC 和管理页面随 RM29，自动调度由 RM10 所有。同步 SQLite 完整性检查的取消仍可能延后。V/A/F 状态保持未完成。

<a id="rm08"></a>

## 2026-11-08 · RM08 一致快照、归档、开放导出与核心清理

完成 RM08.1–RM08.4 的基础接口与本地契约验收，接续工作区 RM04/RM05 并保留同时进行的 RM06/RM07 改动。源码基线 `eadc715` 加未提交工作区；未创建 Git 提交。接口、格式与复现见 [Rust 快照与归档](RUST-SNAPSHOT-ARCHIVE.md)，没有修改 schema v5、旧 TS 业务实现或真实用户数据。

- RM08.1：Online Backup/WAL 切面、写租约 pin、附件 hard link/copy、临时目录生命周期；冻结后在后台处理。Full 保持源 epoch，Current 重建 FTS/VACUUM，Preservation 保留未裁剪 DB 与附件。持久快照创建/列举/校验/恢复新库，源 DB 损坏时仍能列举恢复；重开租约不能复用快路。
- RM08.2：有界 ZIP/ZIP64 导出，私有 staging 导入及全部大小/hash/CRC/精确 schema/身份/树/资源闭包校验；预检中央目录以防 ZIP reader 隐藏重复条目，拒绝穿越、链接、加密、重叠、超预算及错误内容声明。requiredExtensions 只检查内容，不加载插件。导入重置库 ID/lineage、自链接与索引，不覆盖源库；最终输出无覆盖发布。
- RM08.3：Markdown 目录/ZIP、NFC/UUID 文件名与长路径映射、损失报告、修订绑定资源、白板原 scene/嵌图场景/图片/预览、批注 sidecar。完整性证据包含未裁剪切面、hash 和错误，拒绝将已裁剪或裁剪失败的副本标为完整保全；Notebook 证据不代替配置与整个工作区迁移备份。
- RM08.4：仅清理超保留策略的持久快照，5 分钟/20 个计划，显式确认、租约/epoch/序列/文件身份与 hash 复核；活动 pin、旧计划或引用变化拒绝。journal 先落盘再隔离，移动失败尽力回滚，重启可恢复且不覆盖新文件。确认提交后 purge 释放隔离文件，部分失败返回剩余项并保留回执；隔离量与已释放量分别返回。

本机 Linux x64 / Rust 1.99.1 / Node 24.11.1，全部为 `tmp/rm08/` 隔离合成材料。最终 `cargo test -p anynote-storage -p anynote-services --locked --offline` **88/88** 通过（含本组 **16 项**；另 2 个 ignored 为既有父测试启动的崩溃 fixture）。两个包全 targets Clippy `-D warnings`、修改文件 rustfmt、探针构建、五工程依赖 guard（839 个锁定包）及 `git diff --check` 通过。旧 archive-stream/cleanup/integrity-inspection **25/25** 回归通过。

`rust-archive-reference.mjs` **10 组** TS↔Rust 差分通过：RM01 冻结 full/current/ZIP64 导入逐表对比、3 类冻结恶意样本拒绝、Rust full/current ZIP64 条目反向旧客户端导入、Markdown 映射/正文/scene/图片/批注比对，以及 32 MiB 随机附件流式写包时 SIGKILL 后不发布半包、源库/附件可重开。Rust 测试另覆盖复制后续编辑隔离、旧页敏感文本清除、文件篡改/重叠/重复目录/解压预算、过期及引用变化拒绝、移动后注入 I/O 错误回滚、隔离恢复冲突、显式 purge、流式取消与模拟写满错误。初次 Node 子进程和后续并发新增网络测试在沙箱出现 EPERM，分别在允许本机子进程/socket 的环境重跑通过，没有将受限执行计为成功。日志保存在 `tmp/rm08/`，该目录可删除。

边界：只完成 RM08 本地契约，不宣称三平台、真实资料/外部卷、物理磁盘满/断电/拔盘、20 GiB 或性能通过。取消可能等待同步完整性检查完成；清理 hash 复核占用写队列，大规模延迟未测。最终媒体闭包交 RM24/26，任务/IPC/管理 UI 接线交 RM29，整体接管和配置保全交 RM14；不关闭 V/A/F，也不执行真实清理。

<a id="rm06"></a>

## 2026-11-08 · RM06 跨库闭包、幂等回执与中断恢复

完成 RM06.1–RM06.3，沿用 RM05 写队列、独占租约、事务、索引和 CAS 发布器，未新增 schema 或修改旧 TS 产品代码。服务入口 `anynote_services::transfer::transfer_node`，存储阶段及回执在 `notebook/transfer.rs`；接口与失败语义见 [Rust 写存储](RUST-WRITE-STORAGE.md#跨库复制与移动)。保留同一工作区并行 RM07/RM08 的改动，不把其交付计入本组。

- RM06.1：复制节点子树（含已删除子项）、全部修订、当前及历史资源、PDF 批注/提取文本、导入报告和修订元数据。重映射内部链接、资源 ID 和白板场景嵌图，外部链接及未知正文保留；不复制库级未知状态。节点 10,000、记录/附件各 100 MiB，递归查询和逐行读取限制预算。复用 CAS 发布，转移不会被普通保存的 50 MiB 单资源入口误限。
- RM06.2：服务在同一写队列任务内固定两端租约；容量 1 时临时容纳两端，结束恢复预算。目标记录/索引/回执原子提交，移动再核对目标记录/附件和源指纹，最后软删除源并提交完成回执；不改变旧删除批次。已有回执绑定完整请求，返回原 ID 映射，恢复源后重复完成请求也不再次删除。指纹保留 TS 字段/行顺序，使用 `ryu-js` 处理 ECMAScript 数值序列化，包括 `1e-7` 排序键，支持两种语言交替续跑。
- RM06.3：4 项 storage 故障/预算测试 + 4 项服务专项测试，覆盖两端事务中回执前后进程退出、目标资源/SQL 失败、资源损坏、版本/父节点/同库拒绝、operation ID 冲突、容量回收、重开与两端后续编辑保护。新增 ignored child 是由父测试启动的 4 个崩溃切点，不是跳过故障验收。

本机 Linux x64 / Rust 1.99.1 / Node 24.11.1，全部为 `tmp/rm06/` 隔离合成数据。`cargo test -p anynote-storage --locked --offline` **36/36**（另 2 个 ignored 子进程 fixture 均由父测试执行），`cargo test -p anynote-services --test transfer --locked --offline` **4/4**，旧 `vitest run tests/transfer.test.mjs` **8/8**。`rust-transfer-reference.mjs` **8 组 TS/Rust 互通通过**：Rust 完整复制与 TS 回读、TS 目标提交→Rust 完成、Rust 目标提交→TS 完成、源/目标编辑、两端附件损坏、目标 WAL 提交后 SIGKILL 重启；覆盖历史白板图片与 PDF 检索，并验证先前删除子项的恢复批次。storage 全 targets Clippy、实际 transfer 服务源文件的隔离 harness Clippy、脚本 ESLint 及五工程依赖 guard 通过。

并行 RM07/RM08 编辑期间首次整包构建存在缺失模块/未缓存依赖，先在 `tmp/rm06/harness` 直接引用正式 transfer 服务源文件和 storage crate 验证，随后原工作区服务专项与探针构建通过。仅修正两处阻断公共编译/Clippy 的明显字段/借用问题（导入读取 `note.node.note_type`、`create_inside` 的多余 `&id`），未改变导入业务范围。Node 互通脚本首次沙箱 `spawnSync EPERM`，在允许本机子进程的环境重跑；未吞掉错误或将失败输出算作通过。最终互通报告为 `tmp/rm06/reference-G2npH7/report.json`。全 services Clippy 此次仍被并行 RM08 的 `archive.rs`（`unnecessary_sort_by`）及 `open_export.rs`（`regex_creation_in_loops`）挡住；未修改这些相邻模块，不声称全 services lint/全工作区回归通过。

边界：本组不是三平台/真实用户库/外部卷、断电、性能、生产接管或 UI 验收；RM24 的完整白板编辑互通、RM31/32/33 与全部 V/A/F 保持原状态。中断或 SQL 失败留下无引用 CAS 时不擅自清除，由 RM08 的受控清理接续。关闭后的损坏库可能在取得租约时拒绝而非返回 changed 状态；两种路径均保留源数据。

<a id="rm05"></a>

## 2026-11-08 · RM05 写租约、核心事务与资源修订

完成 RM05.1–RM05.4，在既有 RM04 未提交实现上接续，保留其他工作区改动。源码基线 `eadc715` 加本地 RM04/RM05 工作区；不创建 Git 提交。接口、失败边界和复现见 [Rust 写存储](RUST-WRITE-STORAGE.md)。没有修改冻结 schema、旧 TS 产品逻辑或真实用户资料。

- RM05.1：一个后台写线程、容量 64 的 FIFO、可配置 1–64 连接 LRU、跨调用 pin、退出排空。SQLite EXCLUSIVE/WAL/FULL 租约与旧版竞争同一 OS 锁，事务错误及 unwind 回滚，沿用可选完整 backup revision SQL。租约 lineage 每次重开变化，持久 lineage 保留。
- RM05.2：托管/外部建库、库名称/封面、节点/目录、条件保存、移动/排序、标签/收藏、删除批次恢复、修订元数据恢复、FTS/反链及 hash 绑定批注。使用旧毫秒、安全整数和 UTF-16 限额；条件冲突不覆盖正文。
- RM05.3：流式 SHA-256、flush、无覆盖 CAS 发布、资源 ID 重绑定与修订计数、递归白板嵌图闭包。旧修订资源优先复用，恢复后保存不漂移。内置设置白名单及单笔记 propose/apply/undo，应用和撤销的正文/状态同事务；原始未知 JSON、历史资源及未涉及的密文保持不变。
- RM05.4：旧 TS 写→Rust 读→Rust 写→旧读的同库交替，以及独立副本的逐项写差分；涵盖标题/标签/收藏、排序、删除恢复、历史、批注、提案双向消费、建库续写、资源失败与三进程互斥。SQLite 事务内退出与持锁进程 SIGKILL 分别验证回滚及租约释放。

本机 Linux x64 / Rust 1.99.1 / Node 24.11.1，全部为隔离合成数据。`cargo test -p anynote-storage --locked --offline` **32/32**；另 1 个 ignored 是由父测试以 `--ignored` 显式执行的崩溃 fixture。storage 全 targets Clippy `-D warnings`、两个探针构建、Rust 五工程依赖 guard（800 个锁定包）通过。`rust-write-reference.mjs` **17 组通过**，最终报告 `tmp/rm05/reference-FU57r2/report.json`；RM04 只读差分 **28 组通过**且原库文件 hash 不变。旧 storage/organization/workspace/rust-migration 共 **33/33**：首次沙箱内 32 通过、1 个旧 OS 锁子进程测试超时；沙箱外重跑 workspace **6/6** 通过。未运行全工作区 UI/editor/云端回归。

验证实际暴露并修复 Unix 文件身份检查的锁缺陷：额外打开/关闭 DB 描述符会释放该进程的 POSIX 锁，同进程 SQLite 检查却仍显示 Busy。改用 stat device/inode 后，旧 TS 与两个 Rust 进程互斥通过；该回归不能简化成仅同进程测试。最初互通脚本在沙箱内 spawnSync 返回 EPERM，转到允许本地子进程的环境完成，未忽略错误。脚本仅规范化独立运行的时间/生成修订 UUID，对未知 JSON、正文、资源 hash、整数及既有 ID 保持严格核对。

边界：本轮不是 M3 整体、三平台、实际用户库/卷、断电、性能或最终发行验收；日常业务 IPC/UI 与生产接管仍按原后续组实施。CAS 发布使用 hard link，暂不支持该能力缺失的卷；Windows 目录持久化及三平台真实卷行为仍须 RM32/33。失败留下的无引用 CAS/临时文件保全，RM08 再以清理计划处理；不擅自删除未知状态或旧密文。全部 V/A/F 与 RM06–12/28/29/32/33 等状态不变。

<a id="rm04"></a>

## 2026-11-08 · RM04 schema v5、资源与搜索只读数据面

交付 `anynote-storage::notebook` 的 schema/catalog/read/search 与 CAS 资源句柄，不新增 schema 或写入业务，不接 GPUI 页面。接续接口、恢复拒绝边界和复现见 [Rust 只读存储](RUST-READONLY-STORAGE.md)。复用 RM01 冻结 SQL/库、已有 Rust directive parser、TS search/navigation 语义；既有迁移成果保留，未改旧 TS 产品实现。

- RM04.1：精确 SQL 对照、可选完整 backup tracker 与 64 位整数 counter、integrity/foreign keys、树/当前修订归属检查；外部目录与离线登记、身份/路径诊断、只读 LRU。缓存核对原文件和 WAL 身份，替换/更新后重新打开；不自动修复、重建 FTS 或创建业务表。WAL 缺少共享内存时明确拒绝恢复，避免只读入口创建源文件。
- RM04.2：读取节点/正文/全部或最近 100 条历史/回收站/批注/未知 JSON；历史资源按 revision 固定 hash，包含白板嵌图闭包，未知原文不规范化。流式校验 CAS hash/大小，持有已校验文件句柄作有界范围读取，复核路径和文件身份；原库与拒绝样本的文件清单/hash 不变。
- RM04.3：FTS5 trigram、Unicode 字符数分支的短查询、跨库组合过滤/稳定排序/软预算/取消/截断、反链、正文/PDF 页面/当前 hash 批注/metadata 定位。保留旧格式小数排序键；搜索任务宿主接线继续复用 RM03，不另造任务状态。

本机 Linux x64 / Rust 1.99.1 / Node 24.11.1，全部为合成离线数据。`cargo test -p anynote-storage --locked --offline` **14/14**（13 项新增只读测试 + 1 项增强 SQLite 构建能力测试）；storage 全 targets Clippy `-D warnings` 通过。`rust-readonly-reference.mjs` **28 组 TS/Rust 差分通过**，搜索结果与读取投影逐项一致，警告按 Notebook 身份比较，原文件 hash 不变。旧 TS search/navigation/workspace/rust-migration 共 **30/30** 回归通过：首次沙箱内 workspace 子进程锁崩溃恢复 1 项超时，沙箱外重跑 workspace **6/6** 通过。Rust 五工程依赖边界通过（800 个已锁定包）。

只读本机验证不代表三平台/真实用户资料/外部卷/性能/断电验收，也未接日常业务 IPC、UI 或写流程；RM05 和 RM28/29 按原范围接续，M2 与 V/A/F 状态不变。临时差分输入/报告位于可删除的 `tmp/rm04/`，长期信息保留在上述接续文档。

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

### 2026-11-09 · RM22 续实施

沿用唯一 Board/Scene/事务历史，新增 `CropImage`、`ResizePath`；图片裁剪支持八手柄、旋转/翻转、比例约束、原图边界与恢复完整图片，路径支持负坐标/多点缩放并保留压力。组级对齐/分布实现最外层组边界及重叠中心间距规则；新 `order` 模块处理跨组、框内外、绑定文字和墓碑的排列。带绑定图片、elbow/绑定路径仍拒绝，避免在缺少连接布局时产生错误 scene。未新增依赖、UI 或持久格式；MIT 移植许可随代码保留。

上游证据扩展为 30 步主轨迹、14 条层级序列（84 步）、145 例几何，Rust 逐步业务 JSON 差分及 undo/redo。多框部分选择的置顶差分揭示 0.18 每次从原数组计算、仅最后一个 frame 排列保留；按冻结版语义实现并记录，没有用理想化算法生成参考值。裁剪组合覆盖八手柄、两种角度、四种翻转、两种比例模式，另有未裁剪/已有裁剪的极端 pointer，以及路径零跨度/负坐标。

新增隔离浏览器入口探针，挂载真实 Excalidraw 和 AnyNote 的四个 UIOptions，记录主菜单、更多工具、属性和右键菜单、93 个运行时动作（91 注册项加 undo/redo）的 macOS 快捷键分派。测试页面由路由直接返回 localhost 安全上下文，外部请求阻断。`export:false` 仍允许 saveFileToDisk 分派、默认图片导出及右键复制图片，明确保留在迁移范围。快捷键普查拦截副作用；另有 8 类工具的真实指针/文字创建和旧版键盘 undo/redo，不能混称所有动作都已完整执行。

本机 macOS、Rust 1.99.1、Node 24.22.0、独立 Chrome 临时配置：23 项 Rust 白板测试通过，包含上述参数化语料及连续裁剪的浮点边界/未知属性保留；当前 editor crate 全部 85 项测试通过；editor 全 targets Clippy `-D warnings` 通过。脚本的 ESLint/Prettier、Rust 定向格式与 diff whitespace 检查通过。浏览器初次受沙箱进程限制，获准离线测试后运行；Playwright 缓存缺失时复用已安装的 Chrome。中途 Cargo 锁文件与其他在途依赖修改短暂不同步，未由本任务修改锁文件，恢复一致后 `--locked --offline` 检查通过。临时日志/bundle 位于 `tmp/rm22/`。

RM22 仍部分完成：尚缺条件入口完整交互、原生字体布局、开放绑定/elbow、组内编辑、完整路径/剪贴板/库/导出及其全序列历史差分。已同步 TODO、兼容契约和文档索引；不关闭 E8/M6，也未接管旧白板或改动其他在途功能。

<a id="rm21"></a>

## RM21 · 图片阅读、文档图片与版本（2026-11-09）

完成有界静态解码、EXIF 方向/相机信息、640 缩略图与 2560 阅读预览、安全 SVG、缩放/适应/实际尺寸/平移/视图旋转。图片块复用 core 编辑事务，保留 anynote-resource/core.image 未知字段，宽度 32–4096 或自适应；文件选择、剪贴板和外部拖放走同一后台导入管线。区域批注固定原图归一化矩形和 hash；旋转另存 PNG 新修订，历史原字节与旧批注不漂移。

媒体写入纳入 RM19 CAS 与媒体 generation，ack/断线核对同时匹配 hash；失败保留待提交字节，冲突另存复制资源。复用 VerifiedAsset 实现有界读取租约，避免每 256 KiB 重验整图 hash；关闭/取消/读完释放句柄和纹理。原图复制/导出不使用旋转预览；跨库、完整快照和 Markdown 导出复用既有服务。

本机 `cargo test`：core/editor/storage **127 项通过、2 个既有辅助夹具 ignored**；desktop 带 ui-tests 的库与 image/image_backend/image_storage/image_ui **41 项通过**。覆盖真实后端上传/CAS/历史/批注/句柄，跨库与导出闭包，生产控件粘贴/文件选择/拖入/取消/宽度/选区/批注/原图复制导出/旋转/历史/冲突另存和关闭迟到结果。另有 archive/transfer **18 项通过**；五工程全目标 Clippy（含 ui-tests）、定向 rustfmt、依赖边界（5 工程 / 844 包）与 diff 空白检查通过，日志 `tmp/rm21-*.log`。发现并修复了 arbitrary_precision + tagged enum 的浮点坐标往返问题。

本地矩阵完成，未接管真实资料。原生隔离 macOS 构建打开笔记、插入菜单与文件选择器，但路径确认工具反复回到根目录，未完成原生图片画面及系统导出选择器；真实照片、DPI、内存和三平台验收留 RM31/32。静态首帧、SVG 外部资源禁用及 40MP/24MP/纹理预算详见[图片契约](RUST-IMAGE-MEDIA.md)，不关闭整组 M6/INV-07 或 RM18/19 平台缺口。

<a id="rm20"></a>

## RM20 · 声明块与静态内置业务（2026-11-09）

已知阅读 callout 与原生 details/提示块可展示、字段编辑、共享撤销；未知/未来/非法数据保留源码、复制和导出。采集卡片使用有预算的 HTML 文本标签及样式白名单，原生投影不执行脚本、事件或远程资源。阅读菜单提供创建、模板、UTF-16 统计、同步/异步检索追加、目标、整理次数及 RM07 公开文本下载；偏好窗口提供目标和白板/视频/HTML、远程嵌入同意。新 Notebook 远程同意默认关闭。

复用 RM19 flush/CAS/epoch/generation，网络任务不阻塞后端协议循环。相同 operation UUID 与摘要核对持久回执；正文、历史、FTS、次数、回执及 content_seq 同事务。新增 TEMP trigger 故障注入验证回执失败全部回滚。固定 manifest/checksum/schema 转换保留 v1/v2 状态和未知字段；未转换的旧状态阻止默认值覆盖。没有新增动态插件系统。所有首方 adapter 的归属及未知脚本迁移阻塞见[业务契约](RUST-BUILTIN-BUSINESS.md)。

本机 core/editor/storage 联合回归 **127 项通过**，services 内置业务 **9 项通过**，desktop 带 ui-tests 的库测试 **30 项通过**，真实后端阅读/偏好/重开 **1 项通过**。新增 RM20 专项共 18 项：editor 4、services 9、storage 2、GPUI 2、backend 1；GPUI 测试使用原生字段输入、点击应用、撤销、details 展开与原文复制。依赖边界 **5 工程 / 844 包**通过，`git diff --check` 通过。最终五工程全目标 Clippy（含 desktop ui-tests）通过；本轮新增文件 rustfmt 检查通过。临时日志位于 `tmp/rm20/`，最终 Clippy 日志为 `clippy-final.log`。

补充服务回归：lib **18 项通过**（包括已有 RM07 下载器本地 socket/超时/取消/TLS 测试，沙箱禁止监听后获准重跑）；RM14 migration **11 项通过**。后者首次并行运行遇到 `MIGRATION_BUSY` 与临时目录 `PATH_REDIRECT`，使用规范路径 `TMPDIR=/private/tmp`、`--test-threads=1` 后通过；没有修改迁移实现或放宽校验。日志分别为 `tmp/rm20/migration-tests.log`、`migration-serial.log`。

隔离状态目录启动了原生 macOS 窗口；桌面工具一次调用长时间阻塞，返回的可访问树只有窗口与菜单，因此未完成真实内容交互、导出文件选择器、卡片视觉对照或 IME 验收。未访问真实个人资料，未将私网拒绝/下载器单元测试算成真实公网成功下载。正式用户插件盘点、RM14 接管和 RM19 平台退出边界仍分别阻止对应阶段放行；不关闭 M5/E6。

<a id="rm19"></a>

## 2026-11-09 · RM19 源码模式与保存会话（部分完成）

完成 RM19.1/.2 与 RM19.3 的应用内实现。`DocumentSession` 聚合唯一 core source/history/composition 和保存控制器；Kit 源码按需创建，启用 Markdown/inline grammar、高亮/行号/折叠/内置搜索替换和格式包裹，批次一次撤销、程序化无回声、反向选区和滚动恢复。补齐源码视口高度；沿用 RM18 正文视图而不改其几何/剪贴板范围。

桌面私有协议 v2 接 Create/Open/Save/历史资源，控制帧 16 MiB 覆盖既有正文预算的 JSON 转义；后端延迟打开 RM05 单写队列。平台壳新建/继续编辑使用独立状态目录 `workspace/`，同笔记复用窗口，不激活旧用户目录。650ms debounce、串行 CAS、epoch/generation 和发送中输入隔离已实现；未知提交先读原笔记核对、明确未提交才允许重试；冲突保留两方快照，可复制、查看或另存正文。正常关闭、切换、失焦和应用内退出统一等待 flush/IME。

本机 macOS / Rust 1.99.1，core/editor/desktop 联合回归 **118 项通过**，另有 1 项 ignored 子进程夹具由父测试执行；新增 4 状态、5 GPUI、2 真实后端测试。覆盖批量替换/选区/源码视口与折叠候选/滚动、断线/失败/迟到 ack/IME 等待、切换隔离、丢失响应后重开/大正文及历史资源绑定。短 TMPDIR 避开既有平台 socket 长度限制；沙箱拒绝 socket 后获准复跑通过。Clippy、rustfmt、依赖边界（5 工程 / 844 包）通过。新增五项锁定语法依赖，Kit/GPUI 版本不变；日志在 `tmp/rm19/`。

真实原生窗口打开了隔离笔记和源码入口，后续工具报状态变化及 timeoutReached，未完成实际输入/关闭/重开验收。Kit `on_app_quit` 不可取消，系统 Dock/OS 退出仍可能绕过应用内保存屏障；平台结束组合输入请求接口亦未提供，只能等待 commit/cancel。RM19.3 保留未完成，不宣称跨进程崩溃草稿恢复、RM18/32/E5 或媒体/真实资料通过。详见[会话契约](RUST-DOCUMENT-SESSION.md)。

<a id="rm18"></a>

## 2026-11-09 · RM18 连续 GPUI 编辑视图与原生输入（部分完成）

新增 `apps/desktop-rust/src/document_editor/` 与平台壳“新建草稿…”入口。Kit `editor_host` 渲染连续正文，按段落/列表行/表格行虚拟布局；RM16 持有唯一 source/history/composition，RM17 处理结构命令。接入原生文字输入、slash/浮条/工具条/原生菜单统一命令、任务/表格、搜索与内部块移动、原文入口、剪贴板字符串/本应用 Markdown/TSV、候选窗位置及模型文本/表格 a11y。源码 `InputEditsEvent` 使用逐步快照，程序化同步无回声，undo/redo 回到同一内核。草稿明确未保存，不新增 DocumentSession、资源写入或第二套 autosave。

原型修复解码文本与源范围映射、空任务物化、空引用输入、代理对取整、组合局部更新/取消与源码预编辑保护、插入 marks 的历史分组、屏幕外未测量行搜索及缩放定位。内核只做所需事务/片段复制/结构扩展，保留 opaque 原文与严格原子验证；新增 desktop 对已锁定 markdown/unicode-segmentation 的直接依赖，未升级 Kit/GPUI。

本机 macOS、锁定 Rust 1.99.1、合成语料：16 项编辑器测试（含 6 项 GPUI）通过；core/editor/desktop 联合回归 107 项通过，另有原设计 ignored 的子进程夹具 1 项。联合测试启用 serde_json 保序特性后暴露既有白板对象键顺序比较错误，改为键集合比较，其他语义/历史断言不变。macOS 默认临时路径超过 Unix socket 限制，改用仓库 tmp；沙箱 socket 拒绝后获准复跑通过。Clippy `-D warnings`、rustfmt、依赖边界（5 工程/839 包）通过；日志位于可删除的 `tmp/rm18/`。

RM18.1–.3 尚未完成：BiDi/跨行范围几何、HTML MIME 原生适配、跨复杂结构选择、表格/代码独立滚动、完整 a11y 和实际拖放仍有缺口。真实程序已启动，但桌面工具随后报 `noWindowsAvailable`，不能认定原生编辑窗口/系统输入法/读屏通过。保存和媒体行为依赖后续任务，旧 test:document 未完整重放。详见[连续编辑视图契约](RUST-EDITOR-VIEW.md)；M1/M4、E1/E4、V/A/F 及旧桌面退役门槛保持未通过。

<a id="rm17"></a>

## 2026-11-08 · RM17 列表、表格与结构编辑

完成 RM17.1–RM17.3 的纯 E3 结构范围。新增 `anynote-editor::structure::{Structure, StructureNode}`，准备同一 RM16 `Transaction`；新增内部 runs 复用入口，没有改动 model/transaction/history/composition 所有权、依赖或持久格式。段落/标题/list split/join、列表创建/缩进/逐层提升/空项退出、引用/任务勾选、plain/多段 Markdown/atom 粘贴、表格插入/替换/空单元格编辑/Tab/行列/矩阵粘贴、跨节点/块选区、atom 落点及整块移动/删除均经过统一原子提交和历史。详见[结构编辑接续契约](RUST-EDITOR-STRUCTURE.md)。

局部结构 serializer 复用 RM16 marks/link/entity/code 编码，在提交前重解析比较语义并验证全文相邻块。修复共同语料暴露的 Unicode directive 分隔、行首缩进与 CR code 逻辑换行边界；列表尾部空白 span 可按解析器归属变化，但源 splice 保留未改字节。相邻列表用等价 marker 防止空项退出后合并。表格补齐短行，额外单元格扩列保留；不新增复杂合并单元格。opaque/directive 保留原文、未知属性/JSON 和资源 URI，不执行载荷；无法安全隔离的 unclosed fence/嵌套 atom 操作原子拒绝。

本机 Linux、锁定 Rust 工具链、离线合成语料：`cargo test -p anynote-core -p anynote-editor --offline --locked` **77/77** 通过（core 2、board 19、RM15 13、RM16 17、RM17 26）。RM17 包括 fixed seed `0x17ab1e`、`0xc0ffee`、`0xdeadbeef` 各 200 轮表格编辑与独立矩阵比较、`0x171157` 180 轮列表操作，逐步验证源选区并完整 undo/redo；RM15 54 份共同语料中 38 个可富编辑块完成结构转换/字节恢复，恰达 UTF-16 预算的增加操作明确拒绝。覆盖嵌套 list/quote/table/code、marks/Unicode、空项和空单元格、表头提升、跨块反向选区、真实 directive 原文、资源链接、过期及 composition 活跃的原子失败。

core/editor 全 targets Clippy（`-D warnings`）、变更 Rust 文件 rustfmt、五工程依赖 guard（839 个锁定包）、文档链接及 `git diff --check` 通过。没有增加新依赖。临时证据在可删除的 `tmp/rm17/`；保留工作区已有 RM14/RM16 等改动。

限制：本组验证纯命令内核，没有执行连续 GPUI UI、OS 剪贴板/HTML 导入宿主、真实 IME/a11y、输入延迟或保存验收。空段落用源落点表示；虚拟空单元格暂以行尾源位置配合 `CellAddress` 定位；结构改动后重新取得 generation/BlockId/path，不能缓存旧路径。局部及全文重解析/临时源缓冲仍存在；RM18/19/32 及 M1/M4/V/A/F 保持原状态。

<a id="rm16"></a>

## 2026-11-08 · RM16 文本事务、选区、撤销与组合输入

完成 RM16.1–RM16.3 的纯编辑内核。`transaction::Editor` 独占文档、选区、历史与 composition；复用 RM15 `SourceEdit`/`ChangeMap`/mdast，增加同一 generation 的原子批量 patch，验证全部 expected/range/结果选区后一次发布。修复批量映射中块边界插入的身份候选处理，RM15 原文/BlockId 回归保持通过。`selection` 支持 UTF-8/UTF-16/grapheme 精确转换、整 cluster 删除、反向选择与 affinity；`InlineContent` 支持局部 marks/link、字面文本、代码 fence、表格管道及 CRLF 硬换行，并通过重解析验证生成语义。详细调用约束见[输入内核契约](RUST-EDITOR-TRANSACTIONS.md)。

历史只保存改动字节及前后选区，普通相邻源码输入/删除按同块和时间窗口合并，格式/粘贴/跨光标/IME 等打断；步数与累计字节预算仅丢弃旧历史，不裁正文。预编辑保持独立 overlay，cancel 不改变正文与 redo，commit 一次进入相同事务/历史；富文本最终文字通过冻结 inline 投影准备，提交失败保留组合。没有增加 UI、保存副作用或第二个历史 owner。

本机 Linux x64、锁定 Rust 工具链、离线合成语料。`cargo test -p anynote-core -p anynote-editor --offline --locked` **51/51** 通过：core 2、既有 board 19、RM15 13、RM16 17。专项覆盖原子失败/redo 保全、Unicode/选区映射、输入合并、预算、组合状态转移与重复/过期提交、富文本 marks/link/code/CRLF/表格及源恢复。固定 seed `0x16a11`、`0xc0ffee`、`0xdeadbeef` 各 300 轮文本/组合输入，独立字符串预期、模型不变量及完整 undo/redo 重放通过；`0x16f04a7` 的 240 轮重叠 marks/link 通过。历史预算用 200,000 字节正文和超过预算的 Unicode 插入验证没有裁正文，不作为性能验收。

core/editor 全 targets Clippy（`-D warnings`）、变更 Rust 文件 rustfmt、五工程依赖边界 guard（本次 839 个锁定包）、文档相对链接及 `git diff --check` 通过。只新增 editor 对已锁定 `unicode-segmentation = 1.13.3` 的直接依赖；没有升级依赖版本。临时日志写入可删除的 `tmp/rm16/`。保留同期 migration/storage 模块的其他工作区改动。

范围限制：全量派生重解析与临时源缓冲仍存在；未测输入延迟、原生视图、OS IME、候选窗、焦点/a11y 或保存接线。RM17/18/19/32、M1/M4 和 V/A/F 状态不因这些核心测试自动通过。

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
