import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { ViewState } from "./components/ui/view-state";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import "./styles.css";
import "./design-preview.css";

/** Development-only specimen; it is not imported by the application entry or release build. */
function DesignPreview() {
  const [dialog, setDialog] = useState(false);
  const ai = new URLSearchParams(location.search).has("ai");
  return (
    <main className="design-preview">
      <header>
        <span className="eyebrow">ANYNOTE · DESIGN SPECIMEN</span>
        <h1>{ai ? "AI 提案侧栏 · 设计样张" : "纸张、文字与交互"}</h1>
        <p>
          仅供视觉评审 ·{" "}
          {ai
            ? "尚无可用 AI 页面，以下为静态提案样张，不调用模型或修改笔记。"
            : "复用应用 token 与 UI 控件，不属于产品导航。"}
        </p>
      </header>
      {ai ? (
        <div className="design-ai-layout">
          <article className="design-paper">
            <small>当前文档 · 阅读札记</small>
            <h2>把灵感整理成可以重读的文字</h2>
            <p>午后读完一章书，留下三段摘录。先写自己的理解，再补充引文。</p>
            <blockquote>
              提案只修改明确选中的内容，其余段落保持原样。
            </blockquote>
            <h3>仍待整理的线索</h3>
            <p>作者对记忆与书写的讨论，可以和上周的笔记相互参照。</p>
          </article>
          <aside className="design-paper" aria-label="AI 提案设计样张">
            <h2>整理选中段落</h2>
            <p className="muted">上下文：当前笔记 · 已选 1 段 · 未发送</p>
            <hr />
            <h3>建议变更 1 / 1</h3>
            <del>午后读完一章书，留下三段摘录。</del>
            <ins>午后阅读后，我留下了三段摘录，并准备补充自己的理解。</ins>
            <p>
              <a href="#reference">引用：阅读札记 / 第三章</a>
            </p>
            <div className="design-actions">
              <Button disabled>接受选中变更</Button>
              <Button variant="outline" disabled>
                拒绝
              </Button>
              <Button variant="ghost" disabled>
                撤销
              </Button>
            </div>
            <small>样张操作不可用 · 应用前需要版本校验。</small>
          </aside>
        </div>
      ) : (
        <>
          <div className="design-columns">
            <section className="design-paper">
              <h2>字体与层级</h2>
              <h3>中文标题 · 春日阅读手记</h3>
              <p>
                系统 UI
                字体承载工具与表单；宋体回退用于书名和章节。正文强调清晰的行距与留白。
              </p>
              <small className="muted">说明文字 / 次级信息 / 2026-10-21</small>
              <pre>
                <code>const notebook = "本地知识库";</code>
              </pre>
              <div className="design-swatches">
                {[
                  "bg",
                  "sidebar",
                  "text",
                  "secondary",
                  "accent",
                  "focus",
                  "danger",
                ].map((token) => (
                  <span key={token}>
                    <i style={{ background: `var(--${token})` }} />
                    {token}
                  </span>
                ))}
              </div>
            </section>
            <section className="design-paper">
              <h2>按钮、表单与焦点</h2>
              <div className="design-actions">
                <Button onClick={() => setDialog(true)}>打开样张对话框</Button>
                <Button variant="outline">次要操作</Button>
                <Button variant="destructive">删除</Button>
                <Button disabled>不可用</Button>
              </div>
              <label>
                Notebook 名称
                <Input defaultValue="春日阅读与那些尚未整理的漫长中文标题" />
              </label>
              <label>
                说明
                <Textarea defaultValue="按 Tab 检查键盘焦点，按 Escape 关闭对话框。" />
              </label>
              <a href="#states">查看状态样张</a>
            </section>
          </div>
          <section id="states" className="design-states">
            <ViewState kind="loading" title="正在读取藏书…">
              请稍候，正在整理目录。
            </ViewState>
            <ViewState title="这里，等待新的想法">
              创建笔记或导入已有资料。
            </ViewState>
            <ViewState
              kind="error"
              title="读取未完成"
              action={<Button variant="outline">重试</Button>}
            >
              当前目录不可用。检查位置后重试。
            </ViewState>
          </section>
        </>
      )}
      {dialog && (
        <Dialog open onOpenChange={setDialog}>
          <DialogContent className="form-dialog">
            <DialogTitle>创建 Notebook</DialogTitle>
            <DialogDescription>
              动态创建的设计样张，关闭后卸载。
            </DialogDescription>
            <label>
              名称
              <Input autoFocus defaultValue="新的篇章" />
            </label>
            <div className="design-actions">
              <Button onClick={() => setDialog(false)}>完成样张</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </main>
  );
}

if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<DesignPreview />);
