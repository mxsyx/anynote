# Anynote backend

私有应用装配入口。Electron、预览 API 和需要备份功能的 Node 工具从此包创建 Storage：

```ts
import { Storage } from "@anynote/backend";

const storage = new Storage(root, { maxWriteConnections: 8 });
```

它将本地、Cloudflare、云盘备份操作及快照捕获注入 `@anynote/storage-sqlite`。服务实现与官方 Provider 按需加载；快照捕获沿用写队列，远端并发操作由装配描述指定。系统凭据、云盘宿主和调度器仍由宿主按现有生命周期配置。

仅需笔记存储的消费者可直接使用 `@anynote/storage-sqlite`；该包没有备份服务的反向依赖。新服务通过 `StorageOptions.services` 的每实例接口接入，输入和结果必须在各自边界验证。该接口供可信宿主装配，不是第三方扩展的权限接口。

构建：`pnpm --filter @anynote/backend build`。独立消费、快照和队列回归：`pnpm exec vitest run tests/backup-boundaries.test.mjs`。设计与限制见 [ADR-012](../../docs/adr/012-backup-service-composition.md)。
