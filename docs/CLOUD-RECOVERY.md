# 全新设备从云端恢复

设置页的「从云端恢复」可以在没有原 Notebook、备份目标或 lineage 配置的设备上发现云端版本并恢复为本地副本。

## 使用

1. 打开「设置 → 从云端恢复」，添加云连接。
2. Cloudflare 填写原 Worker Endpoint 和应用 Token。S3 填写原 Endpoint、Bucket、Region、Prefix 和访问凭据；阿里云 OSS 选择「虚拟主机寻址」。Prefix 必须与原备份一致。
3. 点击「保存连接并查询」，按需「继续加载版本」。核对 Notebook 和版本 UUID、时间与附件数量，再点击「恢复此版本」。旧备份缺少名称时以 UUID 标识。
4. 在任务中心查看进度或取消；完成后打开恢复的 Notebook。如需继续备份，另行为副本配置目标。

桌面凭据通过系统密钥服务加密，重启后可读取；连接元数据不保存明文密钥，也不进入 Notebook 归档。浏览器预览仅在 API 进程内存保留凭据，重启后需重新配置。当前最多保存 20 个恢复连接。

## 发现与恢复

恢复连接独立保存于设备 `_local/recovery-connections.json`。发现跨越该连接范围内的 Notebook 和分支，每次最多读取 10 个版本清单，继续按钮使用分页游标。Cloudflare 按提交时间倒序；S3 按对象列表顺序，不保证跨库时间排序。S3 每次对象列表最多 1,000 个键，只接受规范路径下的 COMMITTED 标记并验证清单哈希及身份；损坏版本跳过并显示警告。

Cloudflare 需升级包含 `backup-discovery-v1` 能力的 Worker，可运行 `pnpm run cloud:deploy` 复用已有 Wrangler 管理部署，无需新增 D1 迁移。`GET /v1/backups` 使用相同 APP_TOKEN，只返回已提交且未退役的版本。

列举成功代表版本清单通过校验。恢复任务随后逐对象下载、检查大小和 SHA-256，在私有暂存目录重建/校验数据库，全部通过后原子发布为新 UUID 的 Notebook；失败不登记半成品。任务沿用 20GiB 流式恢复预算、取消、临时目录租约及 Cloudflare 恢复 pin。

发现与恢复不取得远端写入身份、不删除版本，也不启用自动备份。恢复连接不替代备份目标；副本不会携带原设备凭据、目标配置或备份游标。远端保留和设备接管仍使用独立的显式操作。

## 验收

```sh
pnpm run test:cloud:cold-recovery
pnpm run test:cloud:cold-recovery --provider cloudflare
pnpm run test:cloud:cold-recovery --provider s3
```

报告写入 `test-results/cloud-cold-recovery-acceptance.json`。真实 Cloudflare 和阿里云 OSS 各六项通过，见真实云报告：发布两个版本、删除全部独立源工作区、在空工作区只配置云连接、发现旧新版本，再分别恢复并验证正文、未知块、自链接重写、标签/收藏、历史、回收站、附件哈希与搜索。恢复后没有备份目标。

本地回归新增三项：两个提供方各 12 个版本的分页及无源恢复、连接持久化和错误身份拒绝；完整 92 项及类型检查通过。

桌面扩展验收见 [桌面说明](./DESKTOP-CLOUD-ACCEPTANCE.md)。真实云脚本删除的是独立测试数据；仍需有效账号凭据，不证明丢失云账号后可恢复。尚未覆盖 Windows/macOS、整机故障和长期负载，完整 v1 发布门槛仍未全部完成。

真实 Cloudflare 和 OSS 的最新 Linux 打包应用各通过 11 项桌面检查，包含独立新设备目录的界面连接、真实系统加密、重启发现及恢复打开；见 Cloudflare 打包报告和 OSS 打包报告。
