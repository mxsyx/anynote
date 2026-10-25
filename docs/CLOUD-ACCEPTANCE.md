# 真实云备份验收

> 状态归属：本文维护验收步骤和历史证据，任务完成状态只在 [Cloudflare](../TODO.md#a007) 维护。旧格式报告不构成当前 schema v4/独立附件协议验收；维护规则见 [文档维护](DOCUMENTATION.md)。

2026-10-03 已通过 Wrangler 自动创建并部署独立 Worker/D1/R2，真实 Cloudflare 验收 **passed**，13 项检查全部通过。结果见真实云报告。这些协议测试不代表完整产品发布验收通过。

## Wrangler 自动创建、部署并验收（Cloudflare）

直接运行：

```sh
pnpm run cloud:deploy
```

使用本机 Wrangler 登录授权；未登录时先运行 `npx wrangler login`。单账号自动选择；多账号通过 `CLOUDFLARE_ACCOUNT_ID` 选择。**无需填写 `ANYNOTE_CF_ENDPOINT` 和 `ANYNOTE_CF_TOKEN`**。

脚本创建独立的 `anynote-backup-acceptance-<随机后缀>` Worker/D1/R2，应用远程迁移，生成 APP_TOKEN，并用 Wrangler `deploy --secrets-file` 随代码上传，然后提取 workers.dev 地址并执行真实云 Cloudflare 场景。该方式依据 [Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/workers/)。重复运行复用资源与 Token；中途失败会保留部署状态，重跑时检查已有资源。

部署配置和状态保存在 `.cloudflare-acceptance/`，已加入 git 忽略；`secrets.json` 权限为 600，不包含在验收报告中。请保留该目录以复用这套测试资源。后续 `pnpm run test:cloud` 自动读取保存的地址与 Token；只有完整的手填 Endpoint/Token 对才优先覆盖自动配置。

此命令只部署并验收 Cloudflare。源文件 `apps/cloudflare-backup/wrangler.jsonc` 留作手动生产部署配置，自动流程使用独立生成的配置。

## 配置已有服务（可选手动 Cloudflare）

将根目录 `.env.cloud.example` 复制为 `.env.cloud`，在本机填写；此文件已加入 git 忽略，不要提交或粘贴密钥到聊天。

| 环境变量              | 用途                                          |
| --------------------- | --------------------------------------------- |
| `ANYNOTE_CF_ENDPOINT` | 已部署 Worker 的 HTTPS 地址                   |
| `ANYNOTE_CF_TOKEN`    | Worker 的 APP_TOKEN，非 Cloudflare 管理 token |

Node 24 可直接读取文件，无需把密钥放入 shell 命令参数。直接调用脚本前先编译核心；`pnpm run test:cloud` 会自动完成编译：

```sh
pnpm run build:backend
node --env-file=.env.cloud scripts/cloud-acceptance.mjs --preflight
node --env-file=.env.cloud scripts/cloud-acceptance.mjs
```

也可以由当前环境提供变量，再运行：

```sh
pnpm run test:cloud
pnpm run test:cloud --report test-results/cloud-acceptance.json
```

预检查不联网，仅验证变量与地址格式，不验证凭据可用性。缺少配置退出码为 2、验收失败为 1、通过为 0；预检查通过报告为 `configured`，绝不会标成真实云 `passed`。

## 部署 Cloudflare Worker

根目录已固定 Wrangler 版本。新部署需要有 Workers 发布、D1 与 R2 管理权限的 Cloudflare 账号；建议使用专用测试资源。已有已部署 Worker 可直接使用上一节。

```sh
npx wrangler d1 create anynote-backup
npx wrangler r2 bucket create anynote-backup
```

把创建返回的数据库 UUID 和实际 bucket 名填入 `apps/cloudflare-backup/wrangler.jsonc`。未填写的 `REPLACE_WITH_YOUR_DATABASE_ID` 不能用于真实部署。先检查打包，再应用远程 migration、设置 APP_TOKEN 并部署：

```sh
pnpm run cloud:check
npx wrangler d1 migrations apply anynote-backup --remote --config apps/cloudflare-backup/wrangler.jsonc
npx wrangler secret put APP_TOKEN --config apps/cloudflare-backup/wrangler.jsonc
npx wrangler deploy --config apps/cloudflare-backup/wrangler.jsonc
```

`secret put` 使用交互输入，不将 APP_TOKEN 放入配置文件或命令参数。管理授权可使用 Wrangler 登录或由本机提供 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`；它们不代替运行验收所用的 APP_TOKEN。命令依据 [Cloudflare D1 CLI](https://developers.cloudflare.com/workers/wrangler/commands/d1/)、[R2 CLI](https://developers.cloudflare.com/r2/reference/wrangler-commands/) 和 [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)。手动部署与自动验收资源独立。

## 验收内容

临时库包含中文正文、未知扩展块、目录、标题/标签/收藏历史、内联资源、独立图片和回收站内容。真实云下载后使用正式导入路径创建新 Notebook，验证内容、资源字节、历史、回收站与重建搜索。远端数据读取会执行正式 Provider 的 SHA-256、大小、schema 与完整性检查。

| 场景                       | Cloudflare                                       |
| -------------------------- | ------------------------------------------------ |
| 无效身份凭据被拒绝         | 错误 APP_TOKEN 返回 401                          |
| 上传、读取校验与完整恢复   | 逻辑实体 checkpoint 与附件                       |
| 未变化对象不再上传         | 新 generation plan 的 missing 为 0               |
| 未提交版本对恢复列表不可见 | staging 版本、缺对象提交拒绝                     |
| 提交响应丢失与幂等重试     | commit 已完成后客户端抛错、查询状态并重复 commit |
| 篡改校验                   | 错误哈希对象上传被拒绝                           |
| 幂等身份冲突               | 同 generation 不同 manifest 返回 409             |
| 并发提交竞争               | 两个 generation 同时提交，只有一个可发布         |
| 新旧版本恢复               | 修改后走公开 Provider 上传/恢复，同时验证旧版本  |

新增 5 项 Cloudflare 检查覆盖恢复 pin 与预览不删除、保护改变后旧计划拒绝、确认后旧版本删除/保留 head 恢复、接管后旧设备拒绝上传及新设备提交、日/周/月策略保留旧月代表版本并恢复。新上传对象仍在 24 小时宽限期内，不据此宣称真实云老化对象回收已验收。

故障注入发生在客户端调用边界，上传、commit、列举和恢复仍由真实服务执行；不表示云厂商发生实际故障，不包括区域失效、跨地域复制或权限撤销演练。

## 报告与测试数据

报告默认写入 `test-results/cloud-acceptance.json`，每步更新：模式、整体/目标状态、步骤耗时、endpoint、测试 Notebook/lineage/generation UUID、错误或缺失变量。已知 token 和访问凭据会脱敏；报告目录已被 git 忽略。

每次验收使用新的 Notebook 和 lineage。云端测试数据保留供核查，脚本不删除原有数据；清理时仅处理报告列出的本次测试范围。Cloudflare 已提供受并发保护的清理 API；新增维护场景只删除本次新建测试库中的指定旧版本，其余测试数据继续保留。详见 [远端维护](./REMOTE-MAINTENANCE.md)。

仅当报告 `mode=real-cloud`，所有选定目标 `status=passed` 且全部步骤通过，才能记录该目标的真实云协议验收成功。Linux 真实 GNOME Keyring、应用重启、正式自动备份与恢复流程已另行通过 [桌面验收](./DESKTOP-CLOUD-ACCEPTANCE.md)。其他平台的系统密钥服务、系统重启、自动备份长期运行、超过 24 小时无引用对象的真实回收及厂商级故障仍需独立验收。

## 本地验证

```sh
pnpm test
pnpm run test:cloud:local
pnpm run cloud:check
```

`pnpm test` 使用本地内存对象与 SQLite D1/R2 适配器验证验收逻辑。`test:cloud:local` 则启动官方 workerd，用隔离的本地 D1/R2、真实 HTTP 和并发请求执行同一套 Cloudflare 场景，报告明确为 `local-workerd`；临时服务、数据库和文件会在结束时清理。`cloud:check` 为 dry-run，仅打包，不上传。

## 跨会话老化样本

`test:cloud:aging` 使用当前 schema v4 服务，生成小规模独立 Notebook，保存无凭据状态到 `.cloudflare-acceptance/aging.json`。它建立可回收旧版本对象、保留版本、其他分支和未提交 staging；先删除旧版本身份，留下仍受 24h 宽限保护的对象。创建时间来自实际操作，不改服务器时钟、对象上传时间或 staging 活动时间。

```sh
# 只建立一次；已有文件会被拒绝覆盖。
pnpm run test:cloud:aging --seed

# 按状态文件中的 due24h、due7d 接续，24h 阶段必须在 staging 满 7 天前执行。
pnpm run test:cloud:aging --verify 24h
pnpm run test:cloud:aging --verify 7d
```

`--state 路径` 可指定另一份独立样本。状态绑定 endpoint，同一文件通过 SQLite 排他锁防止并发操作；锁在进程退出后释放，不应删除 `.lock.sqlite` 文件。状态原子写入，复验在清理前保存计划，响应丢失或中途失败后重跑同一命令会继续该计划。初始化中断时保留已记录的 Notebook/版本身份，使用新的状态文件重建，不覆盖或冒充成功初始化。

未到期复验不联网、不刷新 staging 活动，退出码为 2；阶段通过为 0，错误为 1。建立成功只记录 `waiting`，不表示老化验收通过。24h 阶段验证老化候选、恢复 pin/staging/分支保护与三个保留版本的实际恢复；7d 阶段验证当前分支 staging 到期、清理及墓碑重放拒绝。恢复 pin 在复验时创建，不声称一个 pin 持续有效 7 天。

对象 API 的 404 还可能来自 D1 验证目录缺失，不能单独证明 R2 物理删除。管理员须根据状态中的 `orphanHashes` 和 Notebook ID，在清理前后用独立 R2 接口核对，保存结果；例如：

```sh
pnpm exec wrangler r2 object get '<测试桶>/objects/<Notebook ID>/<hash>' \
  --remote --config .cloudflare-acceptance/wrangler.json --file /tmp/aging-object.bin
```

只把明确的对象不存在结果计为物理删除，不把鉴权、网络或服务异常当作通过。此脚本尚不覆盖孤立 manifest/临时对象、归档写失败、桶 multipart 自动回收或容量成本；即使两阶段通过，也不能单独完成 A008。样本身份、最早复验时间和剩余范围见 [Cloudflare 任务交接](history/todo-progress-2026-10-25.md#cloudflare)。
