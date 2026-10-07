# 受限正文转换脚本

桌面扩展安装支持 `quickjs-transform` 运行方式。普通转换命令接收当前 Markdown 笔记的 `{ id, title, body, revision }` 快照，同步返回完整正文字符串，需显式授权 `notes:read` 与 `notes:write`。[有状态命令](SCRIPT-STATE.md) 另需状态读写权限，并原子提交正文和自身状态。宿主将结果写回原笔记，可声明[当前库搜索上下文](SCRIPT-SEARCH-CONTEXT.md)并另行授权 `search:read`，宿主提供标题和短片段快照；不允许脚本指定其他 Notebook、目标笔记、资源、SQL、路径或调用宿主 SDK。

## 使用

1. 在「扩展」页选择 [阅读整理脚本 JSON](../packages/plugin-sdk/src/examples/reading-transform.json)，检查完整脚本和读写权限，再确认安装。
2. 授权当前 Notebook，打开 Markdown 笔记，按 `Ctrl+K` 执行「追加阅读字数摘要」。
3. 宿主先保存当前草稿，脚本在独立解释器中处理快照；返回后验证清单校验值、授权、启用状态和笔记版本，再提交正文与操作回执。
4. 可在扩展页撤销当前 Notebook 授权。停用、更新、卸载也会取消在途任务，保留已提交的知识数据和历史。

示例入口是表达式函数：

```js
(note) =>
  note.body + "\n\n## 阅读统计\n\n正文字符数：" + note.body.length + "\n";
```

普通转换的 `action.kind` 必须是 `transformMarkdown`，源码放在 `action.script`；脚本扩展不贡献动态编辑器节点。安装不会执行源码，语法或返回类型错误在执行时提示。公开 SDK 提供 `ScriptManifest`、`ScriptCommand`、`MarkdownTransformInput` 类型；打包 SDK 不包含执行宿主、Worker、QuickJS 或其他运行依赖。

## 运行边界

Guest JavaScript 在 QuickJS/WASM 解释器内求值。可信 Node Worker 只负责加载解释器、传入 JSON 和取回字符串，只在声明异步能力时提供[受限 JSON 能力桥接](SCRIPT-ASYNC-HOST.md)，不暴露 Node 对象，也不配置模块加载器。[QuickJS 官方说明](https://github.com/justjake/quickjs-emscripten)介绍了独立 context、内存上限和中断接口；本项目另外使用 Worker 终止保护总耗时。Worker 负责响应性，guest 与宿主的分离由解释器承担，不把 Node Worker 本身称为权限沙箱。

- 无 Node、DOM、直接网络、文件、凭据、定时器及通用宿主 SDK 能力；异步命令可声明当前库搜索和固定 HTTPS 网络代理。guest 内部 `eval`/`Function` 仍在 guest 环境，不能取得宿主引用。
- 每次使用全新 Worker 与 QuickJS context，不复用 guest 全局或原型。失败后仍可再次运行。
- 源码最多 64KiB，整份清单最多 128KiB；最多 30 个命令，脚本节点贡献必须为空。
- Guest 执行阶段的时间中断预算为 250ms；异步命令累计计入求值与 Promise jobs 的执行时间，宿主等待不消耗这一预算。从创建 Worker 开始，总耗时上限 2 秒。时间中断按墙钟测量，并非精确 CPU 计费。
- QuickJS 堆上限 64MiB、栈上限 256KiB；Node Worker 配置 V8 old-generation 上限 64MiB 和栈 4MiB。WASM 与其他内存不计入 V8 heap；这些参数不是整个进程 RSS 上限。
- 每个服务最多两个在途脚本，同一进程最多两个脚本 Worker；超额请求提示稍后重试。直到 Worker 实际终止才释放槽位。
- 正文最多 2,000,000 个 JavaScript 字符；未声明 asyncSearch 或 networkRequests 的普通转换输出必须是同步、原始字符串，Promise、包装 String 和其他类型均拒绝；声明异步能力后允许等待 Promise，但最终结果仍须为原始字符串。有状态命令使用独立的严格 JSON 返回协议。

脚本执行期间不占用知识队列。授权变更能够及时取消任务；并发修改当前笔记会使旧结果版本冲突。结果提交重新排入知识队列，继续使用原有本地事务与幂等回执。操作 UUID 及其清单/笔记/版本条件必须匹配才可重试复用结果。

脚本必须原样保留原正文中每一个已识别扩展块，重复块按数量核对；可以移动这些块，不能更改或删除其未知字段。该保护不代表任意普通 Markdown 的语义无损转换。正文转换能力可改变普通正文，执行前可通过源码审阅选择扩展，执行结果保留在本地历史中。

清单和授权继续保存在设备目录，不随 Notebook 归档或云备份自动安装。校验值绑定审核版本，不是发布者签名。已加入可等待的声明式当前库搜索；未开放通用第三方 JS/React 模块、任意宿主 API、动态 URL 或凭据网络访问、原生模块或中央插件市场。签名分发和设备侧自动检查见扩展分发文档；本运行时未经过独立安全审计。

## 验证

```sh
pnpm test
pnpm run test:editor
pnpm run test:sdk:package
pnpm run package
ANYNOTE_EXECUTABLE=release/linux-unpacked/anynote node scripts/editor-ecosystem-smoke.mjs
```

新增 8 项合约检查：缺失宿主能力与原型隔离、死循环/内存/递归/非法输出、安装约束、授权与幂等、并发版本保护、六种撤销路径、未知块保护及并发槽位释放。真实桌面验收增加安装审阅、执行后阅读渲染和撤销授权；报告沿用生产页面和 Linux 打包版。这轮测试使用临时数据，不读取云凭据或访问真实云服务。

已有扩展块使用线性计数核对，重复的相同块也必须全部保留；测试包含只删除一个重复块时拒绝提交。

安装审阅页在显示前检查元数据格式并生成预览文本；无效字段和无法序列化的深层 JSON 显示错误，不执行源码。桌面测试覆盖无效名称对象被拒绝后仍可正常安装示例。

最终验收：109 项完整回归通过；生产页面和最终 Linux 打包版各 11 项编辑器流程、6 次无障碍扫描通过，违规为零；独立 SDK 离线安装、TypeScript 编译和运行验证通过。本轮较早构建的既有性能/界面复验 15 项、36 次扫描通过；随后只调整重复块计数与安装输入校验，并完成上述最终复验。
