# 插件公网端点验收

A010 使用真实 Electron Storage 进程执行已安装 QuickJS 插件，经过桌面 IPC、Notebook 授权、脚本执行器和生产 `safeDownload`。首方 `utilityProcess` 扩展宿主是另一条链路，`test:extension-host` 不替代本项。

## 公网资源准备

由资源负责人提供独立测试域名、证书及服务管理权限。端点不得承载真实笔记、账号凭据或业务数据。

1. 将 `scripts/plugin-network/service.mjs` 部署到受控公网主机，以域名匹配、受公共 CA 信任的完整证书链监听 **443**。脚本只依赖 Node 内置模块，服务版本为 `anynote-public-network-v1`。
2. 准备另一个 HTTPS 服务，使用不受信任的自签名证书；再准备一个域名指向正常服务，但保留不匹配该域名的证书。证书主机名测试不能与不受信任证书测试合并。
3. 在可控 DNS 中配置仅私网地址、同时含公网与私网地址、NXDOMAIN 三类域名。混合 DNS 必须在客户端实际解析结果中保留两类地址；若 DNS 服务或本地解析器过滤了私网记录，报告应失败，需调整测试环境。
4. 正常域名的所有 A/AAAA 记录必须可用且为公网地址；客户端不支持在 URL 中指定自定义端口。服务无需登录，插件仅发固定 GET，不携带凭据或笔记正文。

服务启动示例（证书由资源负责人在服务器上配置，私钥不写入仓库）：

```sh
ANYNOTE_NETWORK_TLS_CERT=/secure/fullchain.pem \
ANYNOTE_NETWORK_TLS_KEY=/secure/privkey.pem \
PORT=443 node scripts/plugin-network/service.mjs
```

也可经 TLS 反向代理部署，但必须保留流式响应、`Content-Length`、302 状态和 5 秒延迟，关闭缓存、压缩和响应缓冲。代理的证书必须分别满足正常、不受信任、主机名不匹配三种场景。

复制 `scripts/plugin-network/config.example.json` 到本地配置文件，替换 `serviceId`、`serviceVersion` 及全部六个端点。URL 是场景服务的目录前缀，使用 `/` 结尾；不放查询参数、Token 或用户信息。示例域名是占位符，不能直接用于验收。

## 运行及证据

```sh
ANYNOTE_PLUGIN_NETWORK_CONFIG=/absolute/path/network-config.json \
pnpm run test:plugin-network

# 已构建的目录或发行产物：
ANYNOTE_PLUGIN_NETWORK_CONFIG=/absolute/path/network-config.json \
ANYNOTE_EXECUTABLE=/absolute/path/anynote \
node scripts/plugin-network-acceptance.mjs
```

桌面必须可启动并连接显示服务。脚本使用临时 Notebook 和独立用户目录，结束后关闭桌面并删除测试数据。测试不向真实知识库安装插件。不能设置 `NODE_OPTIONS`、`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`SSL_CERT_DIR` 或 `NODE_TLS_REJECT_UNAUTHORIZED=0`，以免改变证书验收条件。

| 场景                                    | 预期                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| 正常文本、JSON、16 KiB 边界             | 返回准确内容并仅增加一次正文版本                         |
| 声明长度 16385 字节、无长度的流式超预算 | 拒绝，正文及版本不变                                     |
| 302 重定向                              | 拒绝，不请求目标地址                                     |
| 5 秒延迟                                | 由插件 1500ms 网络期限拒绝，不能把脚本总期限超时当作通过 |
| TLS 建连后撤销 Notebook 授权            | 请求取消，正文及版本不变                                 |
| 自签名证书、主机名不匹配                | 分别记录对应 TLS 拒绝原因                                |
| 私网 DNS、混合 DNS、NXDOMAIN            | 连接前拒绝，记录客户端实际 DNS 结果或错误                |
| 异常后的正常请求                        | 成功，确认执行与网络并发配额可再次使用                   |

报告为 `tmp/reports/plugin-network/<runId>.json`，每次独立保存，不覆盖此前证据。记录 UTC 时间、Git 提交及工作区是否有改动、桌面/Electron/Node 版本、服务标识、端点、各场景拒绝原因、耗时、内存快照、DNS 记录、实际 socket 地址、TLS 版本/证书指纹、响应字节和中止事件。公网实际地址必须与本次 DNS 记录匹配；私网实际 socket 的注入拒绝仍由本地 `tests/script-network.test.mjs` 覆盖，不伪称公网已注入该异常。

观察器仅在验收调试会话包装原始 DNS/HTTPS 调用并记录事件，不替换解析结果、证书校验、连接或响应，也不增加生产旁路。内存快照用于诊断，不代表已经证明进程内存峰值上限；流式超预算时已到达的单个数据块可能超过 16 KiB，验收要求拒绝提交，而非声称网络栈从未接收额外字节。

所有场景通过才输出 `passed`；配置缺失或不合法为 `blocked`，实际运行失败为 `failed`，后二者退出码均为 1。服务部署版本和域名/DNS 管理证据需负责人连同报告保存；仅有正常站点请求成功不足以完成 A010。

## 本地回归

```sh
pnpm run build:backend
pnpm exec vitest run tests/plugin-network-acceptance.test.mjs tests/script-network.test.mjs
```

新增测试验证场景完整性、证据判定、HTTP 场景响应以及真实本机 TLS 连接的无替换观察；TLS 测试需要 `openssl`，临时生成并清理测试证书。本地回环服务、临时证书及单元测试都不属于公网验收证据。
