import { useEffect, useState } from "react";
import type {
  DiagnosticLevel,
  DiagnosticSettings,
  DiagnosticsExport,
} from "@anynote/types";
import { request } from "./api";

/** Recording levels offered in the UI. */
const levels: { value: DiagnosticLevel; label: string }[] = [
  { value: "off", label: "关闭记录" },
  { value: "minimal", label: "最小化（默认）" },
  { value: "full", label: "完整（导出前脱敏）" },
];

/** Category labels for the retained events. */
const categoryLabels: Record<string, string> = {
  sqlite: "SQLite 提交",
  queue: "任务与队列",
  throughput: "资源吞吐",
  backup: "备份校验",
  restore: "恢复",
  plugin: "插件",
  editor: "编辑器",
};

/**
 * Format a millisecond value compactly.
 *
 * @param value Milliseconds.
 * @returns A readable string.
 */
function ms(value: number) {
  return value >= 1000
    ? (value / 1000).toFixed(2) + "s"
    : value.toFixed(1) + "ms";
}

/**
 * Device diagnostics: recording level, aggregated metrics, retained events and
 * a redacted JSON export. Only operation names, timings, sizes and error codes
 * are shown; document content, source URLs and credentials are never recorded.
 */
export default function Diagnostics() {
  const [settings, setSettings] = useState<DiagnosticSettings | null>(null),
    [bundle, setBundle] = useState<DiagnosticsExport | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);

  /** Reload settings and the current export bundle. */
  const load = async () => {
    setError("");
    try {
      const [nextSettings, nextBundle] = await Promise.all([
        request<DiagnosticSettings>("getDiagnosticsSettings"),
        request<DiagnosticsExport>("getDiagnostics"),
      ]);
      setSettings(nextSettings);
      setBundle(nextBundle);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  /**
   * Change the recording level, then refresh the summary.
   *
   * @param level New level.
   */
  const change = async (level: DiagnosticLevel) => {
    setBusy(true);
    try {
      setSettings(
        await request<DiagnosticSettings>("setDiagnosticsSettings", { level }),
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Download the redacted bundle as a JSON file. */
  const exportBundle = () => {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download =
      "anynote-diagnostics-" + bundle.generatedAt.slice(0, 10) + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /** Clear the retained metrics and events. */
  const clear = async () => {
    setBusy(true);
    try {
      await request("clearDiagnostics");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recent = bundle ? [...bundle.events].slice(-50).reverse() : [];
  return (
    <section className="local-cleanup">
      <h2 className="subheading">诊断日志与指标</h2>
      <p>
        统一记录 SQLite
        提交、任务队列、资源吞吐、备份与恢复校验、插件启动与崩溃、编辑器模式转换耗时。
        导出内容始终脱敏：不包含正文、来源敏感 URL
        或密钥；默认最小化，仅记录耗时、大小与错误码。
      </p>
      <div className="cleanup-options">
        <label>
          记录级别
          <select
            aria-label="诊断记录级别"
            value={settings?.level ?? "minimal"}
            disabled={busy}
            onChange={(e) => void change(e.target.value as DiagnosticLevel)}
          >
            {levels.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          刷新
        </button>
        <button
          className="secondary"
          disabled={busy || !bundle}
          onClick={exportBundle}
        >
          导出诊断
        </button>
        <button
          className="danger-button"
          disabled={busy}
          onClick={() => void clear()}
        >
          清空记录
        </button>
      </div>
      {bundle && (
        <div className="cleanup-plan">
          <strong>
            指标 {bundle.metrics.length} 项 · 事件 {bundle.events.length} 条
            {bundle.truncated ? "（较早事件已按上限丢弃）" : ""}
          </strong>
          <details>
            <summary>查看指标（耗时 / 字节）</summary>
            {bundle.metrics.slice(0, 40).map((m) => (
              <p key={m.name}>
                {m.name}：{m.count} 次 · 累计 {ms(m.totalMs)} · 峰值{" "}
                {ms(m.maxMs)}
                {m.bytes ? ` · ${m.bytes} 字节` : ""}
              </p>
            ))}
            {!bundle.metrics.length && <p>暂无指标。</p>}
          </details>
          <details>
            <summary>查看最近事件（最多 50 条）</summary>
            {recent.map((e, i) => (
              <p key={i}>
                {new Date(e.at).toLocaleTimeString("zh-CN")} ·{" "}
                {categoryLabels[e.category] || e.category} · {e.name}
                {e.code ? ` [${e.code}]` : ""}
                {e.outcome && e.outcome !== "ok" ? ` · ${e.outcome}` : ""}
                {e.durationMs !== undefined ? ` · ${ms(e.durationMs)}` : ""}
                {e.detail ? ` · ${e.detail}` : ""}
              </p>
            ))}
            {!recent.length && (
              <p>暂无事件（最小化级别仅记录失败与关键事件）。</p>
            )}
          </details>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
