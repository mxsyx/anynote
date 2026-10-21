# G20 · 视觉组件与设计验收

[返回总入口](../../TODO.md)

类型：UI / 设计。目标：共用 token/组件、状态、窗口与主题截图。

前置：沿用当前拟物、原生应用方向；先核对现有组件与最新界面。

并行边界：与后端独立组并行；main.tsx、styles.css 和组件与 G14/G19 串行集成。

## 建议入口

- [apps/desktop/src/components/ui](../../apps/desktop/src/components/ui)
- [apps/desktop/src/styles.css](../../apps/desktop/src/styles.css)
- [apps/desktop/src/Bookshelf.tsx](../../apps/desktop/src/Bookshelf.tsx)
- [apps/desktop/src/icons.tsx](../../apps/desktop/src/icons.tsx)

## 执行顺序

1. 核对共用 token、字体、排版和焦点，复用现有 UI 组件。
2. 按页面补加载/空/错误状态，保留真实行为，模态/对话框按项目规则动态创建。
3. 最后一次视觉改动后再执行相关浏览器测试并审图，人工辅助技术验收交 G06。

## 待办

### T057 · 原 §9

- [x] **P2 — 视觉组件与设计交付**：完善共用 token/组件、字体/排版、焦点规范及核心页面加载/空/错误状态；在三档窗口、浅深主题、长中文标题、极深目录和多插件内容下持续截图评审，补齐尚无可用页面的设计样张。

## 验证与完成条件

- `pnpm run test:bookshelf`
- `pnpm run test:ui`
- `pnpm run test:document`
- 最终改动后的三档窗口、浅深主题、长中文标题、深目录和扩展内容截图。

完成条件：最终界面截图与行为回归齐全；模拟 RPC 的浏览器用例不证明真实存储。

人工 / 外部资源：设计取舍和人工体验评审；浏览器脚本只证明其实际覆盖的界面行为。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。

## 2026-10-21 交接

T057 本机实现与截图回归已完成。源码基线 `b06b0a0` 加本组工作区改动；设计规范、复现步骤与证据边界见 [G20 视觉报告](../G20-visual-review.md)。

- 共用字体/间距/焦点/错误 token 与 `ViewState`；补书橱初始化、搜索和扩展列表加载/错误/空态与重试，缺失图片增加重试。保持书橱、纸张、真实编辑与动态模态挂载。
- 增加仅开发环境可访问的组件与 AI 提案样张；AI 明确为静态设计，不作为已实现能力。生产入口未引入样张。
- 三档窗口 1280×800、1440×900、1920×1080 × 浅深主题：浏览器/样张 47 张，真实 Electron 核心页面 36 张。覆盖长中文标题、40 层目录、长代码、视频/白板/未知扩展与缺失资源。生成目录 `docs/screenshots/g20/`，本地总览 `index.html`，两组 `report.json` 均为 passed。
- 已通过 `pnpm run test:bookshelf`、`pnpm run test:visual`、`pnpm run test:ui`、`pnpm run test:document`；最终字体改动后重新构建并通过 document，随后重跑 `node scripts/ui-smoke.mjs` 与两项浏览器回归。变更文件 ESLint、Prettier、构建中的 TypeScript 与 `git diff --check` 通过。
- `node scripts/check-renderer-bundle.mjs` 通过：首屏 JS 363,515 bytes / gzip 113,840 bytes。无新增首屏重型依赖；Vite 保留既有大块警告，具体负载性能继续由 G19 管理。
- 修正旧 UI 脚本的源码/阅读切换与浏览器菜单假设；真实 Electron 导出使用临时保存路径。原生菜单 helper 等待 renderer 收到 IPC 后再继续输入，图片插入测试确认菜单触发文件输入后注入 fixture。构建清理 workspace dist 与 Vite 测试曾发生竞争，最终按先构建、后浏览器回归的顺序全部通过。

环境：macOS arm64，Node 24.22.0、Electron 41.9.1、Playwright 1.55.1、Chrome 155.0.8059.85。浏览器数据为模拟 RPC；桌面回归使用真实临时存储。生成截图不提交版本库，可按报告命令重建。

本组无剩余实现阻塞。人工体验/读屏/真实 IME/原生文件选择器/200% 缩放交接 G06 T010/T016；不据此勾选 G06 或声明跨平台发布验收完成。
