# Rust 内置下载服务公网验收

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 当前状态与资源

Cloudflare DNS 可以配置本项记录；Worker 或代理边缘统一提供的受信任 TLS 不能覆盖可控自签名证书场景。后续需要一个能控制 443/TLS 的临时公网服务，至少两个可用公网地址（同机双地址或两台服务）用于多记录与完整地址变更。所有地址上运行相同场景服务及有效证书。无需接触 RM34 的 Worker/D1/R2 或老化命名空间。

建议使用以下独立子域名，均配置为 **DNS only**，保留 Cloudflare 实际 DNS 配置导出、操作人及变更时间：

| 配置键               | mxsyx.site 子域名         | 条件                                                     |
| -------------------- | ------------------------- | -------------------------------------------------------- |
| public               | ok.rm35.mxsyx.site        | 公网 A/AAAA，受公共 CA 信任且匹配主机名的证书            |
| untrustedCertificate | untrusted.rm35.mxsyx.site | 公网地址，主机名匹配但不受信任的自签名叶证书，`CA:FALSE` |
| hostnameMismatch     | mismatch.rm35.mxsyx.site  | 公网地址，使用正常服务证书；SAN 必须排除本主机名         |
| privateDns           | private.rm35.mxsyx.site   | 仅 `10.0.0.1` 等私网记录                                 |
| mixedDns             | mixed.rm35.mxsyx.site     | 同时配置正常公网地址和私网地址；客户端解析必须保留两者   |
| missingDns           | missing.rm35.mxsyx.site   | 真实域名下不存在的记录；避免 wildcard DNS                |
| multipleDns          | multiple.rm35.mxsyx.site  | 至少两个不同的可达公网地址，全部证书匹配                 |
| changingDns          | changing.rm35.mxsyx.site  | 首轮地址 A，第二轮完整切换到不相交的地址 B，证书保持相同 |

不能使用包含 `mismatch.rm35.mxsyx.site` 的 wildcard 证书充当错误主机证书。不要开启会过滤私网 DNS 记录的解析器防护来执行混合记录验收；若实际结果被过滤，批次会失败，不能删掉断言。实际连接只使用每次解析所得的第一个地址；多记录场景证明整组记录均被校验，并不声明探测每个地址的可用性或实现地址故障回退。

## 服务部署

复用旧 `scripts/plugin-network/service.mjs` 的文本/JSON/重定向 fixture，新服务增加请求凭据拒绝、流式预算、HTML/视频元数据、慢响应和重定向边界：

```sh
ANYNOTE_NETWORK_SERVICE_ID=rm35-mxsyx-site \
ANYNOTE_NETWORK_TLS_CERT=/secure/fullchain.pem \
ANYNOTE_NETWORK_TLS_KEY=/secure/privkey.pem \
PORT=443 node scripts/network/service.mjs
```

Node 主入口加载一个证书对。多种证书可以分别部署到不同公网地址，或者由可控 TLS 反向代理按 SNI 选择证书并转发到场景服务；不要将自签名端点套在 Cloudflare 代理后面。代理必须保留 302、Set-Cookie、Content-Length、无长度流式响应和 12 秒延迟，禁用缓存、压缩及响应缓冲。

服务无管理 API，只有固定 GET 场景。可选 `size` 查询参数限制为 1–1048577 字节；非 GET 和 Cookie/Authorization/Proxy-Authorization/Referer 均被拒绝，且不会回显其值。运行标识只用于关联日志，不发送实际笔记或账号数据。

## 配置与证据

复制 `scripts/network/config.example.json`，替换所有域名及 serviceId。`deploymentEvidence` 相对配置文件目录解析，内容示例：

```json
{
  "operator": "实际部署操作人",
  "server": "服务器标识、公网地址与平台版本",
  "dnsChangeProcedure": "初始/变更后完整 A/AAAA 集合、TTL、执行时间和配置导出位置",
  "certificateFingerprints": {
    "public": "64位小写SHA256",
    "untrustedCertificate": "64位小写SHA256",
    "hostnameMismatch": "64位小写SHA256",
    "multipleDns": "64位小写SHA256",
    "changingDns": "64位小写SHA256"
  }
}
```

证书指纹使用叶证书 DER 的 SHA256（无冒号），公共端点的实际指纹必须与部署记录一致。私钥不进入配置、仓库或报告。补充保存证书公开信息、DNS 配置导出和服务器访问/连接关闭日志；部署记录是资源证据，不作为网络请求成功的替代。

```sh
# 首轮所有场景成功时为 waiting_dns_change，退出码 1，不能记为通过。
node scripts/rust-network-acceptance.mjs /absolute/path/config.json

# 完整更换 changingDns 地址，等待真实解析器缓存更新；不改时钟、不注入 DNS。
node scripts/rust-network-acceptance.mjs /absolute/path/config.json \
  --dns-baseline /absolute/path/first-report.json
```

两次必须使用同一配置、部署记录与 Rust 探针二进制。最终批次重新执行所有场景，要求变更前后解析地址集合不相交、实际响应地址属于本轮固定地址。只有全部通过才输出 `passed` / 退出码 0。配置或资源证据缺失为 `blocked`，执行/断言失败为 `failed`，首次完成为 `waiting_dns_change`，均退出码 1。模板、`.invalid`、`.test`、localhost、IP literal、凭据 URL 和自定义端口不能作为公网端点配置。

入口每次 `cargo build --locked`，自动读取 Cargo target 目录；记录源码提交、dirty 状态、rustc、二进制与部署记录 SHA256、OS/架构、域名、每次 DNS、连接尝试、实际 HTTP 响应 peer、已验证证书指纹、接收字节、结果与耗时。设置不可用代理验证生产 `.no_proxy()`；不加载私有根证书或替换解析器/传输。报告独立保存于 `tmp/reports/rust-network/<UUID>.json`。原始报告及部署证据需另行归档，未完成范围与阻塞维护于 TODO。

## 断言与观测边界

75 个场景包括下载器身份、四条路径各 18 项（成功、安全重定向、Set-Cookie 后仍无凭据、精确预算、声明/流式超限、私网/凭据重定向、重定向循环、慢响应头/正文超时、响应头后的业务取消、两类证书失败、私网/混合/NXDOMAIN、异常后成功），另加多记录与地址变更。公开文本/视频使用原有 128 KiB/1 MiB、10 秒/6 秒预算；导入与直接下载使用 16 KiB 和可配置期限。网页失败后零笔记，公开文本失败后正文与修订不变；成功仅提交一次。

Rust 契约允许最多五次安全重定向，每一跳重新验证 DNS、固定地址及校验证书，不再采用旧插件“所有重定向都拒绝”的断言。视频通过普通 HTTPS 链接的真实 `VideoCard`/`video::fetch` 路径验证网络和解析；三家 provider 的真实播放及 WebView 仍属 RM32。

`network::observe` 是任务局部只读事件订阅，不替换生产 transport，退出作用域后自动移除；未安装观察器时不分配事件内容。`connect` 表示尝试连接，只有 `response.peer` 是实际响应 socket 地址。证书拒绝发生在 HTTP 响应前，reqwest 不提供此时的实际 peer/证书对象，报告保留完整错误源链，并结合部署证书证据；不会把 pinned 地址冒充实际连接。慢响应头超时同样没有 response peer，不宣称已观察到 TLS 建连。公共 TLS 协议版本当前未暴露，不伪造该字段。

取消通过真实响应头事件触发 CancellationToken，服务延迟正文以确保请求仍在进行。流式超预算允许网络栈已经收到超额 chunk，但不得写入超预算 sink 或提交业务内容。实际错误 peer 的拒绝仍由本地 `validate_peer` 测试覆盖，公网地址变更使用真实 DNS/连接；不声称公网制造了错误 socket。进程内存峰值、GUI、跨平台设备和发行验收不在此报告中。

## 本地验证与退役范围

```sh
cargo build --locked -p anynote-services --example network_probe
cargo test --locked -p anynote-services --lib --test builtin
node --test scripts/test-rust-network.mjs
cargo clippy --locked -p anynote-services --example network_probe -- -D warnings
```

本机 socket 测试需要允许回环监听。Node 回归验证服务实际响应、错误证据不能误判通过、配置门控和四条真实 Rust 业务的私网拒绝。Rust 回归覆盖地址策略/实际 peer、流式预算、超时/取消、sink 错误、TLS 错误源链和任务局部观测，并检查业务取消及缩略图阶段的取消不会返回成功。

旧 QuickJS 安装/授权撤销场景和 `test:plugin-network` 活跃入口退役；旧脚本只作为迁移参考，删除前核对消费者。业务取消、DNS/TLS、重定向、凭据与预算继续由新入口验证。任何本地 HTTP/TLS、模拟证据和 NXDOMAIN 单独结果都不计 RM35/F016 公网通过。
