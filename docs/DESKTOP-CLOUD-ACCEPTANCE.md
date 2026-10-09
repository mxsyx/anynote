# 真实云桌面验收

2026-10-02 生产页面和现有 Linux 打包应用均通过 9 项真实云桌面检查：生产页面报告、Linux 打包应用报告。

脚本使用真实 Electron 生产页面、Preload/IPC、SQLite Utility Process、系统 safeStorage 和已部署 Cloudflare Worker/D1/R2。目标配置、连接测试、启用/停用自动备份、立即备份和选择云端恢复版本通过桌面界面操作；夹具补充与恢复内容检查走正式 IPC API。

先构建生产页面并确保 Cloudflare 已部署：

```sh
pnpm run build
pnpm run cloud:deploy
pnpm run test:desktop:cloud
```

默认读取 `.cloudflare-acceptance/` 中 Wrangler 自动部署保存的地址与 Token，也可使用完整的 `ANYNOTE_CF_ENDPOINT` / `ANYNOTE_CF_TOKEN`。测试使用独立临时桌面数据目录，不操作现有 Notebook；远端测试数据保留供核查。

Linux 可在独立 D-Bus 会话内启动已安装的 GNOME Keyring：

```sh
pnpm run test:desktop:cloud --isolated-keyring
```

此选项使用真实 Secret Service 和 `gnome_libsecret`，随机密码仅通过 stdin 传入，keyring 与数据保存在临时目录，结束时删除；不修改用户登录 keyring，不替换 safeStorage。它需要 `dbus-run-session`、`gnome-keyring-daemon`、libsecret 及可用 X11 DISPLAY。它验证应用重启后读取加密凭据，不证明系统重启后仍可解锁，也不代表每个 Linux 桌面环境的默认配置已通过。

脚本直接启动 Electron，再通过 CDP 控制页面及 Node Inspector 读取运行设置。Playwright 的 Electron 启动器会强制 `--password-store=basic`，因此本验收不使用该启动器；也不改写产品的凭据服务。启动使用 `--no-sandbox` 以适配当前测试环境，窗口仍检查 sandbox/contextIsolation；系统级沙箱发行验收另行进行。

验收包含：

1. 系统加密可用且后端不为 basic_text，窗口启用 sandbox/contextIsolation 并关闭 nodeIntegration。
2. 真实桌面保存中文/未知块夹具，包含标签、收藏、历史、回收站和内联资源。
3. UI 配置目标并测试真实云连接，凭据文件非明文、目标元数据不含 Token。
4. UI 开启约每分钟自动备份配置，退出并重启，Electron 环境不传入云端 Token。
5. 等待正式 60 秒轮询触发到期的首个自动备份；核对任务中心、远端 generation 和本机 ack 游标。
6. 修改笔记后通过 UI 手动备份，再次备份无变化时跳过上传且远端版本数不增加。
7. UI 选择旧、新云版本分别恢复为副本，核对正文、未知块、资源字节、历史、回收站和搜索；原 Notebook 不被覆盖。
8. 导出归档不含 Token、设备凭据及备份目标。
9. 再次退出并重启，核对游标和自动备份开关持久化，再测试连接与列举版本。

自动备份没有模拟时钟、缩短调度轮询或绕过调度器；首次备份因没有 lastAttempt/lastSuccess 而到期。它不等于持续自动备份的长时间负载测试。

验收启动时设置 `NODE_USE_ENV_PROXY=1`，使真实存储进程使用本机已有的 HTTP(S) 代理配置；没有代理时仍直连。测试不注入或替换网络响应。

默认逐步报告在 `test-results/desktop-cloud-acceptance.json`，包含运行时、加密后端、步骤状态/耗时、Notebook/target/lineage/generation 与恢复副本 UUID。报告脱敏，不记录 Token。

现有 Linux 打包应用可通过同一脚本验证：

```sh
ANYNOTE_EXECUTABLE=release/linux-unpacked/anynote pnpm run test:desktop:cloud --isolated-keyring
```

## 远端维护扩展验收

追加 `--maintenance`（仅 Cloudflare）运行原有 9 项和新增 3 项桌面检查。新增步骤通过 UI 设置保留 1 个版本，验证预览没有删除、未勾选确认不能执行，确认后只剩 head 并恢复其内容；读取写入权并确认接管，核对持久化 epoch、远端 UUID、ack 清空与自动备份关闭；再次重启后手动备份验证接管身份持续可用。验收只清理本次新建测试库中的旧版本。

```sh
pnpm run test:desktop:cloud --isolated-keyring --maintenance
ANYNOTE_EXECUTABLE=release/linux-unpacked/anynote pnpm run test:desktop:cloud --isolated-keyring --maintenance
```

真实老化对象回收、大规模清理和 Worker 强制终止恢复仍未验收；详见 [远端维护边界](./REMOTE-MAINTENANCE.md)。

维护模式使用单独报告：`test-results/desktop-cloud-maintenance-acceptance.json` 与 `test-results/desktop-cloud-maintenance-packaged-acceptance.json`，避免覆盖基础备份验收结果。真实生产页面与 Linux 打包应用分别通过 12 项检查，见维护生产页面报告与维护打包报告。

日/周/月采样扩展在同一维护步骤中填写 7 天/4 周/12 月，核对返回计划的 UTC 策略和保留原因，再确认删除及恢复保留版本。其余步骤继续核对接管、持久化和重启后备份。窗口解释见 [采样语义](./REMOTE-MAINTENANCE.md)。

## 全新设备恢复扩展验收

追加 `--cold-recovery` 运行基础 9 项和新增 2 项：切换到全新的桌面用户目录，通过设置页填写独立云连接、分页找到版本并检查真实系统加密；关闭重启后读取加密凭据，再通过界面发现/恢复并打开 Notebook，校验完整内容及没有备份目标。新目录不复制源工作区配置；桌面首次启动仍按现有行为创建默认 Notebook。

```sh
ANYNOTE_EXECUTABLE=release/linux-unpacked/anynote pnpm run test:desktop:cloud --isolated-keyring --cold-recovery
```

默认报告仍为 `test-results/desktop-cloud-acceptance.json`。此扩展验证全新设备向导与应用重启；彻底删除源工作区并分别恢复旧新版本的独立云验收见 [全新设备恢复](./CLOUD-RECOVERY.md)。

真实 Cloudflare 的最新 Linux 打包应用通过 11 项桌面检查，包含独立新设备目录的界面连接、真实系统加密、重启发现及恢复打开；见 Cloudflare 打包报告。
