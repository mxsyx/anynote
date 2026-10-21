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

- [ ] **P1 — 自编译自定义 Client ID 链路**：环境变量注入已实现（`resolveClientId` 读取 `ANYNOTE_GOOGLE_CLIENT_ID` 等，缺省时明确报错而非使用占位值），待补设置页/高级设置入口，以及「切换 OAuth 应用后需重新授权、既有备份目录不自动可见」的显式提示与迁移说明。

### T037 · 原 §5

- [ ] **P2 — 账号与目标管理 UI 补齐**：多账号并存与切换、重新登录入口、打开云盘目录、失败原因的可操作提示；当前已有断开/删除与重新授权入口，但重新登录需重新添加目标。

### T038 · 原 §5

- [ ] **P2 — 等待网络状态探测**：`waiting-network` 已在 UI 定义但未实现探测；评估接入计量网络/离线检测并与设备级暂停策略统一。

## 验证与完成条件

- [tests/oauth.test.mjs](../../tests/oauth.test.mjs)
- [tests/cloud-backup.test.mjs](../../tests/cloud-backup.test.mjs)
- [tests/backup-policy.test.mjs](../../tests/backup-policy.test.mjs)
- 设置/账号切换和 waiting-network 状态的浏览器回归。

完成条件：账号身份和目标不会误绑定，网络状态来自实际探测，设置与策略测试通过。

人工 / 外部资源：真实授权、撤销和重新登录复用 G01；不把设置完成当作授权验收。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
