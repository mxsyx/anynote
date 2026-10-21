# 已完成记录与历史背景

[返回总入口](../../TODO.md)

以下 21 条完成记录及背景从拆分前清单迁移，保留原始勾选和实现说明。它们是历史记录，不是 2026-10-21 重新执行的验收结果；旧版本、路径、模式和未实现描述可能已经变化，不能作为当前状态的唯一依据。真实设备/厂商验收仍在各执行组。旧章节号见 [原章节对照](../../TODO.md#原章节对照)。

## 原 §2.3 macOS 专属

- [x] **P1 — macOS/APFS 实盘验收**：验证卷身份、挂载/重挂载、网络盘与 FAT 限制，以及复制、覆盖替换、fsync、校验和完整恢复。已新增 `scripts/macos-volume-acceptance.mjs`（`pnpm run test:macos:volume`），用 `hdiutil` 挂载真实 APFS/FAT32 卷（免 root、结束自动卸载清理）逐项验证：卷身份与 `diskutil` 报告的 `VolumeUUID` 一致且能与源卷区分、替换/读回/目录 fsync 探测、复制与覆盖替换、完整校验与完整恢复（恢复后数据库与全部附件哈希核对）、卸载后 `TARGET_OFFLINE` 且不发布、重挂载后清单与卷身份一致、同一路径换上另一块卷被拒绝、FAT32 单文件限制按计划拒绝超限；报告 `test-results/macos-volume-acceptance.json`（5 项通过）。真实 Electron 41.9.1 与 Utility Process 在 APFS 上以 `--require-filesystem apfs` 通过 9 项桌面验收，报告 `artifacts/macos-desktop/desktop-local-backup-apfs.json`。仍未执行：本机系统拒绝创建 exFAT 镜像（`hdiutil` 返回「操作不被允许」，记为 `skipped`，exFAT 仅保留解析层 fixture 覆盖）、真实网络盘挂载（仅解析层覆盖）及真实输入法/原生对话框人工验收。

## 原 §5. 云盘备份（Google Drive / Dropbox / OneDrive）

- [x] **P1 — Dropbox Provider**：已按云盘备份设计 §11 新增 `extensions/backup-dropbox`（`dropbox.ts`/`provider.ts`/`manifest.ts`）：App Folder 访问范围与 PKCE + refresh token（`token_access_type=offline`）后台访问，不引入厂商 SDK；在应用根按 `AnynoteBackup/notebooks/<id>/devices/<slot>` 真实目录布局组织对象，locator 用大小写无关的 `path_lower` 身份并保留 rev。上传前在本地来源上按 Dropbox 分块算法（4MiB 块、块摘要拼接后再哈希）计算 content_hash，上传后与远端返回的 `content_hash` 比对（不等或大小不符即拒绝提交），对象据此达到 `provider-checksum` 等级，跨 Provider 清单仍保存应用 SHA-256；≤8MiB 单次上传、超过走 `upload_session/start|append_v2|finish`，偏移按实际发送量推进、会话中断时用同一份来源重建。`current.json` 首次用禁止覆盖语义（`strict_conflict`）创建、已有对象按刚读到的 rev 条件更新（`WriteMode.update`），rev 不符或并发创建即冲突并保留原 head、不生成 rename 副本；`conditionalHead` 显式记录为「未实测结论」而不是默认值，实测通过前仍按单写设备槽 + 发布前后检查。第二设备只读恢复按 Notebook 与设备槽路径直接定位，无需原机槽表；非幂等语义的复用会比对既有清单记录的远端 content_hash。`tests/cloud-dropbox.test.mjs` 覆盖 content_hash 分块、能力/权限声明、App Folder 身份标记校验、端到端上传/无变化跳过/增量只传新对象、upload session 与偏移拼接、rev 冲突与不生成副本、content_hash 不符拒绝、缺失元数据与幂等删除；`packages/backup-core/src/identity.ts` 与 README 同步移除 Dropbox 的 Beta 标记。真实账号端到端与最小权限实测仍见上方 P0/P1 条目。

- [x] **P1 — OneDrive Provider**：已按云盘备份设计 §12 新增 `extensions/backup-onedrive`（`graph.ts`/`provider.ts`/`manifest.ts`）：使用 `GET /me/drive/special/approot` 与 `Files.ReadWrite.AppFolder` 最小权限，按 `driveId`+`itemId`（不透明引用 `driveId::itemId`）定位对象，并在受管目录内按名称唯一发现/创建（多候选即停写）；小文件走内容上传、超过 4MiB 走 `createUploadSession` 并以 320KiB 对齐分片、以服务端确认偏移推进，会话失效（404/410）用同一来源重建；分片 PUT 用 `raw` 模式不附加 Bearer、`uploadUrl` 不写入长期清单；`current.json` 发布按 eTag（`If-Match`）与 `conflictBehavior=fail` 处理 409/412 冲突，`conditionalHead` 仍保持 `false` 待实测；第二设备只读恢复按 Notebook 目录名称定位远端槽。`tests/cloud-onedrive.test.mjs` 覆盖能力/权限声明、320KiB 分片对齐、端到端创建/分段上传/冲突拒绝/恢复读回与第二设备恢复；`packages/backup-core/src/identity.ts` 与 README 同步移除 OneDrive 的 Beta 标记。真实账号最小权限下的创建/列表/下载/分段上传/删除端到端验收仍待人工完成（见上方 P0/P1 条目）。

## 原 §11.1 远端备份、维护与统一任务（原 §3）

- [x] **P1 — Cloudflare 旧维护锁处置**：新增只读诊断 `/retention/diagnostics` 与受限释放 `/retention/legacy-lock/release`（显式确认 + 旧请求停止声明 + 精确 CAS + 审计），并提供 `pnpm run cloud:legacy-lock` 管理员工具；仅清除被确切观测的无主执行锁并保留 Notebook 锁，释放后在维护界面重试由协调器续跑；不按时间抢占。新协调器中断恢复回归保留。

- [x] **P1 — 持久化任务历史与中断恢复入口**：任务状态/错误/校验报告写入设备侧 `_local/task-history.json`（原子写、200 条上限、单条证据预算），任务创建与结束统一经 `track`/`settle` 记录，进程退出或重启时仍在进行中的任务标记 `interrupted`，`listTasks` 合并历史与当前会话任务；新增 `retryTask`（只重放记录了可复现入参的操作）与只读 `queryPendingGeneration`，任务中心提供重试与提交查询入口。

- [x] **P1 — 统一重试和暂停策略**：新增 `packages/backup/src/policy.ts` 统一引擎：错误分类（transient / throttled / auth / permanent / aborted）、指数退避（`base → 2^n`，上限截断）与 equal-jitter 抖动、按服务 `Retry-After`（秒或 HTTP 日期）优先延后；永久鉴权与协议错误写入粘性 `pausedReason`（`auth`/`permanent`）停止自动调度，重试次数用尽记 `exhausted`，仅在成功或用户改配置/重新启用时清除。失败计数、`nextAttemptAt` 与暂停原因随远端目标（`backup-targets.json`）及本地目标持久化，调度器据此门控自动触发；电池/计量网络/大任务暂停为设备级可选策略（`_local/backup-policy.json`），由桌面 `powerMonitor` 与渲染进程 Network Information API 上报，手动“立即备份”始终可执行。新增 `getBackupPolicy`/`setBackupPolicy`/`reportBackupEnvironment` 操作并在策略界面展示暂停原因；Cloudflare 采用设计建议的约 60 秒间隔作为默认值（仍为周期触发，非编辑停止空闲去抖）。`tests/backup-policy.test.mjs` 覆盖分类、退避/Retry-After、暂停与鉴权停止。

## 原 §11.2 编辑器、阅读器与知识组织（原 §4）

- [x] **P1 — 富文本稳定化与模式切换**：明确首发支持的 CommonMark/GFM/扩展语法边界，补齐嵌套列表、转义、脚注、引用链接、复杂表格等往返语料及局部回写；无法安全表示时保留原文并导向源码。验证切换选区/滚动锚点、撤销和 IME，不以任意 Markdown 完整往返作为已完成保证。已导出 `richSyntax` 语法边界与 `RichBlockReason` 降级原因，块内不可安全表示时保留原文并就地提示、导向源码；补齐嵌套列表/转义/脚注/引用式链接/对齐表格/代码元数据/混排图片的边界与局部回写语料；模式切换按相对比例恢复阅读位置，源码搜索替换、块内撤销/重做与组合输入保护沿用既有验收。

- [x] **P1 — PDF 阅读补齐**：实现可收起页缩略图、适应页/宽及从选区创建关联 Markdown 笔记，保存返回页码/批注位置的链接；现有分页、缩放、文字选择、搜索、高亮、密码和阅读位置已实现。已确认缩略图面板按需解码、适应宽度/页面按容器尺寸计算并在缩放窗口时重算；新增 `createPdfNote` 在同一事务内写入高亮批注与关联笔记，正文含引用片段与 `anynote://…/#pdf-page-N`（或 `#pdf-annotation-<id>`）返回链接，阅读器按锚点回到对应页；阅读位置与旧行为保持。真实输入法/触控与独立设备验收仍待人工完成。

- [x] **P1 — PDF 文本任务与边界提示**：将文本抽取/索引纳入可取消后台任务，明确前 500 页/正文预算导致的部分搜索状态；覆盖扫描件、复杂字体/向量、大量照片和加密 PDF，验证资源换绑后的批注旧哈希保护与重新锚定交互。已新增 `beginPdfIndex`（登记可取消、持久化的 `pdf-index` 任务，同一笔记复用进行中任务）并由 `indexPdf` 结算 `completed`/`failed`；抽取向任务中心上报进度并按状态中止丢弃部分结果，`pdfIndexCoverage` 区分完整/部分/扫描件（OCR 未启用）并在界面标注部分索引；`reanchorAnnotation` 仅在显式操作时把旧哈希批注迁移到当前版本，`addAnnotation`/`createPdfNote` 继续拒绝过期哈希，旧版本批注以“旧版本”标记保留。真实扫描件、复杂字体向量、加密 PDF 与资源换绑的真实交互验收仍待人工完成。

- [x] **P1 — 图片阅读能力**：补齐实际尺寸、旋转查看、EXIF、说明/批注及相应持久化与恢复；视图旋转不修改原 Asset，图像编辑必须创建新版本。已新增独立 `ImageReader`：百分比缩放、适应窗口、实际尺寸、顺时针 90° 视图旋转，以及 EXIF（JPEG APP1/PNG eXIf/WebP EXIF）与尺寸/类型/大小信息；说明写入笔记正文并进入历史，区域批注复用 `annotations` 表（`page=1` + 归一化矩形）支持删除与旧版本标记；缩放/适应/旋转按笔记持久化到本地并在重开时恢复。视图旋转只改预览，新增 `saveImageVersion` 把旋转编辑另存为新的不可变资源版本（拒绝过期哈希与未变化内容），旧批注自动标记为旧版本。真实输入法/触控与独立设备验收仍待人工完成。

- [x] **P1 — 图片安全与内存预算**：实现像素/解码预算、超大图缩略图与分辨率分级，以及 SVG 清洗/栅格预览路径；现有 PNG/JPEG/WebP 类型检查和整文件 base64 读取不等于这些能力已完成。已新增 `@anynote/protocol/image-safety`：从文件头解析像素尺寸（PNG/JPEG/WebP/SVG，不解码）、40MP/16384px 写入预算（`importFile` 与 `writeResource` 双入口拒绝）、按解码预算（24MP）与分辨率分级（640/1280/2560/4096）选择预览解码边，渲染层用带 resize 的 `createImageBitmap` 做有界解码/降采样；新增 `image/svg+xml` 导入与内联插入，SVG 预览先清洗（去脚本/事件处理器/外链/javascript:）再栅格化，原文件照常保存与下载。真实超大图/复杂 SVG 的设备级内存峰值验收仍待人工完成。

- [x] **P1 — 视频卡片补齐**：支持安全通用视频 URL 卡片、可获取的标题/缩略图本地缓存及 Notebook 级远程嵌入开关；验证播放视图导航、域名和权限。当前 YouTube 点击才播放已实现，不扩展为 YouTube 视频下载。已新增 `@anynote/protocol/video` 统一 URL 规范化：YouTube/Vimeo/Bilibili 严格 ID 校验与固定嵌入模板，其他无凭据 HTTPS 地址降级为通用链接卡片；嵌入地址始终由 provider+ID 重算、不保存任意 iframe，域名/ID 不符即不可嵌入。新增 `fetchVideoMeta` 经 SSRF 防护下载 provider 元信息（YouTube/Vimeo oEmbed、Bilibili API、通用页 OpenGraph），标题与缩略图（签名校验后）写入本地资源缓存并在卡片展示、离线可用。`getExtensionSettings`/`setExtensionSetting` 新增 `key` 支持 Notebook 级 `remoteEmbed` 开关，关闭后既不加载远程 iframe 也不获取元信息。真实平台元信息与嵌入导航、独立设备验收仍待人工完成。

## 原 §11.3 网页导入与开放导出（原 §5）

- [x] **P1 — 导入预览与来源信息**：新增 `previewImport` / `getImportPreview` / `commitImportPreview`：预览以可取消后台任务在独立 Worker 中转换，提交前展示转换正文（超长截断）、目标目录路径、媒体本地化/总数、已用与上限预算、正文模式与降级提示；确认时直接提交预览结果，不再二次抓取或转换，预览随提交消费并设 TTL/数量上限。导入报告补充来源 URL、最终 URL、获取时间与媒体体积；新增可选原始 HTML 保存（`keepOriginal`），作为资源写入并显式 pin 到修订闭包，报告内可下载。导入对话框改为「预览 → 确认」两步，任务中心标注预览任务；`tests/extensions.test.mjs` 覆盖预览只读、目标路径、确认提交、原始 HTML 资源固定与重复提交拒绝。真实站点与设备交互验收仍待人工完成。

- [x] **P1 — 失败媒体重试**：新增 `retryImportMedia` 操作与 `import-media-retry` 后台任务：读取持久化导入报告，按来源勾选失败媒体并选择重试，在有界预算内复用导入的 data:/相邻文件/受控下载规则重新获取；成功后在同一事务内绑定新资源、重写占位符引用并生成新笔记版本，报告保留原始失败原因（`originalError`）并记录重试次数/时间。提交时重读最新正文合并，用户期间的编辑被保留、无法定位的引用记为“引用已修改，未重写”而跳过；取消会结算已完成的部分结果为部分成功；同一笔记重复重试复用进行中任务，无剩余失败项时明确拒绝；失败占位符加入稳定标记 `anynote-media-*` 以精确重写，任务记录 `noteId` 并支持从任务中心重试。`tests/extensions.test.mjs` 覆盖成功重写引用、用户修改跳过与重复重试拒绝。真实站点网络重试、独立设备与交互验收仍待人工完成。

- [x] **P1 — 媒体发现补齐**：新增 `@anynote/importer/discovery` 媒体发现模块并在清洗前运行：`img` 按已知懒加载属性（`data-src`/`data-original`/`data-lazy-src` 等）与 `srcset` 尺寸描述符（`w`/`x`，超宽回退到最宽候选）选择来源，`picture/source` 折叠为选中的 `img`。受支持的视频提供方 `iframe`/`video` 经 `videoCard` 生成安全 `core.video` 块（嵌入地址由提供方与 ID 重算，不保存任意 iframe）；可直接下载的音视频（扩展名或 `type` 判定）在配额内下载为资源并以链接引用；PDF/附件默认保留外部链接，用户提供授权相邻文件时本地化为资源并重写链接。清洗前统一记录不可本地化媒体（`blob:`、DRM/需登录、未知提供方、缺少地址、`object`/`embed`），以标记占位符替换，避免被直接移除而无报告。导入报告媒体项新增 `kind` 与 `embedded`/`unsupported`/`linked` 状态，桌面导入报告展示未本地化媒体；`retryImportMedia` 按媒体 `kind` 校验 MIME 并选择引用形式（图片内嵌、音视频/附件链接）。`tests/extensions.test.mjs` 覆盖 srcset/picture/懒加载、提供方视频块、直接音视频、不可本地化记录与附件本地化。真实站点、独立设备与交互验收仍待人工完成。

## 原 §11.4 插件、SDK 与工程边界（原 §6）

- [x] **P1 — SDK 扩展点补齐**：按真实需求开放作用域 Notebook/Node、事件、任务、Secrets、importer/exporter、backup/search/AI Provider 注册及公共 UI 贡献；补齐分页、取消、错误码、版本契约和权限合约。当前有限 notes/search/assets/settings、命令及本地备份宿主适配器不等于完整 SDK 草案。已新增 `AnynoteAPI` 的 `notebooks`、`nodes`、`notes.history`、`secrets`、`events`、`tasks`、`ui`、`providers` 扩展点与 `contract()` 版本/能力契约；统一 `ExtensionError` 错误码、游标分页（`nodes.list`/`search.page` 返回 `{items,nextCursor}`）与 `CallOptions.signal` 取消。受信首方宿主新增 `notebooks:read`、`nodes:read|write`、`secrets:read|write`、`events:subscribe`、`tasks:register`、`ui:contribute`、`providers:register` 权限门面并绑定当前 Notebook；Secrets 按 Provider ID 存于 Notebook 命名空间，复用 `extensionSet/GetState` 并新增原子 `extensionDeleteState`；事件仅按命令/参数触发扩展自身的 `note.created`/`note.updated`/`node.moved`/`node.trashed` 变更；任务/UI/Provider 注册经宿主 `bindings` 提供、随会话停用由 disposer 回收，纯 Transport 客户端得到 `unsupported`。`extension-host` 进程宿主扩充权限与 API 分派；`tests/sdk-extension-points.test.mjs` 与 `tests/types/contracts.ts` 覆盖权限、作用域、分页、取消、错误码、事件与注册回收。第三方可安装扩展的通用 JS/React、Provider 执行及中央市场仍不在范围。

- [x] **P1 — 首方功能独立发布验证**：白板、视频、导入及备份适配器逐步经公开 SDK 接入并独立打包，在干净外部项目安装运行；当前同仓库内建能力和阅读模板进程宿主不能替代所有首方插件的外部消费验证。已新增 `@anynote/first-party-adapters`：白板（`get`/`save`）、视频（`insert`/`fetchMeta`）、导入（`start`/`preview`/`getPreview`/`commit`/`retryMedia`/`report`）三项适配器只依赖公开 SDK，备份适配器复用 SDK 的 `createLocalBackupAPI`，统一由 `createFirstPartyAdapters(transport)` 绑定一个已授权 transport，并暴露版本与能力契约（`firstPartyAdapterVersion`/`firstPartyAdapterContractVersion`/`firstPartyAdapterCapabilities`）；适配器把可移植 `noteId` 映射为宿主 `id`，预览与确认共用同一份已转换结果，且不授予扩展新权限。`pnpm run build:first-party` 独立打包到 `artifacts/first-party-adapters`（依赖 `@anynote/plugin-sdk`）；`pnpm run test:first-party:package` 在该 tarball 与 SDK tarball 上写入只有两个离线依赖的干净项目，用 `tsc` 编译并实际运行，校验方法映射、备份不接受调用方路径、产物不含 Node/存储/宿主/脚本执行器，报告写入 `test-results/first-party-package.json`；`tests/first-party-adapters.test.mjs` 与 `tests/types/first-party-adapters.ts` 覆盖映射、冻结、契约与类型边界。真实首方插件经外部 SDK 运行完整功能（而非适配器契约）仍待后续接入。详见 [首方功能适配器](../../packages/first-party-adapters/README.md)。

- [x] **P1 — 公共包发布矩阵**：定义 Desktop、Worker、SDK、开发工具、首方插件、格式/schema 的独立版本与兼容窗口；准备 ESM/类型 exports、许可证、变更日志、发布产物和旧消费者测试。已有 workspace 与离线 tarball 消费通过，npm 发布和完整矩阵尚未完成。已新增 `packages/protocol/src/release.ts` 作为发布矩阵单一来源（运行时中立、无外部依赖）：声明 `desktop`/`worker`/`sdk`/`devtools`/`first-party`/`format` 六个单元的独立版本、SDK（`apiContractVersion`）与首方适配器（`firstPartyAdapterContractVersion`）契约版本、九项格式版本（notebook schema v2、`anynote.notebook` v1、`anynote.logical` v1、`anynote.local-backup` v1、`anynote.cloud-backup-head` v1、`anynote.cloud-backup-manifest` v1、`anynote.extension`/`-directory`/`-settings` v1）与十二项兼容窗口，并提供 `checkReleaseCompatibility`/`assertReleaseCompatibility`/`satisfiesRange`/`satisfiesFormatRange`/`releaseVersion`；越界按设计 §19.2 明确拒绝。新增 `pnpm run build:release`：复用既有便携构建入口把三份 tarball 汇集到 `artifacts/release/<unit>`，校正 `version`/`license`/`engines`、补齐 `files` 白名单、复制根 LICENSE 与 CHANGELOG、校验 `"type": "module"` 与每个 ESM/类型入口文件真实存在，并计算内容聚合 SHA-256，输出 `artifacts/release/release-matrix.json`（`anynote.release-manifest.v1`）。新增 `pnpm run test:release:matrix`：在只含官方 tarball 的干净离线项目中编译并运行 `tests/fixtures/legacy-consumer/consumer.ts`，断言旧消费者向前兼容、发布清单与磁盘产物哈希一致、兼容窗口越界明确拒绝，报告写入 `test-results/release-matrix.json`。新增 `tests/release-matrix.test.mjs` 校验矩阵与真实代码一致（单元版本对齐 package.json、契约版本对齐导出常量、格式版本对齐 schema/迁移 SQL、兼容窗口内部自洽）。新增根 `LICENSE`（许可证待选定占位）、`CHANGELOG.md` 与 [发布矩阵](../../docs/RELEASE-MATRIX.md) 文档，并在 CI 构建发布产物。工作区检查与后端构建已纳入 `extensions/*`：三个官方云盘扩展以私有工作区包随应用构建，不进入公共发布矩阵（见 §5）。npm 发布、公共 registry 的许可证选择与旧/新桌面与 Worker、旧插件/新桌面等真机跨版本矩阵仍待完成。

## 原 §11.5 损坏处理、可观测性与发行打磨（原 §7）

- [x] **P0 — 损坏库恢复交互**：打开失败进入只读诊断/恢复向导，先保存原文件和日志，再提供快照、归档或远端恢复；缺失/损坏资源可定位并从备份修复。新增只读诊断（`diagnoseNotebook`）、证据保存（`preserveNotebookEvidence`）与桌面恢复向导；快照列取/恢复改为不依赖库打开，可对不可用库执行。真实整机/断电恢复仍见 §1/§2 独立验收项。

- [x] **P1 — 启动一致性巡检**：新增只读巡检 `inspectIntegrity`（后台可取消任务 `integrity-inspection`）与报告读取 `getIntegrityReport`：对遗留临时文件（`temp/`、`*.tmp`、`export-*.sqlite`、`assets/**/*.bin.tmp`、清理隔离区及无活动租约的任务暂存目录）、孤儿资源（磁盘上未入库对象、未被任何版本/批注/PDF 文本引用的 `assets` 记录）与缺失引用（被引用但文件缺失、路径无效或大小不符，覆盖历史与回收站版本）做预算受控扫描（扫描与发现条目上限、`truncated` 标记），每 500 条让出事件循环并响应取消；复用备份层的资源闭包定义，活动任务租约（`job-leases`）标记为受保护、暂存目录仅在无租约时记为遗留，Notebook pin 记录为 `pinned`；结果写入设备侧 `_local/integrity-reports.json`（原子写、按 Notebook 保留 50 份），报告仅作提示、不触发任何删除；桌面在启动后自动巡检当前 Notebook，并在本地整理面板与任务中心展示结果与发现项。`tests/integrity-inspection.test.mjs` 覆盖健康库、临时/孤儿/缺失、活动租约保护与取消。

- [x] **P1 — 可导出脱敏日志与指标**：统一记录 SQLite 提交、队列、吞吐、备份/恢复校验、插件启动/崩溃和模式转换；提供诊断导出、敏感 URL/正文/密钥过滤及最小化开关，不把验收脚本 JSON 当作应用日志系统。已新增设备侧 `_local/diagnostics.json`（原子写、事件 300 条与指标 200 项上限）作为应用日志系统：`Storage.tx` 记录提交耗时与回滚，`run`/`dispatch` 记录操作延迟、队列等待与资源读写吞吐，`settle` 记录任务结果及 `verificationReport`/`restoreResult` 校验；导出为 `anynote.diagnostics` v1（平台信息、聚合指标与脱敏事件）。新增 `reportDiagnostic`/`getDiagnostics`/`getDiagnosticsSettings`/`setDiagnosticsSettings`/`clearDiagnostics`：默认最小化仅记录耗时、大小与错误码，`full` 才记录经脱敏的自由文本，`off` 完全关闭；脱敏强制剔除 URL 凭据/查询/片段、密钥与长随机串并替换家目录。扩展宿主在启动/就绪/崩溃/停止时经 `onEvent` 上报插件事件，编辑器模式切换在渲染进程测量耗时后上报；设置页提供级别切换、指标/事件查看与 JSON 导出。`tests/diagnostics.test.mjs` 覆盖指标聚合、最小化/完整/关闭、脱敏、重启持久化与备份校验事件。真实设备长时负载验收仍待人工完成。

## 拆分前背景（原文存档）

本节只保留当时的依据与整理过程。例如早期的 Linux 环境、Beta Provider、旧编辑模式、许可证待选等表述可能与后续实现不一致，应以当前源码和专项记录核对。

### 前言

更新：2026-10-09。依据 [产品与技术设计](../../docs/Anynote-Design.md)、[本地磁盘备份设计](../../docs/Anynote-Local-Disk-Backup-Design.md)、[云盘备份设计](../../docs/Anynote-Cloud-Drive-Backup-Design.md)，结合当前源码、实施记录与验收报告整理。本文是全项目剩余工作入口；只列未完成事项，已完成项集中在文末「§11 已完成」。

优先级：**P0** 为发布前可靠性/数据保护门槛，**P1** 为 v1 能力补齐与发行，**P2** 为性能和工程完善，**P3** 为设计明确的后续能力或可选优化。优先级是本清单的建议排期，不直接等同于设计文档的实施阶段。

代码完成、自动化通过和真实平台/设备验收分别判断。Linux 同机不同目录、SIGKILL、模拟 I/O 错误、合成 PDF、派发组合事件均不能代替独立设备、断电、复杂文件或真实输入法验收。图索引存在旧路径及未跟踪的新源码，相关结论已回到当前文件和最新专项记录核对；旧 README/实施记录中的历史描述不作为功能缺失的唯一依据。

本次重排：原「聚焦清单：不涉及跨平台/跨设备/真实环境验收的 P0/P1」已全部实现并移入 §11；剩余条目均需真实环境或跨平台验证，或属后续完善，其中需要 Windows/macOS 真机的条目集中在 §2，其余章节按优先级重排（跨平台适配代码前置为 P1）。

2026-10-09：新增 §5 云盘备份，原 §5–§10 顺延为 §6–§11。云盘备份的核心框架（Provider 注册、备份中心、账号与 PKCE 授权、一致性捕获、不可变提交与条件发布、受管 GC、恢复落地）与 Google Drive 端到端闭环已实现，Dropbox/OneDrive 为 Beta 占位扩展，因此相关条目全部集中在 §5，其中真实 OAuth 授权与厂商实测为 P0。

2026-10-08：开发环境切换到 macOS 后，补齐了备份层的 macOS 卷适配（`diskutil`/`df`/`mount` 解析、稳定 `VolumeUUID`、挂载状态、网络挂载与 FAT32 限制识别，含解析 fixture 与降级测试），并完成 §2.3 的 macOS/APFS 实盘验收；同时修复了 macOS 符号链接前缀（`/var`、`/tmp` → `/private/*`）导致 `safePath` 与 `assertLocalPath` 拒绝合法临时目录、进而使全部 macOS 用例与验收无法运行的阻塞问题。§3 的卷适配条目因此只剩 Windows 部分。

### 1. 真实环境与可靠性验收

依据：设计 §20–22；[P0 备份可靠性](../../docs/P0-BACKUP-READINESS.md)、[故障恢复演练](../../docs/RECOVERY-DRILLS.md)、[全新设备恢复](../../docs/CLOUD-RECOVERY.md)。以下条目不依赖特定操作系统，但需独立设备、断电或真实远端服务。

### 2. 跨平台验证（Windows / macOS）

依据：设计 §20–22；[P0 备份可靠性](../../docs/P0-BACKUP-READINESS.md)、[全新设备恢复](../../docs/CLOUD-RECOVERY.md)。以下条目必须在对应平台真机或真实系统中验证，当前 Linux 开发环境无法完成。需同时覆盖两个平台的条目列于 §2.1，仅在单一平台验证的条目分别列于 §2.2、§2.3。

### 3. 本地磁盘备份

依据：原专项 TODO（`packages/backup-local/TODO.md`，当前文件不存在；拆分后的任务见 [总入口](../../TODO.md)）、[基准结果](../../packages/backup-local/BENCHMARK.md)。以下覆盖专项清单全部未勾选项；主要备份、增量、提交协调、清理、完整校验、恢复、公开类型及 Linux/ext4 验收已实现。

### 4. 远端备份、维护与统一任务

依据：设计 §11–14；[远端维护](../../docs/REMOTE-MAINTENANCE.md)、[P0 备份可靠性](../../docs/P0-BACKUP-READINESS.md)、[大文件云备份](../../docs/STREAMING-CLOUD-BACKUP.md)。

### 5. 云盘备份（Google Drive / Dropbox / OneDrive）

依据：[云盘备份设计](../../docs/Anynote-Cloud-Drive-Backup-Design.md)、[本地磁盘备份设计](../../docs/Anynote-Local-Disk-Backup-Design.md)。核心框架（`packages/backup-core`、`cloud-backup-common`、`oauth-broker`、`plugin-sdk` 契约）、桌面备份中心与 Google Drive 备份→恢复闭环已实现，`tests/cloud-backup.test.mjs` 覆盖 PKCE/state 校验、single-flight 刷新、无变化跳过、空间不足拒提交、清单完整性（含路径逃逸）、发布冲突与响应丢失确认、受管 GC 与占位 Provider 拒绝。以下为未完成事项；Dropbox 与 OneDrive 均已接入真实厂商 API（Dropbox 见下方条目；OneDrive 应用目录最小权限、`driveId`+`itemId` 定位、`createUploadSession` 320KiB 对齐、`uploadUrl` 凭据保护与 eTag 冲突处理），真实账号端到端与最小权限实测仍见下方 P0/P1 条目。

### 6. 编辑器、阅读器与知识组织

依据：设计 §3、§7–8、§10、§18；[编辑器与扩展记录](../../docs/EDITOR-ECOSYSTEM.md)。

### 7. 网页导入与开放导出

依据：设计 §9、§15；当前 `packages/importer/src/html.ts`、`packages/storage-sqlite/src/open-export.ts` 及 [流式归档](../../docs/STREAMING-ARCHIVE.md)。

### 8. 插件、SDK 与工程边界

依据：设计 §16、§19；[SDK](../../packages/plugin-sdk/README.md)、[首方宿主](../../docs/EXTENSION-HOST.md)、[开发工作流](../../docs/DEVELOPMENT-WORKFLOW.md)。受限 QuickJS、签名、HTTPS 分发、目录浏览、自动检查更新、状态/设置迁移及清理均已实现。

### 9. 性能与体验打磨

依据：[性能与界面验收](../../docs/PERFORMANCE-UI-ACCEPTANCE.md)、[开发工作流](../../docs/DEVELOPMENT-WORKFLOW.md)。

### 10. 后续范围与需明确的产品决策

以下来自设计明确的 P5/后续或可选范围，保留在完整待办中，**不作为当前 v1 本地/备份闭环的默认阻塞项**。

### 11. 已完成

以下为原「聚焦清单：不涉及跨平台/跨设备/真实环境验收的 P0/P1」及各自章节中已实现的条目，按原章节归并保留实现说明备查。代码完成与自动化通过不等于真实平台/设备验收（见 §1、§2）。
