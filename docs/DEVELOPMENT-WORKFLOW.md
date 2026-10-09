# 开发工具与 GitHub CI/CD

仓库使用 Node.js 24+、固定的 pnpm 11.20.0 和 `pnpm-lock.yaml`。安装 pnpm 后运行：

```sh
pnpm install --frozen-lockfile
pnpm run desktop
pnpm run check
pnpm test
pnpm run build
```

`packageManager` 固定 pnpm 版本。`pnpm-workspace.yaml` 包含 `apps/*`、`packages/*`，使用 `nodeLinker: isolated`、`hoist: false`、`autoInstallPeers: false`。根项目只声明编排、测试和工具依赖；桌面与 Cloudflare 应用、8 个共享包各有自己的 package.json、依赖、导出与构建/类型检查命令。内部依赖使用 `workspace:*`，源码通过包名引用。共享包采用 `src/` 源码、`dist/` 产物的结构，示例及运行时 JSON 与源码放在一起；package.json、tsconfig.json 和 README.md 留在包根目录。公开导入路径沿用 `@anynote/包名/...`，types 条件指向 `src/`，运行时指向 `dist/`。静态检查拒绝未声明的运行时依赖、跨包相对 imports 与包根目录散落的源码。

桌面 HTML 入口已移至 `apps/desktop/index.html`，Vite 从桌面 workspace 解析 React 等依赖。需要执行安装脚本的依赖有显式清单；Electron 构建工具的 Git 子依赖改用固定的注册表发行版。

```sh
pnpm -r list --depth -1
pnpm --filter @anynote/protocol build
pnpm --filter @anynote/desktop typecheck
pnpm --filter @anynote/cloudflare-backup build
pnpm run workspace:check
```

共享包包括 `backup`、`extension-host`、`extension-tools`、`first-party-adapters`、`importer`、`plugin-sdk`、`protocol`、`storage-sqlite`、`types`；扩展宿主负责首方进程生命周期和授权代理，详见 [EXTENSION-HOST.md](EXTENSION-HOST.md)。

现有 backup/storage 与 extension-tools/plugin-sdk 的循环依赖仍明确记录，pnpm 会提示。整仓后端使用统一 TypeScript 编译处理这些循环，再把产物放到各包 `dist/`；`.build` 为已有测试与 Electron 入口保留镜像，共享包镜像指向同一产物，避免加载两份模块。按包构建会编译其源依赖闭包。构建会写共享输出，使用根 `pnpm run build` 编排，不并行运行多个构建命令；尚未改造为无循环的 TypeScript project references 图。

桌面打包在 `artifacts/desktop` 克隆锁定的 workspace 依赖图与编译产物，采用 isolated、冻结锁文件、离线且禁用生命周期脚本的生产安装，再由 Electron Builder 打包。生产组装项目显式声明所需依赖，不将开发目录的 node_modules 符号链接直接打包。SDK 与独立开发工具 tarball 仍有便携构建入口，不依赖本仓库才能使用。

各发布单元的独立版本、兼容窗口、许可证与变更日志集中在 [公共包发布矩阵](RELEASE-MATRIX.md) 与 `packages/protocol/src/release.ts`；`pnpm run build:release` 生成 `artifacts/release/` 与发布清单，`pnpm run test:release:matrix` 校验兼容窗口与旧消费者。

## Vitest 测试

回归测试使用 Vitest 4.1.11，配置位于根目录 `vitest.config.ts`，与桌面 Vite 配置独立。`pnpm test` 先编译后端、检查类型合约，再执行 `tests/**/*.test.mjs`。

```sh
pnpm test
pnpm test tests/asset-range.test.mjs
pnpm run test:watch
# 后端已编译时，可直接筛选测试或测试名称
pnpm exec vitest run tests/extension-host.test.mjs
pnpm exec vitest run -t 'background import'
```

测试运行在 Node 环境，每个文件使用隔离子进程，文件按顺序执行，保证原生 SQLite、Worker、内置网络模块 Mock 和执行时间预算的稳定性。后端编译产物交由 Node 原生加载，保留 `import.meta.resolve` 和跨包模块身份。断言继续使用 `node:assert/strict`；Mock 使用 `vi.spyOn`，时钟使用 `vi.useFakeTimers`，资源清理由 `onTestFinished` 执行，全局钩子恢复 Mock、计时器和内置 ESM 导出。

`test:watch` 启动时编译一次后端，随后监听测试文件。修改后端源码后，退出监听并重新运行 `pnpm run test:watch`，以重新编译产物。UI、Electron、真实云验收脚本继续使用各自的 `test:*` 命令。CI 的 `pnpm test` 自动执行 Vitest。

## ESLint、Prettier 和提交钩子

```sh
pnpm run lint
pnpm run lint:fix
pnpm run format:check
pnpm run format
pnpm run typecheck
```

ESLint 使用 Flat Config、JavaScript/TypeScript 推荐规则；Prettier 负责格式，`eslint-config-prettier` 关闭冲突规则。当前动态 SQLite/IPC 数据边界允许显式 `any`，严格 TypeScript 编译继续独立执行。保留现有短路调用写法；空 catch、字符清洗正则及测试适配器的 `this` 别名有明确兼容配置。

安装时 `prepare` 启用 Husky；提交前 `lint-staged` 只对已暂存的源文件运行 ESLint 自动修复和 Prettier，对已暂存的文档/配置运行 Prettier。完整检查由 CI 执行。生成目录、凭据文件和用户提供的原始设计文档（`docs/*-Design.md`）排除在格式化范围外。CI 设置 `HUSKY=0`。

## 文档与本地产物

`docs/` 下只提交 Markdown 文档。验收报告与截图是 `pnpm run test:*`、`pnpm run benchmark:*` 生成的本地产物，不纳入版本库：截图写入 `docs/screenshots/`，报告写入 `test-results/`，归档报告留在 `docs/*.json`。文档中以行内代码引用这些本地路径，不提供链接。本地保留报告便于复核，重跑对应命令即可重新生成。

参考：[pnpm 配置](https://pnpm.io/settings)、[TypeScript ESLint 配置](https://typescript-eslint.io/users/configs/)、[Husky CI 设置](https://typicode.github.io/husky/how-to.html)。

## GitHub 工作流

| 工作流           | 触发                                    | 行为                                                                                                                                    |
| ---------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`         | main 推送、PR、手动运行、其他工作流调用 | 冻结安装、lint/格式/类型检查、完整测试、生产构建、Worker 离线打包、SDK/开发工具构建；保存产物 7 天                                      |
| `release.yml`    | `v*.*.*` 标签                           | 先执行 CI，标签必须匹配 package.json 版本；Linux AppImage、macOS DMG、Windows NSIS 安装包全部成功后发布 GitHub Release，附 SHA-256 清单 |
| `cloudflare.yml` | 手动运行                                | 先执行 CI，在 `cloudflare-production` 环境中对既有 D1 执行迁移，再部署 Worker                                                           |

`cloudflare.yml` 尚未启用：草稿暂存在 `docs/cloudflare.yml`，启用时移入 `.github/workflows/`。

桌面发布仅发布 GitHub Release，不发布 npm 包。当前没有代码签名与 macOS 公证配置，产物为未签名版本；后续正式分发可单独接入签名。版本标签可按以下方式创建，需先更新根 package.json 的版本并提交：

```sh
git tag v0.1.0
git push origin v0.1.0
```

Cloudflare 部署需要先配置 GitHub Environment `cloudflare-production`：

- Secret：`CLOUDFLARE_API_TOKEN`，具备目标 Worker、D1 和 R2 所需权限。
- Variables：`CLOUDFLARE_ACCOUNT_ID`、`ANYNOTE_CF_DATABASE_ID`。
- 可选 Variables：`ANYNOTE_CF_WORKER_NAME`、`ANYNOTE_CF_DATABASE_NAME`、`ANYNOTE_CF_BUCKET_NAME`；默认使用仓库 Wrangler 配置里的名称。

此工作流复用既有资源与 Worker 认证密钥，不创建桶、不重置令牌。第一次创建云资源仍使用 `pnpm run cloud:deploy` 的现有 Wrangler 流程。CI 不接触 `.env.cloud`、真实 Notebook、生产云资源或真实云验收。普通 PR 仅有仓库读取权限；写 Release 的权限仅在发布 job 中开放。

本次只交付配置与本地工具检查，按要求不触发 GitHub 工作流、不发布版本、不部署云端，也不执行桌面/云端验收。配置 GitHub 环境及推送代码后，工作流按触发条件运行。

本地验证：冻结安装、ESLint、Prettier、严格 TypeScript 和生产构建通过；233 项既有回归测试通过。SDK 与扩展开发工具的 pnpm 离线消费脚本通过。三份工作流 YAML 已完成静态解析；未在 GitHub 执行工作流。
