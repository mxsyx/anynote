# Changelog

本文件记录各发布单元的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号使用语义化版本。发布单元的独立版本与兼容窗口见
[发布矩阵](./docs/RELEASE-MATRIX.md)；本文件随每个 tarball 一起发布。

## 0.1.0

首个预览版本，尚未发布到 npm。桌面安装包通过 GitHub Release 分发，Worker 通过
Wrangler 部署。以下为各单元在该版本首次交付的能力。

### `@anynote/plugin-sdk` 0.1.0

- 新增：`AnynoteAPI` 公开调用面（`notebooks`、`nodes`、`notes`、`search`、`assets`、
  `settings`、`secrets`、`events`、`tasks`、`ui`、`providers`）与 `contract()` 版本/能力契约。
- 新增：`ExtensionError` 错误码、游标分页与 `CallOptions.signal` 取消。
- 新增：声明式扩展、受限 QuickJS 正文转换、有状态命令、声明式设置与数据迁移类型。
- 新增：`createLocalBackupAPI` 本地磁盘备份契约。

### `@anynote/extension-tools` 0.1.0

- 新增：`anynote-extension init / validate / run`，覆盖声明式、普通转换、有状态与
  设置四种 TypeScript 模板。
- 新增：清单诊断复用桌面校验器，示例试运行使用同一隔离 QuickJS 执行器。

### `@anynote/first-party-adapters` 0.1.0

- 新增：白板、视频、导入与本地备份适配器，只依赖公开 SDK。
- 新增：`firstPartyAdapterVersion` / `firstPartyAdapterContractVersion` 能力契约。

### `@anynote/desktop` 0.1.0

- 新增：Electron 桌面应用，本地知识库、编辑器、阅读器、导入导出与本地/远端备份闭环。

### `@anynote/cloudflare-backup` 0.1.0

- 新增：Cloudflare Worker + D1 + R2 逻辑备份、分支 CAS 发布与远端维护。

### 格式 / schema 0.1.0

- Notebook SQLite schema v2；完整归档 `anynote.notebook` v1；逻辑备份协议
  `anynote.logical` v1；本地备份清单 `anynote.local-backup` v1；扩展包
  `anynote.extension.v1`、扩展目录 `anynote.extension-directory.v1`、扩展设置
  `anynote.extension-settings.v1`。
