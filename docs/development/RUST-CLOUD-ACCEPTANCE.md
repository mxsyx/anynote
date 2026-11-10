# RM34 Rust 真实云验收批次

状态以 [TODO RM34](TODO.md#rm34) 为准。本轮完成驱动、本地预验证及真实云小型闭环，RM34.1 已通过；RM34.2 长期调度、RM34.3 真实老化与物理删除仍未闭合，A007/A008/F025 状态不变，A009 独立保留。原生管理 GUI 与最终发行候选包不在本轮证据内。

## 批次入口

使用 Node >=24、锁定 Cargo 依赖。先构建实际 Rust 探针和保留 Worker/浏览器，桌面运行时不依赖 Node。

```sh
cargo build -p anynote-services --example cloud_probe --locked --offline
pnpm run build:browser
pnpm run build:worker
node scripts/rust-cloud-reference.mjs --rm34
CAPTURE_CHROMIUM=/absolute/path/to/chrome node scripts/rust-cloud-reference.mjs --rm34 --workerd --browser
```

`--rm34` 复用 RM10 的真实 Rust 子进程、冻结语料、HTTP 故障代理与 RM12 扩展场景；使用新建 Notebook/lineage/device，不接触日常库。适配器与 workerd 执行同一 `scripts/cloud/rust-scenario.mjs`。本场景不执行 SQL 改时间、改 writer 或修改服务端对象元数据。

真实服务只使用已有授权的独立测试部署；配置 `ANYNOTE_CF_ENDPOINT`（HTTPS）与 `ANYNOTE_CF_TOKEN`（Worker APP_TOKEN），或复用 `.cloudflare-acceptance/deployment.json` 和 `secrets.json`。显式配置必须成对，拒绝将一个部署的 token 与另一个 endpoint 混用。不自动部署、轮换账号令牌或运行 A009。

```sh
node --env-file=/absolute/path/to/test-cloud.env scripts/rust-cloud-reference.mjs \
  --real-cloud --namespace rm34-YYYYMMDD-01 --browser
```

`--namespace` 是本次验收记录标签，远端范围由报告中随机分配的 notebookId/lineageId 确定，不是服务器提供的访问隔离机制。运行前须确认端点属于授权测试部署。`--browser` 使用已构建扩展和隔离 Chromium profile；可省略，但报告会明确浏览器未测。需要环境代理时给 Node 显式添加 `--use-env-proxy`，并确保 `NO_PROXY` 包含 `127.0.0.1`。

首次写入前保存身份、端点、开始时间、源码及 Rust 探针 SHA-256。实际请求仅记录路径/方法/状态/字节，不存 Authorization、配对码或设备 token。报告在 `tmp/rm34/cloud-*/report.json`，真实批次另原子保存 `.cloudflare-acceptance/rm34/<namespace>.json`；同端点使用 SQLite 排他租约，重复标签拒绝覆盖。失败报告保留已通过步骤与身份；不得因为退出失败而丢弃远端范围。恢复探针每次都是新进程，pending/committed 核对使用原传输槽。

批次失败后先阅读持久记录。测试批次整体重跑使用新标签及全新远端 ID；不将未完成批次当作成功，也不自动删除其云端样本。只有本批次创建的配对设备会在正常/异常退出路径撤销；SIGKILL 后根据记录中的设备 ID 手动核对撤销。云端 Notebook/版本保留以便审计，清理需按记录单独处理。

## 覆盖与证据区别

| 检查                     | 执行入口与判断                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| capabilities/schema      | 公开响应记录 protocolVersion、schemaVersions、capabilities；Rust 再执行正式协商                                                  |
| 断网、plan/commit 丢回包 | 客户端代理切断连接；每步重启 Rust 进程，核对冻结 generation、pending 和已提交游标，不重复 commit                                 |
| 增量与调度               | 同切面二次上传经过正式 scheduler；记录对象 PUT 字节，断言未重传相同 DB chunk/附件，不据此推断费用或长期调度                      |
| 旧版本恢复               | 新库身份、正文历史、资源引用、批注、未知状态、采集回执及实际附件 SHA-256                                                         |
| 配对/媒体采集            | 一次性兑换、含图片的 anyclip、applied ACK 丢回包、回执去重、成功备份后才 backedUp                                                |
| 同代 browse              | 固定 generation 的笔记及每个资源 hash，与 Rust 恢复后的库核对                                                                    |
| 浏览器                   | 实际 Chromium 扩展页面配对/上传/采集箱/浏览；流量经本机代理，包含合成缺 capability 降级；不等于原生管理 GUI 或浏览器真实站点采集 |
| 限流/撤权/冲突           | 429 为代理注入，Retry-After=90 秒；设备撤销、stale-head、writer takeover 走实际公开 API，仅操作本批次身份                        |

`passed` 仅表示该报告所列场景通过。代理故障不是 Cloudflare 区域故障；scheduler 单次派发不是长期自动调度。原生 RM29 管理 GUI、系统凭据、真实账号撤权/网络断开、长时间调度仍需单独记录。

## 真实 24h/7d 老化

复用已有 [云老化流程](validation/CLOUD-ACCEPTANCE.md#跨会话老化样本)，不沿用已删除部署或旧报告。新增 `--rust`：仍由既有 TS 兼容流程生成小型 schema v5 样本并执行 retention/tombstone，复验时由 TS 和实际 Rust `restore` 分别恢复 pinned/head/branch 三个固定版本；Rust 正文核对失败则阶段不通过。并非宣称所有维护 API 已由 Rust 发起。

```sh
pnpm run build:backend
node --env-file=/absolute/path/to/test-cloud.env scripts/cloud-aging-acceptance.mjs \
  --seed --rust --state .cloudflare-acceptance/rm34/rm34-YYYYMMDD-01-aging.json
node --env-file=/absolute/path/to/test-cloud.env scripts/cloud-aging-acceptance.mjs \
  --verify 24h --rust --state .cloudflare-acceptance/rm34/rm34-YYYYMMDD-01-aging.json
node --env-file=/absolute/path/to/test-cloud.env scripts/cloud-aging-acceptance.mjs \
  --verify 7d --rust --state .cloudflare-acceptance/rm34/rm34-YYYYMMDD-01-aging.json
```

长期状态使用专用目录，不放 `tmp/`。`rustRequired` 绑定验证模式，后续不能省略 `--rust` 退回 TS 单独通过；旧 TS 样本不能加该参数冒充 Rust 批次。等待期退出码为 2，不联网、不启动 Rust、不刷新 staging 活动；真实 due24h/due7d 从 seed 全部完成时计算，24h 阶段必须在 staging 满 7 天前完成。阶段内的 Rust 版本、恢复 ID、时间和探针摘要随原状态保存。不得改系统时钟或服务端时间代替等待。

本机单元测试使用假时间仅校验流程，不能形成真实等待证据。对象 API 404 也不构成 R2 物理删除证据；到期后另用部署对应的 R2 管理权限检查报告列出的 `objects/<notebookId>/<hash>`，记录桶身份、对象键、检查时间和明确不存在结果。鉴权/网络错误不算删除。维护进程中断/重启、孤立 manifest/临时对象与 multipart 生命周期仍需受控批次证据，不能仅用本入口关闭 A008。

## 2026-11-10 本地结果

- 当前 macOS arm64、Node 24.22.0：合成 D1/R2 9 项通过；官方 local-workerd 及 Chromium 扩展 10 项通过。
- 二次上传复用 DB/附件 228,070 字节，对象 PUT 为 0 字节；只表示本语料与请求边界。
- 既有 RM10 协议回归 14 项通过；Rust cloud/capture/maintenance 12 项通过；老化状态机及 CLI 4 项通过；真实模式缺配置、重复标签保全、端点排他租约 3 项通过。
- 原生探针锁定离线构建通过。本地首次回环监听被沙箱 EPERM 拒绝，获准本机监听后通过。最初 TS 测试缺构建产物，执行完整 build:backend 后通过。
- 本地准备阶段没有真实云写入；用户随后提供 `.env.cloud`，真实运行见下一节。

可重复验证命令：

```sh
cargo test -p anynote-services --test cloud --test cloud_capture --test maintenance --locked --offline
node --test scripts/test-rust-cloud.mjs
pnpm exec vitest run tests/cloud-aging.test.mjs
```

## 2026-11-10 真实云小型闭环

用户指定仓库根目录 `.env.cloud` 后，只读取应用配置；没有修改 Worker 部署、D1 schema、账号令牌或既有数据。端点为 `https://anynote-backup-acceptance-518ee6c2.mxsyxin7605.workers.dev`，真实 capabilities 返回协议 v1、schema v5 及本批次全部所需能力。初次沙箱内请求 DNS 失败，获准网络访问后 HTTP 200。

北京时间 14:12:45–14:15:19，批次 `rm34-20261110-01` 的 10 项检查全部通过。真实云首次/二次备份、旧版本及采集后恢复、配对/含媒体采集/同代 browse/撤销、head/writer 冲突均通过公开 API；断网、429 和丢回包由客户端代理注入。二次相同切面复用 228,070 字节 DB/附件，对象 PUT 为 0 字节。Rust 可执行文件摘要与运行报告一致。

- 测试 Notebook：`0ace3573-3905-4d22-b864-c190c39dc5e1`。
- lineage：`19f60808-ac77-4b31-b104-8ea832dc9fc2`。
- 首版本：`bbcc0495-104f-45c6-a5a0-ff38603207f5`。
- 最终版本：`200f26f2-33b7-47f8-a61d-a257ff2a16d8`。
- 持久报告：`.cloudflare-acceptance/rm34/rm34-20261110-01.json`；临时详细材料：`tmp/rm34/cloud-KU1HYJ/`。

浏览器证据来自实际 Chromium MV3 扩展页面，经本机代理访问真实 Worker；测试设备和浏览器配对设备均已撤销。Rust 使用实际服务实现的独立探针，未操作原生 RM29 管理 GUI，没有最终签名候选包结论。报告顶层 endpoint 是真实服务地址；identity.endpoint 是用于故障注入的回环代理地址，不能把临时代理端口作为后续连接配置。

### 本批真实老化样本与接续时间

样本状态为 `waiting`，持久文件 `.cloudflare-acceptance/rm34/rm34-20261110-01-aging.json`；Notebook `d5c567a7-e326-4e69-8b7e-b046822e1d16`，lineage `ee50105e-61b6-4c1b-8149-09da19a3a985`。本次新建五类样本：orphan、pinned、head、branch 和 staging。seed 通过公开 retention API 仅移除本次 orphan 版本，新对象仍受 24h 宽限保护；没有复用旧部署样本。

- 建立完成：2026-11-10 14:16:18.991（北京时间）。
- 24h 最早复验：2026-11-11 14:17:18.991；操作时建议 14:18 后，且须在 staging 满 7 天之前完成。
- 7d 最早复验：2026-11-17 14:17:18.991；操作时建议 14:18 后，先确认 24h 阶段通过。

2026-11-10 14:17 已使用正式 Rust restore 直接通过 HTTPS 恢复 pinned/head/branch 并核对正文，三项通过。结果记录在 `phases.baseline`，只验证复验入口，不冒充 24h/7d；未更改时间、staging 活动或对象老化 metadata。立即运行 24h 复验返回等待（退出码 2），未生成 24h 通过记录。

接续命令（Node >=24，`.env.cloud` 保留在本机）：

```sh
node --use-env-proxy --env-file=.env.cloud scripts/cloud-aging-acceptance.mjs   --verify 24h --rust --state .cloudflare-acceptance/rm34/rm34-20261110-01-aging.json
node --use-env-proxy --env-file=.env.cloud scripts/cloud-aging-acceptance.mjs   --verify 7d --rust --state .cloudflare-acceptance/rm34/rm34-20261110-01-aging.json
```

没有设置自动定时任务。到期后需执行对应命令；不能重新 seed 覆盖此文件。`.env.cloud` 目前仅提供 Worker 应用权限，尚未核对测试 R2 桶管理访问能力，因此 R2 物理删除仍须补管理端证据。长期调度、原生管理 GUI 和最终发行候选包不在上述结果中，RM34.2/.3 继续未完成。
