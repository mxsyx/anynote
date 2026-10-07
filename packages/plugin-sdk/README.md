# Plugin SDK 0.1

公开 SDK 没有 Node、Electron、数据库或 UI 框架依赖。宿主提供 Transport，并将实例绑定到已经授权的 Notebook；插件不能通过公开 API 指定其他 Notebook、SQL、磁盘路径或 actor。笔记修改带版本条件和幂等 operationId；settings 位于独立命名空间并纳入归档。

## 扩展点与调用合约

`AnynoteAPI` 覆盖设计 §16.4 的扩展点：`notebooks`、`nodes`、`notes`、`search`、`assets`、`settings`、`secrets`、`events`、`tasks`、`ui`、`providers`，命令仍通过 `context.registerCommand` 注册（不重复暴露 `api.commands`）。注册类扩展点返回 `Disposable`，停用/卸载时随宿主统一回收。

- `api.contract()` 返回 `{ sdk, api, capabilities }`：`sdk` 是 SDK 版本，`api` 是调用面合约版本，`capabilities` 列出当前调用面方法，插件可据此判断可用能力。
- 分页：`nodes.list`、`search.page` 接受 `{ cursor, limit }`，返回 `{ items, nextCursor }`；`limit` 由宿主钳制，未知游标返回 `invalid`。
- 取消：所有方法接受可选 `CallOptions.signal`，取消后在调用前后抛出 `aborted`。
- 错误码：宿主按 `denied` / `invalid` / `not_found` / `conflict` / `busy` / `aborted` / `unsupported` / `internal` 抛出 `ExtensionError`，插件无需解析文案即可分支。
- 权限合约：受信首方宿主新增 `notebooks:read`、`nodes:read`、`nodes:write`、`secrets:read`、`secrets:write`、`events:subscribe`、`tasks:register`、`ui:contribute`、`providers:register`；每个调用与注册都在权限门面内校验并绑定当前 Notebook。

`events`、`tasks`、`ui`、`providers` 是宿主推送/注册能力，无法由请求/响应 Transport 承载：`createAPI(transport, bindings)` 需宿主提供 `bindings`。仅使用 Transport 的客户端调用这些方法会得到 `unsupported`。`providers.register` 只登记 `search/backup/ai/importer/exporter` 描述符，具体提供方执行仍由宿主实现；`secrets` 按 Provider ID 作用域存放，当前落在 Notebook 命名空间，设备级密钥库为后续范围。

```ts
import { createAPI } from "@anynote/plugin-sdk";
const api = createAPI(transportFromTrustedHost);
const { items, nextCursor } = await api.nodes.list({ limit: 50 });
await api.secrets.set({ provider: "anynote.demo", key: "token" }, token);
```

## 独立开发与打包

```sh
pnpm run build:sdk
pnpm --dir artifacts/plugin-sdk pack --pack-destination ..
```

生成的 SDK 包只包含 公开 API、声明式扩展和本地备份契约模块及其 `.d.ts`，没有应用内部 imports。可以在干净项目中安装 `artifacts/anynote-plugin-sdk-0.1.0.tgz`。此命令仅构建本地产物，不发布 npm。

```ts
import { createAPI, type DeclarativeManifest } from "@anynote/plugin-sdk";
const api = createAPI(transportFromTrustedHost);
await api.notes.get(noteId);
```

`src/host.ts` 是应用内部的受信首方宿主，不包含在公开 tarball。受信工厂可以获得 Node 本身的高权限，能力门面不能限制工厂直接调用 Node。停用撤销能力、注销命令与 disposer；旧上下文不能追加注册，旧 disposer 不会删除重新激活后的注册。

## 可安装的声明式扩展

桌面扩展页支持本地 JSON 安装与贡献定义审阅，示例为 [reading-callout.json](./src/examples/reading-callout.json)。运行方式必须是 `declarative`，引擎要求固定为 `^0.1.0`。支持：

- `commands`：向当前 Markdown 追加模板，或插入已声明节点。
- `editorNodes`：callout/折叠视图、文本字段与默认值，由核心渲染和编辑。
- `notes:write`：命令写入权限，必须在每个 Notebook 明确授权。

扩展及其贡献 ID 使用自有命名空间；禁止首方 ID、脚本入口、未知字段、网络/文件/凭据权限。字段和值以文本显示；不加载 JavaScript，不执行任意 HTML 或 React。每个 JSON 最大 128KiB，最多安装 64 个扩展、30 个命令及 20 个节点；每节点最多十个文本字段。

安装保存规范化贡献的 SHA-256，授权绑定该校验值；更新清除已有授权，要求重新审阅。校验值用于检测变化，不是签名认证。全局停用与 Notebook 覆盖停止功能；卸载保留正文、资源、版本和命名空间状态。未安装、未授权、停用或数据版本不支持的节点显示原始块，支持下载。

扩展定义和授权是设备状态，不随 Notebook 归档/云恢复自动安装。扩展块与 `extension_data` 是知识数据，随完整归档保留。恢复的 Notebook 必须重新安装定义并授权，之后才能执行命令。

## 可安装的正文转换脚本

本地安装另支持 `quickjs-transform`，示例为 [reading-transform.json](./src/examples/reading-transform.json)。脚本扩展声明 `notes:read` 和 `notes:write`，贡献 `transformMarkdown` 命令，其 `script` 是接收当前笔记 `{id,title,body,revision}` 并同步返回正文字符串的函数表达式。`editorNodes` 必须为空。脚本不接收 `ExtensionContext`，不能调用公共 API 或指定其他笔记/Notebook。

源码仅在独立 QuickJS/WASM guest 中执行，不在宿主 Node/React 上求值。仅通过声明的 JSON 能力桥接请求搜索或固定 HTTPS 资料；没有模块加载器、文件、直接网络、DOM 和定时器。每次新建 Worker/context，设置 guest 堆 64MiB、栈 256KiB、执行中断 250ms、总耗时 2 秒、源码 64KiB 和正文 2,000,000 字符预算；同一进程最多两次并发。V8 与 WASM 内存独立，预算不是整个进程 RSS 上限。

提交前重新校验启用、授权、清单和笔记版本，正文与幂等回执同一事务写入。更新、停用、撤销授权、卸载或关闭服务会取消在途脚本。已有扩展块必须按原文及数量保留，不能删除未知数据。公开包导出 `ScriptManifest`、`ScriptCommand`、`MarkdownTransformInput` 类型，公开 SDK 包不包含执行器或 QuickJS 依赖；独立开发工具包复用受限执行器。

第三方可安装扩展仍不开放通用 JS/React 模块、任意 NodeView、原生模块、动态 URL 网络访问、Provider 执行及中央插件市场；`providers.register` 仅在受信首方宿主登记描述符。设备侧可选择开启自动检查更新，安装仍需人工审核。

签名包可使用项目的 `pnpm run extension:package ...` 制作和验证，公开类型为 `SignedExtensionPackage`、`ExtensionSource`。签名验证、发布者信任与 Notebook 授权由桌面后端独立检查；信任发布者不会自动授予笔记权限。协议与制作流程见项目 `docs/EXTENSION-SIGNING.md`。独立 SDK 包只包含可移植类型，不包含私钥或 Node 签名实现。

桌面已安装扩展的 `InstalledExtension.downloadURL` 是可选的设备更新来源。公开 HTTPS 签名包支持用户触发的下载审核与手动更新，具体流程见项目 `docs/EXTENSION-DISTRIBUTION.md`。更新来源不会进入 QuickJS 笔记快照，也不赋予脚本网络能力。

公开目录类型为 `ExtensionDirectory`、`ExtensionDirectoryEntry`、`SavedExtensionDirectory`。项目的 `extension:package directory` 从实际签名包生成目录清单，桌面支持 HTTPS 目录配置、搜索和下载审核，见 `docs/EXTENSION-DIRECTORY.md`。目录声明不会自动建立发布者信任或 Notebook 授权。

## 有状态的受限命令

示例 [reading-session.json](./src/examples/reading-session.json) 使用 `transformMarkdownWithState`，额外声明并获得 `settings:read`、`settings:write` 权限。输入含当前 Notebook 中本扩展的 `state`，同步返回 `{body,state}`；首次状态为 `{}`。普通转换命令仍只接收笔记，不接收状态。

状态为普通 JSON 对象，最多 64KiB、16 层、4096 个值，不含函数、访问器、符号、undefined、非有限数字或循环。宿主检查笔记与状态两个版本，在同一事务提交正文、状态及幂等回执；并发冲突、失败或撤销不写入结果。状态位于 Notebook 的 `extension_data`，随归档保留，停用或卸载不删除。未知状态 schema 被拒绝，不自动迁移。

公开类型为 `ScriptStateValue`、`ScriptState`、`StatefulMarkdownTransformInput`、`StatefulMarkdownTransformResult`。详见项目 `docs/SCRIPT-STATE.md`。这不是通用宿主 API，也不赋予网络或文件能力。

## 声明式设置表单

示例 [reading-preferences.json](./src/examples/reading-preferences.json) 在 `contributes.settings` 声明版本 1 的文本、数字、布尔字段，额外申请 `settings:read` 与 `settings:write`。用户授权当前 Notebook 后编辑并保存，命令输入的 `note.settings` 只包含本扩展声明的字段；没有表单的命令不接收设置。

公开类型为 `ExtensionSettingField`、`ExtensionSettingsContribution`、`ExtensionSettingsValues`、`ExtensionSettingsSnapshot`。表单由核心 UI 渲染，不接收 React/HTML/脚本渲染器。最多 12 个字段，每字段必须声明同类型默认值；后端检查文本长度、数字范围、整数约束、完整字段和设置 revision。

设置与脚本状态分开保存在 Notebook，随归档保留。保存取消旧设置下的在途命令；改变表单定义或未知 schema 会拒绝写入并保留数据，不隐式迁移。详见项目 `docs/EXTENSION-SETTINGS.md`。

## 声明式数据迁移

`contributes.dataMigrations` 提供顶层 `rename`、缺失值 `defaults` 和显式 `remove`，不执行迁移代码。状态命令可用 `contributes.stateVersion` 声明当前版本（默认 1），状态迁移必须升级至该版本；设置迁移绑定规范化旧表单的 SHA-256。两种迁移均需要状态读写权限，用户先预览再确认，核心同事务保存原始数据备份并应用修改。

[reading-session-v2.json](./src/examples/reading-session-v2.json) 将 v1 的 `runs` 迁移为 `visits`；[reading-preferences-v2.json](./src/examples/reading-preferences-v2.json) 将 `target` 迁移为 `goal`。先使用 v1 示例产生数据，再安装 v2 并重新授权。恢复操作也先预览并备份当前数据；恢复旧数据后可再次迁移。每个扩展最多 8 条迁移和 32 份 Notebook 内数据副本，不隐式覆盖未知数据。核心扩展页提供[显式数据清理](../../docs/EXTENSION-CLEANUP.md)：选择删除迁移副本，或卸载后清理全部留存数据；第三方脚本无此管理能力。

公开类型为 `ExtensionDataMigration`、`ExtensionDataOverview`、`ExtensionDataReview`、`ExtensionDataApplyResult`。副本随 Notebook 归档保留，不自动授予新 Notebook 权限。详见项目 `docs/EXTENSION-DATA-MIGRATIONS.md`；原生执行器和数据库操作不包含在 SDK tarball 中。

## 扩展开发工具

独立的 `@anynote/extension-tools` 提供 `anynote-extension init / validate / run`，支持声明式、普通转换、持久化状态及设置四种 TypeScript 模板。工程用本 SDK 的 `InstallableManifest` 检查类型，再生成桌面可安装 JSON。清单诊断与桌面共用校验器；命令试运行使用同一 QuickJS Worker 和正文保护规则，输入只来自 JSON 示例。

在仓库运行 `pnpm run build:extension-tools` 生成本地工具包，`pnpm run extension:dev --help` 查看用法。SDK 与工具包均可通过本地 tarball 安装，尚未发布到 npm。工具不包含 SQLite/Storage/设备权限服务，试运行不会修改 Notebook 或 fixture。详见项目 `docs/EXTENSION-DEVELOPMENT.md`。

## 受限搜索上下文

正文转换命令可声明 `action.searchContext: {query, limit}` 并申请 `search:read`，接收当前 Notebook 的标题和短片段快照。有状态命令同样支持；当前库发生知识写入时拒绝旧上下文提交。示例见 [reading-related.json](examples/reading-related.json)，类型为 `ScriptSearchRequest` / `ScriptSearchContext`。授权、预算与开发工具 fixture 见 [搜索上下文说明](../../docs/SCRIPT-SEARCH-CONTEXT.md)。

## 受限异步宿主查询

声明 `action.asyncSearch` 并申请 `search:read` 后，脚本可使用第二个参数 `host: ScriptHostAPI`，执行 `await host.search(queryId)`。查询固定于清单，仅访问当前 Notebook；最多 4 次串行请求，取消或过期结果拒绝提交。有状态命令同样支持。示例 [reading-async-related.json](examples/reading-async-related.json)，权限、预算和 fixture 格式见 [异步宿主说明](../../docs/SCRIPT-ASYNC-HOST.md)。

## 固定 HTTPS 网络代理

声明 `action.networkRequests` 并申请 `network` 后，可使用 `ScriptNetworkAPI.request(id)` 等待固定地址的文本/JSON。安装审核显示域名和 URL；没有动态 URL、请求体、凭据或直接 fetch。搜索与网络共享四次串行调用预算。示例 [reading-network.json](examples/reading-network.json)，完整边界与离线 `fixture.network` 见 [网络代理说明](../../docs/SCRIPT-NETWORK-PROXY.md)。

## 宿主本地磁盘备份接口

`createLocalBackupAPI(authorizedTransport)` 提供配置、范围、定时计划、预览、备份、完整校验、恢复、删除及任务查询的统一类型。由受信宿主提供已授权的核心操作 transport；此适配器独立于插件 `createAPI` 和 `ExtensionContext`，不会增加扩展权限。`configure` 通过宿主原生目录选择器授权目录，不接收调用方提供的路径，用户取消时返回 `null`。

```ts
import { createLocalBackupAPI } from "@anynote/plugin-sdk";
const backup = createLocalBackupAPI(authorizedTransport);
const handle = await backup.verify({ notebookId, targetId });
const task = await backup.getTask(handle.id);
// 重复查询直到 status 为 completed、failed 或 cancelled。
const report = task?.verificationReport;
```

备份、校验和恢复返回任务 ID。任务包含进度、错误码、备份统计以及 `LocalVerificationReport`；恢复成功还提供 `restoreResult.restoredId`。校验报告逐文件列出缺失、大小不符、哈希不符、读取失败和 SQLite 异常，取消或卷身份变化标记为 `interrupted` / `complete: false`，不能当作完整校验通过。组任务在 `notebookResults` 中保留每个 Notebook 的结果与报告。

输入的 `targetId` 是设备配置 ID；清单、校验报告和恢复结果中的 `targetId` 是备份根目录身份 UUID。`getTask` 返回内存中的当前会话任务，进程重启后不保留历史任务。恢复先完整校验，再创建具有新身份的工作 Notebook。
