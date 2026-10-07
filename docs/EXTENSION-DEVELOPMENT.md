# 扩展开发工具

`@anynote/extension-tools` 提供本地 `anynote-extension` 命令，用于创建 TypeScript 工程、校验 JSON 清单或签名包，以及在隔离 QuickJS 中试运行示例。校验、设置、迁移声明、签名验证、正文预算与扩展块保留规则与桌面共用源码。工具包只依赖 Zod 和 QuickJS，不包含 Electron、Storage、SQLite、设备授权或云配置。

## 本地安装

在 Anynote 源码目录构建两个本地包：

```sh
pnpm run build:sdk
pnpm run build:extension-tools
pnpm --dir artifacts/plugin-sdk pack --pack-destination ..
npm pack ./artifacts/extension-tools --pack-destination artifacts
```

两个包尚未发布到 npm。可在独立工程的父目录用本地 tarball 安装工具，或直接使用仓库内 CLI：

```sh
pnpm run extension:dev init /tmp/my-extension garden.example stateful
pnpm run extension:dev validate /tmp/my-extension/manifest.json
pnpm run extension:dev run /tmp/my-extension/manifest.json garden.example.run /tmp/my-extension/fixture.json /tmp/my-extension/result.json
```

每次通过 `pnpm run extension:dev` 执行前会构建后端；已有构建时可运行 `node scripts/extension-dev.mjs ...`。命令输出 JSON，失败退出码为 1，诊断包含字段路径；`--help` 输出用法。`validate` 展示规范化清单摘要、命令、权限、迁移 ID 及设置表单摘要，方便制作迁移规则。

## 独立 TypeScript 工程

`init <新目录> <扩展ID> <模板>` 要求目录尚不存在，支持 `declarative`、`transform`、`stateful`、`preferences`。生成 `manifest.ts`、初始 `manifest.json`、含未知扩展块的 `fixture.json`、严格 `tsconfig.json`、构建脚本、README 和忽略规则。不会覆盖既有工程。

在生成目录安装两个本地 tarball 和 TypeScript 5.9.2：

```sh
pnpm install --save-dev /absolute/path/anynote-plugin-sdk-0.1.0.tgz /absolute/path/anynote-extension-tools-0.1.0.tgz typescript@5.9.2
pnpm run validate
pnpm test
```

编辑 `manifest.ts` 后，`pnpm run build` 用 TypeScript 编译并运行工程内 `build.mjs`，生成 `manifest.json`。这是开发者主动执行的本地工程构建；工具的校验和试运行只读取 JSON，不加载工程模块，也不在 Node 中执行清单的脚本字符串。模板里的脚本是受限 QuickJS 函数表达式，不能直接使用编译为宿主模块的 JS。

`pnpm test` 输出结果但不覆盖 fixture，可以反复执行。需要保存结果时提供一个尚不存在的输出文件；工具拒绝覆盖输入、既有输出和指向既有文件的符号链接。

## 示例输入与结果

```json
{
  "note": {
    "id": "example-note",
    "title": "示例",
    "body": "# 内容\n",
    "revision": 1
  },
  "state": { "runs": 0, "custom": "保留" },
  "stateVersion": 1
}
```

`note` 只包含当前笔记快照；设置表单可通过 `settings` 显式传入，缺省时使用声明默认值。有状态命令读取本扩展的 `state`；提供已有状态必须注明 `stateVersion`，版本需与清单相符，否则拒绝运行。普通命令拒绝状态字段，没有设置表单的扩展拒绝设置字段。所有输入均严格校验，不接受其他 Notebook、SQL、路径或宿主对象。

结果格式为 `anynote.extension-dry-run.v1`，包含扩展 ID、命令 ID、安装摘要、来源元数据、正文，以及适用的设置、状态和状态版本。可检查输出，再自行制作下一次 fixture；工具不会持久化或升级输入数据。签名验证不代表桌面设备信任或 Notebook 授权。

清单输入最多 128KiB，签名包最多 160KiB，fixture 文件最多 10MiB，正文最多 2,000,000 字符；状态最多 64KiB、16 层和 4096 值。普通文件读取有字节预算，拒绝目录和设备文件。脚本沿用 64MiB guest 堆、256KiB 栈、250ms 中断与 2 秒总耗时预算，不能直接访问 Node、文件、网络或 DOM；声明的异步能力在试运行中只返回 fixture。输出必须保留已有扩展块原文和数量；声明式命令使用桌面相同的模板追加和节点生成规则。

试运行不模拟桌面的权限、笔记/设置/状态 CAS、知识事务、撤销与安装更新，也不执行数据迁移；这些通过桌面集成测试与实际 Notebook 审核验证。开发完成后在桌面扩展页审阅 `manifest.json`，安装并授权测试 Notebook；发布前可使用现有 `extension:package` 命令制作签名包及目录。

## 验证

```sh
pnpm test
pnpm run test:extension-tools:package
```

工具包验收使用本地已安装依赖的 tarball，在空目录离线安装 SDK、工具及 TypeScript，创建全部四种模板，通过 npm 工程构建、清单校验和试运行；并验证签名拒绝、预算失败、输入不变及覆盖保护。不调用真实云服务，不读取 `.env.cloud` 或真实用户 Notebook。

## 本次验收记录

2026-10-04：完整回归 169 项（开发工具专项 9 项）、严格 TypeScript 编译、公开 SDK 离线类型/运行消费和 Linux 应用目录打包通过。四种独立 TypeScript 模板在空目录离线构建、校验并重复执行通过，见 `test-results/extension-tools-package.json`。生产页面与最新 Linux 打包应用各复验 18 项流程、21 次自动 WCAG 扫描通过，违规为零，见项目 [实施记录](IMPLEMENTATION.md)。

## 搜索上下文示例

声明 `action.searchContext` 的命令需 `search:read`，试运行 fixture 需提供查询匹配且受预算约束的 `searchContext`；工具不查询真实知识库。完整格式见 [SCRIPT-SEARCH-CONTEXT.md](SCRIPT-SEARCH-CONTEXT.md)。

本轮独立离线验证还包含 SDK 中的 `reading-related.json` 与显式搜索 fixture：两次输出一致，未知块保留；报告 `test-results/extension-tools-package.json` 共 5 项检查通过。

声明 `asyncSearch` 的命令还需提供按查询 ID 映射的 `fixture.asyncSearch`，工具模拟异步宿主响应，仅执行已声明且符合预算的示例数据。用法见 [SCRIPT-ASYNC-HOST.md](SCRIPT-ASYNC-HOST.md)。

本轮离线包验收新增 `reading-async-related.json` 与异步搜索 fixture，公开 SDK 示例可配合独立工具验证并重复运行，未知块保留。报告 `test-results/extension-tools-package.json` 共 6 项检查通过。

## 网络响应 fixture

声明 `networkRequests` 的命令须提供按 ID 映射的 `fixture.network`，覆盖全部声明且不含额外 ID；URL、MIME 与响应字节数严格校验。工具只返回本地数据，重复执行可验证确定性和未知块保留。SDK 示例及格式见 [SCRIPT-NETWORK-PROXY.md](SCRIPT-NETWORK-PROXY.md)。
