# ADR-005 · Cloudflare staging 与原子发布

状态：已采纳（当前实现追认）。核对：2026-10-21，源码基线 `e975c1c`。

[返回 ADR 索引](README.md)

## 背景

D1 与 R2 没有跨服务事务，上传完成也不代表一个可恢复版本已经发布。

## 决定

先建立 staging generation，上传 plan 指定的缺失对象，校验对象大小与 SHA-256，再提交。Worker 检查对象存在及 verified 状态。

最终 D1 batch 使用事务 guard 检查 head、writer/epoch、维护锁与退休状态，然后更新分支 head、generation committed 与 Notebook revision。冲突不发布；恢复列表只列 committed。提交响应丢失时以同一 generation 查询确认，再更新设备 ack 游标。

## 取舍与边界

不将 UPDATE 零行视为成功，不靠客户端自行声明 verified；R2 孤立对象由维护流程处理。原子发布的本地适配器证据不等于当前部署环境已验收。

## 证据与验证

[Worker plan/commit/status](../../../apps/cloudflare-backup/src/index.ts)、[上传提交](../../../packages/backup/src/cloud-snapshot.ts)、[响应丢失确认](../../../packages/backup/src/service.ts)。

[云流式测试](../../../tests/cloud-stream.test.mjs)；[流式备份契约](../../features/STREAMING-CLOUD-BACKUP.md)、[真实云验收入口](../../development/validation/CLOUD-ACCEPTANCE.md)。

本轮执行结果统一见 [G18 核对报告](../../development/history/todo-2026-10-24.md#g18)；测试入口和历史报告不等于本轮已执行或真实发布验收。
