# 签名身份与发行凭据验收

[返回账号任务入口](02-account-validation.md) · [返回总入口](../../TODO.md)

更新：2026-10-24。已补齐凭据预检、手动 CI 入口和真实证据记录规范；尚缺真实凭据、CI 执行与 F006，A011 保持未完成。

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

- [凭据准备与证据规范](../RELEASE-CREDENTIALS.md)、`pnpm run test:release:credentials`、[手动预检 workflow](../../.github/workflows/release-credentials.yml)。预检仅检查变量组，不调用签名或公证服务。
- [发行矩阵](../RELEASE-MATRIX.md)、[打包脚本](../../scripts/package-desktop.mjs)、[发行 workflow](../../.github/workflows/release.yml)。按阶段选用 `pnpm run package:release` 和 `pnpm run test:release:matrix`，本地打包不替代真实 CI。
- 开发者身份申请、证书签发、账号授权和 CI 凭据配置需有权限的负责人参与；文档只记录非敏感身份标识和验证结果。

## 2026-10-24 实施与交接

- 已实现 [凭据预检脚本](../../scripts/release-credentials.mjs)：支持按 Windows/macOS 独立检查、两种公证认证方式及冲突拒绝；每次生成独立脱敏报告。状态只区分配置完整与阻塞，真实验收固定为 `not-run`。
- 已准备 [手动 CI 入口](../../.github/workflows/release-credentials.yml)，仅检查 `release` environment 的凭据配置并上传报告；未调用 GitHub、创建 environment、配置 secrets 或触发真实 CI。现有发行 workflow 与打包签名接入仍归 F006。
- 当前环境实测：`pnpm run test:release:credentials` 返回 `blocked`、退出码 2；Windows/macOS 签名和公证变量均未配置。报告：[c275f789-778b-488c-b7fb-561257bf4352.json](../../test-results/release-credentials/c275f789-778b-488c-b7fb-561257bf4352.json)。环境为 Linux、Node v24.11.1、应用 0.1.0，源码 HEAD `25e6db1` 加本次未提交改动；没有可记录的真实签名身份。
- 修复发行矩阵 smoke 仍断言旧 Notebook schema 2/3 的问题，改为读取当前矩阵版本并检查下一版本拒绝。`pnpm run test:release:matrix` 完整通过，包含后端构建、三份发布包组装、兼容窗口及干净离线消费者；报告：[release-matrix.json](../../test-results/release-matrix.json)。此结果不构成签名或更新验证。
- 本地回归：`pnpm exec vitest run tests/release-credentials.test.mjs tests/release-matrix.test.mjs`，2 文件、19 项通过；变更脚本与测试的 ESLint、Prettier 和 `git diff --check` 通过。沙箱内 Node 子进程出现 `EPERM`，获准在沙箱外重跑后通过。
- 剩余阻塞：真实 Windows/macOS 身份、公证授权、实际 CI 配置和执行，以及 F006 签名/更新实现。未运行真实签名、公证、更新身份或安装/升级/回退验收，A011 不勾选。
- 下一步：账号所有者按 [准备说明](../RELEASE-CREDENTIALS.md)提供凭据并配置可信 CI environment，运行手动预检；F006 就绪后，在原生 runner 上核验签名、公证和更新产物身份，再交 V011 做实机验证。凭据值不写入交接文档或聊天。

收尾：按[统一完成与交接规则](02-account-validation.md#handoff)更新本文件复选框、阻塞原因、下一步和证据；部分通过保持未完成，完成后归档并同步入口。
