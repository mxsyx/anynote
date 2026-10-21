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

- [x] **P2 — 首屏与依赖体积**：分析 Excalidraw/mermaid 等大块依赖，优化拆包、加载时机和缓存，验证离线可用、首次编辑和打包后的资源路径。

## 验证与完成条件

- `pnpm run test:performance`
- `pnpm run benchmark:search`
- `pnpm run build`
- 打包后离线首次编辑、冷启动、复杂 PDF/大图与长任务内存测量。

完成条件：性能结论标注设备与缓存条件，优化不损害离线首用或打包资源。

人工 / 外部资源：提供代表性设备和真实复杂语料；本机基线/分析不等待。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。

## 2026-10-21 实施与交接

基于 `c61dd8e` 工作区实施；本次改动尚未提交。测试设备为 macOS arm64、Apple M4（10 逻辑核）、32GiB RAM，启动器 Node 24.22.0、Electron 41.9.1（内置 Node 24.17.0）。使用临时真实 SQLite 工作区与合成语料，不使用模拟 RPC；OS 文件缓存保留，离线首用阶段另清除 Chromium HTTP/代码缓存。

### 已实施

- 将任务中心、恢复/迁移弹窗、备份/扩展/设置功能改为动态导入；每个功能有独立 Suspense 边界，共享加载提示。保留文档、PDF、图片和白板的现有按需加载。
- 在白板动态导入之前初始化本地字体路径，增加真实文字输入、本地 Excalifont 加载、预览导出、保存与重载检查。Excalidraw 的 CDN 回退声明仍由 CSP 拦截，不依赖在线服务，也不放宽 CSP。
- 增加 `dist/renderer-bundle.json`：按静态导入闭包统计首屏、gzip、总 JS、模块归属与动态导入。`test:performance` 强制首屏 400KiB / gzip 128KiB 预算，检查大功能未混入首屏及产物引用完整。
- 更新已过时的源码编辑器验收，改为连续文档编辑器；新增四库搜索/反链、16MP 图片、离线首用、持续媒体切换、进程工作集和 CDP JS heap 采样。保留 50KiB 打开/保存、万节点虚拟树、万篇搜索和 100MiB PDF 范围读取预算。
- 将可选的 G20 界面/无障碍及备份响应检查放到 `test:acceptance:ui`（`--ui --backup`）；报告显式记录启用的套件，默认性能通过不代表这些可选检查通过。G08 大备份清单不混入本次结论。
- Electron 驱动使用跨平台可执行文件解析、正常退出清理、失败清理、限时 UI 等待，并按名称进入固定 Notebook，避免最近访问顺序影响样本。
- 修复打包脚本读取 pnpm 12 多文档 lockfile 的失败，保留包管理器独立文档及 workspace 依赖文档。此装包入口修改交 G05/G14；运行与证据说明见 [性能验收](../PERFORMANCE-UI-ACCEPTANCE.md)。

### 体积基线

| 指标                |      改动前 |      改动后 |   变化 |
| ------------------- | ----------: | ----------: | -----: |
| 首屏静态 JS         |   473,421 B |   362,346 B | -23.5% |
| 首屏 JS gzip        |   143,618 B |   112,937 B | -21.4% |
| 所有 JS（含懒加载） | 9,213,429 B | 9,215,655 B | +0.02% |

大块依赖保留在功能加载路径：Excalidraw 字体子集约 1.82MB、Mermaid ELK 约 1.45MB、白板共享块约 1.11MB、文档编辑器约 728KB。优化目标是加载时机，未裁剪已有功能。Vite 内容哈希文件名和 ESM 模块缓存保持原行为。构建仍会提示超过 500KB 的懒加载块，未通过提高警告阈值掩盖体积。

### 设备与语料边界

四库共 11,064 节点，含 10,062 篇 Markdown、1,000 层目录、52,216 B 普通文档、1,664,013 B 超大文档、104,887,221 B / 100 页 PDF、4096×4096 / 3,316,651 B PNG，以及来自三个 Notebook 的 60 条反链。PDF 是注释填充文件，PNG 为确定性渐变；都不是复杂真实媒体。CPU 节流仅作用于离线首次编辑阶段，不等同于低配设备或内存限制。

T055 的外部验收仍需要真实低配设备、清空 OS 缓存后的启动、复杂 PDF/照片语料与小时级长期任务。短时工作集波动及峰值不作为“无泄漏”结论，保留未勾选。Windows/Linux 最终包与签名发布不在本次本机证据内，交 G05/G00 汇总。

### 验证记录

- `pnpm run test:performance`：生产构建、首屏预算、11 项真实 Electron 检查通过。
- `pnpm run benchmark:search`：四库 10,000 篇合成语料通过；全局唯一短语 / 短中文 / 带类型标签范围查询 p95 分别为 1.07 / 28.02 / 10.54ms。后端报告明确标注热索引与 OS 缓存。
- `npm_config_store_dir=/Users/mxsyx/Library/pnpm/store pnpm run package`：完整构建及 macOS arm64 未签名目录包生成通过。使用既有 pnpm 离线缓存；首次受限执行无法链接该缓存，已使用明确的 store 路径重跑。
- `pnpm exec vitest run tests/renderer-bundle.test.mjs tests/whiteboard-assets.test.ts tests/editor-ecosystem.test.mjs`：3 文件、12 测试通过；覆盖静态闭包去重/循环、动态字体路径初始化顺序及现有编辑器协议回归。
- 修改文件 ESLint、Prettier、`git diff --check` 通过；`build` 已包含前后端编译与 renderer TypeScript 检查。

| 指标                 | 源码生产页面 | macOS 目录包 |
| -------------------- | -----------: | -----------: |
| 新进程启动 p95       |     789.93ms |     773.54ms |
| 50KiB 文档打开 p95   |       30.5ms |       26.4ms |
| 50KiB 保存提交 p95   |      19.11ms |      11.04ms |
| 万篇唯一短语搜索 p95 |       1.64ms |        1.4ms |
| 虚拟树滚动 p95       |      38.75ms |      34.99ms |
| 四库搜索 p95         |      10.16ms |       8.22ms |
| 跨库反链 p95         |          3ms |       2.92ms |

离线首次进入 50KiB 编辑器：源码页面 891.33ms（原速），目录包 2666.09ms（仅该阶段 4 倍 CPU 节流），两个数字不作为同条件对比。两轮均加载本地绘图字体并完成白板文字保存；PDF 前两页范围读取 2,752,512 B，全量读取次数为 0，单 canvas。

生成证据：`dist/renderer-bundle.json`、`docs/search-benchmark.json`、`test-results/performance-ui-acceptance.json`、`test-results/performance-ui-packaged-acceptance.json`，截图为 `test-results/performance-editor.png`、`test-results/performance-packaged-editor.png`。生成目录未提交，以上命令可复现；此次未执行 `test:acceptance:ui` 的完整 G20 自动无障碍或备份负载套件，不复用历史通过结论。

目录包验证命令：`ANYNOTE_EXECUTABLE="$PWD/release/mac-arm64/Anynote.app/Contents/MacOS/Anynote" ANYNOTE_CPU_THROTTLE=4 ANYNOTE_SOAK_SECONDS=180 node scripts/performance-ui-acceptance.mjs`，11 项检查全部通过；最后的编辑器截图已查看，懒加载后工作区和文档正常显示。

| 内存采样         | 源码生产页面 | macOS 目录包 |
| ---------------- | -----------: | -----------: |
| 实际时长         |       60.74s |      180.52s |
| 循环次数         |           43 |          128 |
| 首末总工作集增长 |    296.36MiB |     82.13MiB |
| 总工作集峰值     |   1691.13MiB |   1664.58MiB |

工作集包含主进程、renderer、GPU、存储及其他 Utility 进程；不强制 GC，增长值受缓存、分配器和采样时机影响。目录包逐轮 JS heap 使用 CDP 实测。当前媒体负载的内存峰值较高，低配设备和小时级重复负载仍是 T055 的必需后续证据，不能据此声称内存恒定或无泄漏。
