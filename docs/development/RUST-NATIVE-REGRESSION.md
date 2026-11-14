# Rust 原生回归与性能测量

本文提供回归命令、语料使用和性能判据。设备与人工验证见 [设备验收](RUST-DEVICE-ACCEPTANCE.md)，任务状态见 [TODO](../../TODO.md)。

## 入口与证据层级

```sh
# 安装锁定库，目录必须不存在；已有安装可直接设置环境变量
python3 scripts/install-pdfium.py --output "$PWD/tmp/pdfium"
export ANYNOTE_PDFIUM_DIR="$PWD/tmp/pdfium"

# 不运行 Node；cargo --locked --offline，含 GPUI ui-tests，失败后继续其他测试目标
python3 scripts/rust-regression.py --stages tests,boundary

# 真实 OS 窗口、5 次新进程及本地系统 WebView 100 次循环
python3 scripts/rust-regression.py --stages native,webview

# 使用优化构建；3600 秒只代表编辑负载持续时间，不自动证明全部媒体老化通过
python3 scripts/rust-regression.py --stages native --release --load-seconds 3600

# Node >=24，仅作为旧格式 oracle/保留端测试进程，不成为 Rust 桌面运行依赖
# 已安装的测试浏览器可通过 CAPTURE_CHROMIUM 指定；普通 Chrome 不一定允许载入测试扩展
python3 scripts/rust-regression.py --stages formats,interop,recovery

# 复用发行扫描与资源健康检查，针对已构建的本机目录包；不安装、不发布
python3 scripts/rust-regression.py --stages payload --payload tmp/candidate/Anynote.AppDir

# 完整本地集合；--strict 使尚未闭合的验收返回 2，实际失败返回 1
python3 scripts/rust-regression.py --stages tests,boundary,formats,interop,recovery,native,webview --strict
```

产物位于新建的 `tmp/rm31/<时间>-<pid>/`，包括命令、退出码、日志、测试名称/数量、平台/架构、源码与 lock/二进制摘要、采样原值及预算判定。`report.json` 分开记录 `selected_checks` 和需人工核对的整体 `acceptance`。缺报告、损坏 JSON、非零退出、崩溃、空测试集合均不得判为通过；原生样本数、完整滚动和后台回执也须满足要求。忽略的测试单独计数，超时清理整个进程组。CI 使用同一入口并在失败时上传报告；真实 CI 证据按 F019/F030 单独验收。

- **无头 GPUI**：复用实际组件和真实 Rust 后端子进程，测试 pointer/keyboard/Actions、保存回执、修订资源和状态。没有 DOM、CDP、React selector。
- **真实窗口探针**：`regression_probe` 使用生产编辑器和 Kit 原生事件分发。测量终点是同步 draw，不是 GPU/compositor present；只能验证原生窗口与控件路径，不能证明物理键盘、系统 IME、读屏或真实屏幕呈现延时。
- **系统 WebView**：复用 RM27 `webview_probe` 的本地 bridge、Range、bounds、显隐、关闭与资源撤销；检查 JSON 的 requested/completed 都是 100 且 failure 为空。无远端播放。
- **进程采样**：采集主进程及观察到的后代 RSS、可执行文件和 fd；macOS fd 来自 lsof，Linux 来自 `/proc`。Windows 通过 `Win32_Process` 采集 WorkingSetSize 和 HandleCount，分别记为 `rss_bytes`、`open_handles`，不把内核句柄计作 fd。缺失的采样记 unavailable。系统拥有/重新挂接的 WebView 进程、显存及全部任务/订阅不在完整观测范围内，报告保持 incomplete。对照旧版 110% 预算须有同机基线；首用分配包含在整段趋势里，增长提示不是泄漏定论。
- **运行包**：`payload` 阶段复用 RM36 的文件清单、摘要、架构、旧宿主扫描及 `--release-check`，记录 manifest 身份；该检查不自动赋予 RM37 最终候选资格，也不等于 GUI 全生命周期采样。

## 动作、断言与语料

通过生产元素 ID、编辑命令和平台键绑定执行动作，元素查找失败必须终止该项。输入校验比较解码后的文本；合法 Markdown 实体编码不等于输入丢失。保存逐字节核对服务端正文，等待 UI 回执清除 dirty、保存按钮恢复可用后再开始下一次测量；分别记录点击、后台回读和 UI 等待，避免将无效点击计入保存延时。

[INV 清单](../../scripts/rust-regression-invariants.json) 为 INV-01–24 指定参考入口、Rust 测试名称和覆盖边界；运行结果只关联实际输出 `ok` 的测试。单个测试不能等价为完整 INV 验收。

`formats` 先重建 Rust examples，再执行 readonly/write/transfer/archive/local-backup/import 双向驱动；`interop` 覆盖能力协商、云协议和实际测试扩展。核对移动后的新身份映射、PDF 索引、双向续传、回执重放、源数据保留，以及未知状态和正文/附件保真。内置偏好的持久化与远端嵌入开关使用对应业务测试，不要求其存储行与退役插件设置完全相等。

`regression_ui` 各执行 100 次笔记、白板、图片生命周期，包含真实文本输入、矩形绘制、主题切换、窗口 resize、图片 zoom/fit，关闭后检查实体弱引用与窗口集合。PDF 独立用例断言页面正在加载时关闭并重开；视频卡独立用例执行插入、保存、播放同意门控和关闭，保持外部嵌入禁用，不能算真实 provider 播放。系统 WebView 引擎循环由单独阶段验证。这里只证明观察到的资源释放，不宣称全部 GPU/OS 句柄无泄漏。

性能 seed 为独立的 4 库、11,064 节点（10,000 篇正文、1,000 层目录、64 条反链），首次文档 52,216 字节，持续输入文档 100 KiB。它对齐规模而非声称与旧 Electron 语料逐字节相同。每次新进程使用 seed 的私有副本；`--fixture tmp/.../seed` 可复用已完成 seed，避免重复生成。报告把首次打开与连续打开分开，均明确保留 OS 缓存；不能通过新进程或复制目录假称冷缓存。

滚动探针要求实际到底再回顶，记录步数；持续负载在输入/删除之前提交搜索和反链请求，绘制后核验回执。该组合不覆盖目录/白板滚动、备份及混合媒体负载，不能把 3600 秒编辑循环等同一小时媒体验收。

## 性能判据

测量按相同语料、构建和缓存条件执行，预算不随单次结果调整：

| 指标                        | 既定预算      |
| --------------------------- | ------------- |
| 启动至编辑器 draw p95       | < 3000 ms     |
| 首次/连续打开 draw p95      | < 300 ms      |
| 100 KiB 输入 draw p95 / p99 | ≤ 50 / 100 ms |
| 输入最长同步 draw           | ≤ 100 ms      |
| 完整到底再回顶滚动 draw p95 | ≤ 16.7 ms     |
| 搜索 / 反链 IPC p95         | 各 < 500 ms   |
| 保存正文回读及 UI 回执 p95  | < 150 ms      |

同时记录尾延迟、最长停顿、并发负载回执、进程 RSS/句柄及未观测资源。同步 draw 不等于实际呈现，部分指标达标不能抵消主线程停顿或缺失的设备证据。性能任务见 [F009](../../TODO.md#f009)，三平台性能与资源验收见 [F029](../../TODO.md#f029)。

单次回归结果、诊断栈、构建摘要与批次历史放入 `tmp/` 或受控发行证据包，不在本文记录。

## 便携恢复复现

```sh
cargo build --locked --offline -p anynote-services --example local_backup_probe --example archive_probe
python3 scripts/rust-recovery.py prepare tmp/rm31-portable-bundle
# 将 bundle 整体复制到待验收设备，再使用该设备构建的 Rust 驱动
python3 scripts/rust-recovery.py verify tmp/rm31-portable-bundle --output tmp/rm31-portable-restored
```

准备阶段使用仓库黄金语料生成 v3 本地备份、完整 `.anynote`、逻辑预期和传输清单；验证阶段在全新目录执行双格式恢复并核对身份重映射和数据完整性。跨设备使用 `--expected-manifest-sha256` 固定源端单独记录的摘要。包格式、逐项断言与实物边界统一见 [便携恢复与实物步骤](RUST-DISASTER-ACCEPTANCE.md)。

`formats` 阶段使用 [固定参考环境](RUST-LEGACY-RETIREMENT.md)。首次运行前执行 `python3 scripts/legacy-reference.py install`；驱动通过链接使用当前工程的 Rust probes，不编译冻结提交的 Rust 实现。
