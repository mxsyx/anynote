# 受限异步宿主搜索

日期：2026-10-04。

受限第三方脚本现在可以等待宿主执行当前 Notebook 的声明式搜索。接口为 `await host.search(queryId)`，只有清单中明确列出的查询可以执行。每次请求和最终提交都复核安装、来源信任、Notebook 授权、启用状态、当前笔记版本及当前库知识变更序号。

## 使用

安装 [异步相关阅读索引](../packages/plugin-sdk/src/examples/reading-async-related.json)，审核查询与每次调用的数量上限，授权当前 Notebook 后从命令面板执行「追加异步相关阅读索引」。命中标题和短片段被追加到当前笔记。撤销授权、停用、卸载、更新或服务关闭会取消在途执行。

```json
{
  "kind": "transformMarkdown",
  "asyncSearch": [{ "id": "reading", "query": "阅读记录", "limit": 5 }],
  "script": "async (note, host) => { const matches = await host.search('reading'); return note.body + '\n\n' + matches.results.map(r => r.title).join('\n'); }"
}
```

查询声明仍需 `notes:read`、`notes:write`、`search:read`；有状态命令另需 `settings:read`、`settings:write`。一个命令可声明 1–4 个唯一查询 ID，ID 为 1–40 个小写字母、数字或连字符，首字符为字母。每次执行累计最多 4 次调用、最多 1 个在途请求。重复查询也计入调用预算。未声明 ID、非字符串参数、超额或并行调用会使整个执行失败，即使 guest 捕获异常也不能提交。脚本结束前必须等待已发起请求完成，不支持后台搜索。

## 宿主边界与一致性

QuickJS guest 接收冻结的能力对象，搜索桥接为 `search`；若另声明网络请求，则还提供 `request`，见 [网络代理](SCRIPT-NETWORK-PROXY.md)。可信 Worker 将查询 ID 通过消息传给宿主；授权核对与查询进入现有知识队列，查询返回只包含验证过的 JSON 副本。guest 不获得 Node 对象、SQL、文件句柄、模块加载器、网络、凭据或其他 Notebook 能力。原有同步命令仍使用原有同步返回协议，未声明 `asyncSearch` 或 `networkRequests` 时不传入宿主对象；仅声明静态 `searchContext` 的命令也不会自动获得异步调用。

查询词及数量来自安装时审核的清单，不接受 guest 任意查询字符串。字段、全文索引、排除规则和每次 32KiB 结果预算沿用 [搜索上下文](SCRIPT-SEARCH-CONTEXT.md)：排除当前笔记、目录、回收站和其他 Notebook；只返回 ID、标题、revision、笔记类型和最多 512 字符片段。四次调用最多返回 128KiB JSON；无资源原件或完整笔记读取能力。

准备阶段绑定当前库知识变更序号。请求执行前及提交前，当前 Notebook 的任何知识写入都会使任务失效，未使用查询也采用此保守检查；其他 Notebook 的修改不影响该序号。失败不写入正文、状态或操作回执。有状态异步命令仍返回严格的 `{body, state}`，正文、状态和回执在同一事务提交；原有未知块保留检查与幂等重试规则保持。

## 执行预算和取消

沿用每服务/进程最多两个脚本 Worker、总耗时 2 秒、guest 执行阶段累计 250ms、QuickJS 堆 64MiB 和栈 256KiB 的限制。累计执行时间按求值及待处理 Promise jobs 的墙钟测量，不是精确 CPU 计费；宿主等待不消耗这部分时间，但计入 2 秒总耗时。Promise jobs 分批运行并让出 Worker 事件循环，拒绝、超时或取消后终止 Worker，实际终止后释放并发槽位。迟到响应被忽略，不启动后续调用或写入。

实现遵循 [QuickJS 官方 Promise 生命周期与 pending jobs 说明](https://github.com/justjake/quickjs-emscripten#promises)，在可信侧创建 guest Promise 并显式驱动 jobs，释放结果和未完成的句柄。SQLite FTS 查询仍为同步操作，没有单条 SQL 的精确 CPU 中断；查询或宿主事件循环阻塞可能延迟超时处理，不承诺 SQL 查询本身的硬实时截止。队列检查和结果预算不能替代这一限制。此搜索接口不支持动态自由查询；固定 HTTPS 请求见 [网络代理](SCRIPT-NETWORK-PROXY.md)。它不提供任意宿主 API、第三方 React 或系统权限。

## 独立开发与试运行

SDK 导出 `ScriptAsyncSearchRequest`、`ScriptHostAPI`，原有 `ScriptSearchContext` 为返回类型。开发工具 fixture 必须提供所有声明 ID 的 `asyncSearch` 映射，不接受缺项、多余 ID、不同查询、超过声明数量、重复笔记 ID或当前笔记自身。

```json
{
  "note": {
    "id": "11111111-1111-4111-8111-111111111111",
    "title": "当前笔记",
    "body": "原文",
    "revision": 1
  },
  "asyncSearch": {
    "reading": {
      "query": "阅读记录",
      "truncated": false,
      "results": [
        {
          "id": "22222222-2222-4222-8222-222222222222",
          "title": "阅读记录示例",
          "revision": 1,
          "noteType": "markdown",
          "snippet": "本地示例内容"
        }
      ]
    }
  }
}
```

工具仅模拟声明的 fixture，不查询真实 Notebook、不授予设备权限。同步、静态上下文和异步命令可共存；新增清单字段会使旧客户端明确拒绝安装，需要使用支持此能力的桌面版本。

## 验证

专项覆盖清单权限和预算、guest 无宿主原型能力、串行次数、并行与未等待请求拒绝、等待与 CPU 预算分离、超时/取消释放槽位、迟到响应、当前库/跨库隔离、有状态原子与幂等、并发变更拒绝、撤销/卸载/关闭及 fixture 完整性。真实桌面流程验证异步查询审核、授权、结果渲染、未知块保留和撤销后命令移除，使用独立临时 Notebook。

报告：生产构建、Linux 打包应用。截图：`docs/screenshots/editor/extension-async-search.png`。

本次完整回归 195 项通过（异步宿主专项新增 10 项）；严格 TypeScript 构建、独立 SDK 离线类型/运行验证、四种独立开发工程及静态/异步搜索 fixture、Linux 应用目录打包均通过。生产构建与最新 Linux 打包应用各 21 项编辑器/扩展流程、27 次自动无障碍扫描通过，违规为零；工具包报告共 6 项检查通过。四份桌面归档报告、工具报告与异步查询审核截图已更新。
