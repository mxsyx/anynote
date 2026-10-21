# G15 · 网页媒体流式导入与目录授权

[返回总入口](../../TODO.md)

类型：独立实现。目标：有界资源入库、可配置预算、相邻资源目录。

前置：先定义流式资源句柄与授权目录边界；统一大文件提示交给 G16。

并行边界：与云盘/卷适配并行；Storage 资源接口修改与 G16/G17 串行集成。

## 建议入口

- [packages/importer/src/html.ts](../../packages/importer/src/html.ts)
- [packages/importer/src/media.ts](../../packages/importer/src/media.ts)
- [packages/importer/src/network.ts](../../packages/importer/src/network.ts)
- [packages/storage-sqlite/src/assets.ts](../../packages/storage-sqlite/src/assets.ts)
- [apps/desktop/src/ImportDialog.tsx](../../apps/desktop/src/ImportDialog.tsx)

## 执行顺序

1. 定义资源句柄、并发/响应/单资源/总量预算并实现流式入库。
2. 接入原生授权目录，在授权边界内解析相对资源与符号链接。
3. 回归媒体重试、预览提交和取消，把入口限制交给 G16 汇总提示。

## 待办

### T046 · 原 §7

- [ ] **P2 — 媒体流式入库与可配置预算**：将当前图片逐个缓冲/base64 的流程扩展为有界并发/流式资源句柄，提供响应、单资源、总量和解码预算；不直接套用设计建议的 100/500MB 默认值而绕过现有保护。

### T047 · 原 §7

- [ ] **P2 — 授权相邻资源目录**：支持原生授权目录内的相对资源解析、符号链接和路径边界校验；当前用户逐个提供相邻资源文件是安全的有限实现。若支持内网站点，须新增显式任务/Notebook 策略并保留 DNS/连接地址验证。

## 验证与完成条件

- [tests/extensions.test.mjs](../../tests/extensions.test.mjs)
- `pnpm run test:features`
- 目录逃逸、符号链接、预算与取消回归。

完成条件：内存有界、取消可用、路径不逃逸；可配置预算不会绕过已有保护。

人工 / 外部资源：原生目录授权人工体验复用 G06；真实站点样本需有相应访问权限。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
