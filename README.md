# Anynote

本地优先的个人知识库，基于 [产品设计文档](./Anynote-Design.md)。当前为可运行的桌面预览版，已包含文档扩展、网页导入、PDF 批注和远端备份闭环；完整 v1 发布门槛仍有未完成项，见 [实施记录](./docs/IMPLEMENTATION.md)。

## 运行

需要 Node.js 24+ 和 pnpm 11.20.0。

```sh
pnpm install
pnpm run desktop
```

生产构建和启动：

```sh
pnpm run build
pnpm start
```

核心源码已使用 TypeScript，运行前编译到 `.build/`；开发和测试命令会自动编译。可运行 `pnpm run typecheck` 检查前后端及类型合约，编译规则和类型边界见 [TypeScript 迁移](./docs/TYPESCRIPT-MIGRATION.md)。

SQLite 与附件读写在独立 Electron Utility Process 中执行；渲染器使用校验后的 IPC 门面。白板字体、PDF worker 和静态资源随应用打包，本地编辑无需联网。

浏览器开发预览：

```sh
pnpm run dev
```

打开 <http://127.0.0.1:5173>。开发 API 仅监听本机并校验 Host/Origin，不适合部署至公网。可用 `ANYNOTE_DATA_DIR` 指定独立开发数据目录。

## 功能

- 桌面系统目录选择器打开外部 Notebook，在原目录编辑；工作区登记、独占写锁、移出工作区保留原文件。
- 多个独立 Notebook、目录树、重命名、移动、拖拽移动与同级排序、收藏、标签、最近打开、回收站及批次恢复。
- 跨 Notebook 复制/移动：笔记与目录子树、历史、附件和批注保留，内部链接重写，幂等重试；移动后源条目可从回收站恢复。
- 跨 Notebook 全局搜索：类型、目录子树、标签、更新时间筛选，显示库名、路径和命中上下文；支持取消与部分结果提示。
- CodeMirror Markdown 源码编辑、GFM 阅读与块级富文本 Beta；防抖保存、中文输入法保护、草稿保留和版本冲突校验。
- 内联本地图片、稳定内部链接、跨 Notebook 反向链接、未知扩展只读降级与原文保留。
- Excalidraw 白板：保存场景、图片和静态预览；历史版本冻结资源引用，恢复后继续编辑可保留原资源版本。
- 视频链接卡片：YouTube/Vimeo/Bilibili 严格域名与 ID 校验、其他 HTTPS 地址降级为通用链接卡片；点击嵌入播放后才加载外部播放器，Notebook 可关闭远程嵌入，标题与缩略图经受控下载缓存到本地、离线可见。
- 网页链接、HTML 文件或粘贴内容导入：正文提取/页面模式、编码识别、内容清洗、图片本地化、失败报告与可取消后台任务。HTML 文件只读取用户选择的相邻图片；网络下载拒绝私网、回环和保留地址并验证重定向。
- PDF.js 阅读：分页、缩放、文字选择、密码输入、文内搜索、高亮与批注、阅读位置；提取文本及批注加入本地全文搜索。扫描 PDF 未提供 OCR。
- 图片阅读：缩放/适应窗口/实际尺寸、顺时针 90° 视图旋转、EXIF 与尺寸信息、说明（写入正文与历史）与区域批注；缩放/适应/旋转按笔记恢复。视图旋转只改预览，旋转编辑经 `saveImageVersion` 另存为新的不可变资源版本。
- 图片原件（PNG/JPEG/WebP/SVG）、SHA-256 内容寻址、不可变正文及标题/标签/收藏历史、本地一致性快照；写入时校验像素/边长预算，大图按分辨率分级有界解码，SVG 预览先清洗再栅格化，原文件照常保存。
- 快照保留数量/天数与本地孤立资源清理：先预览、再确认，保护历史及回收站引用，执行前复查候选文件。
- 桌面完整 `.anynote` 流式 ZIP/ZIP64 导入/导出，支持磁盘预算、后台进度和取消；包含历史、回收站、批注、资源和扩展状态；开放 Markdown 文件夹 ZIP 导出，白板导出可携带图片的 Excalidraw 场景，批注为 JSON sidecar。
- S3 兼容备份：一致性 SQLite 快照、未变附件去重、上传后哈希验证、已提交版本列表和恢复副本。
- Cloudflare Worker + D1 + R2 自托管逻辑备份：实体对象去重、staging/committed、分支 CAS、幂等提交、完整 checkpoint 与实体 delta，恢复后创建新 Notebook。
- Cloudflare 远端维护：按版本数及 UTC 日/周/月采样预览并确认清理，保护全部分支、上传中版本与恢复 pin；设备接管撤销旧 epoch，支持恢复副本接续远端分支。详见 [远端维护](./docs/REMOTE-MAINTENANCE.md)。
- 统一任务中心，备份目标独立游标，失败重试与提交响应丢失后的游标确认；用户可为每个目标启用每 10 分钟检查变更的自动备份。
- 首方扩展可按 Notebook 停用，停用保留内容；[SDK 0.1](./packages/plugin-sdk/README.md) 提供权限范围、命令生命周期、独立状态和版本条件幂等写入。
- [扩展开发工具](./docs/EXTENSION-DEVELOPMENT.md) 提供四种 TypeScript 工程模板、清单诊断及隔离示例试运行，支持独立本地工具包安装。
- 扩展支持 [显式状态/设置迁移与恢复](./docs/EXTENSION-DATA-MIGRATIONS.md)：预览字段变化，确认时原子保存原值副本，恢复后可再次迁移。
- AI 提案、显式应用及版本条件撤销工具接口；没有配置或调用模型 Provider。
- 浅色/深色主题、大纲/历史面板、专注模式与键盘快捷键。

设置页「从云端恢复」支持全新设备只提供云连接信息，分页查找并恢复备份，无需原 Notebook 或目标配置。使用步骤见 [全新设备恢复](./docs/CLOUD-RECOVERY.md)。

## 备份配置

侧栏「本地优先，安心记录」进入备份页面，添加 S3 或 Cloudflare 目标。S3 填写 Endpoint、Bucket、Region、Prefix 和访问凭据，可选择寻址方式并填写临时 Session Token；OSS 必选虚拟主机寻址；Cloudflare 填写部署好的 Worker URL 与应用 Token。先测试连接，再立即备份；任务中心展示结果，历史版本可恢复为新的 Notebook。

Cloudflare 服务源码和部署步骤见 [apps/cloudflare-backup/README.md](./apps/cloudflare-backup/README.md)。Cloudflare 可直接运行 `pnpm run cloud:deploy`，通过现有 Wrangler 登录创建、迁移、部署并自动验收，无需手填 Endpoint/Token。真实云验收工具、环境变量和部署命令见 [真实云备份验收](./docs/CLOUD-ACCEPTANCE.md)。工具使用独立测试前缀/Notebook，验证上传、恢复、去重、失败重试及并发提交并输出逐步报告。Wrangler 自动部署及真实 Cloudflare 验收已通过，结果见 [云验收报告](./docs/cloudflare-acceptance.json)；阿里云 OSS 的 S3 兼容 API 也已通过 7 项真实云检查，见 [OSS 验收报告](./docs/oss-acceptance.json)。

Cloudflare 生产页面及 Linux 打包应用均通过 9 项真实桌面检查，涵盖系统加密、应用重启、正式自动备份、云端恢复和游标持久化：[验收说明](./docs/DESKTOP-CLOUD-ACCEPTANCE.md)。OSS 生产页面和 Linux 打包应用也通过 9 项真实桌面检查：[生产页面报告](./docs/desktop-oss-acceptance.json)、[打包应用报告](./docs/desktop-oss-packaged-acceptance.json)。Linux 测试使用隔离的真实 GNOME Keyring，未覆盖系统重启和其他平台。

桌面凭据通过 Electron safeStorage 与系统密钥服务加密保存在设备目录；Linux keyring 不可用时拒绝持久化。浏览器开发预览仅在 API 进程内存保留凭据。凭据与目标游标不进入 Notebook 导出。自动备份只在应用运行且用户已启用该目标时执行；远端备份独立于本地保存，不提供双向同步。

## 数据与边界

桌面数据位于 Electron `userData/notebooks/<UUID>/`，Linux 通常为 `~/.config/anynote/notebooks/`；开发默认使用 `.anynote-dev/`。

桌面设置页的「打开 Notebook 目录」可打开含 `notebook.sqlite` 的现有目录，保留 UUID 并在原处读写。目录登记只保存在本机；同一 UUID 不允许对应多个目录，需要副本时使用归档导入。目录内符号链接及不兼容数据库会被拒绝；「移出工作区」释放连接和写锁，保留原文件。可写连接被 LRU 回收时释放写锁，之后的写入会重新获取锁。浏览器预览不提供系统目录访问。

每库包含 `notebook.json`、`notebook.sqlite`、`assets/sha256/`、`snapshots/`。SQLite 使用 WAL、外键和 FULL 同步，知识修改串行事务提交。数据库连接采用 LRU 回收，默认最多 8 个可写连接、4 个只读连接；快照期间固定连接，可暂时超出可写缓存上限，完成后回收。schema v1 自动迁移到 v2 前保存独立 SQLite 快照。

单文件导入上限 50MB；桌面完整归档采用流式 ZIP/ZIP64，解压总量预算 20GiB、最多 100000 条目；浏览器/旧归档 API和本地快照仍为 100MB；正式云备份恢复采用 16MiB 分块、20GiB 总量预算，详见 [大文件云备份](./docs/STREAMING-CLOUD-BACKUP.md)；HTML 上限 10MB、最多 200 张图片。Cloudflare 单对象上限 20MB。桌面归档细节和测试见 [流式归档](./docs/STREAMING-ARCHIVE.md)。尚未实现 S3 远端保留/GC、第三方插件沙箱、任意 Markdown 的完整富文本往返、签名更新及跨平台发行验证。富文本仅规范化用户编辑的块，普通表格与任务项支持富文本编辑，独立本地图片支持尺寸编辑，复杂表格、HTML、混排/远程图片和未知扩展使用源码编辑。新历史可恢复正文、资源和标题/标签/收藏；旧历史缺少元数据时保留当前值，目录位置不回滚。本地清理不删除仍登记在数据库中的资源。

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

输出 Linux 应用目录 `release/linux-unpacked/`。可直接启动 `release/linux-unpacked/anynote`。目前没有经过签名的生产安装包。

性能与界面验收覆盖万篇笔记、千层目录、100MiB PDF、备份期间界面响应，以及三档视口、浅深主题、键盘和自动无障碍检查；步骤、机器、报告和人工验收边界见 [性能与界面验收](./docs/PERFORMANCE-UI-ACCEPTANCE.md)。脚本使用临时数据和本地 S3 服务，不读取云凭据。

后端搜索基准可运行 `pnpm run benchmark:search`，在临时目录创建 10,000 篇合成笔记并输出 [基准报告](./docs/search-benchmark.json)；不覆盖完整桌面性能验收。

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

各发布单元（Desktop、Worker、SDK、开发工具、首方插件、格式/schema）的独立版本、兼容窗口与发布产物见 [公共包发布矩阵](./docs/RELEASE-MATRIX.md)。`pnpm run build:release` 汇集可发布产物并写出发布清单，`pnpm run test:release:matrix` 在干净离线项目中校验兼容窗口与旧消费者。

仓库包含 10 个 pnpm workspace，使用 isolated 且关闭依赖提升；包边界、筛选构建及现有循环依赖说明见 [开发工作流](./docs/DEVELOPMENT-WORKFLOW.md)。

首方扩展的独立进程运行、Notebook 会话授权、命令惰性激活与故障回收见 [扩展宿主](./docs/EXTENSION-HOST.md)。使用 `pnpm run test:extension-host` 验证宿主及真实桌面流程。

本地磁盘备份的实现、平台边界和剩余待办见 [本地备份说明](packages/backup-local/README.md)。运行 `pnpm run test:desktop:local-backup` 验证生产 Electron 中的目录授权、范围配置、校验、取消与恢复导航；报告保存在 `artifacts/local-backup-acceptance.json`。
