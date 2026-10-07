# TypeScript 迁移

核心产品源码已迁移到 TypeScript：`packages/`、Cloudflare Worker 与 Electron 主进程、Preload、存储进程。桌面前端继续使用 TS/TSX。测试和开发/验收脚本保留 `.mjs`，统一加载编译产物。

## 编译与运行

```sh
pnpm run typecheck       # 前端、后端及类型合约检查，不输出文件
pnpm run build:backend   # 清理 .build，编译核心，复制必要静态文件
pnpm test                # 先编译，再验证类型合约和 76 项业务回归
pnpm run build           # 核心编译 + 前端检查 + Vite 生产构建
pnpm run package         # 生成 release/linux-unpacked（当前环境为 Linux）
```

`tsconfig.backend.json` 使用 NodeNext、`strict: true`、`noEmitOnError: true`，生成 JavaScript、类型声明和 source map。源码的相对导入使用 `.js`；TypeScript 将其解析到 `.ts`，编译产物沿用有效的 `.js` 路径。没有通过关闭严格检查或 `@ts-nocheck` 跳过核心源码。

- `.ts` 编译为 ESM `.js`。
- Electron `main.cts`、`preload.cts` 编译为 CommonJS `.cjs`，保留沙箱 Preload 的加载方式。
- 生成目录为 `.build/`，已加入忽略列表，每次后端构建先清理，避免遗留已删除模块。
- `operations.json`、SDK 包信息和 D1 migrations 同步复制到对应编译目录。
- 开发、桌面启动、测试及云验收命令的前置步骤负责后端编译；生产页面和桌面包使用生成的入口及 Worker 文件。
- Wrangler 源码配置入口为 `apps/cloudflare-backup/src/index.ts`；自动部署脚本使用 `.build/apps/cloudflare-backup/src/index.js`。部署测试检查这个文件确实存在。

SDK 和协议模块的旧手写 `.d.mts` 已移除，声明由同一份源码生成。SDK 构建产物在 `.build/packages/plugin-sdk/`，其中 `package.json` 的 `.js`/`.d.ts` exports 与实际文件一致；开发时直接导入源码对应的 `.js` 路径。原 `packages/plugin-sdk/` 是源码目录，尚未作为可发布的 workspace 包接入。

## 类型边界

已显式描述后台任务及状态、备份目标、凭据、逻辑 manifest、归档进度、SDK 参数/返回值和进程消息。S3 与 Cloudflare 适配器使用联合类型并按实际实例收窄。SQLite `get()` 保留“可能没有结果”的类型；归档输入继续通过 Zod 校验后使用。

这次迁移不等同于消除所有动态类型。动态 SQL 投影集中保留 `SqlRow = Record<string, any>`；动态操作分派、JSON 和部分异常仍有显式类型边界。现有 Zod、权限、版本条件和文件校验继续承担运行时验证，TypeScript 不替代这些检查。后续可以逐项把常用 SQL 查询和操作结果收紧为专用接口。

`tests/types/contracts.ts` 仅参与编译，不执行。它验证 SDK 必填条件、资源 MIME、Notebook 范围、SQLite 空结果、任务数值字段及 IPC 消息区分；负例的 `@ts-expect-error` 如果失去作用，会使检查失败。

## 本轮验证

- 前端、核心和类型合约严格检查通过；76 项业务回归通过。
- Vite 生产构建与 Linux 应用目录打包通过。
- 官方 Wrangler/workerd 本地 D1/R2 的 12 项备份/恢复/维护检查通过；Wrangler TypeScript 源码 dry-run 通过。
- 真实 Electron 生产页面通过沙箱、Preload、SQLite Utility Process、富文本、本地保存/快照、HTML Worker、附件、离线白板、目录打开和跨库搜索检查。
- Linux 打包应用通过真实 112MiB 流式导出/导入、文件选择授权桥接、任务中心、历史/回收站及归档校验线程检查。

- 最新 Linux 打包应用的真实 Cloudflare 桌面验收 12 项通过，涵盖系统凭据加密、重启后自动备份、恢复及远端维护；见打包版云报告。

汇总结果见 `docs/typescript-acceptance.json`。本次 Worker 本地验收与 dry-run 不代表重新部署后的真实云验收。各项真实云、跨平台安装和大数据发布门槛仍以对应验收记录为准。
