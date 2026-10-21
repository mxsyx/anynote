# G18 文档状态核对

日期：2026-10-21。源码基线：`e975c1c`（工作区起始干净）。本次只修改文档；不修改运行逻辑、不部署、不发布。任务状态唯一入口为 [G18/T054](todo/18-documentation-adr.md)。

## 差异与证据

| 原描述                                                | 当前核对结果                                                           | 依据与回写                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| ADR-001–010 只是建议清单                              | 十项实际决定已逐项记录背景、取舍、源码和验证入口                       | [ADR 索引](adr/README.md)，设计 §25 改为链接                      |
| better-sqlite3、notebook.json、独立 Notebook 租约文件 | node:sqlite；数据库身份；主连接 EXCLUSIVE 写锁                         | ADR-001；README、设计 §4/§5、IMPLEMENTATION                       |
| 实体 delta、周期 checkpoint、恢复重放链               | 数据库 1MiB 分块、完整附件；每代完整恢复清单                           | ADR-005/006；设计 §12 与存储专项契约                              |
| 源码/阅读/Beta 切换                                   | Tiptap 连续文档；保留复杂块原文，不承诺任意 Markdown 全文无损往返      | ADR-002；README、IMPLEMENTATION、EDITOR-ECOSYSTEM                 |
| 第三方沙箱、签名分发未实现                            | 声明式/QuickJS 已实现；签名包、审核更新、定时检查已实现                | ADR-007；区分未开放的通用 Node/React 与未完成的桌面应用签名       |
| 未建立 pnpm workspace / 发布矩阵                      | 已有 workspace、源码 src/dist、公开产物构建及版本矩阵                  | package.json、pnpm-workspace.yaml、构建脚本；迁移、开发与实施文档 |
| pnpm 11.20.0；源码目录未接入包；SDK examples 旧路径   | pnpm 12.14.0；私有 SDK workspace 与便携产物分开；示例位于 src/examples | README、DEVELOPMENT-WORKFLOW、TYPESCRIPT-MIGRATION、SDK README    |
| 发布矩阵表中 schema 3 / 本地及云盘清单 v2             | `release.ts` 当前为 schema 4 / 本地及云盘清单 v3                       | RELEASE-MATRIX；保留开发期不兼容边界                              |
| 历史 SDK 离线消费通过                                 | 当前消费失败：云盘模块未进入独立 SDK 产物                              | 见下方失败证据；SDK/README/实施/迁移/发布文档撤下当前成功暗示     |
| 历史 Linux/Cloudflare 统计代表当前验收                | 明确日期、旧格式与设备边界                                             | 相关说明保留历史记录，任务引用 G01/G03/G05/G07/G19/G20            |
| 专项说明与 TODO 可分别维护状态                        | 只在所属 T 条目维护勾选；专项说明记录契约/步骤/证据                    | [文档维护规则](DOCUMENTATION.md)、TODO 交接规则及专项入口         |

结构核对使用代码图并逐路径检查覆盖；`archive-stream.ts:343`、`main.tsx:2304`、`styles.css:2–6`、SDK `index.ts:367–368` 的部分解析范围已直接读取源码。图只作为定位工具，实际决定以当前源码为证据；未依赖缺失的旧 runtime 路径或忽略的截图目录作结论。

## 本轮验证

环境：macOS arm64，Node 24.22.0，pnpm 12.14.0。默认 shell 是 Node 22，本轮运行命令前将已安装 Node 24 的 bin 加入 PATH。仅临时测试数据和本地模拟服务，无真实云账号访问。

```sh
pnpm run test:sdk:package
pnpm exec vitest run tests/storage.test.mjs tests/sqlite-assets.test.mjs tests/organization.test.mjs tests/document-model.test.ts tests/cloud-backup.test.mjs tests/cloud-stream.test.mjs tests/archive-stream.test.mjs tests/extensions.test.mjs tests/script-runtime.test.mjs tests/sdk.test.mjs tests/appearance.test.ts tests/navigation.test.ts
pnpm exec vitest run tests/cloud-backup.test.mjs
```

- SDK 命令中的后端 TypeScript 编译及 SDK 目录生成通过；独立离线消费者编译失败。入口已导出 `./cloud-backup.js` 和 `@anynote/types/cloud-backup.js`，但 [build-sdk.mjs](../scripts/build-sdk.mjs) 只复制原有模块和本地备份类型。直接检查生成声明可复现 `TS2307: Cannot find module './cloud-backup.js'`。不是把文档命令名称改掉就能解决的问题。
- ADR 相关 12 文件共 93 项：首次 91 通过，2 项 OAuth 回环回调因沙箱禁止监听 `127.0.0.1`（EPERM）失败。允许本机监听后，同一云盘文件 16 项全部通过；所选 93 项均已获得通过证据，不宣称全量回归通过。
- 已校验 29 份修改/新增 Markdown 的 333 个相对链接（含标题锚点）、42 个根脚本命令名、10 个连续 ADR 编号和全部 70 个 T 编号的唯一归属；均通过。Prettier 按仓库配置排除原设计文档，其他修改文件与 `git diff --check` 通过。生成报告路径为命令产物，不按已提交文件链接校验。

## 归属与边界

SDK 公共产物缺少云盘模块的修复归 [G05/T009](todo/05-desktop-distribution.md)，只在该条维护后续状态；本报告是发现证据。修复后应重跑 SDK 消费及发布矩阵。此缺陷不阻止记录真实架构和文档状态，但阻止宣称当前 SDK 可发布。

本轮未重跑浏览器/原生 UI、性能、workerd、真实云、物理磁盘/独立设备、整机故障、安装包或 GitHub CI，也未访问官方网页验证历史外部资料。ADR 中的测试与专项报告链接是可复核入口，不自动构成上述验收证据。首发取舍仍归 G00，不在文档治理中代作决定。
