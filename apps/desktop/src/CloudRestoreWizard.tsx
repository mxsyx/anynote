import { useEffect, useState } from "react";
import { HardDriveDownload, X } from "lucide-react";
import { request } from "./api";
import type { CloudTargetView } from "./CloudBackup";

/** A restorable backup slot (device + current copy). */
interface Slot {
  deviceSlotId: string;
  deviceLabel?: string;
  commitId?: string;
  completedAt?: string;
  databaseBytes?: number;
  assetCount?: number;
  verification?: string;
  local?: boolean;
}

/** One background task row as returned by the task centre. */
interface TaskRow {
  id: string;
  status: string;
  progress?: string;
  error?: string;
  restoredId?: string;
}

/** Human-readable verification level. */
const verificationLabels: Record<string, string> = {
  "provider-checksum": "已上传并校验内容",
  "download-sha256": "已完整校验",
  "accepted-size": "已上传，尚未完整校验",
};

/** Human-readable byte count. */
function formatBytes(bytes?: number) {
  if (bytes == null) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Restore wizard: account → device slot → current copy → download and verify.
 *
 * Restore creates a new Notebook by default without overwriting the local working DB; after download the core rewrites the copy's identity
 * and rebuilds search; on hash mismatch it will not register a normal Notebook.
 */
export default function CloudRestoreWizard({
  notebookId,
  target,
  onClose,
  onRestored,
}: {
  notebookId: string;
  target: CloudTargetView;
  onClose: () => void;
  onRestored: (id: string) => void;
}) {
  const [slots, setSlots] = useState<Slot[]>([]),
    [selected, setSelected] = useState<Slot | null>(null),
    [taskId, setTaskId] = useState(""),
    [progress, setProgress] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);

  useEffect(() => {
    void request<Slot[]>("listCloudDevices", {
      notebookId,
      targetId: target.target.id,
    })
      .then(setSlots)
      .catch((e) => setError((e as Error).message));
  }, [notebookId, target.target.id]);

  // Restore is a background task: poll the task center and switch to the new Notebook when done.
  useEffect(() => {
    if (!taskId) return;
    const timer = setInterval(() => {
      void request<TaskRow[]>("listTasks", { id: taskId })
        .then((rows) => {
          const task = rows.find((row) => row.id === taskId);
          if (!task) return;
          setProgress(task.progress ?? "");
          if (["running", "committing", "waiting-disk"].includes(task.status))
            return;
          clearInterval(timer);
          if (task.status === "completed" && task.restoredId) {
            onRestored(task.restoredId);
            return;
          }
          setError(task.error ?? "恢复未完成");
          setTaskId("");
        })
        .catch((e) => {
          clearInterval(timer);
          setError((e as Error).message);
          setTaskId("");
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [taskId, onRestored]);

  return (
    <div className="modal-overlay">
      <div
        className="form-dialog task-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="从云盘恢复"
      >
        <div className="dialog-heading">
          <h2>{target.provider.title} · 恢复当前副本</h2>
          <button onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        {!slots.length && !selected && (
          <p className="muted">该账号下还没有可恢复的设备槽。</p>
        )}

        {!selected &&
          slots.map((slot) => (
            <div className="snapshot-row" key={slot.deviceSlotId}>
              <HardDriveDownload size={14} />
              <span>
                {slot.deviceLabel ?? slot.deviceSlotId.slice(0, 8)}
                {slot.local ? " · 本设备" : ""}
                <small>
                  {" "}
                  ·{" "}
                  {slot.completedAt
                    ? new Date(slot.completedAt).toLocaleString("zh-CN")
                    : "未知时间"}{" "}
                  · {formatBytes(slot.databaseBytes)} · {slot.assetCount ?? 0}{" "}
                  个资源
                </small>
              </span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setSelected(slot)}
              >
                选择
              </button>
            </div>
          ))}

        {selected && !taskId && (
          <>
            <p>
              将恢复{" "}
              {selected.completedAt
                ? new Date(selected.completedAt).toLocaleString("zh-CN")
                : "所选时间"}{" "}
              的副本：
              {formatBytes(selected.databaseBytes)} 数据库 ·{" "}
              {selected.assetCount ?? 0} 个资源。
            </p>
            <p className="small-note">
              校验状态：
              {verificationLabels[selected.verification ?? ""] ??
                selected.verification ??
                "未知"}
              。恢复创建新
              Notebook，不覆盖当前工作库；缺少的插件内容会保留数据并降级预览。
            </p>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setSelected(null)}>
                返回
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setBusy(true);
                  void request<{ id: string }>("restoreCloudTargetBackup", {
                    notebookId,
                    targetId: target.target.id,
                    deviceSlotId: selected.deviceSlotId,
                    manifestRef: undefined,
                  })
                    .then((task) => {
                      setTaskId(task.id);
                      setProgress("正在下载并校验恢复版本");
                    })
                    .catch((e) => setError((e as Error).message))
                    .finally(() => setBusy(false));
                }}
              >
                下载并校验
              </button>
            </div>
          </>
        )}

        {taskId && (
          <>
            <p role="status">{progress || "正在下载并校验恢复版本"}</p>
            <p className="small-note">
              下载结果会先在隔离临时目录校验，再注册为新的
              Notebook；取消或校验失败都会清理临时文件。
            </p>
            <div className="dialog-actions">
              <button
                className="secondary"
                onClick={() =>
                  void request("cancelTask", { id: taskId })
                    .then(() => setTaskId(""))
                    .catch((e) => setError((e as Error).message))
                }
              >
                取消恢复
              </button>
            </div>
          </>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
