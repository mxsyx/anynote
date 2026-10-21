# G13 · 云盘账号设置与网络状态

[返回总入口](../../TODO.md)

类型：UI / 配置。目标：自定义 Client ID、多账号/重登录、网络等待。

前置：设置页可立即开发；真实重授权和网络状态通过 G01 验证。

并行边界：与导出/卷适配并行；与 G11/G12 共享云盘操作和界面，串行集成。

## 建议入口

- [apps/desktop/src/CloudBackup.tsx](../../apps/desktop/src/CloudBackup.tsx)
- [apps/desktop/src/CloudBackupAdd.tsx](../../apps/desktop/src/CloudBackupAdd.tsx)
- [packages/oauth-broker/src/apps.ts](../../packages/oauth-broker/src/apps.ts)
- [packages/backup-core/src/operations.ts](../../packages/backup-core/src/operations.ts)
- [packages/backup-core/src/scheduler.ts](../../packages/backup-core/src/scheduler.ts)
- [packages/backup/src/policy.ts](../../packages/backup/src/policy.ts)

## 执行顺序

1. 先统一自定义身份配置、重授权提示和账号/目标关系，明确目录可见性变化。
2. 再补账号切换、重新登录和可操作错误入口；复用已有断开/删除能力。
3. 接入离线/计量网络来源并对齐暂停策略，验证等待、恢复与手动操作的状态。

## 待办

### T034 · 原 §5

- [x] **P1 — 自编译自定义 Client ID 链路**：环境变量注入已实现（`resolveClientId` 读取 `ANYNOTE_GOOGLE_CLIENT_ID` 等，缺省时明确报错而非使用占位值），待补设置页/高级设置入口，以及「切换 OAuth 应用后需重新授权、既有备份目录不自动可见」的显式提示与迁移说明。

### T037 · 原 §5

- [x] **P2 — 账号与目标管理 UI 补齐**：多账号并存与切换、重新登录入口、打开云盘目录、失败原因的可操作提示；当前已有断开/删除与重新授权入口，但重新登录需重新添加目标。

### T038 · 原 §5

- [x] **P2 — 等待网络状态探测**：`waiting-network` 已在 UI 定义但未实现探测；评估接入计量网络/离线检测并与设备级暂停策略统一。

## 验证与完成条件

- [tests/oauth.test.mjs](../../tests/oauth.test.mjs)
- [tests/cloud-backup.test.mjs](../../tests/cloud-backup.test.mjs)
- [tests/backup-policy.test.mjs](../../tests/backup-policy.test.mjs)
- 设置/账号切换和 waiting-network 状态的浏览器回归。

完成条件：账号身份和目标不会误绑定，网络状态来自实际探测，设置与策略测试通过。

人工 / 外部资源：真实授权、撤销和重新登录复用 G01；不把设置完成当作授权验收。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。

## 2026-10-21 实施交接

G13 的本地实现与自动化完成；上面的条目正文保留原清单描述。真实厂商授权、撤销和重新登录仍交给 G01，未因此勾选 G01 的真实验收。

### 改动范围

- T034：云盘高级设置支持三家 Client ID / App Key、本机持久化、来源 / 阶段提示与恢复默认；明确切换应用必须重新授权、原目录不会自动可见，附迁移步骤。详情见 [OAuth 设置说明](../OAUTH-REGISTRATION.md#5-本机设置账号与网络g13)。
- T037：添加时复用已连接账号、多账号 / 多应用身份并存；原目标重新登录在写凭据前验证原账号，错误账号不会覆盖。切换账号生成新槽、清除旧引用和游标、关闭自动备份，保留旧云端副本；同账号同 Notebook 禁止重复目标。账号级缓存隔离、运行中目标保护、重复授权去重和刷新 / 断开并发保护一并完成。
- 目录入口：Google Drive 指向已有目录；OneDrive 使用厂商返回的 `webUrl`；Dropbox 打开 Apps 并提示进入授权应用与 Notebook 子目录，不猜测 App Folder 深层链接。原断开 / 删除入口保留；断开保留公开身份以支持原目标重登录，只清除本机凭据、不撤销其他设备授权。
- T038：接入 Electron `net.isOnline()`、浏览器在线 / 离线事件、Network Information 省流量 / 蜂窝信号。云盘自动备份读取设备统一策略；离线不创建新任务，网络恢复重新调度，手动备份可越过计量暂停。传输中断网不消耗失败重试次数。环境只驻留内存，重启重新采样，1000 次报告不写盘。
- RPC 操作白名单、Storage 分派、共享类型、SDK、三家 Provider 和桌面 / 预览入口同步更新。弹窗按需挂载，设置、账号和网络状态复用现有桌面组件与样式。

### 验证记录

环境：macOS / Darwin arm64，Node 24.22.0，pnpm 12.14.0，已安装 Google Chrome；基线 `ebca1ff`，本次为未提交工作区修改。

- `pnpm run build`：通过（已有大包体积提示）。
- `pnpm run check`：工作区依赖检查、ESLint、Prettier 和前后端 / 契约类型检查通过。
- 专项 `vitest run tests/cloud-account-settings.test.mjs tests/oauth.test.mjs tests/cloud-backup.test.mjs tests/backup-policy.test.mjs`：43 / 43 通过。覆盖真实本机回环、模拟厂商 token 响应、临时 SQLite / 本机配置、账号隔离、切换 / 重登录和网络策略；不调用真实厂商服务。
- 全量 `pnpm test`：422 项中 419 通过，3 项失败均在既有 `tests/icons.test.ts`：旧图标测试期望 48×48 viewBox、SVG title 和无 Lucide 前缀的 class，当前未改动图标组件输出 Lucide。`git diff --exit-code HEAD -- tests/icons.test.ts apps/desktop/src/icons.tsx apps/desktop/package.json` 确认涉及文件未改动；本组未扩展到图标迁移。日志：`/tmp/anynote-g13-tests.log`。
- `ANYNOTE_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/cloud-accounts-smoke.mjs`：通过。覆盖设置保存 / 重开、显式账号切换、错误账号提示、等待期间取消、原目标重登录、目录入口、计量网络手动操作、浏览器离线 / 恢复和 720px 窄屏；无页面异常。模拟 RPC 不代替真实后端 / 厂商验收。报告与截图：`/tmp/anynote-cloud-accounts/{report.json,settings.png,offline.png,narrow.png}`。

### 剩余外部验证与下一步

- G01：三家真实账号、系统浏览器授权 / 撤销 / 重登录、切换 OAuth 应用后的目录可见性和第二设备恢复；厂商真实目录链接也需在该批次确认。
- G02：不同平台的真实断网、唤醒、计量 / 省流量网络；平台不提供计量信号时 UI 保留未知边界，不推断网络费用。主机显示在线不等于厂商服务可达。
- G20：既有图标测试与实现不一致，独立处理。此次未改图标系统或其他组清单。
