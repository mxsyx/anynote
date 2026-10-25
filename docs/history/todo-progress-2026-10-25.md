# 待办合并前的阶段进展与证据

归档：2026-10-25。以下记录迁自原任务文件，保留当时的实施范围、结果、阻塞和接续信息；本次仅整理文档，未重新验证源码、真实服务或设备。文中“本次”“当前”“下一步”均指原记录时点，不代表最新状态。任务状态与后续安排统一见 [TODO](../../TODO.md)。

<a id="cloudflare"></a>

## Cloudflare：2026-10-24 实施与交接

- 范围：用户限定仅小规模验证，本次不做付费压力测试。复用 `anynote-backup-acceptance-518ee6c2` 独立 Worker/D1/R2；通过现有 Wrangler 登录完成部署、D1 迁移、应用接口与 R2 只读检查，未撤销账号权限或修改桶规则。
- 版本：源码基于 `8afc60a`，本次增加老化入口并修复部署后验收仍传入已移除 `--provider` 的问题；Worker 更新到 schema v4，版本 ID `8b464dd2-b17b-437b-89c2-e0a97b258e13`。旧部署能力检查只支持 schema v2，不能沿用旧报告。
- **A007 部分通过**：`pnpm run build:backend` 后执行 `node scripts/cloud-deploy.mjs`，真实云协议/维护 14 项通过；`node --env-file-if-exists=.env.cloud scripts/cloud-recovery-acceptance.mjs` 的 6 项通过，覆盖提交前/后 SIGKILL、游标确认、恢复中断及源库离线恢复。报告：`test-results/cloud-acceptance.json`、`test-results/cloud-recovery-acceptance.json`。
- **A007 续传**：`node --env-file-if-exists=.env.cloud scripts/cloud-stream-acceptance.mjs` 首次收到 HTTP 503，保留 `test-results/cloud-stream-acceptance-first.json`；开启只读诊断后复跑 7 项通过，上传重启复用 32MiB、下载重启复用 16MiB、112MiB 附件完整哈希校验通过。成功报告及脱敏日志为 `test-results/cloud-stream-acceptance.json`、`test-results/cloud-stream-tail.json`。首次 503 根因未确认；复跑成功不能替代限流退避、厂商故障或长期调度验收。
- **A008 等待真实时间**：新增 [老化场景](../../scripts/cloud/aging-scenario.mjs)、[CLI](../../scripts/cloud-aging-acceptance.mjs) 和 [回归](../../tests/cloud-aging.test.mjs)。已运行 `node --env-file-if-exists=.env.cloud scripts/cloud-aging-acceptance.mjs --seed`，状态为 `waiting`；提前运行 `--verify 24h` 返回 2，未冒充通过。状态文件 `.cloudflare-acceptance/aging.json` 保存完整 manifest、对象哈希、保护关系和后续清理计划，不含凭据。
- **R2 基线**：独立管理端下载验证了 167936 字节孤立对象及其 SHA-256；桶规则为已启用的 `Default Multipart Abort Rule`，所有前缀的未完成 multipart 在 7 天后 abort。记录在 `test-results/cloud-aging-resource-check.json`。这里只核对当前规则，未证明厂商已执行到期回收。
- **A009 未执行满负载**：遵守本次预算范围，不运行 20GiB、2000 活动版本、200000 引用、满上传会话预算或长期归档增长/成本测试。112MiB 重复块仅用于续传与完整性，不代表随机吞吐或容量预算通过。
- **本地验证**：Cloudflare 相关 9 个测试文件、61 项全部通过（`cloud-aging`、`cloud-deploy`、`cloud-acceptance`、`cloud-resume`、`cloud-stream`、`cloud-recovery`、`remote-maintenance`、`cloud-multipart`、`maintenance-recovery`）；报告 `test-results/cloud-validation-local.json`。后端构建和变更脚本 ESLint 检查通过。受控时钟只用于本地回归，不作为真实老化证据。

本次老化样本（时间为北京时间 UTC+8）：

| 项目                                     | 标识 / 时间                            |
| ---------------------------------------- | -------------------------------------- |
| Notebook                                 | `a4259e93-0469-4f44-a561-187b9577d9a8` |
| 当前分支                                 | `4943c2a0-a3b1-4fc6-915b-8ca9865c8b1a` |
| 旧版本（已退役，保留无引用对象等待老化） | `8e890304-867b-4feb-8e0d-8807a57be351` |
| 恢复 pin 验证版本                        | `66d88983-2606-458c-bc7b-2797e1516997` |
| 保留 head                                | `c0d50f38-fd03-4571-af1f-8ddc36c04b7d` |
| 其他分支 head                            | `cb07988b-4d9a-4936-95dc-f6a50dca1072` |
| 无活动 staging                           | `296600c0-b02a-43a1-9f11-a4a4fd96fb4e` |
| 样本建立完成                             | 2026-10-24 21:10:18                    |
| 24h 最早复验                             | 2026-10-25 21:11:19（已留 1 分钟余量） |
| 7 天最早复验                             | 2026-10-31 21:11:19（已留 1 分钟余量） |

下一步按[老化验收命令](../CLOUD-ACCEPTANCE.md#跨会话老化样本)先执行 `pnpm run test:cloud:aging --verify 24h`，在 staging 满 7 天前完成该阶段；到期后再执行 `--verify 7d`，同时用管理端核实 R2 物理删除。等待期间不要对该样本重新 plan、上传或提交，以免刷新 staging 活动或改变保护集合。本次未启动后台调度器，需后续会话按期接续。

剩余阻塞：A007 尚缺长期自动备份、多类真实故障/权限撤销/配额不足、multipart 生命周期/复制中断/abort 丢响应；A008 尚需真实等待及物理删除证据、孤立 manifest/临时对象、7 天 staging 到期和归档失败恢复；A009 需要另行明确负载费用范围。保持 A007–A009 未勾选。

<a id="plugin-network"></a>

## 插件公网端点：2026-10-24 实施与交接

- 已实现：14 个场景，包含证书/主机名、DNS/实际连接地址、超时、建连后撤权、响应预算及异常后恢复；逐次保存独立报告，缺配置或失败均返回非零退出码。
- 本地证据：`pnpm exec vitest run tests/plugin-network-acceptance.test.mjs tests/script-network.test.mjs`，24 项通过；本机 HTTP/TLS 服务只验证脚本，不计公网通过。
- 资源门槛验证：未配置端点时报告为 `blocked`，见 `test-results/plugin-network/741e4ae1-5bbc-4083-a4db-4f76ee6fbdcc.json`。
- 桌面失败路径：Linux / Electron 41.9.1，使用保留的 `.invalid` 域名执行完整 IPC 安装、授权、命令、卸载流程；仅 NXDOMAIN 场景通过，其余场景均未被误判为通过，整体 `failed`、退出码 1，清理成功。报告为 `test-results/plugin-network/7a894bf4-50dc-4bb3-87a9-5cc8cfc6046f.json`；这不是公网验收。
- 工程验证：`pnpm run build`、本次新增脚本及测试的 ESLint、Prettier 检查通过；构建仍有既有大分块提示。
- 阻塞：尚未提供受控公网域名、公共证书、错误证书/主机名服务以及私网、混合、NXDOMAIN DNS 场景；未执行真实公网验收。
- 下一步：负责人按专项说明部署服务并提供非敏感配置路径，执行 `pnpm run test:plugin-network`；保留部署/DNS 配置证据与全部场景报告后再决定勾选 A010。

<a id="release-credentials"></a>

## 发行凭据：2026-10-24 实施与交接

- 已实现 [凭据预检脚本](../../scripts/release-credentials.mjs)：支持按 Windows/macOS 独立检查、两种公证认证方式及冲突拒绝；每次生成独立脱敏报告。状态只区分配置完整与阻塞，真实验收固定为 `not-run`。
- 已准备 [手动 CI 入口](../../.github/workflows/release-credentials.yml)，仅检查 `release` environment 的凭据配置并上传报告；未调用 GitHub、创建 environment、配置 secrets 或触发真实 CI。现有发行 workflow 与打包签名接入仍归 F006。
- 当前环境实测：`pnpm run test:release:credentials` 返回 `blocked`、退出码 2；Windows/macOS 签名和公证变量均未配置。报告：`test-results/release-credentials/c275f789-778b-488c-b7fb-561257bf4352.json`。环境为 Linux、Node v24.11.1、应用 0.1.0，源码 HEAD `25e6db1` 加本次未提交改动；没有可记录的真实签名身份。
- 修复发行矩阵 smoke 仍断言旧 Notebook schema 2/3 的问题，改为读取当前矩阵版本并检查下一版本拒绝。`pnpm run test:release:matrix` 完整通过，包含后端构建、三份发布包组装、兼容窗口及干净离线消费者；报告：`test-results/release-matrix.json`。此结果不构成签名或更新验证。
- 本地回归：`pnpm exec vitest run tests/release-credentials.test.mjs tests/release-matrix.test.mjs`，2 文件、19 项通过；变更脚本与测试的 ESLint、Prettier 和 `git diff --check` 通过。沙箱内 Node 子进程出现 `EPERM`，获准在沙箱外重跑后通过。
- 剩余阻塞：真实 Windows/macOS 身份、公证授权、实际 CI 配置和执行，以及 F006 签名/更新实现。未运行真实签名、公证、更新身份或安装/升级/回退验收，A011 不勾选。
- 下一步：账号所有者按 [准备说明](../RELEASE-CREDENTIALS.md)提供凭据并配置可信 CI environment，运行手动预检；F006 就绪后，在原生 runner 上核验签名、公证和更新产物身份，再交 V011 做实机验证。凭据值不写入交接文档或聊天。

<a id="type-boundaries"></a>

## 动态类型边界：2026-10-25 实施与交接

F005 保持未勾选：本轮完成基础调用链，后续继续按业务接口分批，不将动态服务返回 `unknown` 视为所有操作契约已完成。

| 批次 | 已交付范围                                                                                                                                                                                           | 剩余范围                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1    | `Storage.run/execute` 移除 `any` 输入/结果；基础 Notebook、节点、历史、搜索、资源读取、归档发布及本地备份版本共 17 项操作建立关联输入/结果契约；动态服务消费方校验快照、扩展目录/下载/更新和导入结果 | 其余操作目前返回 `unknown`，继续按导入/编辑、扩展管理、备份任务等接口组补齐操作名关联类型，复用现有运行时校验 |
| 2    | 校验 Notebook/节点/修订投影、标签 JSON、导入报告与导入提交、幂等修改回执、远程备份目标；调度器共用备份目标读取，写入前校验本地/远程配置，本地版本复用既有 schema                                     | 白板场景、批注 selector、清理计划等剩余 SQL/JSON 边界仍需独立收紧；全局 `SqlRow` 尚未替换                     |
| 3    | `createAPI` 方法/输入映射与固定结果校验完成；动态 settings 返回 `unknown`，由扩展校验；宿主搜索补齐声明的笔记快照；首方宿主通道命名为 `OperationTransport`，SDK 发布包包含新模块且无新增运行时依赖   | 首方 `OperationTransport` 适配器仍有独立结果断言，不能将公共 `createAPI` 的完成推广到这些适配器               |

实现入口：[Storage 契约](../../packages/storage-sqlite/src/operation-contracts.ts)、[导入契约](../../packages/storage-sqlite/src/import-contracts.ts)、[扩展结果](../../packages/storage-sqlite/src/extension-results.ts)、[备份连接](../../packages/backup/src/connection.ts)、[SDK transport](../../packages/plugin-sdk/src/transport.ts)。调用方与 SDK/首方适配器 README、独立打包脚本已同步。

验证记录：

- `pnpm run build:backend`、`pnpm run typecheck`、`pnpm run workspace:check` 通过；变更文件 ESLint、Prettier 与 `git diff --check` 通过。
- [运行时回归](../../tests/type-boundaries.test.mjs)与[类型回归](../../tests/types/type-boundaries.ts)覆盖非法输入/结果、缺失字段、损坏 JSON、备份调度拒绝非法配置、嵌套 transport 返回、异常与取消。最终受影响的 storage、SDK、web-import、backup-boundaries、backup-policy、backup-local、extension-download、extension-updates、extension-directories、search、transfer 等 13 个测试文件：118 通过、1 跳过。
- `node scripts/sdk-package-smoke.mjs`、`node scripts/build-first-party-adapters.mjs && node scripts/first-party-package-smoke.mjs`：离线独立消费方类型和运行时通过。最初独立 Node 子进程测试在沙箱内遇到 `EPERM`，允许本地子进程后已通过。
- 完整 `pnpm exec vitest run`：439 通过、1 跳过、4 失败；3 项为未修改的 `icons.test.ts` 与现有图标输出不符，1 项为 `archive-stream.test.mjs` 的流式导出缓冲增长 51,943,840 字节，超过 48 MiB 阈值。该归档文件与新增边界/SDK 回归随后单独运行共 24 项通过；首次内存阈值失败原因未定位，不能据重跑通过宣称修复。完整回归未全绿。

下一批先选择一个剩余 Storage 业务组，将其输入、结果和消费方校验一起落地；后续以根目录 TODO.md 为跨会话状态入口。未执行真实云、真实设备或 UI 验收，本轮没有修改界面流程。
