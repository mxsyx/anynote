import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { request } from "./api";

/** Target that a remote maintenance operation acts on. */
interface Target {
  provider?: "s3" | "cloudflare";
  id: string;
  lineageId: string;
  remoteNotebookId?: string;
  name: string;
}

/** UTC daily/weekly/monthly sampling retention policy. */
interface Calendar {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
}

/** Display labels for retention reasons. */
const reasonNames: Record<string, string> = {
  latest: "最近版本",
  daily: "日采样",
  weekly: "周采样",
  monthly: "月采样",
  future: "未来时间保护",
};

/** One remote cleanup plan (keep/delete lists and reclaimable bytes). */
interface Plan {
  id: string;
  keep: number;
  calendar?: Calendar;
  referenceTime?: string;
  sampled?: { id: string; reasons: string[] }[];
  lineageId?: string;
  remove: { id: string; createdAt: string }[];
  objects: { size: number }[];
  protected: string[];
  staging: number;
  reclaimBytes: number;
  graceHours: number;
  status?: string;
}

/** Current writer info of the remote branch. */
interface Writer {
  head: string;
  deviceId: string;
  writerEpoch: number;
}

/**
 * Remote maintenance dialog.
 *
 * Two modes: version retention and cleanup (preview, then confirm permanent
 * deletion), and device takeover (bump the writer epoch to revoke the previous
 * device's write access).
 */
export default function RemoteMaintenance({
  notebookId,
  target,
  onClose,
  onChanged,
}: {
  notebookId: string;
  target: Target;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"retention" | "writer">("retention"),
    [keep, setKeep] = useState(30),
    [calendar, setCalendar] = useState<Calendar>({
      dailyDays: 0,
      weeklyWeeks: 0,
      monthlyMonths: 0,
    }),
    [remote, setRemote] = useState(target.remoteNotebookId || notebookId),
    [lineage, setLineage] = useState(target.lineageId),
    [plan, setPlan] = useState<Plan | null>(null),
    [writer, setWriter] = useState<Writer | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [s3Ready, setS3Ready] = useState(false),
    [notice, setNotice] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  /**
   * Run an async action uniformly and clear notice state.
   *
   * @param fn Action to run.
   */
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void request<{ activePlan: Plan | null }>("remoteRetentionState", {
      notebookId,
      targetId: target.id,
    })
      .then((result) => {
        if (result.activePlan) {
          setPlan(result.activePlan);
          setKeep(result.activePlan.keep);
          setCalendar(
            result.activePlan.calendar || {
              dailyDays: 0,
              weeklyWeeks: 0,
              monthlyMonths: 0,
            },
          );
          setNotice("发现未完成的清理，请确认后重试同一计划。");
        }
      })
      .catch((e) => setError(e.message));
  }, [notebookId, target.id]);
  return (
    <div className="modal-overlay">
      <div
        className="form-dialog task-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="远端维护"
      >
        <div className="dialog-heading">
          <h2>{target.name} · 远端维护</h2>
          <button aria-label="关闭" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {target.provider === "s3" && (
          <label>
            <input
              type="checkbox"
              checked={s3Ready}
              onChange={(e) => setS3Ready(e.target.checked)}
            />
            确认访问此分支的所有客户端已升级，旧任务已停止。清理需要桶版本管理和条件写入；不会自动修改桶设置。
          </label>
        )}
        <div className="dialog-actions">
          <button
            disabled={busy || plan?.status === "deleting"}
            onClick={() => {
              setMode("retention");
              setConfirmed(false);
            }}
          >
            版本保留与清理
          </button>
          {target.provider !== "s3" && (
            <button
              disabled={busy || plan?.status === "deleting"}
              onClick={() => {
                setMode("writer");
                setConfirmed(false);
              }}
            >
              设备接管
            </button>
          )}
        </div>
        {mode === "retention" ? (
          <>
            <p>
              {target.provider === "s3"
                ? "仅清理此目标分支；保留版本和活动恢复受保护，备份执行期间不能清理。无引用资源版本的宽限期为 24 小时，失败后可重试同一计划。"
                : "仅清理当前分支的旧版本。所有分支的 head、保留版本、上传中版本和恢复 pin 均受保护；对象宽限期为 24 小时。"}
            </p>
            <label>
              保留最近版本数
              <input
                type="number"
                min={1}
                max={1000}
                value={keep}
                disabled={busy || plan?.status === "deleting"}
                onChange={(e) => {
                  setKeep(Number(e.target.value));
                  setPlan(null);
                  setConfirmed(false);
                }}
              />
            </label>
            <p>
              可叠加 UTC 日/周/月采样，每个时间段保留最新版本；0
              表示关闭。周从周一开始，窗口包含当前日、周或月。
            </p>
            {(
              [
                ["dailyDays", "每日采样保留天数", 365],
                ["weeklyWeeks", "每周采样保留周数", 104],
                ["monthlyMonths", "每月采样保留月数", 120],
              ] as const
            ).map(([key, label, max]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={0}
                  max={max}
                  value={calendar[key]}
                  disabled={busy || plan?.status === "deleting"}
                  onChange={(e) => {
                    setCalendar({ ...calendar, [key]: Number(e.target.value) });
                    setPlan(null);
                    setConfirmed(false);
                  }}
                />
              </label>
            ))}
            <button
              className="secondary"
              disabled={
                busy ||
                plan?.status === "deleting" ||
                (target.provider === "s3" && !s3Ready)
              }
              onClick={() =>
                void act(async () => {
                  setPlan(
                    await request<Plan>("previewRemoteRetention", {
                      confirmed: target.provider === "s3" ? s3Ready : undefined,
                      notebookId,
                      targetId: target.id,
                      keep,
                      calendar,
                    }),
                  );
                  setConfirmed(false);
                })
              }
            >
              预览清理
            </button>
            {plan && (
              <>
                <p>
                  将删除 {plan.remove.length} 个旧版本、{plan.objects.length}{" "}
                  {target.provider === "s3" ? "个对象版本" : "个无引用对象"}
                  ，预计释放 {(plan.reclaimBytes / 1024 ** 2).toFixed(2)}{" "}
                  MB。保护 {plan.protected.length} 个版本
                  {target.provider === "s3"
                    ? "。"
                    : `及 ${plan.staging} 个上传中版本。`}
                </p>
                {plan.calendar && (
                  <p>
                    本次计划：最近 {plan.keep} 个版本 +{" "}
                    {plan.calendar.dailyDays} 天日采样 /{" "}
                    {plan.calendar.weeklyWeeks} 周周采样 /{" "}
                    {plan.calendar.monthlyMonths} 月月采样。以{" "}
                    {new Date(plan.referenceTime!).toISOString()} 为 UTC
                    窗口基准。
                  </p>
                )}
                {!!plan.sampled?.length && (
                  <details>
                    <summary>查看策略保留版本与原因</summary>
                    {plan.sampled.map((g) => (
                      <p key={g.id}>
                        {g.id} ·{" "}
                        {g.reasons
                          .map((reason) => reasonNames[reason] || reason)
                          .join("、")}
                      </p>
                    ))}
                  </details>
                )}
                <details>
                  <summary>查看待删除版本</summary>
                  {plan.remove.map((g) => (
                    <p key={g.id}>
                      {g.id} · {new Date(g.createdAt).toLocaleString("zh-CN")}
                    </p>
                  ))}
                </details>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我确认永久删除列出的远端版本和对象
                </label>
                <button
                  className="primary"
                  disabled={busy || !confirmed}
                  onClick={() =>
                    void act(async () => {
                      setPlan({ ...plan, status: "deleting" });
                      try {
                        await request("applyRemoteRetention", {
                          notebookId,
                          targetId: target.id,
                          planId: plan.id,
                          confirmed: true,
                        });
                      } catch (e) {
                        try {
                          const state = await request<{
                            activePlan: Plan | null;
                          }>("remoteRetentionState", {
                            notebookId,
                            targetId: target.id,
                          });
                          setPlan(state.activePlan);
                        } catch {}
                        throw e;
                      }
                      setPlan(null);
                      setConfirmed(false);
                      setNotice("清理已完成，保留版本仍可恢复。");
                      onChanged();
                    })
                  }
                >
                  {busy
                    ? "正在清理…"
                    : plan.status === "deleting"
                      ? "重试未完成清理"
                      : "确认永久清理"}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <p>
              填写已有远端 Notebook 与分支身份。接管会增加 writer
              epoch，旧设备随后只能读取；本地内容不会自动合并。接管后自动备份关闭，先核对内容再备份。
            </p>
            <label>
              远端 Notebook UUID
              <input
                value={remote}
                disabled={busy || !!writer}
                onChange={(e) => setRemote(e.target.value)}
              />
            </label>
            <label>
              远端 Lineage UUID
              <input
                value={lineage}
                disabled={busy || !!writer}
                onChange={(e) => setLineage(e.target.value)}
              />
            </label>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setRequestId(crypto.randomUUID());
                  setWriter(
                    await request<Writer>("remoteWriter", {
                      notebookId,
                      targetId: target.id,
                      remoteNotebookId: remote,
                      lineageId: lineage,
                    }),
                  );
                  setConfirmed(false);
                })
              }
            >
              读取写入权
            </button>
            {writer && (
              <>
                <p>
                  当前设备 {writer.deviceId} · epoch {writer.writerEpoch}
                  <br />
                  head：{writer.head || "尚无版本"}
                </p>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我确认撤销原设备并接管此远端分支
                </label>
                <button
                  className="primary"
                  disabled={busy || !confirmed}
                  onClick={() =>
                    void act(async () => {
                      await request("takeoverRemoteWriter", {
                        notebookId,
                        targetId: target.id,
                        remoteNotebookId: remote,
                        lineageId: lineage,
                        requestId,
                        expectedHead: writer.head,
                        expectedWriterEpoch: writer.writerEpoch,
                        confirmed: true,
                      });
                      setNotice("已接管写入权，自动备份已关闭。");
                      setWriter(null);
                      setPlan(null);
                      setConfirmed(false);
                      onChanged();
                    })
                  }
                >
                  确认设备接管
                </button>
              </>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </div>
  );
}
