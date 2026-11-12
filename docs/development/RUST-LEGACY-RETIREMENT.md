# 旧桌面退役检查指南

本文规定旧运行链和参考工具的删除前检查。任务范围见 [F018](../../TODO.md#f018)，冻结参考环境见 [迁移语料指南](RUST-MIGRATION-BASELINE.md)。

## 运行闭包与参考闭包

| 类别         | 源码/消费者                                                                                         | 处理规则                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 原生桌面     | `apps/desktop-rust`、`crates/anynote-{core,storage,services,editor}`                                | Cargo 锁定闭包；通过 RM36 打包和扫描                                                            |
| 保留 TS      | `apps/browser-extension`、`apps/cloudflare-backup`；共享 `capture`、`importer`、`protocol`、`types` | 复用 `build-retained.mjs` 按入口可达文件编译；不能整包删除，包内非可达桌面代码须另核对          |
| 旧桌面运行链 | `apps/desktop`、`packages/{backend,backup,backup-local,storage-sqlite}`                             | 从业务参考消费者迁走后才能删除；不是把依赖从 manifest 删掉就完成                                |
| 旧插件设施   | `packages/{plugin-sdk,extension-host,extension-tools,first-party-adapters}`                         | 与旧存储及基线工具的消费者一起清理；不把 `extension_data`、未知 JSON 或样例业务数据列入删除范围 |
| 构建与发行   | 根 `package.json`、workspace/lockfile、tsconfig、旧脚本、CI                                         | 核对所有命令及消费者；`package` / `package:release` 只允许原生打包路径                          |

保留 TS 的共享包白名单只是上限，实际文件闭包由编译器输出到 `tmp/retained/<target>/closure.json`。`check-retained-builds.py` 在不复制旧桌面和旧服务的源码目录中验证独立构建。

## 删除前必须处理的具体消费者

| 消费者                                                                                          | 当前依赖                                 | 验证含义与保留方法                                                               |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `migration_probe.rs` → `rust-migration-legacy-read.mjs`                                         | Node、旧 TS `validateDirectory` / schema | Rust 最新写入后的旧端回读；不能用 Rust 自己的 reader 替换后仍声称旧端兼容        |
| `rust-migration-rehearsal.mjs`                                                                  | 旧 TS Storage、schema、目录校验          | 生成旧库、边界退出/重启、最新数据回退核验；先固化独立参考环境再移除活动依赖      |
| `rust-{readonly,write,transfer,archive,local-backup}-reference.mjs` / `rust-import-interop.mjs` | 旧 Storage/backup 与 `.build`            | 格式、资源闭包、幂等和回读业务断言须保留；冻结输入与旧 oracle 要隔离于候选运行包 |
| `rust-board-reference.mjs`                                                                      | 旧桌面 Excalidraw、React 和白板宿主源码  | 上游动作差分不是插件设施测试；完整白板动作未交付时不能删除唯一可执行参考         |
| `rust-config-fixtures.mjs` / `rust-config-electron-fixtures.mjs`                                | 清单校验和 Electron 偏好/凭据参考        | 冻结 checksum、配置和合成凭据语料；不访问真实用户凭据，不将 oracle 带入新包      |
| `rust-migration-fixtures.mjs` / `rust-migration-baseline.mjs`                                   | 旧后端、存储、媒体与 Electron            | 基线再生成工具与冻结结果不同；保留固定提交/结果，工具迁到独立参考环境            |

此表是删除前检查入口，不能代替完整消费者核对。删除时还须从根命令和 CI 反向核对消费者，包括旧云部署/验收入口；不能仅搜索文件名中的 `extension`。旧宿主注册、权限、生命周期和 SDK 打包专属测试可随机制删除；安全下载、正文/状态原子性、网络限制、格式拒绝与用户数据保全属于业务断言，继续验证。

## 删除后验证

先按 [构建与互通指南](RETAINED-TS-INTEROP.md) 检查独立构建、capability、备份恢复、采集与维护协议；再按 [原生打包指南](RUST-NATIVE-RELEASE.md) 扫描候选包。以下命令使用合成资料和本地端点：

```sh
# Node >=24；均使用合成资料和本地端点
pnpm run test:retained
pnpm run test:retained --workerd

# 不复制旧桌面源码的 TS 构建
python3 scripts/check-retained-builds.py --target browser
python3 scripts/check-retained-builds.py --target worker

# 原生候选校验；payload 是实际 .app/AppDir/Windows 目录
python3 scripts/test-rust-release.py
python3 scripts/rust-release.py verify <payload> --health
```
