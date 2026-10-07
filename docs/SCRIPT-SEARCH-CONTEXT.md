# 受限脚本搜索上下文

日期：2026-10-04。

第三方正文转换命令现在可以声明当前 Notebook 的只读搜索上下文。宿主在执行前查询现有全文索引，向 QuickJS 传入数据快照；guest 不获得宿主函数、SQL、文件句柄或其他 Notebook 的访问能力。此项补齐受限宿主能力的一部分，后续已加入[受限异步宿主查询](SCRIPT-ASYNC-HOST.md)，固定 HTTPS 网络代理见 [SCRIPT-NETWORK-PROXY.md](SCRIPT-NETWORK-PROXY.md)。

## 使用与授权

安装 [相关阅读索引](../packages/plugin-sdk/src/examples/reading-related.json)，审核查询「阅读记录」与最多 5 条的范围，授权当前 Notebook，然后从命令面板执行「追加相关阅读索引」。它将命中标题与短片段追加到当前 Markdown 笔记，正文中的未知块仍须原样保留。

```json
{
  "kind": "transformMarkdown",
  "searchContext": { "query": "阅读记录", "limit": 5 },
  "script": "(n) => n.body + '\n\n' + n.searchContext.results.map(r => r.title).join('\n')"
}
```

清单必须同时声明 `notes:read`、`notes:write` 和 `search:read`。没有搜索声明时拒绝额外申请 `search:read`，普通命令不会收到搜索数据。授权仍是对当前 Notebook 的完整清单授权；新增查询或改变范围会改变安装摘要，更新后需重新审核及授权。安装页展示每个命令的查询词、数量及当前库范围。目录和签名制作工具使用相同权限与清单校验。

## 数据范围和一致性

`input.searchContext` 包含 `query`、`truncated` 和 `results`。每条结果仅有 `id`、`title`、`revision`、`noteType`、`snippet`，没有完整正文、资源字节、设备凭据、数据库路径或 Notebook 列表。搜索排除当前笔记、目录、回收站和其他 Notebook；全文索引已收录的 PDF 文本及批注也可产生短片段。结果按更新时间降序、ID 排序。

查询是固定文字短语，不展开 FTS 运算符或 SQL。去除首尾空白后至少 3 个 Unicode 字符，最多 100 个 JavaScript 字符，不含控制字符；每次 1–20 条，标题最多 240 字符，片段最多 512 字符，整个 JSON 快照最多 32KiB。索引查询使用现有 SQLite FTS，不提供精确 CPU 超时；guest 继续受既有执行、内存和并发预算限制。资源内容读取及扫描 PDF OCR 不属于此能力。

准备阶段读取当前库知识变更序号，运行期间释放知识队列。提交再次检查安装、信任、授权、启用状态、笔记版本和变更序号。当前 Notebook 的任何知识写入都会使旧上下文失效，包括未命中的笔记修改；这是保守检查，避免新增命中、删除或索引变化遗漏。其他 Notebook 的修改不影响此序号。发生冲突时不写入正文、状态或命令回执，重新执行获取新上下文。成功提交沿用正文/状态/回执的同一事务和幂等重试规则。

guest 可以改变自己拿到的 JSON 副本，不能改变宿主记录。搜索结果属于笔记资料，不会被当作权限或宿主指令执行。静态上下文本身不提供 guest 发起的动态搜索、跨库搜索或完整笔记读取；可等待的声明式宿主查询见[异步宿主搜索](SCRIPT-ASYNC-HOST.md)。

## 开发工具试运行

`anynote-extension run` 的 fixture 需显式提供 `searchContext`，查询必须与声明一致、条数不得超过声明 limit、ID 不重复且排除当前笔记。例如：

```json
{
  "note": {
    "id": "11111111-1111-4111-8111-111111111111",
    "title": "当前笔记",
    "body": "原文",
    "revision": 1
  },
  "searchContext": {
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
```

工具只验证和执行这些示例数据，不搜索真实 Notebook、不授予设备权限。SDK 导出 `ScriptSearchRequest`、`ScriptSearchContext` 和可选输入字段；独立 SDK 包仍不包含执行宿主。

## 验证

专项测试覆盖声明与权限匹配、跨库和回收站隔离、最小结果投影、字节预算、FTS 字面短语、幂等、当前库并发变化拒绝、普通命令不泄露上下文、有状态事务提交以及开发工具示例校验。真实桌面验收使用独立临时 Notebook，审核范围、授予权限、执行命令并验证其他库数据未出现，撤销后移除命令入口。

报告：生产构建、Linux 打包应用。截图：`docs/screenshots/editor/extension-search-context.png`。

本次完整回归 185 项通过（新增搜索上下文专项 9 项）；严格 TypeScript 构建、独立 SDK 离线消费、四种开发工具工程及新增搜索 fixture 的离线重复试运行、Linux 应用目录打包均通过。生产和最新 Linux 打包应用各 20 项编辑器/扩展流程、25 次自动无障碍扫描通过，违规为零。界面场景覆盖搜索范围审核、当前库授权、命中内容追加、跨库隔离和撤销后命令移除；四份归档报告、工具包报告和审核截图已更新。
