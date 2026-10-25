# 发行凭据准备与验收

本流程服务于 [A011](../TODO.md#a011)。凭据配置检查、真实签名/公证、更新身份验证分别记录；预检成功不能作为发行验收通过。

## 本地预检

```sh
pnpm run test:release:credentials
pnpm run test:release:credentials --target win
pnpm run test:release:credentials --target mac
# 可选：从已被 Git 忽略的本地文件加载；不要把凭据作为 CLI 参数。
node --env-file=.env.release scripts/release-credentials.mjs
```

预检无需构建、安装依赖或联网，仅检查当前进程是否提供完整、非空的环境变量组。每次写入独立 `test-results/release-credentials/<UUID>.json`，包含源码 HEAD、应用版本、执行平台、变量名、缺项及检查边界；HEAD 不代表工作区无修改，真实 CI 证据应对应干净 checkout。

| 状态         | 退出码 | 含义                                           |
| ------------ | ------ | ---------------------------------------------- |
| `configured` | 0      | 所选平台的变量组完整；未验证值是否正确         |
| `blocked`    | 2      | 缺少变量、只有空白值或同时配置两种公证认证方式 |
| 执行失败     | 1      | 参数、源码清单或报告写入错误；不保证生成报告   |

所有报告的 `acceptance` 均为 `not-run`。脚本不读取证书内容、不验证密码或权限、不调用签名/公证服务；报告不包含环境变量的值、证书路径或原始异常。没有证书身份验证结果时，不能声称身份有效。

## 凭据约定

以下约定与仓库锁定的 electron-builder 26.0.12 环境变量接口对应。当前准备流程采用有密码的证书文件；硬件签名、云签名或系统钥匙串身份需要另行接入 F006，不能用虚构值让预检变绿。

| 平台 / 用途          | 环境变量                                                   | 准备内容                                                                           |
| -------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Windows 签名         | `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`                     | 有效的代码签名证书及私钥容器、对应密码；使用 Windows 专用变量，避免误用 macOS 身份 |
| macOS 签名           | `CSC_LINK`、`CSC_KEY_PASSWORD`                             | Developer ID Application 身份、私钥及证书链的导出容器、对应密码                    |
| macOS 公证：Apple ID | `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | 可访问所属开发者团队的账号、应用专用密码和团队 ID                                  |
| macOS 公证：API key  | `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`    | 真实 runner 上可读的私钥文件路径、key ID 和 issuer                                 |

公证认证方式二选一，删除另一组变量，避免打包器的优先级隐式选中另一身份。`APPLE_API_KEY` 是文件路径，预检只检查存在非空值；实际 CI 必须先从受保护的 secret 安全写出私钥文件并在结束后清理。证书链接可按打包器支持的路径、HTTPS 或 base64 形式提供；完整性、可读性、有效期、信任链与私钥可用性留待真实签名验证。

账号所有者负责申请/授权开发者身份并配置凭据。密码、token、私钥和证书容器放入 CI Secrets 或未跟踪的本地环境文件；任务文档仅记录非敏感标识。

## 手动 CI 预检

[Release credential preflight](../.github/workflows/release-credentials.yml) 只由 `workflow_dispatch` 触发，使用 GitHub `release` environment 和只读仓库权限。管理员按仓库发行权限约定配置该 environment、允许执行的分支及上述同名 secrets，然后从可信源码运行此 workflow。

该作业在 Linux 上检查两平台变量组，不安装依赖、不构建产物、不发布 Release。凭据仅注入预检 step；即使缺项失败，也上传脱敏 JSON，artifact 名包含 run ID 和 attempt，保存 14 天。需要长期证据时下载归档。没有实际运行记录时，提交 workflow 文件只表示入口已准备。

现有 [发行 workflow](../.github/workflows/release.yml) 仍未接入这些 secrets、签名或公证。这是独立的准备入口；不能用预检成功替代 [F006](../TODO.md#f006) 的实现，也不改变当前发行流程。

## 真实验收与证据

凭据与 F006 就绪后，在对应 Windows/macOS runner 上执行真实打包与身份核验。记录安装包和更新产物的 SHA-256、签名者/证书指纹、时间戳、验证工具及退出码；macOS 还需公证请求 ID、服务结果以及 staple/系统验证结果。使用实际验证输出，不以配置字段或校验和推断身份。

每次验收至少记录：

| 字段       | 内容                                                                 |
| ---------- | -------------------------------------------------------------------- |
| 来源       | 日期、commit、tag、应用版本、CI run URL / attempt、runner 系统与架构 |
| 身份       | 平台、公开签名者名称/团队 ID、证书指纹及有效期、授权范围；不含私钥   |
| 输入与产物 | 构建命令、安装包/更新文件名、SHA-256、CI artifact / 证据归档路径     |
| 签名与公证 | 实际验证命令、退出码、脱敏日志、公证请求 ID / 结果                   |
| 更新身份   | F006 实际更新链路的身份匹配、篡改/错误身份拒绝证据                   |
| 结论       | 每个场景的通过/失败/未执行、原因及剩余工作                           |

签名、过期/错误身份、缺失凭据、不可用公证服务及被篡改更新产物的失败行为按 F006 实现补齐。安装、升级和回退的真实设备结果继续归 [V011](../TODO.md#v011)。只有真实证据满足 A011 范围后才勾选任务。
