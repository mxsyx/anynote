# Rust 迁移基线与语料使用

本文件规定 RM01 冻结材料的用途和复现方式；实施状态只见 [TODO RM01](TODO.md#rm01)，本次运行结论见[实施记录](IMPLEMENTATION.md#rm01)。这些材料是旧客户端的比较基线，不表示任何 Rust 功能已经实现。

## 固定版本与证据层次

- 旧提交：`60a8c4b614b8831d2a16366a79d595942e7b87a1`，初始工作树无改动。产品源码、依赖锁和现有 smoke 保持原样。
- [baseline.json](../../tests/fixtures/rust-migration/inventory/baseline.json) 保存源码文件和 lockfile 的 SHA-256；[operations.json](../../tests/fixtures/rust-migration/inventory/operations.json) 覆盖 146 个 renderer 白名单操作，每个操作有唯一主责组、保留/退役处置、源码契约及已有测试引用。其中 111 个迁移，35 个运行入口退役，业务及持久数据仍按相应组保留。
- [contract-fragments.json](../../tests/fixtures/rust-migration/inventory/contract-fragments.json) 固定操作分支内的校验、返回及错误代码；间接 helper 以固定提交中的源码为准。没有类型化 output schema 的服务不能仅凭当前 TypeScript 类型推断其完整结果。片段和测试引用是静态证据，不是对 146 个操作逐一运行后的成功记录。
- [internal-operations.json](../../tests/fixtures/rust-migration/inventory/internal-operations.json) 分配 20 个内部/漏接线入口，包括归档发布、捕获、导入提交、backup cursor/revision 及退役插件内部状态操作；它们不是新的 renderer API。生成器检查 storage/backup 的 `op ===` 分支没有未分配的名字。
- [coverage.json](../../tests/fixtures/rust-migration/inventory/coverage.json) 保存 INV-01–24 的旧入口、预期行为、RM 归属及现有测试入口；[observations.json](../../tests/fixtures/rust-migration/corpus/observations.json) 才是本次合成库生成过程的实际输入/结果/错误。测试构造失败和产品基线失败分开记录。

图核对使用 Anynote、Tier 2、generation `2026-11-08T08:55:45Z`，检查了引用文件覆盖。`archive-stream.ts:397`、`first-party-adapters/src/index.ts:31`、`plugin-sdk/src/index.ts:343`、`types/src/index.ts:247–250`、CSS 指令及故意损坏的 plist 缺口已直接读取。操作清单另经 TypeScript AST 扫描和旧源码逐项引用核对；无记录的图缺口不等于完整证明。

## 功能到语料和执行组

下表的操作序列供后续差分验收使用。未在本次运行的交互仍是比较用例，不写成通过。详细旧错误分支见冻结契约，格式拒绝样本见 `corpus/invalid/`。

| INV | 旧操作/结果与失败边界                                         | 语料或现有复现入口                                               | 后续归属      |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- |
| 01  | 建库、打开/重命名/移出外部库；离线保留登记，移出不删原件      | 合成库；`organization`/`workspace` 测试                          | RM05/28       |
| 02  | 创建目录、排序/拖动、跨库复制/移动；循环和失效操作拒绝        | 合成父子目录；`organization`/`transfer`                          | RM05/06/28    |
| 03  | 编辑→防抖保存→切换；过期 revision 拒绝且保留草稿              | `observations.json` 保存冲突；document smoke                     | RM16/19/28    |
| 04  | 连续编辑、表格/列表/任务/格式/源码；未知块保留                | `markdown.json`、边界生成配方；document smoke                    | RM15–19       |
| 05  | 阅读、内部链接、历史与恢复；历史内容不被新版本覆盖            | `expected.json`、完整归档；`recovery`                            | RM04/05/19/28 |
| 06  | 关键词/短中文/跨库过滤、取消、定位；过期结果不覆盖            | 10,000 笔记 benchmark；`search`                                  | RM04/28       |
| 07  | 图片缩放/旋转、批注、另存版本；原图不变、危险 SVG 拒绝        | `media/pixel.png`；`image-reader`/`image-safety`                 | RM21          |
| 08  | PDF Range、页码、选区/批注、索引/关联笔记；hash 失配拒绝      | 三页 PDF、合成批注；performance UI 的 100MiB PDF                 | RM25/26       |
| 09  | scene→保存→再次编辑→打开旧版本；旧嵌图按历史映射读取          | `scene-*`、归档、历史闭包；performance UI                        | RM22/23/24    |
| 10  | 插入视频卡片→启用远端嵌入→播放；协议和 CSP 限制               | `video`；known-gap renderer 探针                                 | RM20/27       |
| 11  | HTML/文件预览→确认→媒体重试；拒绝路径/私网，保留后续正文      | `web-import`；采集图片夹具                                       | RM07          |
| 12  | 完整/当前/ZIP64 导入导出；错误版本/hash/路径拒绝              | `full.anynote`、`current.anynote`、`zip64.anynote`、异常包       | RM07/08       |
| 13  | 备份、pending 查询、writer、retention 预览/提交；过期计划拒绝 | `cloud-snapshot.json`；`retention-policy`/`maintenance-recovery` | RM10/11/29    |
| 14  | 本地备份→校验→独立目录恢复；目标替换/损坏拒绝                 | `local-backup/`；真实旧引擎本机读回                              | RM09/29       |
| 15  | 诊断、证据保全、恢复、清理；不覆盖损坏原件                    | `recovery-diagnosis`、`integrity-inspection`；异常包             | RM08/10/29    |
| 16  | 任务进度/取消/重试/重启历史，诊断查询/清空                    | `task-history`/`diagnostics`；不声称本次 GUI 全测                | RM03/29       |
| 17  | `.anyclip` 导入/重复提交、配对撤销、同切面浏览与 ack          | 带图 capture、云浏览对象、ack；`cloud-capture`                   | RM07/12/30    |
| 18  | propose→apply→undo；过期/幂等/授权错误                        | `extensions.test.mjs` 的提案业务断言；不是 AI 服务               | RM05          |
| 19  | 原生菜单→当前焦点命令、快捷键                                 | document smoke；`application-menu`                               | RM02/18/28    |
| 20  | 单实例、激活/退出、文件选择、DPI/辅助技术                     | Electron 启动实测；其余平台/物理交互未测                         | RM02/13/32    |
| 21  | 凭据 set/get、超时/退出；拒绝 basic_text                      | `main.cts`/`storage.ts`、`task-history`；三平台旧密文未采集      | RM03/13/14    |
| 22  | 主题/导航/阅读位置、焦点/加载/错误状态                        | appearance/navigation 源码；performance UI 部分导航              | RM02/13/28/29 |
| 23  | 已知阅读工具与声明块内置；未知 JSON 保留且不执行              | `known-plugins.json`、阅读块/未知状态；真实用户插件未盘点        | RM20/37       |
| 24  | 桌面替换，TS Worker/浏览器保留；最终产物无旧运行时            | 冻结 lock、包和 CI；本次只构建旧客户端                           | RM30/36/37/38 |

### 已实现、未接线与远期分别处理

当前存储、文档、媒体、导入、备份等已有实现以冻结入口为准，不能因本次未运行其全部场景就标为不存在。AST 未找到直接 renderer 字面量引用的 7 个操作为 `startImport`、`proposePatch`、`applyProposal`、`undoProposal`、`reportDiagnostic`、`archiveExportBudget`、`listExtensionUpdateSources`；这仅说明没有直接字面量引用，可能由 SDK/动态调用使用。

已实际复现的差异：

- `saveRemoteRetention`：UI 调用存在，backup service 分支存在，白名单缺失；真实 renderer 请求返回 `未授权请求`。RM11 提供正确的命令接线，RM29 接 UI。
- 视频：当前 Electron CSP 允许 YouTube frame，Vimeo/Bilibili 触发 `frame-src` violation。探针拦截网络并返回本地 HTML，只证明 CSP 行为；三家真实服务播放、媒体会话退出仍未测，交 RM27/32/35。
- `editor-ecosystem-smoke.mjs` 在 `富文本 Beta` 选择器超时；`desktop-smoke.mjs` 仍引用旧入口，本次未单独运行。当前交互基线使用 `document-editor-smoke.mjs`，旧测试失配不等于连续编辑器失败。

远期的崩溃草稿日志、AI Provider/流式交互、OCR/语义搜索、带批注 PDF 导出、动态登录网页、E2EE、多端同步/协作仍按 F012–F024 对应任务处理；不计入已实现基线，也不因冻结语料而关闭这些任务。F020 插件生态已取消，不恢复宿主。

## 语料格式与边界

[corpus/manifest.json](../../tests/fixtures/rust-migration/corpus/manifest.json) 枚举每个文件的大小和 SHA-256。全部由合成内容及旧 API 生成，无真实用户库、账号、token、密文或插件包。`example.invalid` 只作来源标记，不发起请求。

- `schema.sql` 和 `backup-revision.sql` 分别固定 schema v5 与可选 tracker。旧校验器分别验证无 tracker/有 tracker 的 SQL，并拒绝新增未知列。
- `markdown.json` 保存 CRLF、中文/emoji/组合字符、格式、列表/表格、代码围栏内 directive、已知阅读块、未知字段、坏 JSON/未闭合块和 opaque HTML 的旧 parser 输出。`markdown-boundaries.json` 是 10,240、102,400、500,000、500,001 UTF-16 code units 的可重建配方和字节 hash；UTF-16 长度不冒充 UTF-8 字节数。此配方是数据边界，不是这些大小的输入延迟实测。
- `notebook/`、三类 `.anynote`、`expected.json` 保留正文/回收站、内部链接、修订 metadata、未知 `extension_data`、批注及 `revision_resources`。自校验按旧实现导入到新库，核对重映射后的链接和全量历史/资源。
- 白板合成场景含 rectangle/diamond/ellipse/text/line/arrow/freedraw/image/frame/iframe/embeddable 11 种 type 及未知字段；旧 storage 保存/历史读回验证字段和嵌图闭包。它不做 Excalidraw 几何合法性判断，也不证明全部工具能创建这些合成元素。
- `.anyclip` 由旧流式 writer 产生，含 PNG、表格和来源；导入校验正文资源重映射、图片 hash、重复提交同 note ID。导入会按旧实现补资源名称等正文表示，预期使用冻结的实际结果，而非假设导入前后 Markdown 完全相同。
- `local-backup/` 保留 v3 manifest、DB chunks、CAS 附件和 file token；测试把副本放到新合成 target 并仅替换 targetId，再经旧引擎 full verify/restore，逐字节核对 DB/附件。文件 token 不作为跨机器免校验凭证。
- `cloud-snapshot.json`/`cloud-objects/` 来自旧 snapshot/browse 实现，包含同数据库切面的目录、正文、资源及 capture ack。检查描述、大小、hash 和错误 chunk；没有真实 Cloudflare 请求、发布或恢复证据。
- `invalid/` 固定未知 schema、DB hash 不符、路径穿越、采集正文 hash 不符/未知版本、本地清单缺失文件和云 chunk 大小错误。拒绝后不得发布新库/提交笔记。大型压缩炸弹、重复 ZIP entry、实际磁盘故障继续使用现有专项测试和后续组，不把小语料覆盖夸大为完整故障验收。

### 白板动作比较表

| 范围                                                        | 当前基线证据                                       | 迁移比较动作                                                     |
| ----------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| 打开、绘制、PNG 预览、保存                                  | performance UI 的离线首用绘制/保存已运行           | 首次打开→绘制→保存→重新打开（RM23/24）                           |
| 场景类型与图片历史                                          | 11 种合成 type 经过 storage 保存/旧修订读回        | 逐字段保留及历史嵌图不漂移（RM22/24）                            |
| 选择/多选、拖动、缩放/旋转、分组/层级、复制/粘贴、撤销/重做 | Excalidraw 容器存在；本次未逐动作交互验证          | 对同一旧版场景逐动作记录前后，RM23 对照；不能以 storage 测试替代 |
| 文本容器绑定、箭头绑定/elbow/fixed segments、crop/pressure  | 格式要求已在编辑设计列明；本次场景没有穷举字段组合 | RM22/23 在冻结旧版补充具体案例后比较                             |
| iframe/embeddable/远端内容                                  | 仅存储类型保留，不声称已创建或加载                 | 区分存量格式、当前可创建动作及需网络的能力（RM23/27）            |

这份表固定已测与未测边界，后续不得将 `scene-input.json` 当成白板完整交互验收。

## 平台、安装路径与用户插件盘点

冻结来源为 `apps/desktop/package.json` 与 `.github/workflows/release.yml`：Linux AppImage（ubuntu-24.04）、macOS DMG（macos-14）、Windows NSIS（windows-2025）。配置没有显式锁定 CPU 架构或最低 OS，不能从 CI runner 推导最终支持承诺。本次只观测 Linux x64 开发构建，正式平台/架构门槛由 RM02/32/36/38 落实。

| 位置       | 本次盘点结果及边界                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装程序   | AppImage 是用户选择路径，DMG/NSIS 安装路径没有项目自定义约定；本次没有签名安装包路径实测                                                                                                 |
| 应用资料根 | 源码使用 Electron `app.getPath("userData")`；`ANYNOTE_USER_DATA_DIR` 可覆盖。所有本次 GUI 运行使用独立临时资料根，不打开当前用户 profile                                                 |
| 业务数据   | `userData/notebooks/<UUID>/notebook.sqlite` 及 `assets/sha256/...`；外部库按 `_local/notebook-directories.json` 保留原路径                                                               |
| 配置/任务  | `notebooks/_local/` 目标、策略、恢复连接、任务、诊断；详见[兼容方案](../design/RUST-DATA-COMPATIBILITY.md#51-配置分类)的配置清单                                                         |
| 偏好       | Chromium origin Local Storage；旧 key 及新点分层键映射见[兼容方案](../design/RUST-DATA-COMPATIBILITY.md#52-local-storage-偏好)。三平台实际 LevelDB 与 OS 密钥样本未采集，RM13/14/32 验证 |
| 凭据       | `userData/secrets/<UUID>.bin` 旧密文只保全；本语料不包含凭据，不用假密文声称兼容                                                                                                         |
| 插件       | 仓库已知 13 个来源文件及 checksum 已冻结；实际用户 registry、自写/修改脚本、未知工作流未访问。RM14/37 在用户数据副本接管前清点，不能据此宣布用户功能等价                                 |

已知业务：whiteboard/video/html-import 的核心操作分别归 RM22–24/RM20+27/RM07，local-backup 包装归 RM09；reading-template、reading-callout、reading-transform（UTF-16 长度）、related/async-related、preferences/v2、session/v2、network 示例归 RM20。`known-plugins.json` 的样例不表示默认安装，checksum 不匹配的用户修改版仍按未知记录保全。

未实测还包括 macOS/Windows、低配/冷 OS cache、真实 IME/读屏/DPI、完整白板动作、复杂真实 PDF/照片、1k/100k 规模分层、20GiB 流式边界、物理盘/独立设备/断电、长期内存和真实云/公网。分别仍由 RM22–26/31–35/38 及对应 V/A/F 验收，不是 RM01 的通过声明。

## 复现与后续使用

常规校验读取已提交的黄金文件，不重新生成 expected：

```sh
pnpm run build:backend
pnpm exec vitest run tests/rust-migration.test.mjs
```

重建仅在固定提交的独立 checkout 中进行：把本次两个生成器复制到旧 checkout 的 `scripts/`，使用固定 lock 安装依赖并 `pnpm run build:backend`，然后指定**不存在的新目录**。生成器拒绝其他 HEAD 和产品源码/lock 改动；不允许覆盖已冻结目录。

```sh
node scripts/rust-migration-fixtures.mjs tmp/rm01-rebuilt-corpus
node scripts/rust-migration-inventory.mjs tmp/rm01-rebuilt-inventory
```

生成包含随机 UUID、时间戳、SQLite 物理页与文件 token；重建是同语义/同操作序列，不承诺跨 OS/SQLite 版本得到相同二进制。已提交语料的 hash 才是字节比较基准。两个生成器/测试是迁移工具，不进入最终桌面包；待 RM37 退役旧运行时后可在保留的隔离基线 checkout 运行旧 reader。

复现本次交互与性能（需要可用显示会话，均使用脚本创建的隔离资料）：

```sh
pnpm run build
node scripts/document-editor-smoke.mjs
node scripts/benchmark-search.mjs
node scripts/performance-ui-acceptance.mjs
node scripts/rust-migration-baseline.mjs
node scripts/editor-ecosystem-smoke.mjs
```

最后一个命令在冻结旧版预期出现选择器超时；known-gap 脚本成功表示复现了已知拒绝，**不是修复通过**。性能比较应串行、使用相同机器与构建/缓存条件；本次数据为开发环境采样，不是独占机器的性能认证。原始日志/JSON/截图写 `tmp/reports/`、`tmp/screenshots/`，可删除；长期结论保存在实施记录。
