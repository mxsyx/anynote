# 公共包发布矩阵

本文说明 Anynote 各组成部分的独立版本、兼容窗口、发布产物与旧消费者测试。
矩阵的单一来源是 [`packages/protocol/src/release.ts`](../packages/protocol/src/release.ts)：
该模块运行时中立，桌面主进程、Worker 与发布工具读取同一份定义，避免文档、
脚本与代码三处漂移。

设计依据见 [产品与技术设计](Anynote-Design.md) §19.2（独立发布项目与跨版本矩阵）、
§16.5（SDK 语义版本与合约测试）与 §22.3（v1 发布门槛）。

## 组成单元

| 单元          | 包 / 标识                       | 版本来源                        | 契约 | 渠道               | 可发布 npm |
| ------------- | ------------------------------- | ------------------------------- | ---- | ------------------ | ---------- |
| `desktop`     | `@anynote/desktop`              | 根 `package.json`               | —    | GitHub Release     | 否         |
| `worker`      | `@anynote/cloudflare-backup`    | `apps/cloudflare-backup`        | —    | Wrangler 部署      | 否         |
| `sdk`         | `@anynote/plugin-sdk`           | `packages/plugin-sdk`           | 1    | npm tarball        | 是         |
| `devtools`    | `@anynote/extension-tools`      | `packages/extension-tools`      | —    | npm tarball        | 是         |
| `first-party` | `@anynote/first-party-adapters` | `packages/first-party-adapters` | 1    | npm tarball        | 是         |
| `format`      | `@anynote/protocol`             | `packages/protocol`             | —    | 内部（随单元分发） | 否         |

- 版本彼此独立：升级 SDK 不强制升级桌面，反之亦然。
- 桌面版本必须与根 `package.json` 一致，因为 `release.yml` 用标签 `v*.*.*` 校验
  根版本；同时 `@anynote/desktop` 需保持同步。
- 契约版本（`contract`）只在公开调用面形状变化时递增，与包版本解耦。

## 格式与 schema

| 格式                    | 标识                                  | 版本 | 归属     |
| ----------------------- | ------------------------------------- | ---- | -------- |
| `notebook-schema`       | `notebook.sqlite`（`schema_version`） | 2    | `format` |
| `notebook-archive`      | `anynote.notebook`                    | 1    | `format` |
| `logical-protocol`      | `anynote.logical`                     | 1    | `format` |
| `local-backup`          | `anynote.local-backup`                | 1    | `format` |
| `cloud-backup-head`     | `anynote.cloud-backup-head`           | 1    | `format` |
| `cloud-backup-manifest` | `anynote.cloud-backup-manifest`       | 1    | `format` |
| `extension-package`     | `anynote.extension.v1`                | 1    | `format` |
| `extension-directory`   | `anynote.extension-directory.v1`      | 1    | `format` |
| `extension-settings`    | `anynote.extension-settings.v1`       | 1    | `format` |

格式版本按整数独立演进；新增表或字段必须同步更新矩阵与迁移契约。

## 兼容窗口

`compatibilityWindows` 声明“某消费者接受提供者处于哪个版本区间”，单元用 semver
range、格式用整数 range。越界时按设计 §19.2 明确拒绝，不静默降级写入。

| 消费者        | 提供者                  | 接受范围 | 说明                                   |
| ------------- | ----------------------- | -------- | -------------------------------------- |
| `desktop`     | `notebook-schema`       | `<=2`    | 可读写 schema 1（先迁移）与 2          |
| `desktop`     | `notebook-archive`      | `1`      | 完整归档 `anynote.notebook` v1         |
| `desktop`     | `logical-protocol`      | `1`      | 与 Worker 仅在同一逻辑协议版本内互操作 |
| `worker`      | `logical-protocol`      | `1`      | Worker 只接受 `anynote.logical` v1     |
| `desktop`     | `sdk`                   | `^0.1.0` | 桌面宿主实现 SDK 0.1 契约              |
| `first-party` | `sdk`                   | `^0.1.0` | 首方适配器只使用 SDK 0.1 公开导出      |
| `desktop`     | `extension-package`     | `1`      | 签名扩展包                             |
| `desktop`     | `extension-directory`   | `1`      | 扩展目录                               |
| `desktop`     | `extension-settings`    | `1`      | 扩展设置                               |
| `desktop`     | `local-backup`          | `1`      | 本地磁盘备份清单                       |
| `desktop`     | `cloud-backup-head`     | `1`      | 云盘备份当前指针                       |
| `desktop`     | `cloud-backup-manifest` | `1`      | 云盘备份完整清单                       |

`checkReleaseCompatibility(consumer, provider, version)` 返回 `{ compatible, window }`
或 `{ compatible: false, reason }`；`assertReleaseCompatibility` 在越界时抛错。

## 发布产物

```sh
pnpm run build:release        # 构建 artifacts/release/ 与发布清单
pnpm run test:release:matrix  # 兼容窗口 + 旧消费者在干净离线项目中的校验
```

`build:release` 复用既有便携构建入口（`build:sdk`、`build:extension-tools`、
`build:first-party`），把产物汇集到 `artifacts/release/<unit>/`，并为每个可发布
单元：

- 写入/校正 `version`、`license`、`engines`，补齐 `files` 白名单；
- 复制根 `LICENSE` 与 `CHANGELOG.md`；
- 校验 `"type": "module"`、许可证、引擎与每个 ESM/类型入口文件真实存在；
- 计算目录内容聚合 SHA-256。

发布清单写入 `artifacts/release/release-matrix.json`（`anynote.release-manifest.v1`），
包含各单元版本、契约、格式、兼容窗口、旧消费者清单与产物哈希，供 CI 与审计核对。

## 旧消费者测试

`tests/fixtures/legacy-consumer/consumer.ts` 固定了 0.1.0 的公开调用面（
`@anynote/plugin-sdk` 与 `@anynote/first-party-adapters`）。`test:release:matrix` 将其
复制到只含官方 tarball 的干净项目，用 `tsc` 编译后实际运行，并断言兼容窗口逻辑。
改变公开调用面时，必须同时提升 `legacyConsumers` 的契约版本并更新 fixture，
不能静默破坏旧消费者。

`tests/release-matrix.test.mjs` 另行校验矩阵与真实代码一致：单元版本对齐
package.json、契约版本对齐导出常量、格式版本对齐 schema / 迁移 SQL、兼容窗口
内部自洽。

## 许可证与变更日志

项目使用 **MIT** 许可证，全文见仓库根 [`LICENSE`](../LICENSE)。矩阵中的
`releaseLicense` 与各单元 package.json 的 `license` 字段统一为 `MIT`，构建产物会
随包附带同一份 `LICENSE`。第三方依赖保留各自的许可证，不在本许可证覆盖范围内。

根 `CHANGELOG.md` 按单元记录变更，并随每个 tarball 一起发布。

## 当前边界

- 三份 tarball 可在干净离线项目中安装、类型检查并运行；`npm publish` 与完整
  跨平台矩阵（旧桌面/新 Worker、新桌面/旧 Worker、旧插件/新桌面、新 schema
  导入旧桌面）的真机验收仍见 [TODO](../TODO.md) §1、§6。
- 桌面以 GitHub Release 分发、Worker 以 Wrangler 部署，均不进入 npm。
