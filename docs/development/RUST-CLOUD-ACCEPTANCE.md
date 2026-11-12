# RM34 Rust 真实云验收批次

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](../../TODO.md)。

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

真实服务只使用已有授权的独立测试部署；配置 `ANYNOTE_CF_ENDPOINT`（HTTPS）与 `ANYNOTE_CF_TOKEN`（Worker APP_TOKEN），或复用 `.cloudflare-acceptance/deployment.json` 和 `secrets.json`。显式配置必须成对，拒绝将一个部署的 token 与另一个 endpoint 混用。不自动部署、轮换账号令牌或运行 F020。

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

本机单元测试使用假时间仅校验流程，不能形成真实等待证据。对象 API 404 也不构成 R2 物理删除证据；到期后另用部署对应的 R2 管理权限检查报告列出的 `objects/<notebookId>/<hash>`，记录桶身份、对象键、检查时间和明确不存在结果。鉴权/网络错误不算删除。维护进程中断/重启、孤立 manifest/临时对象与 multipart 生命周期仍需受控批次证据，不能仅用本入口关闭 F012。

## 验证驱动

```sh
cargo test -p anynote-services --test cloud --test cloud_capture --test maintenance --locked --offline
node --test scripts/test-rust-cloud.mjs
pnpm exec vitest run tests/cloud-aging.test.mjs
```

活动老化样本及下一阶段的接续输入见 [F012](../../TODO.md#f012)。先读取状态文件核对部署、身份、到期时间和已执行阶段，不覆盖或重新建立活动样本。
