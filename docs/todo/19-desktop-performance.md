# G19 · 桌面负载基线与首屏体积

[返回总入口](../../TODO.md)

类型：性能 / 实测。目标：代表性负载 → 首屏/依赖优化 → 实际资源验收。

前置：建立可重复样本；低配置设备与复杂真实语料用于最终代表性结论。

并行边界：与云盘/导入可并行；主入口和资源装包修改与 G05/G14 串行集成。

## 建议入口

- [scripts/performance-ui-acceptance.mjs](../../scripts/performance-ui-acceptance.mjs)
- [scripts/benchmark-search.mjs](../../scripts/benchmark-search.mjs)
- [apps/desktop/src/main.tsx](../../apps/desktop/src/main.tsx)
- [vite.config.ts](../../vite.config.ts)

## 执行顺序

1. 先固定低配置/冷缓存/多 Notebook 和复杂媒体基线，与 G08 分开记录备份大清单负载。
2. 针对测得的大依赖优化拆包、加载时机和缓存。
3. 最终测离线首次使用、打包静态路径及长时内存，结果交 G05/G00。

## 待办

### T055 · 原 §9

- [ ] **P2 — 性能代表性补齐**：测量低配置机器、冷缓存启动、多 Notebook 搜索/反链、复杂 PDF/大图、长时间任务与内存增长；继续保留 50KiB 打开/保存、万节点树和万篇搜索预算，现有本机热缓存/合成语料不代表所有环境。

### T056 · 原 §9

- [ ] **P2 — 首屏与依赖体积**：分析 Excalidraw/mermaid 等大块依赖，优化拆包、加载时机和缓存，验证离线可用、首次编辑和打包后的资源路径。

## 验证与完成条件

- `pnpm run test:performance`
- `pnpm run benchmark:search`
- `pnpm run build`
- 打包后离线首次编辑、冷启动、复杂 PDF/大图与长任务内存测量。

完成条件：性能结论标注设备与缓存条件，优化不损害离线首用或打包资源。

人工 / 外部资源：提供代表性设备和真实复杂语料；本机基线/分析不等待。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
