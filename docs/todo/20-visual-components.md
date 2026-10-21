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

- [ ] **P2 — 视觉组件与设计交付**：完善共用 token/组件、字体/排版、焦点规范及核心页面加载/空/错误状态；在三档窗口、浅深主题、长中文标题、极深目录和多插件内容下持续截图评审，补齐尚无可用页面的设计样张。

## 验证与完成条件

- `pnpm run test:bookshelf`
- `pnpm run test:ui`
- `pnpm run test:document`
- 最终改动后的三档窗口、浅深主题、长中文标题、深目录和扩展内容截图。

完成条件：最终界面截图与行为回归齐全；模拟 RPC 的浏览器用例不证明真实存储。

人工 / 外部资源：设计取舍和人工体验评审；浏览器脚本只证明其实际覆盖的界面行为。

收尾时按 [交接规则](../../TODO.md#交接规则) 回写本文件勾选状态、验证结果与剩余阻塞。条目正文沿用原清单记录，开工时核对当前状态；其中旧章节号参见 [原章节对照](../../TODO.md#原章节对照)。
