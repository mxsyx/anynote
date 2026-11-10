# Rust 任务、诊断、备份与恢复管理

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 接入与所有权

- `anynote-core::management` 定义类型化操作、报告、后续操作及任务详情；私有桌面协议 v6，Notebook schema v5 与外部云协议不变。
- `desktop-rust/src/backend/management.rs` 复用 RM03 `TaskHistory`。管理任务逐个准入，后台线程调用 `anynote-services::management`；管道线程仍可响应任务查询、取消、诊断和文档操作。Notebook 操作使用应用现有 `WriteQueue`，不创建第二个写队列。
- `management.jobs.v1` 保存任务意图和结果，状态只来自 `TaskRecord`。结果先于终态写入；重启沿用 RM03 中断状态，保留核对提示。取消只发协作信号，服务返回后才进入终态；已有提交不会因为 UI 请求取消而被改称取消。退出先请求取消，尚未返回时拒绝立即关闭后端。
- `management/` 下独立 `RuntimeState` 保存管理配置和现有云连接/调度服务状态；同一时刻只有一个管理任务持有它。设置键使用点分格式。云令牌只进入系统凭据库；任务回执不保存令牌或配对码。默认最近五项保留完整持久报告，更早报告压缩为摘要并保留清理恢复入口；超过状态库预算时进一步压缩/裁剪旧详情，统一任务历史不受影响。当前会话仍保留完整结果。
- 界面从后台轮询任务/诊断，分页显示记录、表单选项和报告，按钮提交真实服务命令。业务状态和错误不由 GUI 推断。

## 本地备份、清理与恢复

添加目标时选择目录、笔记本分组及间隔；默认暂停自动备份。目标身份和卷信息复用 RM09，源目录交叠检查覆盖整个工作区及外部笔记本。支持修改分组/间隔、手动备份、逐库验证、离线/失败结果和安全重试。连接已有磁盘无需本地源库，可从经过校验的 manifest 浏览、校验、恢复；重新选择目录是显式重新授权，不自动扫描或重新初始化离线目标。

分组中已提交的笔记本保留成功结果；取消后尚未执行的笔记本单独标记，整体任务为已取消。自动调度同样保留每个执行目标的结果、后续操作和失败/取消终态，不把调度检查结束等同于备份成功。

完整性检查捕获一致未裁剪切面并检查数据库/资源。清理复用 RM08 的五分钟预览、引用/身份复核、隔离与 journal。隔离、恢复隔离和永久删除分开；永久删除另需确认，失败保留恢复入口。过期或已改变的计划不能直接执行。

本地备份、归档和云恢复均先选择来源，再选择目的地并确认。服务校验后创建新 UUID 笔记本，随后通过同一写队列登记。发布成功但登记失败会显示已保存的位置，并提供“登记已恢复笔记本”；不会再次复制源数据。普通本地/归档恢复不提供盲目重试；云恢复复用 RM10 的持久发布身份。

## 云管理与调度

云连接先测试 capabilities，再保存配置和系统凭据。恢复连接独立于本地笔记本；云发现按服务游标分页，并保留警告。云目标绑定 connection/endpoint/notebook/lineage/device/epoch，自动备份默认暂停。

- 上传先核对并继续已有 pending；新切面复用同切面 browse/captureAcks，不把“请求发送”当成提交成功。
- 写入设备先查询，再以预览的 head/epoch 和固定 request ID 明确接管；结果持久化新身份并保持自动备份暂停。丢响应可从状态页核对。
- 日/周/月保留配置与删除权限分离。预览列出删除版本和保护/空间信息，确认绑定 plan ID；剩余批次、已确认远端维护、旧锁恢复均调用现有服务并重新检查条件。超过 200 个候选的预览不会提供执行按钮，需要调整策略后重览。
- 支持采集配对、设备列表、撤销前重新查询权限、接收采集；配对码仅保留当前会话。
- 后端每 60 秒检查已启用目标，复用 `BackupScheduler` 的准入、退避、暂停和持久状态。HTTP 响应提供当前连接可达性；本地目标保留等待磁盘状态。网络不可达时保留暂停，手动上传仍允许用户明确重试。

电量与计费网络原生订阅仍使用未知状态，不伪造平台观测；当前界面使用既有调度默认策略（不要求这些条件）。后续接入策略开关时必须同时接平台观测，不能将未知值当作已接电或非计费网络。真实睡眠/唤醒、拔盘、凭据库锁定和各平台系统行为继续 RM32/33 验证。

## 验证方法

```sh
cargo test -p anynote-desktop --test management --test management_ui --features ui-tests --locked --offline
cargo test -p anynote-services --test management --test local_backup --test archive --test cloud --test cloud_capture --test runtime --locked --offline
cargo clippy -p anynote-services -p anynote-desktop --lib --test management --test management_ui --features anynote-desktop/ui-tests --locked --offline -- -D warnings
python3 scripts/check-rust-workspace.py
```

结果按实际运行记录；设备、云端、性能及最终候选的剩余验收统一见 [TODO](TODO.md)。
