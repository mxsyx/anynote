# 扩展数据迁移与恢复

扩展升级不会自动修改 Notebook 内的数据。状态版本或设置定义改变后，命令会拒绝使用旧数据；用户重新授权扩展后，可以在扩展卡片的「数据迁移与恢复」中预览声明的迁移。确认时，后端在同一 SQLite 事务中保存原始数据副本、写入迁移结果和幂等回执。失败会全部回滚。

## 使用流程

1. 安装新版定义或签名包，并授权当前 Notebook。来源信任与权限检查沿用现有规则。
2. 点击「预览迁移」，检查目标、版本以及修改前后的完整 JSON；取消预览不写入知识数据。
3. 点击「确认迁移并备份」。原始数据会出现在本扩展的备份列表。
4. 需要撤回时点击对应副本的「预览恢复」，检查原值，然后「确认恢复并备份」。恢复前的当前数据也会保存为新副本。

恢复只修改本扩展的设置或脚本状态，不撤回扩展安装、权限、笔记正文或历史版本。恢复旧数据后可能需要重新迁移，或安装兼容的扩展定义；当前命令仍会检查版本兼容性。设置表单会重新加载，不能用默认值覆盖不兼容数据。

## 开发协议

`contributes.dataMigrations` 最多声明 8 条规则，每条 ID 必须唯一且位于扩展命名空间。规则由核心执行，不执行扩展提供的迁移 JS，也不提供 SQL、磁盘路径、其他扩展的键或 Notebook 选择能力。

```json
{
  "stateVersion": 2,
  "dataMigrations": [
    {
      "id": "garden.session.v2",
      "title": "整理次数升级",
      "target": "scriptState",
      "fromVersion": 1,
      "toVersion": 2,
      "rename": { "runs": "visits" },
      "defaults": { "lastTitle": "" }
    }
  ]
}
```

脚本状态版本通过 `contributes.stateVersion` 声明，未声明时为 1。必须有 `transformMarkdownWithState` 命令和 `settings:read`、`settings:write` 权限。迁移只能从较小的已知版本升至当前声明版本；新 Notebook 首次写入直接采用当前版本。旧数据不经迁移时不会运行新版本命令。

设置迁移使用 `target: "settings"`，当前 `fromVersion` 和 `toVersion` 均为 1，并必须提供 `fromSettingsChecksum`。该摘要是旧表单通过 `extensionSettingsSchema.parse` 规范化后，`JSON.stringify` 的 UTF-8 SHA-256，不能直接对任意排版的文件求摘要。结果绑定当前表单摘要，并严格检查完整字段、类型和范围。

`rename` 同时映射顶层字段，最多 32 项，拒绝目标重复、源字段缺失和覆盖未映射的已有值。`remove` 显式移除最多 32 个顶层字段；`defaults` 只填入缺失字段，最多 32 个顶层键，遵守脚本状态 JSON 的 64KiB、16 层、4096 值限制。字段名遵守 SDK 安全键约束；迁移不会隐式删掉未知字段或进行类型转换，设置中多余的字段会导致校验失败，必须显式声明删除规则。

完整可安装示例：[状态 v1](../packages/plugin-sdk/src/examples/reading-session.json)、[状态 v2](../packages/plugin-sdk/src/examples/reading-session-v2.json)、[设置 v1](../packages/plugin-sdk/src/examples/reading-preferences.json)、[设置 v2](../packages/plugin-sdk/src/examples/reading-preferences-v2.json)。先执行或保存 v1，再安装 v2、重新授权，便可预览迁移。公开 SDK 导出 `ExtensionDataMigration`、`ExtensionDataOverview`、`ExtensionDataReview`、`ExtensionDataApplyResult`；执行器不进入公开 tarball。

## 一致性与预算

预览保存在服务内存中，使用不透明 UUID，绑定 Notebook、扩展、安装摘要和原始数据的内容、版本及 revision，有效期 10 分钟，每个服务最多 8 份。提交重新校验来源信任、完整权限、启用状态、安装定义和原数据；恢复还核对所选备份是否在预览后改变。数据变化拒绝旧预览，重复的相同 `operationId` 返回同一回执。关闭服务会销毁预览；已提交的回执保留用于重试。

迁移和恢复只处理 `settings:form` 与 `script:state`。原数据最多 128KiB，备份读取预算为 512KiB；状态迁移结果还必须满足脚本状态预算。每个 Notebook/扩展最多保存 32 份副本，达到上限拒绝写入，不自动删除旧副本。副本在迁移与恢复前生成，尚未提供独立手动快照。现在可通过[插件数据清理](EXTENSION-CLEANUP.md)选择删除旧副本，释放副本预算；仍不自动删除。

副本使用本扩展 `extension_data` 的 `data-backup:<UUID>` 键，保存完整原始 JSON 字符串、schema_version、源 revision、时间、安装摘要及原因。恢复保留 JSON 字节与 schema_version，当前 revision 继续递增，不回退并发计数。成功修改会取消此 Notebook 中该扩展的在途脚本。

这些副本是同一 Notebook 内的局部撤回数据，不是独立的数据库灾难恢复文件。完整归档和云备份会沿既有 `extension_data` 路径包含副本；卸载保留副本，恢复为新 Notebook 后仍需重新授权。新定义包含旧客户端不认识的迁移字段，旧客户端可能拒绝安装新版定义，但原始 Notebook 数据仍可保留。

## 验证

```sh
pnpm test
pnpm run package
node scripts/editor-ecosystem-smoke.mjs
ANYNOTE_EXECUTABLE=release/linux-unpacked/anynote node scripts/editor-ecosystem-smoke.mjs
node scripts/sdk-package-smoke.mjs
```

专项合约覆盖声明校验、状态升级、设置摘要绑定、未知字段保护、读预览不写入、事务失败回滚、幂等重试、原值恢复、权限/安装/并发/备份冲突、预算、在途取消和归档后独立授权。桌面流程使用临时 Notebook，通过真实界面完成设置及状态迁移、备份恢复和再次迁移；数据库只读核对原值与版本，不访问真实云账户。

2026-10-04：完整回归 160 项通过，其中迁移专项 10 项；严格 TypeScript 编译、SDK 干净项目离线安装/类型/运行验证和 Linux 应用目录打包通过。生产页面与最新 Linux 打包应用各 18 项流程、21 次自动 WCAG 扫描通过，违规为零。生产报告：`test-results/editor-ecosystem.json`。迁移预览截图：`docs/screenshots/editor/extension-data-migration.png`。打包报告：`test-results/editor-ecosystem-packaged.json`。
