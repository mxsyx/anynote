# 原生候选包安装条件

当前是 Rust 迁移候选，尚未通过 RM37/38 的正式发行门槛。应用身份保持 `app.anynote.desktop` / Anynote。请在隔离账户或测试目录试装，原客户端和日常资料接管由 RM14/38 单独验收。

| 候选目标          | 包               | 首次离线运行前的系统条件                                                                                                       |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| macOS arm64 / x64 | Anynote.app、DMG | macOS 12+、系统 Metal/WKWebView；真实最低系统仍待设备验证                                                                      |
| Windows x64       | 每用户 NSIS EXE  | Windows 10/11、图形驱动、VC++ 2015–2022 x64 Runtime、WebView2 Runtime ≥101；须提前安装运行时                                   |
| Linux x64         | AppImage         | Ubuntu 24.04 构建基线、glibc 2.39+、X11/XWayland、Vulkan 驱动、Fontconfig、GTK3、WebKitGTK 4.1、OpenSSL 3、FUSE2（或解包运行） |

PDF 使用系统 WebView 自带查看器；Noto Sans 基础字体和许可证随包交付；Lucide 图标、Metal shader、内置 WebView 页面编入程序。Excalidraw/React、白板字体及第三方许可证编入程序；中文和 Emoji 的最终呈现仍依赖系统字体与引擎。系统 WebView 运行环境齐备后，图片/PDF/本地白板无需公网即可首次初始化；PDF 引擎不支持预览时可导出原件；网页视频、云和公网下载功能需要网络。Linux 并非包含所有系统库的通用发行版镜像。

Windows 正常启动会在需要时以 `GPUI_DISABLE_DIRECT_COMPOSITION=1` 重启自身，让系统 WebView 使用受支持的宿主模式。设备层视频/键盘/DPI 验收仍未完成。

## 数据和升级

安装器只修改安装目录，不移动、不转换、不删除用户数据。旧 Electron 数据位置（macOS `~/Library/Application Support/anynote`、Windows `%APPDATA%/anynote`、Linux `$XDG_CONFIG_HOME/anynote` 或 `~/.config/anynote`）及用户指定的 `ANYNOTE_USER_DATA_DIR` 均保留；实际旧路径以原应用配置为准。Rust 候选继续使用既有 `anynote-rust` 隔离状态目录或显式 `ANYNOTE_RUST_STATE_DIR`，不把新安装视为原路径已接管。

- macOS 可挂载 DMG；升级前退出程序并保留旧 `.app`。拖放是系统复制操作，无自动回退保证。需要事务回退时使用开发文档的 `rust-release.py install`，它复制到同卷临时目录、自检、切换目录，再次自检；失败恢复旧目录。
- Windows 安装器先解包到 `.candidate`、运行资源自检，再将旧安装改名为 `.previous`。切换后自检失败恢复旧目录。保留的 `.previous` 阻止下一次升级，核验后由用户归档。安装中断或锁文件导致回退失败时保留目录并提示人工恢复。安装器不关闭正在运行的程序。
- Linux 可先 `chmod +x` 后运行 AppImage；没有 FUSE 时用 `--appimage-extract` 解包。事务目录安装适用于解包后的 AppDir，失败保留旧目录。AppImage 文件替换可手动保留旧文件回退。
- 卸载只移除应用，不清理笔记本、备份、凭据或外部目录。回退二进制不回退用户数据；不支持的 notebook schema 由存储层只读校验拒绝。

没有后台自动更新、更新元数据签名或差分升级；可选自动更新见 [F032](../development/FUTURE-TODO.md#f032)，是否首发由 [F017](../../TODO.md#f017) 确认。校验和只检验内容，不能替代发布者签名。未签名候选包不能作为正式发行版本。
