# 发行矩阵

桌面候选由 [原生发行配置](../../apps/desktop-rust/native/release.json) 定义，版本取根 Cargo workspace，并与根 package.json 一致。候选目标不等于已通过设备验收的支持声明。

| 单元              | 构建/分发范围                                                    | 契约                                                       |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Rust 桌面         | macOS arm64/x64 `.app/DMG`、Windows x64 NSIS、Linux x64 AppImage | 主程序/后端及原生库、字体、媒体资源；不携带旧桌面/插件宿主 |
| 浏览器扩展        | 独立 MV3 构建                                                    | `.anyclip`、配对、采集、同代浏览                           |
| Cloudflare Worker | 独立 TS 构建与 Wrangler 部署                                     | Worker/D1/R2、能力协商与备份协议                           |

## 数据与协议版本

| 格式       | 版本                                         |
| ---------- | -------------------------------------------- |
| Notebook   | schema v5                                    |
| 完整归档   | `anynote.notebook` v1                        |
| 本地备份   | `anynote.local-backup` v3                    |
| Cloudflare | `anynote.sqlite` v1，必需 `sqlite-assets-v1` |

具体拒绝边界见 [数据契约](../design/RUST-DATA-COMPATIBILITY.md)，可选 capability 降级见 [保留 TS 互通](RETAINED-TS-INTEROP.md)。不为任意历史格式新增兼容层，不分发旧 SDK/插件包。

## 发行要求

- 构建、资源摘要、架构、许可证、签名/公证及安装失败回退按 [原生发行](RUST-NATIVE-RELEASE.md) 执行。第三方依赖保留其许可证，项目 MIT 许可不覆盖第三方内容。
- 真实身份按 [发行凭据](RELEASE-CREDENTIALS.md) 准备；Linux 发布者签名见 [F019](../../TODO.md#f019)，可选自动更新单独见 [F032](FUTURE-TODO.md#f032)。
- `release.yml` 上传候选工件，不直接发布。最终候选必须完成 [固定验收范围](RUST-RELEASE-SCOPE.md) 与 [发行复核](RUST-RELEASE-ACCEPTANCE.md)。
- 平台范围由 [F017](../../TODO.md#f017) 确认；真实安装、离线首用、卸载保留数据、升级与回退归 [F030](../../TODO.md#f030)。
