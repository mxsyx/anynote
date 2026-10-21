# G12 · 云盘校验等级与恢复预算

[返回总入口](../../TODO.md)

类型：内核 / UI。目标：内容校验等级、附件校验成本说明和恢复前空间预算。

前置：以现有校验等级和恢复数据流为基础；无需先取得官方 OAuth 身份。

并行边界：与卷适配/导入并行；CloudBackup、CloudRestoreWizard 和核心操作修改与 G13 串行。

## 建议入口

- [packages/cloud-backup-common/src/verify.ts](../../packages/cloud-backup-common/src/verify.ts)
- [packages/backup-core/src/tasks.ts](../../packages/backup-core/src/tasks.ts)
- [apps/desktop/src/CloudBackup.tsx](../../apps/desktop/src/CloudBackup.tsx)
- [apps/desktop/src/CloudRestoreWizard.tsx](../../apps/desktop/src/CloudRestoreWizard.tsx)

## 执行顺序

1. 明确校验模式的流量、可信等级和 UI 表达，不将降级结果显示为全部已验证。
2. 计算数据库校验及资源落盘所需空间，接入现有预算与拒绝/提示机制。
3. 补预算不足、取消、降级校验和正常恢复回归，并检查实际提示。

## 待办

### T031 · 原 §5

- [x] **P1 — 附件校验成本与模式**：已核对当前 SQLite v3：附件/历史随数据库分块传输，无法单独跳过附件而保留完整数据库校验。保留强制内容校验，不引入 `verify.downloadAssets=false`。界面说明 Google 新分块的额外下载成本；卡片、设备槽和报告依据实际最弱分块证据显示，不将指针读回当作内容全部校验。

### T032 · 原 §5

- [x] **P1 — 恢复空间预估与预算**：下载前读取清单，预估唯一分块下载量和 `3 × 数据库大小 + 1 MiB` 空间，展示可用空间及并发任务预算；启动时重新确认提交、检查空间并登记进程内预算。不足时拒绝下载，取消/失败/成功释放预算；预算不等于物理磁盘预分配。

## 验证与完成条件

- [tests/cloud-backup.test.mjs](../../tests/cloud-backup.test.mjs)
- [tests/cloud-recovery.test.mjs](../../tests/cloud-recovery.test.mjs)
- 相关设置、恢复提示的浏览器回归。

完成条件：预算在下载前生效，设置/任务/报告显示一致，校验等级没有被夸大。

人工 / 外部资源：真实磁盘满和厂商流量结果分别复用 G03/G01；本地实现先行。

## 实施记录（2026-10-21）

- 核心新增 `previewCloudRestore`，SDK 对应 `previewRestore`；三个官方 Provider 协议升为 v2，分离 `prepareRestore` 元数据预检和 `download` 数据下载。恢复清单与 current 哈希/身份一致，预览后提交变化要求重新预估。
- 修复宿主下载管道的中间流，保留背压并边下载边计算哈希；单块下载限制在清单大小内。网络请求/下载绑定取消信号，临时目录创建失败也会正常结算失败任务。
- 复用原有按钮、动态恢复对话框、磁盘查询和独立 SQLite 校验线程。恢复完整数据库 SHA-256 由核心核对，验证后创建新 Notebook；任务历史保留安全的校验/流量/预算摘要。
- 实现设计见 [云盘分块备份设计](../Anynote-Cloud-Drive-Backup-Design.md)。未修改原有归档/存储整理工作区改动。

验证环境：macOS，本机 Electron 41.9.1 的 Node 24.17.0；默认 Node 22 不满足项目要求。后端测试使用临时真实 SQLite、合成附件、模拟云端响应/磁盘可用量；浏览器使用本机 Chrome 和模拟 RPC。

验证结果：

- `pnpm run build`、`pnpm run build:backend`、`pnpm exec tsc --noEmit`、`pnpm run test:types`、`pnpm run workspace:check` 通过；构建保留已有的大 chunk 提示。
- 相关测试 **10 个文件 / 61 个用例通过**：`pnpm exec vitest run tests/cloud-backup.test.mjs tests/cloud-dropbox.test.mjs tests/cloud-onedrive.test.mjs tests/cloud-verification-budget.test.mjs tests/cloud-recovery.test.mjs tests/cloud-stream.test.mjs tests/task-history.test.mjs tests/first-party-adapters.test.mjs tests/sdk.test.mjs tests/sdk-extension-points.test.mjs`。其中新增预算集成测试 15 个用例，覆盖元数据预检、下载去重、空间不足、预览后空间/提交变化、临时目录 ENOSPC、并发预算、请求/流取消、超限/损坏下载、正文和附件真实恢复、报告重开后保留。
- `ANYNOTE_URL=http://127.0.0.1:5182 ANYNOTE_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/cloud-budget-smoke.mjs` 通过。覆盖成本说明、较弱校验证据、空间不足禁止开始、预检失败重试、取消、正常恢复和任务报告；已查看截图 `/tmp/anynote-cloud-budget-screenshots/{backup,insufficient,ready,reports}.png`。
- G12 改动文件 ESLint（零警告）、Prettier 和 `git diff --check` 通过。按实施前 SHA-256 对照，除本次更新的总 TODO 外，原有 12 个已修改文件内容保持不变。

剩余外部验收：G01 真实 Google/Dropbox/OneDrive 的账号、流量和下载结果；G03 真实满盘/设备故障。模拟预算不足及 ENOSPC 不替代真实磁盘满验收。
