# 首方功能适配器 0.1

`@anynote/first-party-adapters` 把白板、视频、导入三项首方能力，以及既有的本地备份适配器，收敛为一套**只依赖公开 SDK**的可移植接口。它独立打包后可以在干净外部项目中安装运行，用于验证首方功能的外部消费边界，而不是在应用内直接引用内部模块。

## 依赖与边界

- 只依赖 `@anynote/plugin-sdk` 的公开导出（`Transport`、`NoteSnapshot` 与本地备份契约）；不依赖 Node、Electron、存储或 UI 框架。
- 适配器本身不授予任何扩展权限：每个工厂都需要调用方提供**已授权**的 `Transport`，与 SDK 自带的 `createLocalBackupAPI` 一致。
- 备份适配器直接复用 `@anynote/plugin-sdk` 的实现，不重复实现。

## 调用面

```ts
import { createFirstPartyAdapters } from "@anynote/first-party-adapters";

const adapters = createFirstPartyAdapters(authorizedTransport);
await adapters.whiteboard.get({ notebookId, noteId });
await adapters.video.insert({ notebookId, noteId, expectedRevision, url });
await adapters.importer.preview({ notebookId, url });
await adapters.backup.verify({ notebookId, targetId });
```

| 适配器       | 方法                                                                    | 宿主操作                                                                                                              |
| ------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `whiteboard` | `get` / `save`                                                          | `getWhiteboard` / `saveWhiteboard`                                                                                    |
| `video`      | `insert` / `fetchMeta`                                                  | `insertVideo` / `fetchVideoMeta`                                                                                      |
| `importer`   | `start` / `preview` / `getPreview` / `commit` / `retryMedia` / `report` | `startImport` / `previewImport` / `getImportPreview` / `commitImportPreview` / `retryImportMedia` / `getImportReport` |
| `backup`     | 见 SDK 本地备份接口                                                     | `configureLocalBackup` 等                                                                                             |

白板、视频与导入适配器把可移植的 `noteId` 映射为宿主操作的 `id`；预览与确认共用同一份已转换结果，确认时不会二次抓取或转换。`importer.report` 在笔记没有导入记录时返回 `null`。

`contract()` 语义由 `firstPartyAdapterVersion`、`firstPartyAdapterContractVersion` 与 `firstPartyAdapterCapabilities` 暴露，便于消费方按版本判断可用能力。

## 独立打包与外部消费验证

```sh
pnpm run build:first-party          # 生成 artifacts/first-party-adapters
pnpm run test:first-party:package   # 在干净 /tmp 项目离线安装并类型检查/运行
```

`test:first-party:package` 同时打包 `artifacts/plugin-sdk` 与本包，写入一个只有两个 tarball 依赖的干净项目，用 `tsc` 编译并实际运行，校验方法映射（`noteId` → `id`）、备份适配器不接受调用方路径，以及版本契约。报告写入 `test-results/first-party-package.json`。

本包为 v1 预览，尚未发布到 npm；发布矩阵（版本与兼容窗口）见项目 `TODO.md` §6。
