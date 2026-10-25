# 功能回归入口

本文供 Agent 按改动范围选择回归，不保存单次执行结果。功能契约见 [功能说明](../../features/README.md)，当前未完成事项见 [TODO](../TODO.md)。

| 范围                      | 入口                                                                    | 核对重点                                                        |
| ------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| 连续编辑器、PDF、扩展界面 | `pnpm run test:document`、`pnpm run test:editor`                        | 保存与重载、未知块保留、授权撤销、PDF 定位、迁移与清理          |
| 归档与开放导出            | `pnpm run test:archive`                                                 | 完整/当前内容闭包、附件哈希、取消、路径授权、旧目标保护         |
| SDK 与扩展工具            | `pnpm run test:sdk:package`、`pnpm run test:extension-tools:package`    | 干净离线消费者、四种模板、同步/异步搜索与网络 fixture、输出保护 |
| 首方扩展宿主              | `pnpm run test:extension-host`                                          | 子进程隔离、惰性激活、Notebook 授权、崩溃与撤权清理             |
| 云发现与无源恢复          | `pnpm run test:cloud:cold-recovery`                                     | 无原库时列举与恢复、连接隔离、身份重映射、完整性校验            |
| 本地备份                  | `pnpm run test:desktop:local-backup`、`pnpm run benchmark:local-backup` | 增量发布、恢复、取消、断开/重挂载与设备边界                     |
| 目录与检索基准            | `pnpm run benchmark:search`、`node scripts/benchmark-organization.mjs`  | 同级排序、完整快照、搜索预算、暖缓存与硬件条件                  |
| UI 与设计样张             | `pnpm run test:ui`、`pnpm run test:visual`、`pnpm run test:bookshelf`   | 亮暗主题、窗口宽度、键盘、动态对话框、加载/空/错误状态          |

脚本按需创建 `tmp/reports/` 或 `tmp/screenshots/`。UI 浏览器脚本需要先启动本地预览；Node 基准需先构建后端。构建会更新共享产物，不与依赖旧产物的测试并行执行。

按受影响的测试文件运行 `pnpm exec vitest run tests/<name>.test.mjs`；修改后端时先执行 `pnpm run build:backend`。全量检查入口见 [开发工作流](../DEVELOPMENT-WORKFLOW.md)。

扩展网络测试中的受控 DNS/HTTPS fixture 不代表真实公网服务；真实公网、桌面系统凭据、独立设备恢复分别使用专项验收步骤。组合输入事件不代表真实 IME，自动无障碍扫描不代表人工读屏验收，稀疏 ZIP64 文件不代表完成最大容量负载。

每次记录命令、版本、环境、实际场景和未执行项；失败保留其性质，不能把重跑成功解释为首次失败原因已确认。必要结论写入实施记录，原始报告可随 `tmp/` 清理。
