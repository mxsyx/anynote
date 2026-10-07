import { useEffect, useState } from "react";
import type { IntegrityReport } from "@anynote/types";
import { request } from "./api";

/** One cleanup preview (candidate files and reclaimable bytes). */
interface Plan {
  id: string;
  bytes: number;
  files: { path: string; kind: string; size: number }[];
}

/** Local storage cleanup: preview and clean orphan files and expired snapshots. */
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
    [result, setResult] = useState(""),
    [report, setReport] = useState<IntegrityReport | null>(null);
  useEffect(() => {
    request<IntegrityReport | null>("getIntegrityReport", { notebookId })
      .then(setReport)
      .catch(() => {});
  }, [notebookId]);

  /**
   * Run an async action uniformly and maintain busy/error state.
   *
   * @param fn Action to run.
   */
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

  /**
   * Start a read-only consistency scan and poll briefly for its report.
   *
   * The scan is budgeted and usually finishes within a second, so the short
   * poll is enough to refresh the summary without opening the task center.
   */
  const inspect = () =>
    action(async () => {
      await request("inspectIntegrity", { notebookId });
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const latest = await request<IntegrityReport | null>(
          "getIntegrityReport",
          { notebookId },
        );
        if (latest && latest.checkedAt !== report?.checkedAt) {
          setReport(latest);
          return;
        }
      }
    });
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
      <h2 className="subheading">启动一致性巡检</h2>
      <p>
        只读检查遗留临时文件、孤儿资源与缺失引用，并保留活动租约、历史与备份
        pin； 巡检结果仅作提示，不会自动删除任何文件。
      </p>
      <div className="cleanup-options">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void inspect()}
        >
          运行一致性巡检
        </button>
      </div>
      {report && (
        <div className="cleanup-plan">
          <strong>
            {new Date(report.checkedAt).toLocaleString("zh-CN")} 的巡检结果
          </strong>
          <p>
            临时文件 {report.counts.tempFiles} · 孤儿资源{" "}
            {report.counts.orphanResources} · 无引用资源记录{" "}
            {report.counts.unreferencedAssets} · 缺失引用{" "}
            {report.counts.missingResources}
            {report.counts.activeLeases
              ? ` · 活动租约 ${report.counts.activeLeases}（已保护）`
              : ""}
            {report.truncated ? " · 达到预算，结果不完整" : ""}
          </p>
          {report.findings.length > 0 && (
            <details>
              <summary>查看具体发现（{report.findings.length} 项）</summary>
              {report.findings.map((f, i) => (
                <p key={i}>
                  {f.path}：{f.message}
                </p>
              ))}
            </details>
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
