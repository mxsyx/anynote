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

# 复用发行扫描与资源健康检查，针对已构建的本机目录包；不安装、不发布
python3 scripts/rust-regression.py --stages payload --payload tmp/candidate/Anynote.AppDir

# 完整本地集合；--strict 使尚未闭合的验收返回 2，实际失败返回 1
python3 scripts/rust-regression.py --stages tests,boundary,formats,interop,recovery,native,webview --strict
```

产物位于新建的 `tmp/rm31/<时间>-<pid>/`，包括各阶段命令、退出码、日志、测试名称/数量、平台/架构、源码提交与 dirty 清单、lock 摘要、原生二进制摘要、采样原值及预算判定。`report.json` 分开记录 `selected_checks` 和始终需要人工核对的整体 `acceptance`；缺报告、损坏 JSON、非零退出、测试进程崩溃、空测试集合均不会通过。原生探针还要求每类样本数足够、完整滚动到顶/底，并发输入均收到后台回执。忽略的既有子进程 fixture 单独计数。超时终止整个测试进程组，即使主进程先退出，也继续清理忽略 SIGTERM 的后代；Windows 使用 `taskkill /T /F`。CI 使用同一入口并在失败时上传报告；未运行 hosted CI。

- **无头 GPUI**：复用实际组件和真实 Rust 后端子进程，测试 pointer/keyboard/Actions、保存回执、修订资源和状态。没有 DOM、CDP、React selector。
- **真实窗口探针**：`regression_probe` 使用正常 `gpui_kit::application()` 和生产 `DocumentEditor`，通过 Kit 的原生事件分发驱动。窗口生命周期复用生产入口的 `QuitMode::Explicit`，避免关闭一轮的最后编辑窗口后自动退出并丢失报告。`TestWindowExt::render_frame` 终点是同步 draw，不是 GPU/compositor present。它证明原生窗口与控件路径，不能证明物理键盘、系统 IME、读屏或真实屏幕呈现延时。
- **系统 WebView**：复用 RM27 `webview_probe` 的本地 bridge、Range、bounds、显隐、关闭与资源撤销；检查 JSON 的 requested/completed 都是 100 且 failure 为空。无远端播放。
- **进程采样**：Python 采集主进程及观察到的后代 RSS、可执行文件和 fd；macOS fd 来自 lsof，Linux 来自 `/proc`。Windows 通过 [`Win32_Process`](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process) 采集 WorkingSetSize 和 HandleCount，分别记为 `rss_bytes`、`open_handles`，不把内核句柄计作 fd；无法读取路径时保留名称及标志，根进程已退出/工作集缺失则记 unavailable。Windows 解析已用合成响应验证，仍须本机实际采样。系统拥有/重新挂接的 WebView 进程、显存及全部任务/订阅不在完整观测闭包内，报告保持 incomplete。对照旧版 110% 预算没有同机基线时不可通过。首用分配包含在整段趋势里，增长提示不是泄漏定论。
- **运行包**：`payload` 阶段复用 RM36 的文件清单、摘要、架构、旧宿主扫描及 `--release-check`，记录 manifest 身份；该检查不自动赋予 RM37 最终候选资格，也不等于 GUI 全生命周期采样。

## 稳定动作、业务断言与语料

复用生产元素 ID，例如 `workspace-create-book`、`book-<UUID>`、`node-<UUID>`、`workspace-search`、`save-document`、`source-mode`、`board-rectangle`、`board-session-save`、`image-fit`、`pdf-next`；编辑命令复用 `RunCommand` 和已有平台键绑定。缺 ID 会由 Kit 查询失败，不允许空查找后继续通过。输入校验使用解码后的 `text()`；源 Markdown 合法实体编码不等于用户输入丢失。保存逐字节核对服务端正文，并等待 UI 保存回执清除 dirty、保存按钮恢复可用，再开始下一次测量；报告分别记录点击、后台回读和 UI 等待，避免把禁用按钮上的无效点击混入保存延时。

[INV 清单](../../scripts/rust-regression-invariants.json) 为 INV-01–24 指定旧入口、当前 Rust 测试名称和剩余边界；运行结果只关联实际输出 `ok` 的测试。它是任务覆盖索引，不把单个测试等价为完整 INV 验收。完整未覆盖动作继续由 RM18/22/23 等交付。

`formats` 先重建 Rust examples，再复用 readonly/write/transfer/archive/local-backup/import 双向驱动，避免陈旧 probe 假通过；`interop` 复用 RM30 的能力、云协议和真实测试扩展。跨语言移动快照统一包含 `anynote.pdf.index` 的排序行，目标按新 note ID 重映射 key；同时覆盖双向续传、完成回执重放、恢复后不重复删源和仅 PDF 索引变化时保留源数据。移除了 `rust-write-reference.mjs` 中已退役插件设置存储行必须与 Rust 内置偏好完全相等的断言；内置设置的持久化/远端嵌入开关仍由已有 builtin、video、management 测试验证。未知扩展状态和正文/附件保真断言保留。

`regression_ui` 各执行 100 次笔记、白板、图片生命周期，包含真实文本输入、矩形绘制、主题切换、窗口 resize、图片 zoom/fit，关闭后检查实体弱引用与窗口集合。PDF 独立用例断言页面正在加载时关闭并重开；视频卡独立用例执行插入、保存、播放同意门控和关闭，保持外部嵌入禁用，不能算真实 provider 播放。系统 WebView 引擎循环由单独阶段验证。这里只证明观察到的资源释放，不宣称全部 GPU/OS 句柄无泄漏。

性能 seed 为独立的 4 库、11,064 节点（10,000 篇正文、1,000 层目录、64 条反链），首次文档 52,216 字节，持续输入文档 100 KiB。它对齐规模而非声称与旧 Electron 语料逐字节相同。每次新进程使用 seed 的私有副本；`--fixture tmp/.../seed` 可复用已完成 seed，避免重复生成。报告把首次打开与连续打开分开，均明确保留 OS 缓存；不能通过新进程或复制目录假称冷缓存。

正文投影复用批量 `Structure::for_blocks`，避免普通多段文档逐块重复扫描整篇正文；不支持的 Markdown 仍走原有逐块保留路径。滚动探针要求实际到底再回顶，记录步数；持续负载在输入/删除之前提交搜索和反链请求，绘制后核验回执。该组合仍不覆盖目录/白板滚动、备份及混合媒体负载，也不能把 3600 秒编辑循环等同一小时媒体验收。

## 2026-11-11 Linux 本地批次

环境为 Fedora 44 x86_64、锁定 Pdfium 7350，原生性能采用 release 构建及保留 OS 缓存的同机语料。以下结论不代表 RM37 最终候选或三平台验收；临时报告可删除，关键数值和边界在此保留。

本次闭合的具体回归：

- PDF 翻页取消时中断 native reader 的 SIGTRAP 已修复；原始失败发生在第 3 轮，GDB 定位到 `CPDF_SyntaxParser::ReadStream`。100 次循环复测通过；第一次修复后跑到第 86 轮曾超时，日志保留，未放宽测试超时。真实 IO 故障中的 Pdfium CHECK 风险仍见 [PDF 引擎约束](RUST-PDF-READER.md)。
- TS/Rust 移动指纹统一 PDF 索引快照，重新构建驱动后双向差分 15/15；六类格式驱动均通过。保留端扩展/云协议互通在指定本机已安装 Chromium 后通过，同机便携备份 prepare/verify 通过；不计真实云或独立设备恢复。
- 无头真实组件执行笔记、白板、图片、PDF、视频卡各 100 次生命周期；系统 WebView 独立完成 100 次引擎循环。视频仅验证插入、保存、同意门控与关闭；WebView 日志仍有 GDK frame-clock 警告，不算实际 provider 播放、焦点或所有 OS 资源无泄漏。
- Linux 缺省 sans-serif 无匹配字体时回退包内 Noto Sans，修复白板文字轮廓为空；工作区菜单栏复用现有 Shell 高度约束，修复正文/书橱被全高菜单挤出。白板回归改为当前仍不支持的连接线文字布局拒绝场景，不再要求已支持的普通开放绑定失败。

最终五进程批次 `tmp/rm31/20261111-001735-527925/report.json` 复用生产入口的显式退出模式，移除诊断用隐藏窗口。同步 draw/IPC 的既定预算均通过（`selected_checks=passed`），整体仍为 `acceptance=incomplete`；保存尾延迟和并发负载调度异常没有消失。

| 指标                        |   样本 |             结果 |      既定预算 |
| --------------------------- | -----: | ---------------: | ------------: |
| 启动至编辑器 draw p95       |      5 |        271.83 ms |     < 3000 ms |
| 首次打开 draw p95           |      5 |        211.34 ms |      < 300 ms |
| 连续打开 draw p95           |    100 |         48.94 ms |      < 300 ms |
| 100 KiB 输入 draw p95 / p99 |    500 | 36.26 / 37.93 ms | ≤ 50 / 100 ms |
| 输入最长同步 draw           |    500 |         45.06 ms |      ≤ 100 ms |
| 完整到底再回顶滚动 draw p95 |   6065 |          2.97 ms |     ≤ 16.7 ms |
| 搜索 / 反链 IPC p95         | 各 100 |  12.60 / 8.62 ms |   各 < 500 ms |
| 保存正文回读及 UI 回执 p95  |    100 |         32.65 ms |      < 150 ms |

保存 p99 **1984.77 ms**、max **2983.10 ms**；严格确认点击进入 saving 后仍出现约 1 秒的 GPUI timer 唤醒与异步回执等待，不能把原因归结为磁盘提交。带隐藏控制窗口的前一批（`20261111-001019-501424`）保存 p95 **2984.84 ms，失败**；更早未等待 UI 回执的批次也失败（p95 1932.58 ms）。不删除异常样本，不把显式退出修复等价为消除调度停顿。

单次独立诊断在 GDB 附加前以约 50 ms 间隔连续 9 次采样观察到主线程同一 DRM 等待，跨度 401.938 ms（`explicit-diagnostic/wait-observations.json`）；随后捕获 GDB 栈（`tmp/rm31/editor-profile/explicit-diagnostic/main-thread.txt`）：`X11 start_refresh_loop → X11WindowStatePtr::refresh → WgpuRenderer::draw → Surface::get_current_texture → Vulkan acquire → libvulkan_radeon x11_acquire_next_image → wsi_drm_wait_for_explicit_sync_release → drmSyncobjTimelineWait → ioctl`。这定位了该次停顿的交换链显式同步等待路径，而非保存 debounce。锁定 wgpu-core 30.0.1 的 acquire 超时为 1000 ms；定时采样不能证明采样间绝无短暂唤醒，也不足以归责 Kit 或 Mesa，但不能再以输入 draw max 45.06 ms 宣称全程主线程满足 ≤100 ms 门槛。报告该项保持 incomplete，须在其他显示后端/驱动及普通设备复验。诊断运行正常退出，不计性能预算样本。

60 秒并发输入/删除、搜索和 64 条反链完成 88 对请求及回执：双编辑动作合计 draw p95 **164.06 ms**、max **300.41 ms**，后台回执 p95 **210.95 ms**、max **1001.58 ms**。它不是逐次输入的呈现指标，当前报告没有为双动作合计另设预算；性能异常仍须定位，不能用空闲输入结果代替并发验收。尚缺备份与混合媒体负载。进程采样未观察到旧宿主，持续负载轮观察到峰值 RSS 约 236 MiB；因不含全部系统 WebView/显存、旧版同机基线和关闭后完整资源闭包，不作 RSS/泄漏预算通过结论。

完整 `--workspace --features anynote-desktop/ui-tests -- --test-threads=1` 复测通过：379 passed、0 failed、3 ignored（子进程 fixture 由父用例调用），无进程崩溃；回归报告自测 10 项及依赖边界检查通过（`20261111-001407-511644`）。此前 372 passed / 7 failed 的完整失败批次仍保留（`20261111-000101-473857`）。全目标全特性 Clippy 与无媒体 lib Clippy 均通过，后者补齐了发行检查 `Cursor` 导入的 media 条件。

包含本次字体与工作区修复的 Linux dev 目录包已通过清单、旧宿主扫描和健康检查（`20261111-001500-516237`，manifest SHA-256 `9a2532ac8d99dca50dc8ef1831c09e81f2fa676d5df20efceef805c75506b50a`）；未签名、未安装，不是 RM37 最终候选。

原始证据位于 `tmp/rm31/`：格式批次 `20261110-235050-449507`、保留端复测 `20261110-235148-458716`、恢复批次 `20261110-235002-2`、WebView 批次 `20261111-000113-477774`。早期 sandbox EPERM、缺浏览器、原生退出但缺报告、PDF 崩溃和性能失败记录均保留，不能用退出码 0 或后续局部通过覆盖它们。

## 便携恢复复现

```sh
cargo build --locked --offline -p anynote-services --example local_backup_probe --example archive_probe
python3 scripts/rust-recovery.py prepare tmp/rm31-portable-bundle
# 将 bundle 整体复制到待验收设备，再使用该设备构建的 Rust 驱动
python3 scripts/rust-recovery.py verify tmp/rm31-portable-bundle --output tmp/rm31-portable-restored
```

准备阶段使用仓库匿名黄金库，生成 Rust v3 本地备份和完整 `.anynote`，记录标准 SQL 行、历史/回收站、资源 SHA-256、批注、`extension_data`、内部链接和 FTS 命中后删除原始副本。RM33 增加全文件传输清单与两端驱动摘要；旧测试包须重新生成。验证阶段使用全新输出目录，分别执行本地 verify/restore 和 archive import，恢复身份必须变化，正文自链接和 note_links 按新库身份归一后比较；其他未知 JSON 不被归一或丢弃。完整归档按 Full 契约仅裁剪无引用资产。记录两端主机/平台，但主机名不同不自动证明物理设备独立。目录已存在时拒绝覆盖。真实用户资料、Cloudflare 和物理故障不在此驱动的默认行为中。跨设备使用 `--expected-manifest-sha256` 固定源端单独记录的摘要，详见 [RM33 便携恢复与实物步骤](RUST-DISASTER-ACCEPTANCE.md)。
