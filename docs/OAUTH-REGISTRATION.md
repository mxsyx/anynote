# 官方 OAuth 应用注册与授权验收

依据 [云盘备份设计](./Anynote-Cloud-Drive-Backup-Design.md) §6。本文记录为 Google Drive（并预留
Dropbox / OneDrive）注册开发与生产 OAuth 应用、注入应用身份、以及在真实桌面环境完成授权验收的
步骤与当前状态。

Client ID / App Key 是**公开应用标识**，不是密钥：桌面二进制与公开源码无法保密 Client Secret，
因此官方扩展统一按公共客户端 + PKCE（S256）流程处理，仓库与构建产物中不存放任何密钥。

## 1. 应用身份如何解析

`@anynote/oauth-broker` 按以下优先级解析每个厂商的 Client ID（逐一回落，不拼接）：

1. **调用方显式传入**：`beginCloudAuthorization` 的 `oauthClientId`，用于高级设置 / 自编译。
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
连接前提示需在自编译或环境变量中提供 Client ID。

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
  配额/限流分类见 [云盘备份设计](./Anynote-Cloud-Drive-Backup-Design.md) §10.4；相关待办见根 `TODO.md` §5。

在完成真实厂商与真机验收前，不宣称官方 OAuth 应用注册与跨设备授权已验证。
