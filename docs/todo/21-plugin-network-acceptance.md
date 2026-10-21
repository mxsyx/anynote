# G21 · 插件公网端点验收

[返回总入口](../../TODO.md)

类型：验收 / 实测。目标：真实 HTTPS、DNS/地址校验、超时/撤销/预算。

前置：可控公网 HTTPS 服务、证书和对应平台 Electron。

并行边界：与云盘/本地磁盘验收并行；测试端点与账号环境独立。

## 建议入口

- [packages/storage-sqlite/src/script-network.ts](../../packages/storage-sqlite/src/script-network.ts)
- [packages/plugin-sdk/src/script-network.ts](../../packages/plugin-sdk/src/script-network.ts)
- [docs/EXTENSION-HOST.md](../../docs/EXTENSION-HOST.md)

## 执行顺序

1. 准备证书/主机名/DNS/实际地址异常与延时、超预算响应场景。
2. 在真实 Electron 对公网服务执行并记录超时、撤销和响应限制。
3. 归档服务配置与客户端版本，回归发现的问题。

## 待办

### T051 · 原 §8

- [ ] **P1 — 插件网络真实端点验收**：使用受控公网 HTTPS 服务验证证书/主机名、DNS/实际地址、超时、撤销和响应预算；现有 Electron 受控 DNS/HTTPS fixture 不作为公网端点验收。

## 验证与完成条件

- [tests/extension-host.test.mjs](../../tests/extension-host.test.mjs)
- `pnpm run test:extension-host`
- 受控公网端点报告；本地 DNS/HTTPS fixture 不代替公网验收。

完成条件：每个公网场景有可复核报告；单纯 fixture 通过保持本条未完成。

人工 / 外部资源：提供受控服务、域名/证书和真实网络条件。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
