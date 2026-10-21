# G01 · 云盘授权与真实账号验收

[返回总入口](../../TODO.md)

类型：验收 / 实测。目标：OAuth → 厂商读写/故障 → 条件发布 → 第二设备恢复。

前置：官方应用身份、真实测试账号和干净第二设备；组织租户只在该可选范围需要时准备。

并行边界：与本地代码任务并行；同一账号/目录的发布、GC、故障注入串行。

## 建议入口

- [packages/oauth-broker/src/apps.ts](../../packages/oauth-broker/src/apps.ts)
- [packages/backup-core/src/operations.ts](../../packages/backup-core/src/operations.ts)
- [extensions/backup-google-drive/src/provider.ts](../../extensions/backup-google-drive/src/provider.ts)
- [extensions/backup-dropbox/src/provider.ts](../../extensions/backup-dropbox/src/provider.ts)
- [extensions/backup-onedrive/src/provider.ts](../../extensions/backup-onedrive/src/provider.ts)
- [docs/OAUTH-REGISTRATION.md](../../docs/OAUTH-REGISTRATION.md)

## 执行顺序

1. 先整理注册参数、测试目录和报告模板；这些准备工作不依赖真实授权。
2. 人工注册/审核及授权后，按 Google Drive、Dropbox、OneDrive 分批执行同一验收矩阵；已完成 Provider 实现不重复开发。
3. 每批先验证读写及故障，再验证条件发布和第二设备只读恢复；只有实测支持才调整 conditionalHead。
4. OneDrive 企业/学校租户作为可选子批次，缺少组织资源不阻塞其他厂商。将通用故障证据交给 G07，恢复证据交给 G03。

## 待办

### T027 · 原 §5

- [ ] **P0 — 官方 OAuth 应用注册与真实授权**：为 Google Drive（并预留 Dropbox/OneDrive）注册开发与生产 OAuth 应用，配置授权页、隐私政策、回调与必要审核；在真实桌面环境验证系统浏览器唤起、回环回调、`state`/PKCE 校验、授权超时与端口占用状态。**代码侧已就绪**：应用身份按「调用方显式 → 厂商环境变量 → 当前阶段官方注册表」解析（`ANYNOTE_OAUTH_APPS` + `ANYNOTE_OAUTH_STAGE` 区分开发/生产），回调路径与优先端口按 `OAuthProviderDescriptor` 生效，授权状态补齐端口占用、系统浏览器唤起失败与未配置身份，并可在「添加云盘目标」向导中如实提示；`tests/oauth.test.mjs` 覆盖 `state`/PKCE、超时、端口占用（含回落）与浏览器唤起失败，注册与注入步骤见 [官方 OAuth 应用注册](../../docs/OAUTH-REGISTRATION.md)。**仍需人工完成**：真实厂商注册与审核、真实桌面环境的系统浏览器唤起与真实厂商 `state`/PKCE 行为、撤销/重新授权与第二设备；当前仍无任何厂商实测数据。

### T028 · 原 §5

- [ ] **P0 — Google Drive 真实端到端验收**：以真实账号验证 `drive.file` 最小权限下的目录创建/发现/上传/下载/删除、resumable 上传（256KiB 分片、服务端确认偏移、会话失效重建）、上传后下载校验、配额与 403 reason 分类、`current` 读回确认。当前 `googleapis` 调用路径与上传下载协议未经过真实 API 验证。

### T029 · 原 §5

- [ ] **P0 — 第二设备只读恢复**：在干净设备（新授权环境、无原机 file ID 缓存）从云盘恢复当前副本，核对条目数、资源哈希、历史、回收站与搜索重建；同时验证 `drive.file` 下发现既有备份并下载的闭环能力。

### T030 · 原 §5

- [ ] **P1 — 条件发布能力实测**：实测各 Provider 与 endpoint 的版本 token/条件写行为；仅在实测通过后才把 `conditionalHead` 置为 true，否则继续使用单写设备槽 + 发布前后检查，并明确不宣称跨客户端原子互斥。

### T039 · 原 §5

- [ ] **P2 — 真实容量与故障演练**：在真实账号验证空间不足、429/`Retry-After`、授权撤销、token 轮换、上传中断与清理失败重试，记录报告。真实远端故障的通用条目见 §1。

### T040 · 原 §5

- [ ] **P3 — 企业/学校租户策略**：验证 OneDrive 组织租户管理员策略下的授权与最小权限行为；失败时给出准确原因，不静默追加更高权限、不引导绕过组织策略。

## 验证与完成条件

- [tests/oauth.test.mjs](../../tests/oauth.test.mjs)
- [tests/cloud-backup.test.mjs](../../tests/cloud-backup.test.mjs)
- [tests/cloud-dropbox.test.mjs](../../tests/cloud-dropbox.test.mjs)
- [tests/cloud-onedrive.test.mjs](../../tests/cloud-onedrive.test.mjs)
- 真实账号报告按 Provider、权限、endpoint、设备和版本分开记录。

完成条件：各 Provider 的实测范围与未执行项可区分；不能用 mock 测试或一个厂商的通过结果覆盖其他厂商。

人工 / 外部资源：厂商控制台注册/审核、真实账号授权及撤销、组织管理员配合、准备干净第二设备；AI 可准备脚本和整理报告。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
