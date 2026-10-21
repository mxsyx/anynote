import { Button } from "./components/ui/button";
import { useEffect, useState } from "react";
import { HardDriveDownload, X } from "./icons";
import { request } from "./api";
import type { CloudTargetView } from "./CloudBackup";
import type { CloudRestorePreview } from "@anynote/types/cloud-backup";
import {
  formatCloudBytes as formatBytes,
  verificationLabel,
} from "./cloud-backup-display";

/** A restorable backup slot (device + current copy). */
interface Slot {
  deviceSlotId: string;
  deviceLabel?: string;
  commitId?: string;
  completedAt?: string;
  databaseBytes?: number;
  assetBytes?: number;
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
    [preview, setPreview] = useState<CloudRestorePreview | null>(null),
    [estimating, setEstimating] = useState(false),
    [estimateVersion, setEstimateVersion] = useState(0),
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

  useEffect(() => {
    setPreview(null);
    if (!selected) return;
    let active = true;
    setEstimating(true);
    setError("");
    void request<CloudRestorePreview>("previewCloudRestore", {
      notebookId,
      targetId: target.target.id,
      deviceSlotId: selected.deviceSlotId,
    })
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setEstimating(false);
      });
    return () => {
      active = false;
    };
  }, [notebookId, target.target.id, selected, estimateVersion]);

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
          <Button
            variant="ghost"
            size="layout"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={18} />
          </Button>
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
                  ·{" "}
                  {formatBytes(
                    slot.databaseBytes == null
                      ? undefined
                      : slot.databaseBytes + (slot.assetBytes || 0),
                  )}
                </small>
              </span>
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  setSelected(slot);
                }}
              >
                选择
              </Button>
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
              {formatBytes(
                preview
                  ? preview.databaseBytes + preview.assetBytes
                  : selected.databaseBytes == null
                    ? undefined
                    : selected.databaseBytes + (selected.assetBytes || 0),
              )}
              （包含正文、附件和历史）。
            </p>
            <p className="small-note">
              校验状态：
              {verificationLabel(
                preview?.verification ?? selected.verification,
              )}
              。恢复创建新
              Notebook，不覆盖当前工作库；缺少的插件内容会保留数据并降级预览。
            </p>
            {estimating && <p role="status">正在读取备份清单并预估恢复空间…</p>}
            {preview && (
              <div className="small-note" role="status">
                <p>
                  预计下载 {formatBytes(preview.downloadBytes)} · 恢复所需空间约{" "}
                  {formatBytes(preview.diskBudgetBytes)}
                </p>
                <p>
                  本地可用 {formatBytes(preview.availableBytes)}
                  {preview.reservedBytes > 0
                    ? ` · 其他恢复任务预算 ${formatBytes(preview.reservedBytes)}`
                    : ""}
                </p>
                <p>
                  空间预算包含附件、临时分块、数据库组装和索引重建。开始时会重新检查；恢复后会重新核对内容哈希。
                </p>
                {!preview.sufficient && (
                  <p className="form-error">
                    可用磁盘空间不足，请释放空间或等待其他恢复任务结束后重新检查。
                  </p>
                )}
              </div>
            )}
            <div className="dialog-actions">
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  setSelected(null);
                }}
              >
                返回
              </Button>
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                disabled={busy || estimating}
                onClick={() => {
                  setPreview(null);
                  setEstimateVersion((version) => version + 1);
                }}
              >
                重新检查空间
              </Button>
              <Button
                variant="ghost"
                size="layout"
                className="primary"
                disabled={busy || estimating || !preview?.sufficient}
                onClick={() => {
                  setError("");
                  setBusy(true);
                  void request<{ id: string }>("restoreCloudTargetBackup", {
                    notebookId,
                    targetId: target.target.id,
                    deviceSlotId: selected.deviceSlotId,
                    manifestRef: undefined,
                    expectedCommitId: preview?.commitId,
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
              </Button>
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
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                onClick={() =>
                  void request("cancelTask", { id: taskId })
                    .then(() => setTaskId(""))
                    .catch((e) => setError((e as Error).message))
                }
              >
                取消恢复
              </Button>
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
