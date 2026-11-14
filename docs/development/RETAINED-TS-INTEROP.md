# 浏览器与 Worker 构建及 Rust 互通

## 构建闭包

浏览器扩展和 Cloudflare Worker 保留 TypeScript/JavaScript。`scripts/build-retained.mjs` 从目标入口解析可达源码、检查 workspace 依赖白名单，以独立 `tsconfig.retained.json` 编译，再由 Vite/Wrangler 打包。不会调用 `build:backend`、生成旧 `.build` 镜像或运行 Rust 二进制。

| 目标       | 入口                                                                     | 允许的共享包                           | 交付产物                              |
| ---------- | ------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------- |
| 浏览器扩展 | `pnpm run build:browser`，或扩展包内 `pnpm run build`                    | capture、importer、protocol、types     | `apps/browser-extension/dist/`        |
| Worker     | `pnpm run build:worker` / `cloud:check`，或 Worker 包内 `pnpm run build` | capture、protocol、types               | `apps/cloudflare-backup/dist/bundle/` |
| Rust 桌面  | `cargo build --locked -p anynote-desktop`                                | Cargo workspace 五个工程及锁定原生依赖 | `target/debug/anynote-desktop`        |

白名单是允许的上限，实际文件清单以每次编译输出的 `tmp/retained/<target>/closure.json` 为准。浏览器只使用 importer 的转换/发现部分，Worker 的 types 引用为类型依赖，原生 SQLite 实现不得进入 Worker bundle。跨出允许源码目录或增加待退役 workspace 依赖即失败。

共享包 `dist` 可供独立互通驱动读取；浏览器、Worker 的发布 bundle 各自打包。旧 Electron、SDK、全量后端已从活动工程删除；旧端参考工具只存在于固定提交的独立参考目录，不属于这两个构建入口，也不属于 Rust 桌面运行闭包；参考工具的清理要求见 [旧桌面退役](RUST-LEGACY-RETIREMENT.md)。

## 协议与降级

- 外部云协议仍为 v1、Notebook schema v5，Worker 实现无需修改或升级协议。
- Rust 连接拒绝缺少 `sqlite-assets-v1` / `conditional-head`、不支持 v1/v5 或非法结构的响应；忽略未使用的新增 capability。
- 新备份仅在服务声明 `browse-snapshot-v1` / `capture-v1` 时生成对应浏览对象/采集回执。缺少这些可选能力仍可完成基础备份与恢复，不调用采集接口。管理连接测试明确提示“当前服务不支持；备份仍可使用”。
- 上传恢复按冻结清单检查实际所需能力；缺少对应 capability 时拒绝发送，不改写 pending generation，不把未知结果推定为已提交。能力恢复后继续原 generation。
- 扩展在读取和上传前运行时校验能力响应；缺少采集能力时保留已有备份浏览、明确显示降级，上传在发送 plan 前拒绝。设备授权返回的 scoped capabilities 无需包含桌面备份能力。
- 黄金快照只补齐每次传输的 generation/writer/lineage envelope；正文、附件、投影和回执语料保持冻结。非法块描述、不支持的实际协议/投影版本由 Rust 与现有 Worker 拒绝。

## 独立验证入口

先安装锁定依赖，使用 Node >=24、仓库固定 Rust 工具链；需要运行扩展测试时安装 Playwright Chromium：

```sh
pnpm install --frozen-lockfile
cargo fetch --locked
pnpm exec playwright install chromium
pnpm run test:retained:builds
pnpm run test:retained
pnpm run test:retained --workerd
```

`test:retained:builds` 对三个目标分别创建源码副本，可用 `python3 scripts/check-retained-builds.py --target browser|worker|rust` 单独执行。TS 副本不含桌面、Rust、SDK、宿主源码、`.build` 或任何旧 `dist`；只复用已安装的第三方依赖，并将 workspace 链接重新指向副本。Rust 副本没有 TS 工程/node_modules，使用空 `target`、阻断 PATH 中的 JS 工具，再执行原生编译、真实 backend 集成测试和五工程依赖检查。编译使用的三份静态 JSON 迁移资料显式列入复制清单。这是源码/产物隔离构建，未声称重新安装操作系统或重新下载全部依赖。

`test:retained` 自行构建两套 TS 产物和 Rust `cloud_probe` / `maintenance_probe`，复用 RM10/RM11/RM12 驱动，不依赖 TS 桌面后端。默认使用现有 Worker 加内存 D1/R2 适配器；`--workerd` 使用官方本地 workerd、持久化 D1/R2，覆盖 pin 续租、multipart 和实际 MV3 扩展。维护驱动两种模式均读取独立 Worker `dist`，覆盖清理预览/确认、丢响应恢复、tombstone、writer 接管和取消协调。`CAPTURE_CHROMIUM` 可指定本机 Chromium 可执行文件。测试只使用临时资料和回环地址；需要本机端口与 Chromium 启动权限，不访问真实云账户。

独立 CI 见 `.github/workflows/retained.yml`：浏览器/Worker 分开执行隔离构建；Rust job 不安装 Node，阻断预装 JS 工具；互通 job 运行本地 workerd 和 Chromium。实际 CI 执行结果随候选证据保存，不能由工作流定义推定通过。
