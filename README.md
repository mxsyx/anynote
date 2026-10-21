# Anynote

本地优先的个人知识库，基于 [产品设计文档](./docs/Anynote-Design.md)。当前为可运行的桌面预览版，已包含文档扩展、网页导入、PDF 批注和远端备份闭环；完整 v1 发布门槛仍有未完成项，见 [实施记录](./docs/IMPLEMENTATION.md)。

## 运行

需要 Node.js 24+ 和 pnpm 12.14.0（以根 `package.json` 的 `engines` / `packageManager` 为准）。

```sh
pnpm install
pnpm run desktop
```

生产构建和启动：

```sh
pnpm run build
pnpm start
```

界面采用书籍与笔记本设计，保留书脊、页边线、书签、统一的圆角与柔和阴影，支持窄屏布局。外观仅提供亮、暗两种模式：亮模式采用 `#FAFAF8` 编辑器背景、`#F4F4F2` 侧栏、`#242424` 主文字、`#737373` 次级文字、`#E8E8E5` 分隔线与 `#638675` 柔和绿强调色；暗模式采用 [VS Code Dark Modern](https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_modern.json)。通过顶部栏或原生菜单切换明暗模式，重启后恢复。纸张使用当前模式的底色。共享控件使用 [shadcn/ui](https://ui.shadcn.com/docs/installation/vite) 的源码组件方式，位于 `apps/desktop/src/components/ui/`；`components.json` 配置生成路径，Tailwind v4 通过 Vite 编译。按钮、文本输入、多行输入和原生选择框在渲染器中统一复用；新建/重命名及搜索弹窗使用 Radix Dialog 管理焦点和键盘关闭。复选框、文件选择器与第三方编辑器保留原生交互。

主题变量与装订材质样式位于 `apps/desktop/src/styles.css`，不依赖外部字体或图片。已有布局类通过 Button 的 `layout` 尺寸保留工具栏和树行的几何尺寸；新增独立按钮可直接使用标准 variant/size。Tailwind 仅加载 theme/utilities，避免全局 preflight 重置富文本、PDF 和白板内容。

使用临时数据启动浏览器预览后，可运行 `node scripts/book-ui-smoke.mjs` 验证创建、编辑持久化、搜索、弹窗焦点、主题与响应式布局；`ANYNOTE_BROWSER` 可指定 Chrome 路径，截图默认写入 `/tmp/anynote-book-ui-screenshots`。

界面图标使用 shadcn/ui 配套的 [Lucide](https://lucide.dev/)，统一从 `apps/desktop/src/icons.tsx` 引入。该入口集中维护线条粗细、颜色继承和无障碍默认属性；图标随应用打包，离线可用。

核心源码已使用 TypeScript，运行前编译到 `.build/`；开发和测试命令会自动编译。可运行 `pnpm run typecheck` 检查前后端及类型合约，编译规则和类型边界见 [TypeScript 迁移](./docs/TYPESCRIPT-MIGRATION.md)。

SQLite 与附件读写在独立 Electron Utility Process 中执行；渲染器使用校验后的 IPC 门面。白板字体、PDF worker 和静态资源随应用打包，本地编辑无需联网。

浏览器开发预览：

```sh
pnpm run dev
```

打开 <http://127.0.0.1:5173>。开发 API 仅监听本机并校验 Host/Origin，不适合部署至公网。可用 `ANYNOTE_DATA_DIR` 指定独立开发数据目录。

## 功能

- 桌面系统目录选择器打开外部 Notebook，在原目录编辑；工作区登记、独占写锁、移出工作区保留原文件。
- 书橱首页陈列所有 Notebook，以高低错落的烫金书脊和连续木质搁板呈现，点击书脊进入左侧章节目录与右侧笔记的阅读空间；支持返回书橱、新建、导入及不可用笔记本恢复。目录位于正文左侧，使用独立书页面板并与正文留出间距，采用层级编号与点线排版，支持整体收起、章节折叠、键盘导航和拖拽排序；紧凑的笔记本切换位于目录上方。顶部栏使用纯图标提供返回书橱、搜索、最近打开、收藏和明暗主题切换，不显示面包屑；设置、插件、备份与回收站由桌面原生菜单访问。
- 多个独立 Notebook、目录树、重命名、移动、拖拽移动与同级排序、收藏、标签、最近打开、回收站及批次恢复。
- 跨 Notebook 复制/移动：笔记与目录子树、历史、附件和批注保留，内部链接重写，幂等重试；移动后源条目可从回收站恢复。
- 跨 Notebook 全局搜索：类型、目录子树、标签、更新时间筛选，显示库名、路径和命中上下文；支持取消与部分结果提示。
- Tiptap 连续 Markdown 文档编辑，阅读与编辑合一；防抖保存、中文输入法保护、草稿保留和版本冲突校验。复杂语法及未知块保留原文，详见 [编辑器边界](./docs/EDITOR-ECOSYSTEM.md)。
- 内联本地图片、稳定内部链接、跨 Notebook 反向链接、未知扩展只读降级与原文保留。
- 正文纸张限制最大宽度并居中，两侧露出桌面背景；纸张随外层阅读区域整体滚动，不显示笔记类型标记。输入 `/` 可插入标题（一级至六级）、正文、列表、任务、引用、代码、表格、分割线、换行、链接、图片、白板和视频，也可应用加粗、斜体、删除线与行内代码；桌面原生「编辑 → 插入内容」共用同一套命令。收藏笔记位于顶部「更多操作」中。
- Excalidraw 白板：保存场景、图片和静态预览；历史版本冻结资源引用，恢复后继续编辑可保留原资源版本。
- 视频链接卡片：YouTube/Vimeo/Bilibili 严格域名与 ID 校验、其他 HTTPS 地址降级为通用链接卡片；点击嵌入播放后才加载外部播放器，Notebook 可关闭远程嵌入，标题与缩略图经受控下载缓存到本地、离线可见。
- 网页链接、HTML 文件或粘贴内容导入：正文提取/页面模式、编码识别、内容清洗、图片本地化、失败报告与可取消后台任务。HTML 文件只读取用户选择的相邻图片；网络下载拒绝私网、回环和保留地址并验证重定向。
- PDF.js 阅读：分页、缩放、文字选择、密码输入、文内搜索、高亮与批注、阅读位置；提取文本及批注加入本地全文搜索。扫描 PDF 未提供 OCR。
- 图片阅读：缩放/适应窗口/实际尺寸、顺时针 90° 视图旋转、EXIF 与尺寸信息、说明（写入正文与历史）与区域批注；缩放/适应/旋转按笔记恢复。视图旋转只改预览，旋转编辑经 `saveImageVersion` 另存为新的不可变资源版本。
- 图片原件（PNG/JPEG/WebP/SVG）、SHA-256 内容寻址、不可变正文及标题/标签/收藏历史、本地一致性快照；写入时校验像素/边长预算，大图按分辨率分级有界解码，SVG 预览先清洗再栅格化，原文件照常保存。
- 快照保留数量/天数与本地孤立资源清理：先预览、再确认，保护历史及回收站引用，执行前复查候选文件。
- 桌面完整 `.anynote` 流式 ZIP/ZIP64 导入/导出，支持磁盘预算、后台进度和取消；包含历史、回收站、批注、资源和扩展状态；新增仅当前内容归档（只裁剪导出快照）；桌面开放 Markdown 目录/ZIP 流式导出可取消，包含白板原场景、可携带图片的 Excalidraw 场景、批注 sidecar、路径映射和能力损失报告。
- Cloudflare Worker + D1 + R2 自托管分块备份：SQLite 块去重、staging/committed、分支 CAS、幂等提交与完整快照清单，恢复后创建新 Notebook。
- 云盘备份（官方扩展）：Google Drive、Dropbox 与 OneDrive 均已完成备份与恢复闭环（Dropbox 使用 App Folder、分块 `content_hash`、`upload session` 与 rev 冲突处理；OneDrive 使用应用目录 `Files.ReadWrite.AppFolder`、`driveId`+`itemId` 定位与 `createUploadSession` 分片上传）。核心提供备份中心、账号授权、任务调度、一致性捕获、凭据保护与恢复验证；厂商 API 适配下沉到独立官方扩展。连接账号使用系统浏览器 Authorization Code + PKCE，凭据经系统安全存储保存；每设备独立备份槽，只保留当前完整副本。
- Cloudflare 远端维护：按版本数及 UTC 日/周/月采样预览并确认清理，保护全部分支、上传中版本与恢复 pin；设备接管撤销旧 epoch，支持恢复副本接续远端分支。详见 [远端维护](./docs/REMOTE-MAINTENANCE.md)。
- 统一任务中心，备份目标独立游标，失败重试与提交响应丢失后的游标确认；用户可为每个目标启用约每分钟检查变更的自动备份。
- 首方扩展可按 Notebook 停用，停用保留内容；[SDK 0.1](./packages/plugin-sdk/README.md) 提供权限范围、命令生命周期、独立状态和版本条件幂等写入。
- [扩展开发工具](./docs/EXTENSION-DEVELOPMENT.md) 提供四种 TypeScript 工程模板、清单诊断及隔离示例试运行，支持独立本地工具包安装。
- 扩展支持 [显式状态/设置迁移与恢复](./docs/EXTENSION-DATA-MIGRATIONS.md)：预览字段变化，确认时原子保存原值副本，恢复后可再次迁移。
- AI 提案、显式应用及版本条件撤销工具接口；没有配置或调用模型 Provider。
- 浅色/深色主题、大纲/历史面板、专注模式与键盘快捷键。

设置中的「从云端恢复」支持全新设备只提供云连接信息，分页查找并恢复备份，无需原 Notebook 或目标配置。使用步骤见 [全新设备恢复](./docs/CLOUD-RECOVERY.md)。

## 备份配置

通过桌面原生菜单进入备份页面，添加 Cloudflare 目标：填写部署好的 Worker URL 与应用 Token。先测试连接，再立即备份；任务中心展示结果，历史版本可恢复为新的 Notebook。

同一页面还可添加云盘目标：选择 Google Drive、Dropbox 或 OneDrive 并在系统浏览器完成授权，返回应用确认账号、设备标签与要备份的 Notebook；数据库按 1MiB 分块增量上传，未变化块会被复用，恢复默认创建新 Notebook。断开连接只清除本机凭据，不删除远端副本；「删除云端备份」是独立确认操作。设计说明见 [云盘备份设计](./docs/Anynote-Cloud-Drive-Backup-Design.md)。官方版本预置 OAuth 应用身份；自编译版本可通过 `ANYNOTE_OAUTH_APPS`（按 `ANYNOTE_OAUTH_STAGE` 区分开发/生产）或 `ANYNOTE_GOOGLE_CLIENT_ID`、`ANYNOTE_DROPBOX_APP_KEY`、`ANYNOTE_ONEDRIVE_CLIENT_ID` 提供自己的 Client ID。注册、注入与授权验收见 [官方 OAuth 应用注册](./docs/OAUTH-REGISTRATION.md)。

Cloudflare 服务源码和部署步骤见 [apps/cloudflare-backup/README.md](./apps/cloudflare-backup/README.md)。Cloudflare 可直接运行 `pnpm run cloud:deploy`，通过现有 Wrangler 登录创建、迁移、部署并自动验收，无需手填 Endpoint/Token。真实云验收工具、环境变量和部署命令见 [真实云备份验收](./docs/CLOUD-ACCEPTANCE.md)。工具使用独立测试 Notebook，验证上传、恢复、去重、失败重试及并发提交并输出逐步报告。历史 Wrangler 部署及真实 Cloudflare 报告使用当时格式；当前 schema v4/独立附件协议需重新验收，状态见 [G07](docs/todo/07-cloudflare-acceptance.md)。

历史 Cloudflare 生产页面及 Linux 打包应用记录了 9 项真实桌面检查，涵盖系统加密、应用重启、正式自动备份、云端恢复和游标持久化：[验收说明](./docs/DESKTOP-CLOUD-ACCEPTANCE.md)。该历史 Linux 测试使用隔离的真实 GNOME Keyring，未覆盖系统重启、其他平台或当前格式的重新验收。

桌面凭据通过 Electron safeStorage 与系统密钥服务加密保存在设备目录；Linux keyring 不可用时拒绝持久化。浏览器开发预览仅在 API 进程内存保留凭据。凭据与目标游标不进入 Notebook 导出。自动备份只在应用运行且用户已启用该目标时执行；远端备份独立于本地保存，不提供双向同步。

## 数据与边界

桌面数据位于 Electron `userData/notebooks/<UUID>/`，Linux 通常为 `~/.config/anynote/notebooks/`；开发默认使用 `.anynote-dev/`。

桌面设置页的「打开 Notebook 目录」可打开含 `notebook.sqlite` 的现有目录，保留 UUID 并在原处读写。目录登记只保存在本机；同一 UUID 不允许对应多个目录，需要副本时使用归档导入。目录内符号链接及不兼容数据库会被拒绝；「移出工作区」释放连接和写锁，保留原文件。可写连接被 LRU 回收时释放写锁，之后的写入会重新获取锁。浏览器预览不提供系统目录访问。

每库使用 `notebook.sqlite` 保存正文、历史和元数据（schema v4），附件保存为 `assets/sha256/<前两位>/<SHA256>.bin` 不可变文件。数据库按 1MiB 分块增量备份，附件按文件哈希增量备份，统一清单提交与恢复。迁移 Notebook 需携带整个目录；设备快照与凭据留在 `_local/`。不兼容旧 BLOB schema 与旧备份格式；详细契约见 [存储与备份设计](./docs/SQLITE-STORAGE.md)。

单文件导入上限 50 MiB；桌面完整归档采用流式 ZIP/ZIP64，解压总量预算 20GiB，包含清单、数据库和全部引用附件；桌面开放 Markdown 导出的转换后总量同样限制 20 GiB；浏览器/base64 归档 API、本地快照与浏览器 Markdown 导出仍为 100 MiB；跨库转移为 10000 条目、记录和附件各 100 MiB；正式云备份恢复采用 1MiB 数据库分块与附件整文件增量、20GiB 总量预算，详见 [大文件云备份](./docs/STREAMING-CLOUD-BACKUP.md)；HTML 与媒体预算可在导入时配置，具体以导入预览为准。Cloudflare 单次缓冲上传上限 20MiB，大附件使用 multipart 传输，仍保存为完整文件。桌面归档细节和测试见 [流式归档](./docs/STREAMING-ARCHIVE.md)。第三方已支持声明式贡献、QuickJS/WASM 受限脚本、签名包与审核更新；通用第三方 Node/React 宿主、任意 Markdown 无损往返、桌面应用签名更新及跨平台发行验收仍未完成。连续编辑器保留未修改块原文，修改块会规范化；复杂语法与未知扩展显示为保留块，不提供源码模式切换。新历史可恢复正文、资源和标题/标签/收藏；旧历史缺少元数据时保留当前值，目录位置不回滚。本地清理不删除仍登记在数据库中的资源。

## 验证与打包

```sh
pnpm test
pnpm run build
pnpm run test:desktop
pnpm run test:archive
pnpm run test:performance
```

回归测试使用 Vitest。`pnpm test tests/asset-range.test.mjs` 可运行单个文件，`pnpm run test:watch` 可监听测试变更；配置和后端重编译说明见 [开发工作流](./docs/DEVELOPMENT-WORKFLOW.md)。

浏览器验证需要先在独立 `ANYNOTE_DATA_DIR` 启动 `pnpm run dev`：

```sh
pnpm run test:ui
pnpm run test:features
pnpm run test:organization
pnpm run test:search
```

默认 Chrome 路径为 `/usr/bin/google-chrome`，可用 `ANYNOTE_BROWSER` 指定。测试会创建笔记、快照及恢复副本，请使用测试数据目录。

```sh
pnpm run package
```

按当前宿主平台生成 `release/` 下的应用目录；Linux 为 `release/linux-unpacked/`，可启动 `release/linux-unpacked/anynote`。其他平台产物见 [发行任务](docs/todo/05-desktop-distribution.md)；未签名构建不代表正式发行验收。

性能与界面验收覆盖万篇笔记、千层目录、100MiB PDF、备份期间界面响应，以及三档视口、浅深主题、键盘和自动无障碍检查；步骤、机器、报告和人工验收边界见 [性能与界面验收](./docs/PERFORMANCE-UI-ACCEPTANCE.md)。脚本使用临时数据和本地 Cloudflare Worker 适配器，不读取云凭据。

后端搜索基准可运行 `pnpm run benchmark:search`，在临时目录创建 10,000 篇合成笔记并输出基准报告；不覆盖完整桌面性能验收。

客户端 SIGKILL、提交结果确认、恢复中断重试和源 Notebook 目录不可用后的真实云演练见 [故障恢复演练](./docs/RECOVERY-DRILLS.md)，可运行 `pnpm run test:cloud:recovery` 重跑。

编辑器功能、声明式扩展安装与独立 SDK 构建见 [编辑器与扩展生态](./docs/EDITOR-ECOSYSTEM.md)。使用 `pnpm run test:editor` 验收桌面流程，`pnpm run test:sdk:package` 验证离线 SDK tarball。

第三方扩展另支持隔离的当前笔记正文转换脚本，安装、撤销、预算与宿主边界见 [受限脚本运行](./docs/SCRIPT-RUNTIME.md)。

扩展签名包与发布者信任的制作、安装和撤销流程见 [扩展签名文档](docs/EXTENSION-SIGNING.md)。

签名扩展还可通过公开 HTTPS 地址 [下载审核和手动更新](docs/EXTENSION-DISTRIBUTION.md)。

也可添加 [HTTPS 扩展目录](docs/EXTENSION-DIRECTORY.md)，搜索扩展并进入签名审核；本地工具支持从签名包生成目录清单。

扩展页还支持默认关闭的 [自动检查更新](docs/EXTENSION-UPDATE-CHECKS.md)，发现新版后提示人工审核安装。

受限脚本可通过 [有状态命令](docs/SCRIPT-STATE.md) 在明确授权后保存当前 Notebook 的扩展状态，正文与状态原子提交；SDK 包提供阅读整理计数示例。

扩展可声明 [Notebook 设置表单](docs/EXTENSION-SETTINGS.md)，支持文本、数字与开关；SDK 包提供可配置阅读摘要示例。

开发检查、提交钩子和 GitHub CI/CD 见 [开发工作流](./docs/DEVELOPMENT-WORKFLOW.md)。

各发布单元（Desktop、Worker、SDK、开发工具、首方插件、格式/schema）的独立版本、兼容窗口与发布产物见 [公共包发布矩阵](./docs/RELEASE-MATRIX.md)。`pnpm run build:release` 汇集可发布产物并写出发布清单，`pnpm run test:release:matrix` 用于在干净离线项目中校验声明的契约窗口。SDK tarball 云盘模块闭包已由 G17 修复，独立消费证据见 [G17 交接](docs/todo/17-module-boundaries.md)；最终发行矩阵仍待验收。

仓库包含多个 pnpm workspace（`apps/*`、`extensions/*`、`packages/*`），使用 isolated 且关闭依赖提升；包边界、无循环检查与筛选构建说明见 [开发工作流](./docs/DEVELOPMENT-WORKFLOW.md)。云盘官方扩展位于 `extensions/backup-google-drive`、`backup-dropbox`、`backup-onedrive`，与核心同进程注册；`googleapis` 懒加载，Dropbox/OneDrive 直连厂商 HTTP 端点、不引入厂商 SDK。

首方扩展的独立进程运行、Notebook 会话授权、命令惰性激活与故障回收见 [扩展宿主](./docs/EXTENSION-HOST.md)。使用 `pnpm run test:extension-host` 验证宿主及真实桌面流程。

本地磁盘备份的实现、平台边界和剩余待办见 [本地备份说明](packages/backup-local/README.md)。运行 `pnpm run test:desktop:local-backup` 验证生产 Electron 中的目录授权、范围配置、校验、取消与恢复导航；报告保存在 `artifacts/local-backup-acceptance.json`。

架构实际选择见 [ADR-001–010](docs/adr/README.md)，任务状态与证据维护规则见 [文档维护](docs/DOCUMENTATION.md)。
