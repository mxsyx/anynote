import { useState } from "react";
import { request } from "./api";
interface Plan {
  id: string;
  bytes: number;
  files: { path: string; kind: string; size: number }[];
}
export default function LocalCleanup({
  notebookId,
  onCleaned,
}: {
  notebookId: string;
  onCleaned: () => void;
}) {
  const [keep, setKeep] = useState(20),
    [days, setDays] = useState(30),
    [plan, setPlan] = useState<Plan | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState("");
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="local-cleanup">
      <h2 className="subheading">本地存储整理</h2>
      <p>
        保留全部数据库资源与历史引用，仅清理未入库且超过 5
        分钟的孤立文件，以及超过以下保留条件的完整快照。迁移前的数据库快照始终保留。
      </p>
      <div className="cleanup-options">
        <label>
          至少保留最近快照
          <input
            aria-label="保留快照数量"
            type="number"
            min={1}
            max={1000}
            value={keep}
            onChange={(e) => {
              setKeep(Number(e.target.value));
              setPlan(null);
            }}
          />
        </label>
        <label>
          保留最近天数
          <input
            aria-label="保留快照天数"
            type="number"
            min={0}
            max={3650}
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              setPlan(null);
            }}
          />
        </label>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              setPlan(
                await request("previewCleanup", {
                  notebookId,
                  keepSnapshots: keep,
                  keepDays: days,
                }),
              );
              setResult("");
            })
          }
        >
          预览清理
        </button>
      </div>
      {plan && (
        <div className="cleanup-plan">
          <strong>
            将清理 {plan.files.length} 个文件 ·{" "}
            {(plan.bytes / 1024 / 1024).toFixed(2)} MB
          </strong>
          {plan.files.length > 0 && (
            <>
              <details>
                <summary>查看具体文件</summary>
                {plan.files.map((f) => (
                  <p key={f.path}>
                    {f.kind === "snapshot" ? "旧快照" : "孤立文件"} · {f.path}
                  </p>
                ))}
              </details>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const r = await request<{ removed: number }>(
                      "applyCleanup",
                      { notebookId, planId: plan.id },
                    );
                    setResult("已清理 " + r.removed + " 个文件");
                    setPlan(null);
                    onCleaned();
                  })
                }
              >
                确认永久清理这些文件
              </button>
            </>
          )}
        </div>
      )}
      {result && <p role="status">{result}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
