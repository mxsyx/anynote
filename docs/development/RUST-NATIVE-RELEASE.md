# 原生候选打包与发行

本文提供候选构建、资源校验、签名和安装方法。最终放行要求见 [发行复核](RUST-RELEASE-ACCEPTANCE.md)，任务状态见 [TODO](../../TODO.md)。

## 构建与校验

```sh
# 本机目标自动识别；默认优化构建，输出到 tmp/rm36/<target>-<timestamp>
python3 scripts/rust-release.py build
python3 scripts/rust-release.py build --dir
# 重用经过 pin 验证的 Pdfium 下载，显式目录必须尚不存在
python3 scripts/rust-release.py build --target mac-arm64 \
  --pdfium-archive tmp/rm25/pdfium-mac-arm64.tgz --output tmp/rm36/candidate
python3 scripts/rust-release.py verify tmp/rm36/candidate/Anynote.app --health
python3 scripts/test-native-payload.py tmp/rm36/candidate/Anynote.app
python3 scripts/test-rust-release.py
```

`pnpm package` / `package:release` 转发到 Python 入口，不构建 JS 桌面；`scripts/package-desktop.mjs` 提供命令别名。打包需 Python ≥3.12、`rust-toolchain.toml` 锁定的 Rust 及本平台工具。先 `cargo fetch --locked`，之后 Cargo 构建/依赖清单强制 `--locked --offline`。

配置唯一来源为 `apps/desktop-rust/native/release.json`。候选矩阵为 macOS arm64/x64、Windows MSVC x64、Linux GNU x64；不把已有 Pdfium win-arm64 pin 当作 Windows arm64 支持声明。构建必须在对应原生架构 runner 上执行。版本核对根 Cargo/package.json，标签构建额外核对 `v<version>`。

- macOS：`.app/Contents/MacOS/anynote-desktop` 与 `Contents/Resources/pdfium`，`hdiutil` 生成/校验 DMG。
- Windows：NSIS 每用户安装，沿用 `app.anynote.desktop` 推导出的旧卸载 GUID；Pdfium 在可执行文件相邻 `pdfium/bin`。`dumpbin` 保存动态依赖，MSVC WebView2 loader 静态链接，系统 WebView2 Runtime 单独预装。
- Linux：AppDir `usr/bin` 中放程序与 Pdfium，AppRun 直接启动 Rust；appimagetool 和 type2 runtime 的下载地址、asset ID、SHA-256 均锁定。上游 continuous 资产变化时下载校验失败，必须评审新 pin，不能自动接受新哈希。生成后解包并再次核对文件与资源自检。

系统依赖、离线边界和数据路径详见 [原生安装条件](../features/NATIVE-INSTALL.md)。安装不改变既有 `anynote-rust` 隔离运行路径，也不把它改成旧 userData；旧目录和外部笔记本完整保留，正式接管保持 RM14 门控。

## 资源与完整性

Pdfium 原始压缩包和库各验一次仓库 pin；只复制库、VERSION、许可证。Noto Sans 基础字体编入 Rust，同时用于 GPUI 字体注册及 SVG/白板字体解析，许可证随包。图标、shader、内置 WebView 页面由现有 Rust 编译链内嵌，不复制 Electron、Node、React、插件宿主或其分发资源。

文件扫描拒绝符号链接、旧宿主路径、`.asar/.node`，记录每个文件 SHA-256、大小和可执行位。外置 `<payload>.manifest.json` 在签名/装订完成后生成，避免签名资源封印与二进制哈希循环。Mac 校验 Info.plist 身份和版本，所有平台识别 Mach-O/PE/ELF 机器码并核对目标架构；`--release-check` 在无窗口、无用户数据库、无网络下载条件下验证版本/架构/schema、基础字体和 Pdfium 打开/渲染。

许可证收集限定 Cargo 目标依赖闭包，保存 SPDX 元数据与原有 LICENSE/COPYING/NOTICE。缺少独立文件的 crate 补官方源码通知（`native/notices/index.json` 固定 URL/hash），并保留通过 Cargo.lock checksum 校验的原始 `.crate`、原始 Cargo 元数据以及适用的 SPDX 全文；不编造版权持有人。许可证元数据、归档或补充文本 hash 缺失/不匹配会阻止构建。这是资源和声明校验，不代替最终发行的许可证审查。

`candidate.json` 记录版本、架构、profile、签名状态、manifest/安装包 hash 与资源自检；`SHA256SUMS.txt` 是内容校验和。无正式身份的 macOS 包使用 ad-hoc 签名以便本机运行，报告仍标记 `unsigned-candidate`。

最终候选必须包含源码 commit/tree/干净状态、构建前后身份一致性、规范 Cargo.lock 摘要、公开 CI run/attempt/runner 身份及 macOS 公证请求 ID。缺来源字段的候选不能回填后用于最终发行复核；应从最终干净源码重新构建。汇总入口与实签设备证据要求见 [最终发行复核](RUST-RELEASE-ACCEPTANCE.md)。

## 签名与公证

```sh
python3 scripts/rust-release.py credentials --target mac-arm64
python3 scripts/rust-release.py build --target mac-arm64 --sign
python3 scripts/rust-release.py verify <Anynote.app> --signed --health
```

- macOS：本机钥匙串中已有 Developer ID Application 身份，设置 `ANYNOTE_MAC_SIGN_IDENTITY`、`ANYNOTE_MAC_TEAM_ID`、`ANYNOTE_NOTARY_PROFILE`；非默认钥匙串可设 `ANYNOTE_MAC_KEYCHAIN`。先签 Pdfium，再把签后 hash 通过 **编译时** `ANYNOTE_PACKAGED_PDFIUM_SHA256` 写入程序，然后签整个 app。启用 hardened runtime 和时间戳；签名验证固定 Apple trust anchor 和 Team ID。ZIP 提交 `notarytool --wait` 必须返回 `Accepted`，app staple/validate 后再生成 DMG，DMG 再签名、公证和 staple/validate。运行时仍检查真实库 hash，不信任可修改的旁置 manifest。
- Windows：用户证书库已有证书，设置 `ANYNOTE_WIN_CERT_SHA1`、`ANYNOTE_WIN_TIMESTAMP_URL`。先签 DLL，再编译固定 hash、签主程序；NSIS `!uninstfinalize` 签卸载程序，最后签安装器。每次都执行 Authenticode 验证并核对预期 thumbprint；缺配置、错误签名或签名工具失败均终止。
- Linux：仅提供内容校验和，`--sign` 明确拒绝；发布者签名策略见 F019，可选自动更新见 [F032](FUTURE-TODO.md#f032)，由 F017 确认首发范围。CI 不把 Linux 校验和标记为已签名。

手动 `release.yml` 的 `sign=true` 使用 `release` environment：`identity.py` 在 runner 临时目录从 base64 P12 导入证书；Mac 用临时 keychain 和 Apple ID/app-specific password 建 notary profile，Windows 用 CurrentUser/My。`always` 步骤删除临时身份；密码、证书与命令 repr 不写报告。配置字段见 [发行凭据](RELEASE-CREDENTIALS.md)。

Apple 接口遵循 [公证流程](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)，NSIS 卸载签名使用其 [编译期签名钩子](https://nsis.sourceforge.io/Docs/Chapter5.html#uninstfinalize)。

## 安装升级及失败回退

```sh
# 用户明确选择的隔离目录；正式包省略 allow-unsigned 参数并提供预期签名身份
python3 scripts/rust-release.py install <payload> <destination> \
  --allow-unsigned-candidate --notebook <closed-notebook-copy>
```

目录安装事务先校验清单/身份，复制到目标同卷临时目录，清除开发环境 Pdfium 覆盖后运行自检；可选 `--notebook` 调用现有 `ReadonlyNotebook::open` 拒绝不支持 schema，不另写宽松检查。然后旧安装改名 `.previous`，激活候选并再次自检；外置清单与旧目录一起保留，后检失败将候选及清单移到 `.failed`、恢复匹配的旧目录和清单。发生回退重命名失败时保留 install-lock，要求人工核对。崩溃锁和已有 previous/failed 不自动清理。它只安装二进制目录，不停止用户进程、不迁移或恢复数据库。

Windows NSIS 使用同样的候选预检/旧目录保留/后检回退流程；候选与 previous 遗留时拒绝覆盖，非应用目录不接管，卸载保留数据。Mac Finder 拖放和直接替换 AppImage 属于手动复制，不具备此处的脚本事务保证；用上述目录安装入口可验证回退。后台自动更新的范围单独见 [F032](FUTURE-TODO.md#f032)。

## CI 与验收边界

- `rust.yml`：fmt、all-targets/all-features clippy、仓库依赖边界、原生测试、Xvfb 真实窗口/键盘/剪贴板/对话框及打包失败路径测试。
- `retained.yml`：RM30 浏览器/Worker 隔离构建和 Rust/TS 互通，作为独立可复用 workflow。
- `release.yml`：依赖上述检查，四架构原生构建、资源扫描、安装/升级/schema/篡改回归；上传候选安装器和证据，**不创建 GitHub Release、不部署**。macOS runner 用当前支持的 `macos-15` / `macos-15-intel`。

构建与本地资源检查不能替代真实 Developer ID/公证/Authenticode、各目标平台安装、hosted CI、干净设备离线首用/卸载或正式原路径接管。逐项要求见 [发行复核](RUST-RELEASE-ACCEPTANCE.md)。
