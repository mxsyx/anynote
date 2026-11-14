# 开发工具与 CI

## Rust 桌面

使用锁定依赖运行 `cargo build/run/test --locked`。平台依赖、系统 WebView、工程边界和专项验证见 [Rust 开发入口](RUST-DESKTOP-DEVELOPMENT.md)。按改动范围运行 fmt、clippy、单元/集成及必要原生交互检查。

候选打包使用 `python3 scripts/rust-release.py build`，资源、签名与安装方法见 [原生发行](RUST-NATIVE-RELEASE.md)。运行 `python3 scripts/test-rust-release.py` 验证发行失败路径；`python3 scripts/test-rust-release-acceptance.py` 验证证据检查器。正式候选使用 [发行复核](RUST-RELEASE-ACCEPTANCE.md)，本地构建不替代真实 CI、签名或设备验收。

## 浏览器扩展与 Cloudflare

Node >=24，pnpm 版本以根 `packageManager` 和锁文件为准。

```sh
pnpm install --frozen-lockfile
pnpm run build:browser
pnpm run build:worker
pnpm run test:retained
```

独立构建与跨语言协议见 [保留 TS 互通](RETAINED-TS-INTEROP.md)。尚需旧程序生成语料或回读的工具仅用于隔离参考环境，消费者及清理顺序见 [退役契约](RUST-LEGACY-RETIREMENT.md)。

## 质量与工作流

保留 TS 使用现有 ESLint、Prettier、严格 TypeScript 及相关回归；提交钩子只处理暂存文件，不能替代 CI。生成目录和凭据不得作为源文件提交。

| 工作流                    | 用途                                          |
| ------------------------- | --------------------------------------------- |
| `rust.yml`                | Rust 工程及原生检查                           |
| `retained.yml`            | 浏览器/Worker 独立构建与互通                  |
| `release.yml`             | 原生候选构建、可选签名/公证及工件，不直接发布 |
| `release-credentials.yml` | 发行凭据字段预检，不替代真实身份验证          |

真实云验收使用 [云方法](RUST-CLOUD-ACCEPTANCE.md)，部署方法见 [Cloudflare 验收准备](validation/CLOUD-ACCEPTANCE.md)。普通回归不使用日常 Notebook 或生产云资料。

## 文档与临时产物

开始时核对 [TODO](../../TODO.md) 与现有契约，结束后只保留剩余任务和稳定设计。单次报告、截图和日志放 `tmp/`，文档规则见 [文档维护](DOCUMENTATION.md)。

## 旧端对照

旧 Electron/TS 后端与插件构建命令已删除。需要格式回读、Excalidraw 或旧端业务对照时，使用 [独立参考环境](RUST-LEGACY-RETIREMENT.md)，不能在当前工程执行 `build:backend`。
