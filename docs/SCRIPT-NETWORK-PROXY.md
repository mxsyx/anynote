# 受限插件网络代理

2026-10-04 实现。正文转换脚本可通过 `await host.request(requestId)` 取得安装时声明的固定 HTTPS 文本或 JSON。宿主不自动附带笔记正文、设置或凭据；guest 没有 fetch、Node、文件、DOM 或通用 HTTP 客户端。

## 声明与授权

```json
{
  "permissions": ["notes:read", "notes:write", "network"],
  "action": {
    "kind": "transformMarkdown",
    "networkRequests": [
      { "id": "reference", "url": "https://example.com/anynote-demo.txt" }
    ],
    "script": "async (note, host) => { const response = await host.request('reference'); return note.body + '\\n\\n' + response.text; }"
  }
}
```

以上为清单片段；完整示例见 [reading-network.json](../packages/plugin-sdk/src/examples/reading-network.json)。地址是占位示例，使用前需替换为能在预算内返回资料的公开服务。示例没有部署对应端点。

每个命令声明 1–4 个唯一请求 ID，每个 ID 最多 40 字符，由小写字母开头，后续允许数字和连字符。`network` 必须与实际请求声明一致，未使用的权限也拒绝安装。声明式模板扩展不支持此权限。

安装审核展示请求 ID、域名及完整 GET URL；来源信任与当前 Notebook 的网络授权分别确认。更新内容改变后重新授权。guest 仅能传入声明的 ID，不能选择任意 URL、方法、请求头、请求体或额外查询参数。静态 URL 自身包含的查询参数会原样发送，勿在清单中存放秘密。

服务会收到设备 IP 和访问时间。脚本可以根据输入选择声明 ID 或请求时机，因此这种授权仍允许有限的外部可观察行为；不能据此承诺绝对无信息外泄。已发送请求无法撤回，失败或撤销仅阻止后续请求及本地提交。

## 传输与预算

- 仅 HTTPS、默认 443 端口、无用户名密码、无片段的固定 DNS 域名；拒绝 IP 字面量、单标签名称和通配符。
- DNS 的全部结果必须为允许的公网地址；连接使用已核对地址，并核对实际 socket 地址。独立连接 `agent: false`，显式 `rejectUnauthorized: true`，采用 HTTPS 的证书与主机名校验。底层选项参考 [Node HTTPS 文档](https://nodejs.org/api/https.html#httpsrequesturl-options-callback)，解析结果语义参考 [Node 24 DNS 文档](https://nodejs.org/docs/latest-v24.x/api/dns.html#dnspromiseslookuphostname-options)。
- GET 请求只带固定 User-Agent 与 Accept，不使用 Cookie、Authorization、Provider 密钥或代理环境配置；不跟随重定向，只接受 HTTP 200。
- 原始响应最多 16KiB，仅接受 `text/plain` 或 `application/json`，声明字符集时须为 UTF-8，严格拒绝无效 UTF-8。返回 `{url, mime, text}`，序列化 DTO 最多 32KiB；JSON 以字符串交给 guest，没有自动解析、HTML 执行或解压。
- 单次请求最多 1500ms，网络代理每进程最多两项并发。搜索和网络共享每次脚本最多四次调用、一次一个在途请求的预算；重复调用也计数。
- 脚本沿用两个 Worker、2 秒总耗时、guest 执行阶段累计 250ms、64MiB 堆和 256KiB 栈。等待计入总耗时，不计入 guest 执行阶段预算；调度阻塞可能延迟取消，不承诺硬实时截止。

网络等待在知识库队列之外进行，本地编辑仍可提交。调用前后以及最终提交重新检查安装、授权、笔记 revision 和取消状态；声明搜索的组合命令还检查当前库知识变更序号。有状态命令仍将正文、状态、幂等回执原子提交。撤销、卸载、关闭、冲突或执行结束会取消在途传输，迟到结果不能覆盖笔记。

网络执行本身不是可回滚事务，远程 GET 服务也可能产生服务端日志或其他效果。不支持后台请求，guest 必须等待已发出的 Promise；超额、并行或未声明调用会使整个执行失败。

## SDK 与离线试运行

公开 SDK 导出 `ScriptNetworkRequest`、`ScriptNetworkResult`、`ScriptNetworkAPI`；同时使用搜索时可声明 `ScriptHostAPI & ScriptNetworkAPI`。SDK 不包含设备网络实现或 SQLite 宿主。

开发工具要求提供每个声明 ID 的 `fixture.network`，严格核对 URL、MIME、字节预算和 ID 集合，只返回本地数据，不访问公网：

```json
{
  "note": {
    "id": "11111111-1111-4111-8111-111111111111",
    "title": "当前笔记",
    "body": "原文",
    "revision": 1
  },
  "network": {
    "reference": {
      "url": "https://example.com/anynote-demo.txt",
      "mime": "text/plain",
      "text": "离线网络资料"
    }
  }
}
```

运行方式沿用 [扩展开发工具](EXTENSION-DEVELOPMENT.md)。动态 URL、用户凭据、任意方法/头/正文、通用第三方 React 宿主和 Provider 注册仍未开放。

## 验证范围

专项覆盖权限/清单、私网及混合 DNS、连接地址校验、重定向拒绝、响应大小/MIME/UTF-8、超时/取消/并发、授权撤销、卸载、关闭、并发编辑、幂等回执、组合调用预算及离线 fixture。桌面验收使用真实 Storage 子进程中的受控 DNS/HTTPS 响应；这验证实际代理调用路径，不代表真实公网端点、证书服务或部署验收。

报告见生产构建、Linux 打包应用、工具包。审核截图见 `docs/screenshots/editor/extension-network.png`。

本次最终验证：完整回归 218 项通过（网络代理专项 23 项）；严格 TypeScript 构建、SDK 干净离线类型/运行消费、独立开发工具包 7 项检查及 Linux 应用目录打包均通过。生产版与最新 Linux 打包版各 22 项编辑器/扩展流程、29 次自动无障碍扫描通过，违规为零。网络桌面场景采用真实 Storage 子进程中的受控 DNS/HTTPS 响应，覆盖域名/URL 审核、授权、结果与未知块保留及撤销后的请求拒绝；未进行真实公网服务或证书端点验收。四份桌面报告、工具包报告及网络范围截图已更新。
