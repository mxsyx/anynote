# 签名身份与发行凭据验收

[返回账号任务入口](02-account-validation.md) · [返回总入口](../../TODO.md)

更新：2026-10-24。由账号类 TODO 拆分；保留原编号、优先级及未完成状态，未重新运行功能验收。

## 执行边界

- 资源：Windows 代码签名身份、macOS 开发者身份、签名/公证凭据及真实 CI 配置权限。
- 凭据准备与 [F006](03-feature-logic.md#f006) 的本地实现可并行；真实签名/公证和更新产物身份验收须同时具备可用凭据与已完成的 F006 实现，不能把二者写成相互阻塞。
- A011 只维护身份与真实 CI 签名/公证证据，安装、升级和回退实机验收继续归 [V011](01-platform-validation.md#v011)。
- 本组与Cloudflare、插件公网组独立；CI/workflow 或打包脚本变更与 F006 统一安排，避免并发修改同一文件。

## 任务

<a id="a011"></a>

### A011 · 签名身份与发行凭据

- [ ] **P1 — 签名身份与发行凭据**：提供 Windows 代码签名身份、macOS 开发者身份及签名/公证凭据，配置真实 CI；在 [F006](03-feature-logic.md#f006) 实现后验证签名、公证与更新产物的身份。最终安装/升级/回退实机验收归 [V011](01-platform-validation.md#v011)。

## 资源与验收入口

- [发行矩阵](../RELEASE-MATRIX.md)、[打包脚本](../../scripts/package-desktop.mjs)、[发行 workflow](../../.github/workflows/release.yml)。按阶段选用 `pnpm run package:release` 和 `pnpm run test:release:matrix`，本地打包不替代真实 CI。
- 开发者身份申请、证书签发、账号授权和 CI 凭据配置需有权限的负责人参与；文档只记录非敏感身份标识和验证结果。

收尾：按[统一完成与交接规则](02-account-validation.md#handoff)更新本文件复选框、阻塞原因、下一步和证据；部分通过保持未完成，完成后归档并同步入口。
