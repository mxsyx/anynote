# 声明式扩展设置

扩展可以在 `contributes.settings` 声明当前 Notebook 的设置表单。界面由应用渲染，不加载扩展 UI 代码。支持文本、数字和开关；最多 12 个字段，标签与描述按文本显示。示例 [reading-preferences.json](../packages/plugin-sdk/src/examples/reading-preferences.json) 可配置摘要标题、目标篇数和是否追加摘要。

安装审阅显示完整设置定义和权限。扩展必须声明 `settings:read` 与 `settings:write`，并在当前 Notebook 获得全部声明权限；未授权、停用或来源信任被撤销时不展示可操作表单，后端也拒绝读写。声明式扩展只声明设置时可以不申请笔记权限；脚本命令仍需笔记读写权限。

## 使用与字段

授权后在已安装扩展卡片内编辑“当前 Notebook 设置”，点击“保存扩展设置”才生效。“填入默认值”只修改表单草稿，仍需保存；“重新加载设置”用后端当前值替换草稿。默认值首次读取不写入数据库，不增加知识版本。

```json
{
  "version": 1,
  "fields": [
    {
      "key": "heading",
      "label": "摘要标题",
      "kind": "text",
      "default": "阅读目标",
      "maxLength": 80
    },
    {
      "key": "target",
      "label": "目标篇数",
      "kind": "number",
      "default": 3,
      "min": 1,
      "max": 100,
      "integer": true
    },
    {
      "key": "enabled",
      "label": "追加整理摘要",
      "kind": "boolean",
      "default": true
    }
  ]
}
```

每个字段必须声明同类型默认值。文本最多 2000 个 JavaScript 字符，可声明更小的 `maxLength`；数字必须有限，默认范围为 ±1,000,000,000，可声明 `min`、`max`、`integer`；开关只接受布尔值。禁止重复或保留字段 key、未知属性、无效默认值、任意渲染器和设置脚本。保存要求所有声明字段完整且类型正确，拒绝额外字段和隐式字符串转数字/布尔。

公开 SDK 提供 `ExtensionSettingField`、`ExtensionSettingsContribution`、`ExtensionSettingsValues`、`ExtensionSettingsSnapshot` 类型和独立示例。可安装清单、签名和目录继续绑定整个贡献定义及其权限，旧扩展无需增加设置字段。

## 保存、执行与恢复

表单设置保存在 Notebook 的 `extension_data`，以扩展 ID 隔离，固定 key `settings:form`，schema version 1。它与 [脚本计数状态](SCRIPT-STATE.md) 的 `script:state` 分开。配置是知识数据，随完整归档和现有知识备份保存；停用或卸载保留数据。恢复后的 Notebook 仍需重新授权。

设置保存检查安装校验值、来源信任、Notebook 授权、启用状态和设置 revision，沿用知识事务及 `content_seq`。并发修改显示冲突，用户须重新加载再修改；失败回滚设置和知识版本。保存成功取消正在运行的本扩展命令。

声明表单的脚本只获得 `note.settings` 中自己的已声明字段。准备执行记录设置 revision，提交再次校验，不能提交依据旧设置计算的正文。没有表单的脚本不接收 `settings`。这不开放原始 `extension_data`、其他扩展状态、SQL、路径或异步宿主 API。

设置定义有独立 SHA-256：仅升级脚本或扩展版本且表单定义相同时保留设置；表单定义改变、未知 schema 或损坏数据时显示不兼容，拒绝保存与脚本执行，保留原始数据。当前不做隐式迁移；设置迁移及恢复流程属于下一优先级。

## 验证记录（2026-10-04）

完整回归 150 项通过，新增设置专项 8 项覆盖贡献定义/签名、权限与启用状态、只读默认值、字段校验与并发 revision、脚本快照和旧执行取消、升级兼容性、重启/归档/卸载保留、未知 schema 与损坏数据保护，以及知识事务回滚。严格 TypeScript 编译、SDK 干净离线消费及 Linux 最终打包通过。

生产构建与 Linux 打包应用各通过 17 项编辑器/扩展流程、18 次无障碍扫描，零违规。设置场景使用真实桌面界面验证未授权时隐藏表单并拒绝 API、三个字段的保存、外部修改造成的冲突、重新加载及命令应用新设置，撤销授权后重新隐藏并拒绝读写。报告见 `test-results/editor-ecosystem*.json`，截图见 `docs/screenshots/editor/extension-settings.png`。既有远程场景使用实际 Storage 子进程中的受控 HTTPS 响应，不代表真实公网托管验收。

设置定义改变时，可使用 [声明式数据迁移与恢复](EXTENSION-DATA-MIGRATIONS.md) 显式映射字段。预览及确认都由核心执行，原始设置先备份再迁移；恢复旧设置后，表单重新检查兼容性并支持再次迁移。
