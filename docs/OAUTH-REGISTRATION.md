# 官方 OAuth 应用注册与授权验收

依据 [云盘备份设计](./Anynote-Cloud-Drive-Backup-Design.md) §6。本文记录为 Google Drive（并预留
Dropbox / OneDrive）注册开发与生产 OAuth 应用、注入应用身份、以及在真实桌面环境完成授权验收的
步骤与当前状态。

Client ID / App Key 是**公开应用标识**，不是密钥：桌面二进制与公开源码无法保密 Client Secret，
因此官方扩展统一按公共客户端 + PKCE（S256）流程处理，仓库与构建产物中不存放任何密钥。

## 1. 应用身份如何解析

`@anynote/oauth-broker` 按以下优先级解析每个厂商的 Client ID（逐一回落，不拼接）：

1. **调用方显式传入 / 本机高级设置**：`beginCloudAuthorization` 的 `oauthClientId` 优先，否则使用“备份 → 云盘 → 高级设置”的本机 Client ID。重新登录始终使用原账号的应用身份。
2. **厂商环境变量**（自编译最简方式）：
   - `ANYNOTE_GOOGLE_CLIENT_ID`
   - `ANYNOTE_DROPBOX_APP_KEY`
   - `ANYNOTE_ONEDRIVE_CLIENT_ID`
3. **当前阶段的官方注册表** `ANYNOTE_OAUTH_APPS`（JSON）：
   ```json
   {
     "google-drive": {
       "development": "<dev-client-id>",
       "production": "<prod-client-id>"
     },
     "dropbox": {
       "development": "<dev-app-key>",
       "production": "<prod-app-key>"
     },
     "onedrive": {
       "development": "<dev-client-id>",
       "production": "<prod-client-id>"
     }
   }
   ```
   阶段由 `ANYNOTE_OAUTH_STAGE`（`development` / `production`，缺省或非法时按 `production`）选择。
   开发、测试与生产注册必须分开；测试白名单、开发状态或短时效 refresh token 不能作为正式长期备份基线。

三者都缺失时返回 `undefined`，授权会以「未配置 … 的 OAuth 应用身份」明确失败，而不是静默使用占位
字符串发起授权。备份/添加目标向导会从 `listCloudProviders` 的 `oauthConfigured` 得知该状态，并在
连接前提示打开高级设置填写 Client ID，也可使用自编译环境变量。

官方构建在打包时注入 `ANYNOTE_OAUTH_APPS` 与 `ANYNOTE_OAUTH_STAGE`，普通用户登录即可，无需填写
开发者凭据。自编译使用自己的 ID 需要**重新授权**，并可能访问不同的 app folder / 文件范围；跨 OAuth
应用迁移不承诺原目录自动可见，必须显式导出/导入或重新授权。

## 2. 厂商注册清单

对每个厂商分别注册**开发**与**生产**两套应用；授权页/隐私政策、回调与必要审核如下。

### Google Drive

- 应用类型：桌面 / 安装应用（Desktop app）。
- 授权页：配置应用名称、用户支持邮箱、开发者联系信息与**隐私政策 URL**；提交必要的验证（含敏感/
  受限 scope 审核）。
- scope：`openid`、`email`、`https://www.googleapis.com/auth/drive.file`（最小权限，仅访问本应用
  创建或打开的文件）。
- 回调：使用 **loopback** 回调 `http://127.0.0.1:<port>/`；桌面客户端可使用任意端口，无需逐端口注册。
- 测试阶段：在 Google Cloud Console 的 OAuth 同意屏幕添加测试用户白名单；发布前完成验证。

### Dropbox

- 应用类型：Scoped access，访问类型 **App Folder**。
- 权限：`account_info.read`、`files.metadata.read`、`files.content.read`、`files.content.write`。
- 回调：**PKCE + refresh token** 的后台访问模式；按 Dropbox 规则注册回调 URI（`http://127.0.0.1:<port>`），
  若厂商要求固定端口，通过扩展 `accountDescriptor.redirectPorts` 声明优先端口。
- 代码侧已接入 Dropbox Provider（App Folder + PKCE + refresh token、分块 content_hash、upload session 与 rev 冲突处理，见云盘备份设计 §11）；真实应用注册与授权验收尚未完成，因此仍不承诺可用。

### OneDrive / Microsoft Entra

- 应用平台：移动和桌面应用程序（公共客户端），启用 PKCE 授权码流程。
- 权限（delegated，最小）：`offline_access`、`User.Read`、`Files.ReadWrite.AppFolder`。
- 回调：`http://127.0.0.1:<port>/` 或声明固定端口；`response_mode=query`。
- 企业/学校租户可能要求管理员批准：扩展如实报告原因，不自动扩大权限，也不引导绕过组织策略。

## 3. 回调与授权状态

- 统一使用系统浏览器 Authorization Code + PKCE（S256）+ `state`；厂商页面**不放入**带 preload / Node
  权限的 Electron WebView。
- loopback listener 只绑定 `127.0.0.1`、短期存活、只监听单一路径；校验 `state`、预期路径与超时，成功
  后立即关闭。
- 明确状态：**用户取消**、**授权超时**、**回调 state 不符**、**端口被占用**、**系统浏览器唤起失败**、
  **未配置应用身份**分别给出可操作提示（见 `packages/oauth-broker/src/errors.ts`）。端口占用时按优先
  端口顺序回落，全部占用才报错。

## 4. 验证现状

### 已自动化覆盖

`tests/oauth.test.mjs` 覆盖：

- 应用身份按开发/生产阶段解析，显式 > 环境变量 > 注册表的优先级，缺失与非法配置的处理。
- 完整授权链路：`begin` 构造含 `state`/`client_id`/`code_challenge(S256)` 的授权 URL、回环回调、
  `complete` 交换 token（校验 `code_verifier` 能还原 challenge）并写入保管库。
- 回调 `state` 不符时拒绝且不交换 token。
- 授权超时、端口被占用（含回落到随机端口）、系统浏览器唤起失败的状态与清理。

### 仍需人工 / 真机完成

- 真实厂商注册与审核：应用创建、授权页/隐私政策、必要审核（本节 §2）。
- 真实桌面环境验证：系统浏览器唤起、真实回环回调、真实厂商的 `state`/PKCE 行为、授权超时与端口占用
  状态；离开授权页后多次启动、token 过期、撤销、重新授权与第二设备只读恢复。
- Google Drive 端到端（`drive.file` 下创建/发现/上传/下载/删除、resumable 上传、403 reason 分类）与
  配额/限流分类见 [云盘备份设计](./Anynote-Cloud-Drive-Backup-Design.md) §10.4；相关待办见 [云盘授权与真实账号验收](todo/02-account-validation.md#a001)。

在完成真实厂商与真机验收前，不宣称官方 OAuth 应用注册与跨设备授权已验证。

## 5. 本机设置、账号与网络（G13）

- 高级设置按厂商保存公开 Client ID / App Key；留空恢复环境变量 / 发行版配置。设置使用设备 `_local` 文件中的 `oauth.client.id` 键，不进入 Notebook 或备份。应用身份状态不返回默认 Client ID；账号管理中显示其公开应用标识以区分归属。
- 账号身份由厂商、应用 ID、厂商账号 ID 和上下文共同确定。同一身份重复授权修复已有账号；不同账号或不同应用身份可并存。添加目标可复用已连接账号，每个账号在同一 Notebook 下最多一个目标。
- **重新登录**固定原账号与原 OAuth 应用；新凭据写入前校验厂商返回的账号 ID。错误账号不会覆盖原凭据。成功后保留目标、设备槽与备份游标，清除该账号目标的鉴权暂停。
- **切换账号 / 应用**需显式确认，生成新设备槽并清空旧目录引用、成功游标和自动备份开关；旧云端副本保留。操作前须等待或取消该账号的任务。厂商缓存也按账号和 Notebook 隔离。
- **断开**清除本机凭据，保留公开账号引用以便原目标重新登录，暂停该账号关联的全部目标；不会调用厂商全局撤销接口，也不删除云端副本。需要在厂商撤销应用时，仍通过厂商账号安全设置处理。
- Google Drive 目录入口使用已有目录 ID；OneDrive 使用 Graph 返回的 `webUrl`。Dropbox 的 App Folder 相对路径不含用户可见应用目录名，因此打开 Apps 目录并提示进入授权应用，再定位 Notebook 目录；不猜测深层链接。浏览器登录账号仍需用户核对。

切换应用的迁移步骤：保存新 Client ID → 连接新应用下的账号 → 在目标上切换账号并确认新建备份槽 → 执行备份并验证可恢复 → 再决定是否自行删除旧副本。重新授权不会让旧目录自动可见，也不会自动迁移它。

网络状态来自 Electron 主进程的 `net.isOnline()`（启动、唤醒和 30 秒轮询），以及 Renderer 的 `navigator.onLine`、online/offline 事件与 Network Information `change` 事件。省流量偏好或蜂窝连接信号接入已有计量网络暂停策略；不使用 `effectiveType` 推断计费。平台未暴露信号时不声称已识别系统计费状态。[Electron 的离线检测说明](https://www.electronjs.org/docs/latest/tutorial/online-offline-events)、[Network Information API](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation)。

环境观测仅保存在进程内，重启重新采样，频繁报告不写盘。云盘自动调度统一读取设备电池、计量网络和任务大小策略；离线时不启动远端任务，`waiting-network` 区分离线和计量暂停。恢复后立即触发调度检查（仍尊重既有失败退避 / 鉴权暂停），常规轮询最多 60 秒。手动操作可越过计量暂停，不能越过离线检查。本地磁盘备份不因离线而暂停。网络“已连接”只表示主机连接状态，不保证厂商可达；厂商连接失败仍通过原有错误与退避处理。

自动化入口：`tests/cloud-account-settings.test.mjs`、`tests/oauth.test.mjs`、`tests/cloud-backup.test.mjs`、`tests/backup-policy.test.mjs`，以及启动 Vite 后的 `node scripts/cloud-accounts-smoke.mjs`（可通过 `ANYNOTE_BROWSER` 指定已安装 Chrome）。测试使用本机回环、内存凭据和模拟厂商响应；真实授权、系统计量网络和恢复验收仍交给 G01/G02。
