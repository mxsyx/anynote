# G05 · 桌面打包、签名与发行

[返回总入口](../../TODO.md)

类型：实现 / 发行验收。目标：扩展装包 → 签名更新 → CI/安装升级。

前置：G00 的平台/架构范围；签名证书、开发者账号和真实 CI/设备。

并行边界：可先检查打包白名单；同一 release workflow 与打包配置串行修改。

## 建议入口

- [scripts/package-desktop.mjs](../../scripts/package-desktop.mjs)
- [.github/workflows/release.yml](../../.github/workflows/release.yml)
- [package.json](../../package.json)

## 执行顺序

1. 先核对 extensions 和离线静态资源随包可用、googleapis 懒加载与首次启动。
2. 再接入签名、公证与更新验证，验证失败回退和必要的版本拒绝。
3. 使用最终发行产物执行 CI 和真机安装/升级/卸载保留数据矩阵。

## 待办

### T033 · 原 §5

- [ ] **P1 — 桌面正式打包与扩展分发**：确认 `electron-builder` 打包（`files` 白名单）包含 `extensions/*`，并实机验证离线可用与 `googleapis` 懒加载不影响启动；当前仅通过仓库内构建、类型检查与渲染层打包验证。

### T008 · 原 §2.1

- [ ] **P1 — 签名与更新**：接入 Windows 代码签名、macOS 签名/公证、安装包和更新签名验证、升级失败回退及 schema 兼容检查；当前 GitHub Release/校验和流程不等于签名更新。

### T009 · 原 §2.1

- [ ] **P1 — 真实安装与 CI/CD 运行**：在 Linux/macOS/Windows 执行安装、首次启动、卸载保留数据、升级与回退；核对各平台架构、内嵌 Node/SQLite、PDF/白板静态资源与 Worker。现有三平台 workflow 是配置，本地静态检查不能代替 GitHub 实际运行和真机发行验收。

## 验证与完成条件

- `pnpm run package`
- `pnpm run package:release`
- `pnpm run test:release:matrix`
- 真实 CI 运行记录和各平台安装、升级、失败回退报告。

完成条件：产物、签名/公证、CI 和真机报告对应同一版本；本地打包成功不能替代发行验收。

人工 / 外部资源：账号/证书配置、公证所需身份、目标设备操作；发布对外产物按实际发布授权执行。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。

## G18 交接发现（2026-10-21，归 T009）

`e975c1c` / macOS arm64 / Node 24.22.0 / pnpm 12.14.0：`pnpm run test:sdk:package` 在干净离线消费者 TypeScript 编译失败。SDK 入口导出 `./cloud-backup.js` 和 `@anynote/types/cloud-backup.js`，但 `scripts/build-sdk.mjs` 未复制云盘实现/声明或改写其共享类型路径。应补齐公共产物闭包，再运行 SDK 消费与发行矩阵验证；本次 G18 仅核对并修正文档，不修改打包实现。证据见 [G18 报告](../G18-documentation-review.md)。状态沿用本文件 T009，不新建重复任务。

G17 后续交接（2026-10-21）：已补齐 SDK 云盘模块、共享类型声明和路径改写，新增云盘 API 消费断言，干净离线 SDK 消费通过。当前证据与命令见 [G17 首批交接](17-module-boundaries.md#首批实施与交接2026-10-21)；此修复不完成 T009 的真实 CI/设备发行矩阵。
