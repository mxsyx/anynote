# 插件公网端点验收

[返回账号任务入口](02-account-validation.md) · [返回总入口](../../TODO.md)

更新：2026-10-24。已补齐公网场景服务、真实 Electron 验收脚本及本地回归；尚缺受控公网资源，A010 保持未完成。

## 执行边界

- 资源：可控公网 HTTPS 服务、域名/证书，以及可配置 DNS/地址异常、延迟、撤销和超预算响应的环境。需要服务管理权限，不表示客户端必须输入密码。
- 本组不依赖Cloudflare 验收或签名身份，可在公网环境就绪后独立执行。
- 先按现有 QuickJS 插件网络声明与授权协议准备端点场景，再执行真实桌面访问并记录拒绝原因和资源预算；本地 fixture 通过不替代公网结果。

## 任务

<a id="a010"></a>

### A010 · 插件网络真实端点验收

- [ ] **P1 — 插件网络真实端点验收**：使用受控公网 HTTPS 服务验证证书/主机名、DNS/实际地址、超时、撤销和响应预算；现有 Electron 受控 DNS/HTTPS fixture 不作为公网端点验收。

## 资源与验收入口

- [公网部署、场景与证据说明](../PLUGIN-NETWORK-ACCEPTANCE.md)、`scripts/plugin-network/config.example.json`、`pnpm run test:plugin-network`。
- 实际链路：桌面 IPC → `runExtensionCommand` → QuickJS 网络代理 → `safeDownload`；本地回归为 `tests/script-network.test.mjs` 和 `tests/plugin-network-acceptance.test.mjs`。[首方扩展宿主](../EXTENSION-HOST.md)的专项测试不覆盖该公网链路。
- 域名、证书和公网服务控制权需由有权限的负责人提供；资源可用前可准备脚本与预期结果。

## 本次交接

- 已实现：14 个场景，包含证书/主机名、DNS/实际连接地址、超时、建连后撤权、响应预算及异常后恢复；逐次保存独立报告，缺配置或失败均返回非零退出码。
- 本地证据：`pnpm exec vitest run tests/plugin-network-acceptance.test.mjs tests/script-network.test.mjs`，24 项通过；本机 HTTP/TLS 服务只验证脚本，不计公网通过。
- 资源门槛验证：未配置端点时报告为 `blocked`，见 `test-results/plugin-network/741e4ae1-5bbc-4083-a4db-4f76ee6fbdcc.json`。
- 桌面失败路径：Linux / Electron 41.9.1，使用保留的 `.invalid` 域名执行完整 IPC 安装、授权、命令、卸载流程；仅 NXDOMAIN 场景通过，其余场景均未被误判为通过，整体 `failed`、退出码 1，清理成功。报告为 `test-results/plugin-network/7a894bf4-50dc-4bb3-87a9-5cc8cfc6046f.json`；这不是公网验收。
- 工程验证：`pnpm run build`、本次新增脚本及测试的 ESLint、Prettier 检查通过；构建仍有既有大分块提示。
- 阻塞：尚未提供受控公网域名、公共证书、错误证书/主机名服务以及私网、混合、NXDOMAIN DNS 场景；未执行真实公网验收。
- 下一步：负责人按专项说明部署服务并提供非敏感配置路径，执行 `pnpm run test:plugin-network`；保留部署/DNS 配置证据与全部场景报告后再决定勾选 A010。

收尾：按[统一完成与交接规则](02-account-validation.md#handoff)更新本文件复选框、阻塞原因、下一步和证据；部分通过保持未完成，完成后归档并同步入口。
