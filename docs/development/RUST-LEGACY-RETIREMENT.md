# RM37 旧桌面退役与消费者接续

2026-11-10 核对。任务状态和阻塞只在 [TODO RM37](TODO.md#rm37) 维护。本文固定消费者边界、迁移方法和本次证据；不是删除清单执行脚本，也不授权发布或接管用户资料。

## 运行闭包与参考闭包

| 类别         | 源码/消费者                                                                                         | 处理规则                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 原生桌面     | `apps/desktop-rust`、`crates/anynote-{core,storage,services,editor}`                                | Cargo 锁定闭包；通过 RM36 打包和扫描                                                                |
| 保留 TS      | `apps/browser-extension`、`apps/cloudflare-backup`；共享 `capture`、`importer`、`protocol`、`types` | 复用 `build-retained.mjs` 按入口可达文件编译；不能整包删除，包内非可达桌面代码须另核对              |
| 旧桌面运行链 | `apps/desktop`、`packages/{backend,backup,backup-local,storage-sqlite}`                             | 从业务参考消费者迁走后才能删除；不是把依赖从 manifest 删掉就完成                                    |
| 旧插件设施   | `packages/{plugin-sdk,extension-host,extension-tools,first-party-adapters}`                         | 与旧存储及基线工具的消费者一起清理；不把 `extension_data`、未知 JSON 或样例业务数据列入删除范围     |
| 构建与发行   | 根 `package.json`、workspace/lockfile、tsconfig、旧脚本、CI                                         | 当前旧开发入口仍存在；原生 `package` / `package:release` 已由 RM36 接管，不能恢复 Electron 打包路径 |

保留 TS 的共享包白名单只是上限，实际文件闭包由编译器输出到 `tmp/retained/<target>/closure.json`。`check-retained-builds.py` 在不复制旧桌面和旧服务的源码目录中验证独立构建。本次没有改动共享业务字段或数据格式。

## 删除前必须处理的具体消费者

| 消费者                                                                                          | 当前依赖                                 | 验证含义与保留方法                                                               |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `migration_probe.rs` → `rust-migration-legacy-read.mjs`                                         | Node、旧 TS `validateDirectory` / schema | Rust 最新写入后的旧端回读；不能用 Rust 自己的 reader 替换后仍声称旧端兼容        |
| `rust-migration-rehearsal.mjs`                                                                  | 旧 TS Storage、schema、目录校验          | 生成旧库、边界退出/重启、最新数据回退核验；先固化独立参考环境再移除活动依赖      |
| `rust-{readonly,write,transfer,archive,local-backup}-reference.mjs` / `rust-import-interop.mjs` | 旧 Storage/backup 与 `.build`            | 格式、资源闭包、幂等和回读业务断言须保留；冻结输入与旧 oracle 要隔离于候选运行包 |
| `rust-board-reference.mjs`                                                                      | 旧桌面 Excalidraw、React 和白板宿主源码  | 上游动作差分不是插件设施测试；完整白板动作未交付时不能删除唯一可执行参考         |
| `rust-config-fixtures.mjs` / `rust-config-electron-fixtures.mjs`                                | 清单校验和 Electron 偏好/凭据参考        | 冻结 checksum、配置和合成凭据语料；不访问真实用户凭据，不将 oracle 带入新包      |
| `rust-migration-fixtures.mjs` / `rust-migration-baseline.mjs`                                   | 旧后端、存储、媒体与 Electron            | 基线再生成工具与冻结结果不同；保留固定提交/结果，工具迁到独立参考环境            |

该表是本次核对的迁移参考消费者，不冒充全部测试逐项迁移完成。删除时还须从根命令和 CI 反向核对消费者，包括旧云部署/验收入口；不能仅搜索文件名中的 `extension`。旧宿主注册、权限、生命周期和 SDK 打包专属测试可随机制删除；安全下载、正文/状态原子性、网络限制、格式拒绝与用户数据保全属于业务断言，继续验证。

## 已迁移的维护协议回归

`rust-maintenance-reference.mjs` 的内存适配器和 local-workerd 两种路径现在都读取 `apps/cloudflare-backup/dist/src/index.js`，不再读取 `.build`。入口复用现有 `test-retained.mjs`：独立构建浏览器/Worker，编译 Rust `cloud_probe` 和 `maintenance_probe`，执行 capability、备份恢复、采集与维护回归。CI 保存维护报告和 Worker 日志。

```sh
# Node >=24；均使用合成资料和本地端点
pnpm run test:retained
pnpm run test:retained --workerd

# 单独复验维护协议
pnpm run build:worker
cargo build --locked -p anynote-services --example maintenance_probe
node scripts/rust-maintenance-reference.mjs
node scripts/rust-maintenance-reference.mjs --workerd

# 不复制旧桌面源码的 TS 构建
python3 scripts/check-retained-builds.py --target browser
python3 scripts/check-retained-builds.py --target worker

# 原生候选校验；payload 是实际 .app/AppDir/Windows 目录
python3 scripts/test-rust-release.py
python3 scripts/rust-release.py verify <payload> --health
```

采集回归使用 Playwright Chromium；可通过既有 `CAPTURE_CHROMIUM` 指向已安装的测试浏览器。首次本机执行因 localhost 监听沙箱限制失败；允许本地监听后，默认 Playwright 版本又缺少对应浏览器，需设置该变量。不得把这些失败记为协议通过。

本次包校验复用 RM36 的 Mac arm64 候选，仅证明该候选文件与资源自检通过；没有生成退役后的 RM37 最终候选包，也没有做 Rust 全量干净构建、实签或日常资料接管。正式产物必须在源码清理完成后重新构建、扫描和记录版本。

## 本次验证证据

Mac arm64、Node 24.22.0、已安装 Chromium 156：浏览器和 Worker 源码隔离构建通过；local-workerd 协议降级 5 组、备份恢复 16 组、实际扩展采集 9 组、维护协议 9 组全部通过。维护驱动的故障适配器模式另有 12 组通过。发行失败路径 13 项通过，RM36 既有候选文件/资源自检通过。相关脚本 ESLint、格式检查与 diff 空白检查通过。

原始输出位于 `tmp/rm37-{workerd,maintenance,release,payload,isolated-browser,isolated-worker}.log`，逐项报告仍写入各驱动既有的 `tmp/rm10`、`tmp/rm11`、`tmp/rm12`、`tmp/rm30` 目录；删除临时文件不影响上述方法与结论。首次完整适配器入口在 Chromium 路径缺失处失败，后续完整通过证据来自显式指定浏览器的 local-workerd 入口，不能声称两套完整入口都通过。
