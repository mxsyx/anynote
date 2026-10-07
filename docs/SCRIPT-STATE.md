# 受限脚本的 Notebook 状态

`quickjs-transform` 增加 `transformMarkdownWithState` 命令。扩展必须同时声明 `notes:read`、`notes:write`、`settings:read`、`settings:write`，并在每个 Notebook 明确授权全部声明权限。原有 `transformMarkdown` 仍只接收当前笔记并返回正文字符串；即使同一个扩展同时贡献两种命令，普通命令也不接收状态。

示例见 [阅读整理记录](../packages/plugin-sdk/src/examples/reading-session.json)。在扩展页选择 JSON、审阅源码与四项权限、确认安装并授权当前 Notebook，再从命令面板执行“记录一次阅读整理”。计数在同一 Notebook 的多篇笔记之间共享，不跨 Notebook 或扩展命名空间共享。

```js
(note) => ({
  body: note.body + "\n\n已完成一次整理。\n",
  state: { runs: (note.state.runs || 0) + 1 },
});
```

输入为当前笔记的 `{id,title,body,revision,state}` JSON 快照；首次状态是 `{}`。输出必须同步返回恰好包含 `body` 与 `state` 两个字段的普通对象。`body` 是原始字符串；`state` 是普通 JSON 对象，允许嵌套数组、字符串、有限数字、布尔和 null。状态不能包含函数、Promise、BigInt、undefined、访问器、符号、稀疏数组或循环引用，最大 64KiB UTF-8 JSON、16 层嵌套和 4096 个值。状态在解释器内按捕获的内建操作序列化，并由可信 Worker 和后端再次校验；guest 的 `toJSON` 或原型修改不会改变宿主输出封装。

公开 SDK 导出 `ScriptStateValue`、`ScriptState`、`StatefulMarkdownTransformInput` 和 `StatefulMarkdownTransformResult` 类型。SDK 离线包包含示例，仍不包含 Worker、解释器或存储实现。新增命令沿用 [受限脚本运行边界](SCRIPT-RUNTIME.md)，没有 Node、DOM、网络、文件、定时器、模块加载器或宿主回调，不能选择其他笔记、Notebook 或状态 key。

## 提交与恢复

状态保存在当前 Notebook 的 `extension_data` 中，扩展 ID 是独立命名空间，固定 key 为 `script:state`，`schema_version=1`。脚本只读取这个对象，不能读取启用标志、其他扩展状态或命令回执。其内容属于知识数据，随现有完整归档和知识备份保留；不保存到设备配置。停用或卸载扩展保留状态和正文，恢复 Notebook 后仍需重新授权。

执行准备记录笔记版本和状态 revision。解释器运行期间释放知识库队列；提交时重新检查安装校验值、来源信任、全部权限、启用状态、笔记版本及状态 revision。另一篇笔记先更新同一扩展状态时，旧计算被拒绝，不覆盖新状态或旧笔记。正文、状态、不可变笔记历史与幂等操作回执在同一事务提交，失败全部回滚。相同 operationId 重试复用既有结果，不重复计数。并发冲突需重新执行，不自动合并状态。

已有未知扩展块仍须按原文与数量保留；状态命令不能借此删除或修改未知正文。撤销、停用、更新、卸载、关闭服务取消在途命令。未知 `schema_version` 被拒绝且原始状态保留，不做隐式迁移；尚未提供第三方状态迁移脚本或状态编辑表单。

该能力扩展了受限命令宿主，不开放任意 React/JS 模块、异步宿主 API、网络代理或中央市场。

## 验证记录（2026-10-04）

完整回归 142 项通过，新增专项 8 项覆盖权限/签名/目录合约、JSON 与解释器边界、幂等和命名空间、重启及归档、跨笔记状态并发、正文并发与未知块保护、事务回滚、未知 schema 拒绝及撤销取消。严格 TypeScript 编译、SDK 干净离线消费及 Linux 最终打包通过。

生产构建与 Linux 打包应用各通过 16 项编辑器/扩展流程、15 次无障碍扫描，零违规。有状态场景使用实际桌面命令执行两次，核对持久化计数与原始扩展块，再撤销并卸载，确认状态保留；内部状态操作仍不允许 Renderer 直接调用，测试从临时数据库只读核对。报告见 `test-results/editor-ecosystem*.json`，截图见 `docs/screenshots/editor/stateful-script.png`。既有更新检查仍等待实际应用定时器，远程场景使用受控 HTTPS 响应，不代表真实公网托管验收。

状态命令现可声明 `contributes.stateVersion`（默认 1），并通过 [声明式数据迁移与恢复](EXTENSION-DATA-MIGRATIONS.md) 升级旧数据。迁移及恢复均保存原始副本，成功提交取消在途命令；恢复旧版本不会隐式运行不兼容脚本。
