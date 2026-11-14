# 旧桌面退役与参考环境

2026-11-14 已从活动工程删除 Electron/React 桌面、旧 TS 后端、SQLite/备份实现及插件 SDK、宿主、开发工具和分发链。根 `dev`、`desktop`、`start`、`build`、`test` 已切换到 Rust；CI 不再构建旧桌面或 SDK。剩余功能与最终发布证据仍见 [F018](../../TODO.md#f018)，源码删除不表示 Rust 功能或正式数据接管已验收。

## 保留边界

| 内容                 | 当前归属                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| 原生桌面             | `apps/desktop-rust` 与四个 Rust crate；Cargo 锁定闭包                                                        |
| 浏览器扩展、Worker   | 两个 TS/JS 应用，保留 capture、importer、protocol、types 的可达源码及协议测试所用纯函数                      |
| 旧机制测试           | 随旧实现移除，不为删除的机制新增测试                                                                         |
| 格式、业务、安全验证 | Rust 测试、保留 TS 测试及互通驱动；旧端差分在独立参考环境运行，不能将旧端测试通过等同于 Rust 业务覆盖        |
| 冻结语料             | `tests/fixtures` 中的格式、媒体、配置、白板及业务数据；旧 SDK JSON 样例转存 `tests/fixtures/legacy-business` |
| 用户资料与云验收状态 | 不属于删除范围；未改动日常资料、凭据或 `.cloudflare-acceptance` 样本                                         |

保留 TS 的入口与独立编译闭包见 [构建与互通](RETAINED-TS-INTEROP.md)。Worker 部署命令先独立构建 Worker；真实云验证另由 Rust 驱动显式运行。

## 固定旧端参考

参考提交为 `1aebadd57016ebfaf2e3864bad281f617f921369`。`scripts/legacy-reference.py` 使用 `git archive` 恢复到 `tmp/legacy-reference/<commit>`，该目录不属于 workspace、CI 发布路径或原生包。首次使用必须能读取该 Git 对象；浅克隆需先获取该提交。脚本不自动联网获取 Git 历史。

```sh
python3 scripts/legacy-reference.py prepare
python3 scripts/legacy-reference.py install
python3 scripts/legacy-reference.py build

# 当前 Rust 探针配合固定旧端 reader；不构建冻结提交的 Rust 实现
cargo build --locked -p anynote-storage -p anynote-services --examples
python3 scripts/legacy-reference.py run scripts/rust-readonly-reference.mjs
python3 scripts/legacy-reference.py run scripts/rust-migration-rehearsal.mjs
python3 scripts/rust-regression.py --stages formats

# Excalidraw 操作参考；结果写入独立目录，核对后才更新当前冻结语料
python3 scripts/legacy-reference.py run scripts/rust-board-reference.mjs
```

`run` 将参考目录的 `target` 链接到当前候选的 target（支持 `CARGO_TARGET_DIR`），并为迁移探针提供显式 `ANYNOTE_LEGACY_READER`。缺少旧 reader 时返回失败，不能用 Rust 自读冒充旧端回读。参考目录若已有非链接 target 会拒绝执行。不要在参考目录自行编译冻结的 Rust 工程。

生成器要求的早期基线提交与 checksum 仍按 [迁移语料指南](RUST-MIGRATION-BASELINE.md) 执行。固定提交只提供可恢复的工具源码，未证明所有旧操作已经与当前 Rust 等价。临时参考目录可以删除；持久依据是 Git 提交和已提交的 fixture。

旧真实老化驱动也在此环境运行，方法见 [云验收](RUST-CLOUD-ACCEPTANCE.md)。传入显式环境文件及既有 `--state`，保留原样本的实际时间与身份；本次退役不部署云服务、不重新 seed，也不执行到期清理。

## 验证

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:ts
python3 scripts/check-retained-builds.py --target browser
python3 scripts/check-retained-builds.py --target worker
python3 scripts/check-rust-workspace.py
pnpm run test:retained
python3 scripts/test-rust-release.py
```

原生候选扫描与实际安装仍按 [原生发行](RUST-NATIVE-RELEASE.md) 执行；本地检查不代表跨平台安装、完整原生 GUI、真实云或最终发布验收。

## 本次本地验证记录

- 浏览器与 Worker 独立源码副本构建通过；保留 TS 5 个测试文件、67 项测试通过，严格 TypeScript、ESLint、Prettier 与差异空白检查通过。
- 四个核心 crate 的 257 项测试通过；Rust 锁定依赖边界检查通过（5 个工程）；原生发行工具 13 项、发行证据检查器 18 项、回归报告工具 10 项、云验收前置检查 3 项测试通过。
- 独立旧端参考安装、编译通过；当前 Rust 的六组格式差分（只读、写入、转移、归档、本地备份、导入）通过，迁移排练的退出/重启与旧端最新数据回读通过。
- 完整本地 workerd + Chromium + Rust 互通通过，覆盖 capability、上传/恢复、pin 续租、multipart、MV3 配对/采集/浏览/降级及维护确认/恢复。另通过本地适配器的 Chromium 采集互通。

沙箱最初限制了回环监听和部分子进程；上述需要端口/子进程的检查在允许环境下重跑。本次未执行三平台原生干净重编译、最终候选包扫描、真实云或实机安装验收。详细临时日志位于 `tmp/retirement/`，持续有效的边界与结论记录于本文。
