# ADR-005 · Cloudflare staging 与原子发布

状态：采用。

[返回 ADR 索引](README.md)

## 背景

D1 与 R2 没有跨服务事务，上传完成也不代表一个可恢复版本已经发布。

## 决定

先建立 staging generation，上传 plan 指定的缺失对象，校验对象大小与 SHA-256，再提交。Worker 检查对象存在及 verified 状态。

最终 D1 batch 使用事务 guard 检查 head、writer/epoch、维护锁与退休状态，然后更新分支 head、generation committed 与 Notebook revision。冲突不发布；恢复列表只列 committed。提交响应丢失时以同一 generation 查询确认，再更新设备 ack 游标。

## 取舍与边界

不将 UPDATE 零行视为成功，不靠客户端自行声明 verified；R2 孤立对象由维护流程处理。原子发布的本地适配器证据不等于当前部署环境已验收。

相关契约：[Rust 数据与协议](../RUST-DATA-COMPATIBILITY.md)、[剩余任务](../../development/TODO.md)。
