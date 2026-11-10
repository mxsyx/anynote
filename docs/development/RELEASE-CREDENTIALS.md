# 原生发行凭据

RM36 已将活跃入口改为 `python3 scripts/rust-release.py credentials`；`pnpm run test:release:credentials` 转发到该入口。它只检查字段格式/存在性，真实证书与权限必须用原生签名流程验证。完整调用与验收边界见 [Rust 原生发行](RUST-NATIVE-RELEASE.md)。

| 平台    | 本机签名环境                                                                                              | CI 额外配置                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | `ANYNOTE_MAC_SIGN_IDENTITY`、`ANYNOTE_MAC_TEAM_ID`、`ANYNOTE_NOTARY_PROFILE`；可选 `ANYNOTE_MAC_KEYCHAIN` | secrets：`ANYNOTE_MAC_CERTIFICATE_B64`、`ANYNOTE_MAC_CERTIFICATE_PASSWORD`、`ANYNOTE_MAC_SIGN_IDENTITY`、`APPLE_TEAM_ID`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` |
| Windows | CurrentUser/My 中的证书、`ANYNOTE_WIN_CERT_SHA1`、`ANYNOTE_WIN_TIMESTAMP_URL`                             | secrets：`ANYNOTE_WIN_CERTIFICATE_B64`、`ANYNOTE_WIN_CERTIFICATE_PASSWORD`、`ANYNOTE_WIN_CERT_SHA1`；variable：`ANYNOTE_WIN_TIMESTAMP_URL`（HTTPS RFC3161 服务）    |

CI P12 采用 base64 编码；仅导入 runner 临时钥匙串/证书库，always 步骤清理，不存储在工件或仓库。`release-credentials.yml` 为 presence/格式预检；`release.yml` 手动 `sign=true` 才调用实签/公证，仍不发布。缺失任何预期身份或验证失败都停止构建，不降级为“已签名”。Linux 发布者签名尚未启用。

## 预检与真实身份验证

```sh
python3 scripts/rust-release.py credentials
```

预检只检查配置，不能证明证书有效、私钥可用或公证权限正确。凭据使用系统安全存储、CI Secrets 或未跟踪环境文件，不进入文档和日志。

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

签名、过期/错误身份、缺失凭据、不可用公证服务及被篡改更新产物的失败行为按 F006 实现补齐。安装、升级和回退的真实设备结果继续归 [V011](TODO.md#v011)。只有真实证据满足 A011 范围后才勾选任务。
