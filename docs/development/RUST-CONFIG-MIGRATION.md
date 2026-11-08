# Rust 配置与凭据读取器

RM13 的离线读取与转换入口位于 `crates/anynote-services/src/config_migration/`。它只处理关闭后的保全副本，不自动发现或接管日常 userData，不改 Notebook schema v5。完整复制、互斥、journal、发布、调度恢复及旧程序回退由 [RM14](TODO.md#rm14) 接线；真实安装和三平台兼容结论归 [RM32](TODO.md#rm32)。当前实现范围与验证摘要见 [RM13 实施记录](IMPLEMENTATION.md#rm13)。

## Local Storage

`preferences::read_preferences(directory, origin, electron_version)` 锁定 Electron **41.9.1**，只接受 `file://` 或 `http://127.0.0.1:5173`，一次只读取一个 origin，不混合开发与发行配置。输入为完整 `Local Storage/leveldb` 副本；全部文件装入 `rusty-leveldb` 的 MemEnv，恢复日志与临时表均在内存中，原副本的字节不变。数据库预算 64 MiB / 4096 个文件，单值 1 MiB；超限拒绝，不截断。

Chromium 的字符串标记 0 按 UTF-16LE 解码，标记 1 按 Latin-1 解码。孤立 surrogate、非法编码、白名单键的非法值会增加 rejected 计数，使 `is_complete()` 为 false；原始字节继续保留在源副本。未知键忽略，其他 origin 不提取。数据库损坏直接失败，不发布“完整迁移”。

`rusty-leveldb 4.0.1` 的日志恢复和表迭代会忽略部分读取错误，因此打开前另检查 WAL/MANIFEST 的 CRC32C、分片、写批次，以及 SST footer、索引、数据块、Snappy、校验和及重启项结构。该检查是有界兼容适配，不是通用数据库修复工具；不支持的压缩/格式明确拒绝。

| 旧键                                    | Rust 键                                        |
| --------------------------------------- | ---------------------------------------------- |
| `anynote.appearance`                    | 原键                                           |
| `anynote.navigation.tabs`               | 原键                                           |
| `anynote.notebooks.visits`              | 原键                                           |
| `anynote-recent`                        | `anynote.navigation.recent`                    |
| `anynote-book`                          | `anynote.navigation.activeBook`                |
| `anynote-pdf-<book UUID>-<note UUID>`   | `anynote.reader.pdf.<book UUID>.<note UUID>`   |
| `anynote-image-<book UUID>-<note UUID>` | `anynote.reader.image.<book UUID>.<note UUID>` |

值保留原 localStorage 字符串，先按已知外观/导航/PDF/图片结构验证，避免 JSON 重新序列化改变原值。`Preferences::save` 输出 `<userData>/rust/preferences.json`，格式 `anynote.preferences.v1`，`values` 为点分层键到原字符串的映射；temp + flush + 同目录替换，Unix 同步父目录。调用方必须先提供私有目录并确认读取报告完整。Windows 的目录持久性、ACL 和断电恢复由 RM32/33 验证。

`Preferences::reverse()` 输出已知旧键与原字符串，拒绝未知新键/非法值；它不写 Chromium 目录。RM14 回退时须在完整副本中应用并由旧客户端回读后发布。

## 凭据

`credentials::decrypt_legacy` 为锁定版本的一次性只读原型；不调用 Electron/Node，也不创建或替换旧平台主密钥。旧应用身份必须由预检提供，不能猜测其他应用的 keyring 条目。

| 平台                                                          | 原生只读路径                                                                                                   | 当前证据                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Linux Secret Service                                          | 按 application + `chrome_libsecret_os_crypt_password_v2` 查询唯一未锁定条目；`v11`、PBKDF2-SHA1/1、AES-128-CBC | 独立 D-Bus、私有 GNOME Keyring、Electron 41.9.1 → Rust → 新 OS 条目回读通过 |
| macOS                                                         | Security.framework 查询指定 service/account；`v10`、PBKDF2-SHA1/1003、AES-128-CBC                              | 独立 Node 加密向量通过；原生分支尚未编译或真机验证                          |
| Windows                                                       | 从副本 Local State 读取 `os_crypt.encrypted_key`，DPAPI 只读解包，`v10` AES-256-GCM                            | 独立 Node 加密向量通过；DPAPI/Credential Manager 分支尚未编译或真机验证     |
| basic_text、KWallet、未知版本/封装、跨平台复制、锁定/拒绝访问 | 明确失败，不使用默认密码或明文回退                                                                             | 自动化失败路径与保全测试                                                    |

新 OS 条目使用 service `app.anynote.credentials`、account `secret.<原 secret UUID>`。`OsSecretStore` 仅启用各平台真实后端：Linux Secret Service / macOS Keychain / Windows Credential Manager；不使用 keyring 的默认 mock 后端。阻塞调用应在专用凭据线程运行，不能放入 UI 或 Tokio runtime 线程。

`migrate_credential` 先按原 secret ID 保全 `.bin` 密文，再在内存解密、校验凭据 JSON、写新 OS 条目并逐条回读。缓冲区使用 Zeroizing；报告只含连接 ID、secret ID、密文 SHA-256、枚举状态和脱敏原因。不会覆盖同 ID 下已有的不同秘密，也不删除旧密文。失败返回 `ReauthenticationRequired`，成功返回 `MigratedAwaitingCapabilityCheck`；两者均 `tasks_paused=true`。RM14/备份服务消费此结果时保留原连接、endpoint、分支和共享游标，重新认证后仍须做原 endpoint capability 验证，不能因凭据回读成功自动恢复发布/清理。

Windows DPAPI 有一个局部允许 unsafe 的 FFI 边界：系统输出复制后清零并 LocalFree；没有在 workspace 放宽 unsafe 规则。新秘密不会逆写旧 safeStorage；回退旧程序时需重新认证，不能将旧密文当作最新凭据。

格式核对来源：[Electron 41.9.1 safeStorage](https://github.com/electron/electron/blob/v41.9.1/shell/browser/api/electron_api_safe_storage.cc)、Chromium 146 [Windows](https://github.com/chromium/chromium/blob/146.0.7680.0/components/os_crypt/sync/os_crypt_win.cc)、[macOS](https://github.com/chromium/chromium/blob/146.0.7680.0/components/os_crypt/sync/os_crypt_mac.mm)、[Linux Secret Service](https://github.com/chromium/chromium/blob/146.0.7680.0/components/os_crypt/sync/key_storage_libsecret.cc)、[keyring 3.6.3](https://docs.rs/keyring/3.6.3/keyring/)。这些是原型实现依据，不能替代安装包对应版本的实机验证。

## 插件状态

`plugins::convert_state` 接收保全 registry entry 和 `extension_data` 原行。已知 manifest/版本/校验和来自旧 TS `installableManifestSchema` 和 `JSON.stringify` 规则生成的冻结材料；还验证设置 schema checksum、行版本、revision 和值类型。不会解释 manifest 的 `dataMigrations` 或执行任意脚本。

- `garden.preferences` 0.1.0 / 0.1.1：设置 schema 1，已知 checksum；`target` → `goal`，输出 `anynote.reading.preferences` / version 1。
- `garden.session` 0.1.0 / 0.1.1：状态 schema 1 / 2；`runs` → `visits`，保留未知字段，缺省 `lastTitle`，输出 `anynote.reading.session` / version 1。
- 其他 ID、版本、checksum、行键或不兼容值：`PreservedUnknown` / `PreservedIncompatible`，不启用、不删除、不伪造默认值。

转换结果保留 source revision。`reverse_state` 只允许回到该冻结来源，验证已知字段并拒绝字段冲突；返回候选行，不执行 SQL 或暗增当前 revision。Notebook 事务发布和业务替代由 RM05/14/20 负责；这两种已知数据映射不意味着用户安装的插件功能已全部替代。

`preserve_plugins` 将整个旧扩展包目录（包括未登记下载/未知文件）复制到新私有目录，拒绝 symlink/特殊文件，返回逐文件 SHA-256 和已知/未知安装 ID。`preserve_state` 保留原 `value_json` 字符串、key、schema_version、revision 及 Notebook ID，即使是未知/非法 JSON；输出 `anynote.preserved-plugin-state.v1`，文件名含内容摘要，重复运行核对字节而不覆盖。完整 Notebook 副本仍由 RM14 保留，不能只凭这些状态 sidecar 代替完整数据库。未知必需插件仍是功能等价验收的阻塞条件。

## 验证入口

```sh
cargo test -p anynote-services --lib --locked --offline
cargo clippy -p anynote-services --all-targets --locked --offline -- -D warnings
python3 scripts/check-rust-workspace.py
node scripts/rust-config-fixtures.mjs --check
cargo run -p anynote-services --example read_legacy_preferences --locked -- \
  tests/fixtures/rust-migration/config/electron-linux/file-crash/leveldb file://
```

`tests/fixtures/rust-migration/config/` 包含四份 Linux Electron 41.9.1 / Chromium 146.0.7680.216 生成的真实格式合成 LevelDB、SHA-256 清单、旧 TS 归一化 manifest 和独立 Node crypto 向量。测试覆盖 origin 隔离、Latin-1/UTF-16、覆盖/删除、WAL/压缩 SST、损坏拒绝、逆映射、源字节不变、凭据失败暂停和未知状态保全。异常退出样本在 `flushStorageData` 后 SIGKILL，证明已刷入 WAL 的值可恢复；不保证旧进程尚未落盘的内存值。

生成器只操作隔离合成目录；正常测试不启动 Electron：

```sh
pnpm run build:backend
node scripts/rust-config-fixtures.mjs
xvfb-run -a node scripts/rust-config-electron-fixtures.mjs
cargo build -p anynote-services --example check_synthetic_credential --locked
xvfb-run -a node scripts/rust-config-credential-smoke.mjs
```

凭据 smoke 另需 `dbus-run-session`、`gnome-keyring-daemon`，自行创建独立 D-Bus 和临时 XDG 数据目录；Xvfb 下显式选择 GNOME Secret Service，检查整个生成目录未出现测试 token 明文，临时报告位于 `tmp/rm13/`。不要在用户登录 keyring 上直接执行底层示例；其环境保护标记只服务此测试驱动，不是生产授权边界。macOS/Windows 不使用 Linux smoke，须由 RM32 提供对应原生生成/回读证据。

新增依赖固定于 Cargo.lock：rusty-leveldb 4.0.1（MIT）、keyring 3.6.3 / secret-service 4.0.0（MIT/Apache-2.0）、RustCrypto AES/CBC/GCM/PBKDF2/SHA 系列（MIT/Apache-2.0）、snap 1.1.2（BSD-3-Clause）、crc32c 0.6.9（Apache-2.0）、zeroize 1.9.1、tempfile 3.27.0。保留五个 crate，不引入 JS 宿主；最终发行依赖/许可证审计仍由 RM36 完成。
