# Rust 原生回归与性能证据（RM31）

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

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

# 完整本地集合；--strict 使尚未闭合的验收返回 2，实际失败返回 1
python3 scripts/rust-regression.py --stages tests,boundary,formats,interop,recovery,native,webview --strict
```

产物位于新建的 `tmp/rm31/<时间>-<pid>/`，包括各阶段命令、退出码、日志、测试名称/数量、平台/架构、源码提交与 dirty 清单、lock 摘要、原生二进制摘要、采样原值及预算判定。`report.json` 分开记录 `selected_checks` 和始终需要人工核对的整体 `acceptance`；缺报告、非零退出、测试进程崩溃、空测试集合均不会通过。忽略的既有子进程 fixture 单独计数。CI 使用同一入口并在失败时上传报告；未运行 hosted CI。

- **无头 GPUI**：复用实际组件和真实 Rust 后端子进程，测试 pointer/keyboard/Actions、保存回执、修订资源和状态。没有 DOM、CDP、React selector。
- **真实窗口探针**：`regression_probe` 使用正常 `gpui_kit::application()` 和生产 `DocumentEditor`，通过 Kit 的原生事件分发驱动。`TestWindowExt::render_frame` 终点是同步 draw，不是 GPU/compositor present。它证明原生窗口与控件路径，不能证明物理键盘、系统 IME、读屏或真实屏幕呈现延时。
- **系统 WebView**：复用 RM27 `webview_probe` 的本地 bridge、Range、bounds、显隐、关闭与资源撤销；检查 JSON 的 requested/completed 都是 100 且 failure 为空。无远端播放。
- **进程采样**：Python 采集主进程及观察到的后代 RSS、可执行文件和 fd；macOS fd 来自 lsof，Linux 来自 `/proc`。Windows 采集器尚缺。系统拥有/重新挂接的 WebView 进程、显存及全部任务/订阅不在完整观测闭包内，报告保持 incomplete。对照旧版 110% 预算没有同机基线时不可通过。首用分配包含在整段趋势里，增长提示不是泄漏定论。

## 稳定动作、业务断言与语料

复用生产元素 ID，例如 `workspace-create-book`、`book-<UUID>`、`node-<UUID>`、`workspace-search`、`save-document`、`source-mode`、`board-rectangle`、`board-session-save`、`image-fit`、`pdf-next`；编辑命令复用 `RunCommand` 和已有平台键绑定。缺 ID 会由 Kit 查询失败，不允许空查找后继续通过。输入校验使用解码后的 `text()`；源 Markdown 合法实体编码不等于用户输入丢失。保存仍逐字节核对服务端正文。

[INV 清单](../../scripts/rust-regression-invariants.json) 为 INV-01–24 指定旧入口、当前 Rust 测试名称和剩余边界；运行结果只关联实际输出 `ok` 的测试。它是任务覆盖索引，不把单个测试等价为完整 INV 验收。完整未覆盖动作继续由 RM18/22/23 等交付。

`formats` 复用 readonly/write/transfer/archive/local-backup/import 双向驱动，`interop` 复用 RM30 的能力、云协议和真实测试扩展。移除了 `rust-write-reference.mjs` 中已退役插件设置存储行必须与 Rust 内置偏好完全相等的断言；内置设置的持久化/远端嵌入开关仍由已有 builtin、video、management 测试验证。未知扩展状态和正文/附件保真断言保留。

`regression_ui` 各执行 100 次笔记、白板、图片生命周期，包含真实文本输入、矩形绘制、主题切换、窗口 resize、图片 zoom/fit，关闭后检查实体弱引用与窗口集合。PDF 独立用例包含页面尚在加载时关闭并重开，避免 PDF 崩溃掩盖其他三类循环结果。这里只证明观察到的资源释放，不宣称全部 GPU/OS 句柄无泄漏。

性能 seed 为独立的 4 库、11,064 节点（10,000 篇正文、1,000 层目录、64 条反链），首次文档 52,216 字节，持续输入文档 100 KiB。它对齐规模而非声称与旧 Electron 语料逐字节相同。每次新进程使用 seed 的私有副本；`--fixture tmp/.../seed` 可复用已完成 seed，避免重复生成。报告把首次打开与连续打开分开，均明确保留 OS 缓存；不能通过新进程或复制目录假称冷缓存。

## 便携恢复复现

```sh
cargo build --locked --offline -p anynote-services --example local_backup_probe --example archive_probe
python3 scripts/rust-recovery.py prepare tmp/rm31-portable-bundle
# 将 bundle 整体复制到待验收设备，再使用该设备构建的 Rust 驱动
python3 scripts/rust-recovery.py verify tmp/rm31-portable-bundle --output tmp/rm31-portable-restored
```

准备阶段使用仓库匿名黄金库，生成 Rust v3 本地备份和完整 `.anynote`，记录标准 SQL 行、历史/回收站、资源 SHA-256、批注、`extension_data`、内部链接和 FTS 命中后删除原始副本。RM33 增加全文件传输清单与两端驱动摘要；旧测试包须重新生成。验证阶段使用全新输出目录，分别执行本地 verify/restore 和 archive import，恢复身份必须变化，正文自链接和 note_links 按新库身份归一后比较；其他未知 JSON 不被归一或丢弃。完整归档按 Full 契约仅裁剪无引用资产。记录两端主机/平台，但主机名不同不自动证明物理设备独立。目录已存在时拒绝覆盖。真实用户资料、Cloudflare 和物理故障不在此驱动的默认行为中。跨设备使用 `--expected-manifest-sha256` 固定源端单独记录的摘要，详见 [RM33 便携恢复与实物步骤](RUST-DISASTER-ACCEPTANCE.md)。
