# 迁移基线与测试语料指南

本文说明冻结参考资料的来源、覆盖边界和重建方法。功能验收范围见 [功能与操作清单](RUST-MIGRATION-INVENTORY.md)，任务状态见 [TODO](../../TODO.md)。

## 固定版本与证据层次

- 旧提交：`60a8c4b614b8831d2a16366a79d595942e7b87a1`；语料重建使用该固定版本。
- [baseline.json](../../tests/fixtures/rust-migration/inventory/baseline.json) 保存源码文件和 lockfile 的 SHA-256；[operations.json](../../tests/fixtures/rust-migration/inventory/operations.json) 覆盖 146 个 renderer 白名单操作，每个操作有唯一主责组、保留/退役处置、源码契约及已有测试引用。其中 111 个迁移，35 个运行入口退役，业务及持久数据仍按相应组保留。
- [contract-fragments.json](../../tests/fixtures/rust-migration/inventory/contract-fragments.json) 固定操作分支内的校验、返回及错误代码；间接 helper 以固定提交中的源码为准。没有类型化 output schema 的服务不能仅凭当前 TypeScript 类型推断其完整结果。片段和测试引用是静态证据，不是对 146 个操作逐一运行后的成功记录。
- [internal-operations.json](../../tests/fixtures/rust-migration/inventory/internal-operations.json) 分配 20 个内部/漏接线入口，包括归档发布、捕获、导入提交、backup cursor/revision 及退役插件内部状态操作；它们不是新的 renderer API。生成器检查 storage/backup 的 `op ===` 分支没有未分配的名字。
- [coverage.json](../../tests/fixtures/rust-migration/inventory/coverage.json) 保存 INV-01–24 的旧入口、预期行为、RM 归属及现有测试入口；[observations.json](../../tests/fixtures/rust-migration/corpus/observations.json) 保存合成语料的输入/输出与错误预期。测试构造失败和产品基线失败分开记录。

功能与操作范围统一见 [验收清单](RUST-MIGRATION-INVENTORY.md)；INV 到语料、预期行为和测试入口的映射读取 `coverage.json`。冻结样本和操作分配不代表当前候选通过验收。

## 语料格式与边界

[corpus/manifest.json](../../tests/fixtures/rust-migration/corpus/manifest.json) 枚举每个文件的大小和 SHA-256。全部由合成内容及旧 API 生成，无真实用户库、账号、token、密文或插件包。`example.invalid` 只作来源标记，不发起请求。

- `schema.sql` 和 `backup-revision.sql` 分别固定 schema v5 与可选 tracker。旧校验器分别验证无 tracker/有 tracker 的 SQL，并拒绝新增未知列。
- `markdown.json` 保存 CRLF、中文/emoji/组合字符、格式、列表/表格、代码围栏内 directive、已知阅读块、未知字段、坏 JSON/未闭合块和 opaque HTML 的旧 parser 输出。`markdown-boundaries.json` 是 10,240、102,400、500,000、500,001 UTF-16 code units 的可重建配方和字节 hash；UTF-16 长度不冒充 UTF-8 字节数。此配方是数据边界，不是这些大小的输入延迟实测。
- `notebook/`、三类 `.anynote`、`expected.json` 保留正文/回收站、内部链接、修订 metadata、未知 `extension_data`、批注及 `revision_resources`。自校验按旧实现导入到新库，核对重映射后的链接和全量历史/资源。
- 白板合成场景含 rectangle/diamond/ellipse/text/line/arrow/freedraw/image/frame/iframe/embeddable 11 种 type 及未知字段；旧 storage 保存/历史读回验证字段和嵌图闭包。它不做 Excalidraw 几何合法性判断，也不证明全部工具能创建这些合成元素。
- `.anyclip` 由旧流式 writer 产生，含 PNG、表格和来源；导入校验正文资源重映射、图片 hash、重复提交同 note ID。导入会按旧实现补资源名称等正文表示，预期使用冻结的实际结果，而非假设导入前后 Markdown 完全相同。
- `local-backup/` 保留 v3 manifest、DB chunks、CAS 附件和 file token；测试把副本放到新合成 target 并仅替换 targetId，再经旧引擎 full verify/restore，逐字节核对 DB/附件。文件 token 不作为跨机器免校验凭证。
- `cloud-snapshot.json`/`cloud-objects/` 来自旧 snapshot/browse 实现，包含同数据库切面的目录、正文、资源及 capture ack。检查描述、大小、hash 和错误 chunk；没有真实 Cloudflare 请求、发布或恢复证据。
- `invalid/` 固定未知 schema、DB hash 不符、路径穿越、采集正文 hash 不符/未知版本、本地清单缺失文件和云 chunk 大小错误。拒绝后不得发布新库/提交笔记。大型压缩炸弹、重复 ZIP entry、实际磁盘故障继续使用现有专项测试和后续组，不把小语料覆盖夸大为完整故障验收。

## 校验与重建

常规校验读取已提交的黄金文件，不重新生成 expected：

```sh
pnpm run build:backend
pnpm exec vitest run tests/rust-migration.test.mjs
```

重建仅在固定提交的独立 checkout 中进行：把两个生成器复制到旧 checkout 的 `scripts/`，使用固定 lock 安装依赖并 `pnpm run build:backend`，然后指定**不存在的新目录**。生成器拒绝其他 HEAD 和产品源码/lock 改动；不允许覆盖已冻结目录。

```sh
node scripts/rust-migration-fixtures.mjs tmp/rm01-rebuilt-corpus
node scripts/rust-migration-inventory.mjs tmp/rm01-rebuilt-inventory
```

生成包含随机 UUID、时间戳、SQLite 物理页与文件 token；重建是同语义/同操作序列，不承诺跨 OS/SQLite 版本得到相同二进制。已提交语料的 hash 才是字节比较基准。两个生成器/测试是迁移工具，不进入最终桌面包；旧 reader 只在隔离基线 checkout 中运行。

比较旧版交互与性能（需要可用显示会话，均使用脚本创建的隔离资料）：

```sh
pnpm run build
node scripts/document-editor-smoke.mjs
node scripts/benchmark-search.mjs
node scripts/performance-ui-acceptance.mjs
node scripts/rust-migration-baseline.mjs
node scripts/editor-ecosystem-smoke.mjs
```

旧参考工具须在固定 checkout 中运行；旧选择器失配不作为产品行为。性能比较应串行，使用同机器、构建和缓存条件。输出写入 `tmp/`，活动任务见 [TODO](../../TODO.md)。
