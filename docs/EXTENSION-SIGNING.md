# 扩展签名与来源信任

桌面端支持声明式扩展与 QuickJS 正文转换扩展的 Ed25519 签名包。安装页在后端验证签名，再显示发布者声明、完整公钥 SHA-256 指纹、贡献与权限。首次安装签名包须通过独立渠道核对指纹并点击“已核对指纹，信任发布者”，随后安装，最后为各 Notebook 单独授权。

签名确认内容来自持有该私钥的一方；发布者名称是签名覆盖的自我声明，不是实名认证、证书或扩展安全审计。现有未签名 JSON 继续作为明确标注的本地开发扩展安装，仍须 Notebook 授权。它们不会显示为已验证的签名发布者。

## 制作与验证

在项目根目录运行；输出文件必须不存在，避免覆盖已有密钥或包：

```sh
pnpm run extension:package keygen /tmp/anynote-publisher-private.pem
pnpm run extension:package sign packages/plugin-sdk/src/examples/reading-transform.json /tmp/anynote-publisher-private.pem '你的发布者名称' /tmp/reading-transform.signed.json
pnpm run extension:package verify /tmp/reading-transform.signed.json
```

私钥以权限 `0600` 保存，只由制作工具使用。不要随扩展分发、提交版本库或放入 Notebook。示例路径仅用于演示；真实发布应选择安全的持久存储位置。分发 `.signed.json` 和通过独立渠道发布指纹即可；桌面安装过程不读取私钥。

## 格式与校验

包结构为 `{format:"anynote.extension.v1", algorithm:"Ed25519", publisher, publicKey, manifest, signature}`，不接受额外字段。公钥使用标准 SPKI PEM，签名使用 64 字节的标准 Base64 编码。签名覆盖除 `signature` 外的所有字段，其消息为 UTF-8 编码的 `Anynote extension signature v1\n` 加受限 JSON 规范序列化：对象键按 JavaScript UTF-16 顺序排序、数组保留顺序、原始值按 `JSON.stringify` 表示。不宣称实现 RFC 8785；当前严格 manifest 格式仅包含有限数值、字符串、数组与对象。

签名包最多 160KiB，解析后的 manifest 最多 128KiB，脚本最多 64KiB。原有 manifest SHA-256 内容校验保持兼容；它与发布者公钥指纹是不同用途的值。实现使用 Node 内置 [crypto.sign/verify](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback)，Ed25519 使用 `null` algorithm。

## 更新、撤销与持久化

- 已安装签名扩展绑定原公钥；更新不能换钥或改用未签名定义。更换来源需先卸载并重新审核。
- 版本使用现有 `0.1.N` 格式；拒绝低版本和同版本不同内容。安装或更新后清除该扩展的 Notebook 授权。
- 撤销发布者信任会取消其所有在途脚本，清除其所有 Notebook 授权，并从命令列表和编辑器贡献中停用对应扩展。已有笔记、扩展状态和资源保留。
- 重新信任不会恢复旧的 Notebook 授权。脚本准备与提交均检查当前来源信任，防止撤销后写回。
- 来源信任存在设备的 `_local/extensions/publishers.json`；安装目录保存完整签名包，每次读取重新校验签名及其与 manifest 的对应关系。信任配置不进入 Notebook 归档与知识备份。它依赖设备文件系统的完整性，不抵御能任意改写本机文件的攻击者。

公共 SDK 导出 `SignedExtensionPackage` 与 `ExtensionSource` 类型；独立 SDK 包不引入 Node 密钥处理与私钥制作代码。公开 HTTPS 签名包下载与手动更新已补齐，见 [远程分发文档](EXTENSION-DISTRIBUTION.md)。扩展市场、自动更新、证书体系和通用第三方 React/JS 宿主尚未实现。

## 验收记录（2026-10-03）

最终完整回归 114 项通过，新增 5 项覆盖包篡改、显式信任与重启校验、来源绑定与版本更新、撤销在途脚本以及命令行密钥保护/制作/验签。Linux 桌面包生成成功。生产构建与打包应用各完成 12 项真实界面检查、8 次 WCAG 扫描，均零违规；包括首次信任前禁止安装、安装后独立 Notebook 授权以及撤销来源后的停用状态。报告见生产构建验收与打包应用验收。独立 SDK tarball 的离线安装、严格 TypeScript 消费与运行验证通过。
