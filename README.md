# Anynote

本地优先的个人笔记应用，桌面使用 Rust + GPUI Kit。浏览器采集扩展与 Cloudflare Worker 保留 TypeScript/JavaScript。

Rust 桌面已有笔记、编辑、媒体、搜索、备份与恢复实现，当前仍是开发候选版本。编辑器、白板、退出保存及数据接管尚有未完成项，逐项状态以 [TODO](TODO.md#p0) 为准。旧桌面运行链已移除；不要把候选包用于接管日常资料。

## 开发

```sh
# Rust 桌面，工具链由 rust-toolchain.toml 锁定
cargo build --locked -p anynote-desktop
cargo run --locked -p anynote-desktop

# 独立浏览器扩展与 Worker：Node >=24，pnpm 版本见 package.json
pnpm install --frozen-lockfile
pnpm run build:browser
pnpm run build:worker
```

系统编译依赖、隔离数据目录和原生库见 [Rust 开发入口](docs/development/RUST-DESKTOP-DEVELOPMENT.md)。保留 TS 的源码闭包和构建方式见 [独立构建与互通](docs/development/RETAINED-TS-INTEROP.md)。根 `dev`、`desktop`、`start`、`build`、`test` 命令均指向 Rust；`test:ts` 验证保留的协议与 Worker，`test:retained` 验证 Rust 互通。旧端参考工具仅在固定提交的独立目录运行。

## 验证与候选包

```sh
cargo test --locked --workspace
python3 scripts/check-rust-workspace.py
pnpm run test:retained
python3 scripts/test-rust-release.py
python3 scripts/rust-release.py build --dir
```

PDF 预览使用系统 WebView，GPUI/真实窗口测试需相应平台环境；完整入口见 [原生回归](docs/development/RUST-NATIVE-REGRESSION.md)。候选包只包含原生桌面运行闭包，资源扫描、签名接线和平台安装条件见 [原生发行](docs/development/RUST-NATIVE-RELEASE.md) 与 [安装说明](docs/features/NATIVE-INSTALL.md)。本地构建不代表真实签名、跨平台或最终发布验收。

## 数据与能力

Notebook 使用 schema v5 SQLite 与不可变附件；正文、历史、回收站、批注及既有扩展业务数据按 [兼容契约](docs/design/RUST-DATA-COMPATIBILITY.md) 保全。Rust 当前使用隔离状态目录，正式接管与最新数据回退由 [F007](TODO.md#f007) 控制。

已知插件业务迁为 [内置业务范围](docs/design/RUST-MIGRATION-INVENTORY.md)，新桌面不提供通用插件加载、SDK 分发或 QuickJS 宿主。保留 `extension_data` 等数据字段不等于保留插件机制，也不能因字段名称删除用户数据。旧机制的文档仅用于迁移核对。

Cloudflare 提供备份与恢复，不是双向同步；浏览器扩展用于网页/对话采集与云端浏览。部署和服务资料见 [Worker](apps/cloudflare-backup/README.md)、[浏览器采集](docs/features/BROWSER-CAPTURE.md)；当前 Rust 云验证见 [云验收](docs/development/RUST-CLOUD-ACCEPTANCE.md)。

## 文档

- [文档导航](docs/README.md)：设计、开发和功能说明。
- [TODO](TODO.md)：唯一未完成任务清单。
- [退役消费者与验证接续](docs/development/RUST-LEGACY-RETIREMENT.md)：RM37 删除边界及仍需保留的参考链。
- [发行矩阵](docs/development/RELEASE-MATRIX.md)：原生桌面与保留 TS 产物。
