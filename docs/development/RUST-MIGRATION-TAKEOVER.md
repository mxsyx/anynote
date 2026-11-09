# Rust 数据接管与回退演练

[RM14](TODO.md#rm14) 当前交付隔离副本上的迁移状态机，未开放日常资料接管。实现位于 `anynote-services::migration::Rehearsal`，桌面平台壳提供“选择副本并校验…”入口。正式激活及完整验收仍等待 RM06–12、RM19–29 的全部功能门槛和 RM32/33 平台演练；不能把本轮本地通过视为 M8 放行。

## 输入与路径

只接受显式选择的隔离根，不猜测操作系统默认 userData，不自动创建空工作区。根目录必须已有 `anynote.migration-rehearsal.json`，内容恰为 `{"format":"anynote.migration.rehearsal.v1"}`，原 userData 副本位于其 `userData/` 子目录，工作区位于 `userData/notebooks/`。标记是防误操作约束，不是 OS 授权或资料确为副本的证明；不要在日常目录添加它。

复用 `ReadonlyCatalog` 读取 `_local/notebook-directories.json`。每条外部登记必须指向同一隔离根内已准备的外部库副本；未重定向的真实外部路径、离线目录、重复 ID、交叠根均拒绝。目录和数据库绑定规范路径及 Unix device/inode，重启后即使内容相同但 inode 被替换也拒绝。符号链接、硬链接和特殊文件拒绝，不悄悄忽略。当前非 Unix 平台明确返回 `PLATFORM_IDENTITY_UNQUALIFIED`；Windows 原生身份适配仍待实现，macOS 原生分支未实测。

检测 Chromium `SingletonLock` / `SingletonSocket` / `SingletonCookie`，存在时拒绝，不擅自清理。迁移私有文件锁串行化演练，最终 Notebook 写保护复用与旧程序相同的 SQLite 独占租约。此检查不能证明整个旧 Electron 进程生命周期互斥，正式路径还需平台单实例适配，尤其是旧程序只写配置或零 Notebook 的情形。

## 完整保全与 journal

- 固定 journal：`<userData>/rust/migrations/rm14/journal.json`，格式 `anynote.migration.rehearsal.v1`。重复运行复用该 journal，不派生新正式库。
- 托管资料保全：同目录 `preserved/`；外部库保全：其父目录 `.anynote-migrate-rm14-<Notebook ID>/`。目标必须与对应来源同卷。
- 保存全部普通文件及空目录，包括孤立附件、未知包、第三方状态、密文、用户文件、共享 `_local` 和已有 Rust 配置。只排除当前迁移控制目录自身，防止递归复制；旧迁移目录仍保全。不执行插件、不写 Notebook 迁移表。
- 新建保全目录 Unix 权限 0700，临时/目标文件使用私有 tempfile。以 64 KiB 缓冲复制，按路径、长度、SHA-256 比较来源与副本，限制每根 20 GiB、100000 项、64 层。拒绝超限，不截断。
- 空间按实际卷合并计算，保留初始/最新副本及归档/临时解包的保守预算；外部库归档位于设备 journal，因此另外计入设备卷。回退冻结后以最新大小再次预检。
- 文件 temp + sync + 同卷发布；journal 同目录替换，Unix 同步父目录。中断临时文件放在保全树之外，续作核对已发布文件，不覆盖不匹配副本、不删除原文件。物理断电持久性不由 rename 返回值推断。

存储队列新增 `open_for_preservation`：先获得旧格式的独占锁，校验后将必要 WAL 内容 checkpoint 到 DB，并保持锁；预检不安装 `_backup_revision`，正常写入初始化留到激活后的首个写任务。checkpoint 是必要的格式归一化，源文件不承诺原字节不变；原逻辑数据、未知行和全部文件被保全，校验比较归一化后的 DB。现有 WAL 损坏/锁冲突直接失败，不自动修复。

POSIX 对同一 inode 的额外文件描述符执行 close 可能释放进程的 SQLite 字节锁。服务因此在取得租约前预打开数据库输入，后续 hash/copy 复用这些句柄并保持到写队列释放之后；源 DB 不通过额外只读连接验证，完整校验在副本执行。独立进程测试验证复制前后第二个 writer 均被排斥。

## 状态机与发布

`preflight → copied → verified → activated → freezing → rollback-verified → released`。

`prepare` 核对来源指纹、完成完整复制、逐文件复核，再用现有 `ReadonlyNotebook::integrity_check` 校验 schema v5、外键、树、资产及历史资源闭包。staging 不进入 catalog，正式 workspace 只保存原规范路径。

`activate` 只针对上述显式标记副本。复用 RM13 的 Electron 41.9.1 `file://` Local Storage 读取器，逐项验证后发布 `rust/preferences.json`；每个配置发布均先持久化独立意图，再发布文件，重启只允许该意图拥有的文件不同，避免把多文件当作一个原子事务。随后发布 `rust/workspace.json`，所有后台任务保持暂停，不自动夺取云 writer。

演练会话不可 clone，私有写队列不对调用方暴露；`submit(id, closure)` 只操作预检登记并固定租约的 Notebook。首次提交启动正常 writer 初始化，返回既有 `WriteTicket`。当前演练不支持期间增删 Notebook 或改变外部登记，正式业务宿主尚未接线。

## 最新数据回退

`rollback` 先持久化 freezing，停止新提交，再以同一 FIFO 排空已接收提交并 checkpoint，整个过程保持原 Notebook 租约。每个库从独立完整副本导出包含历史/回收站/插件状态的 `.anynote`，同时保留完整 `preserved.latest` / 外部 `.latest` 副本；归档不替代包含孤立文件/配置的完整副本。

调用方必须对隔离副本执行旧程序可读性验证，失败时继续冻结并保留租约。生产代码不启动 Node；测试 example 使用旧 TS `validateDirectory` 作为独立 oracle。oracle 返回后再次校验副本和当前来源，成功才将 Rust workspace 标记为 legacy 并释放租约。恢复该最终发布步骤可重入；released 重开不再拿 Notebook 写锁。

原路径始终保留最新数据，不把旧快照覆盖回去；共享 `_local`、lastGeneration、writerEpoch 不回滚。无新写入也走完整保全路径，未引入高风险快路。旧程序启动由演练调用方完成，当前 UI 不自动启动旧客户端。

配置分开报告：

| 项目          | 当前行为                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UI 偏好       | 最新 Rust 文件已完整保全；RM13 逆映射写 `reverse-preferences.json`。成功状态为 `mapped-awaiting-chromium-publication`，失败为 `preserved-manual-recovery-required` |
| Chromium 回填 | 尚未实现对存储副本的写入、Electron 回读及原子发布，不能声称旧 UI 自动恢复                                                                                          |
| 新凭据        | `reauthentication-required-tasks-paused`；不把旧密文认作最新秘密，不逆写 safeStorage，不落盘明文                                                                   |
| 后台任务      | 演练没有 timer 或真实云任务；正式暂停调度、等待网络/清理等任务结束及逐连接 capability 检查由后续宿主接线，不能把本地 FIFO 排空等同全业务排空                       |

## 桌面与验证

平台壳的选择按钮使用原生目录选择器，通过 `--migration-rehearsal <root>` 启动独立原生检查进程。选择、忙碌、失败和成功状态由 `MigrationView` 持有；重试复用 journal。进程仅执行 prepare，完成后释放锁。正式接管按钮禁用并就近说明未开放原因；GUI 尚无激活、编辑和回退完整向导。

```sh
cargo test -p anynote-services --test migration --locked --offline
cargo test -p anynote-storage -p anynote-services --lib --tests --locked --offline
cargo clippy -p anynote-desktop -p anynote-services -p anynote-storage --all-targets --locked --offline -- -D warnings
python3 scripts/check-rust-workspace.py
pnpm run build:backend
cargo build -p anynote-services --example migration_probe --locked --offline
node scripts/rust-migration-rehearsal.mjs
cargo build -p anynote-desktop --features ui-tests --locked --offline
xvfb-run -a python3 scripts/rust-platform-smoke.py
```

报告位于 `tmp/rm14/`，既有窗口 smoke 截图位于 `tmp/rm02/`；可删除，不作为持久验收凭据。服务回归中的本地 socket 测试需要允许绑定 loopback 的环境；沙箱 `EPERM` 不能归为业务通过。

当前验证是 Linux 合成语料，不含真实用户资料、真实密钥、Windows/macOS、物理卷/断电/拔盘、20 GiB 压力或三平台 GUI。RM14 保持部分完成，V/A/F 不变。后续必须补齐旧程序单实例互斥、正式调度/任务排空、平台身份和权限、偏好回填，以及真实克隆资料的完整向导演练。
