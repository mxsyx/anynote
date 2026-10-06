import { useState } from "react";
import { X } from "lucide-react";

export type {
  LocalBackupEstimate as BackupEstimate,
  LocalBackupInfo as BackupInfo,
} from "@anynote/types";

import type {
  LocalBackupEstimate as BackupEstimate,
  LocalBackupInfo as BackupInfo,
} from "@anynote/types";

/**
 * Format bytes as an MB label.
 *
 * @param bytes Byte count.
 * @returns The MB label.
 */
const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(1) + " MB";

/**
 * Local backup preview/restore confirmation dialog.
 *
 * Backup mode shows the copy volume and unusual-deletion confirmation; restore
 * mode shows the manifest summary and any interrupted-commit notice.
 */
export default function LocalBackupReview({
  path,
  preview,
  info,
  busy,
  onClose,
  onProceed,
}: {
  path: string;
  preview?: BackupEstimate;
  info?: BackupInfo;
  busy: boolean;
  onClose: () => void;
  onProceed: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const m = info?.manifest;
  return (
    <div className="modal-overlay">
      <div
        className="form-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={preview ? "备份预览" : "恢复当前备份"}
      >
        <div className="dialog-heading">
          <h2>{preview ? "备份预览" : "恢复当前备份"}</h2>
          <button disabled={busy} onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <p className="local-backup-path">{path}</p>
        {preview ? (
          <>
            <p>
              预计复制 {preview.copyAssets} 个附件，跳过 {preview.skipAssets}{" "}
              个附件；
              {preview.replaceDatabase ? "替换数据库" : "数据库无需复制"}。
            </p>
            <p>
              复制量 {mb(preview.copyBytes)}；额外空间预算{" "}
              {mb(preview.temporaryBytes)}；可用空间{" "}
              {mb(preview.availableBytes)}。
            </p>
            <p>
              新状态提交后清理 {preview.deleteFiles} 个受管附件，共{" "}
              {mb(preview.deleteBytes)}。
            </p>
            {!preview.enoughSpace && (
              <p className="form-error" role="alert">
                目标可用空间不足，请释放空间后重新预览。
              </p>
            )}
            {preview.requiresReview && (
              <>
                <p className="form-error" role="alert">
                  删除量异常：至少 20
                  个附件且达到旧清单的一半。请检查源内容是否符合预期。
                </p>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                  />
                  我已检查本次删除范围，并确认更新当前副本
                </label>
              </>
            )}
            <p className="muted">
              预览来自已保存的数据库切点；内容继续变化后，实际复制量可能调整，异常删除确认会失效。
            </p>
          </>
        ) : (
          <>
            <p>只有一份当前副本，没有历史版本。</p>
            {m ? (
              <>
                <p>
                  最近完成：{new Date(m.completedAt).toLocaleString("zh-CN")}
                </p>
                <p>
                  数据库 {mb(m.database.size)}；{m.files.length} 个附件，共{" "}
                  {mb(m.files.reduce((n, a) => n + a.size, 0))}。
                </p>
                <p>
                  最近完整校验：
                  {m.lastFullVerifiedAt
                    ? new Date(m.lastFullVerifiedAt).toLocaleString("zh-CN")
                    : "尚未执行"}
                </p>
                {m.verificationStatus === "rebuilt-needs-review" && (
                  <p className="form-error">
                    清单已重建、需核验，无法证明与过去源状态逐字节一致。
                  </p>
                )}
              </>
            ) : (
              <p>尚无已完成备份清单。</p>
            )}
            {info?.needsReconcile && (
              <p role="status">
                存在中断提交，恢复前会先协调提交状态并校验文件。
              </p>
            )}
            <p>
              恢复会完整校验所有文件，并在本机创建新的 Notebook；随后重建索引。
            </p>
          </>
        )}
        <div className="button-row">
          <button className="secondary" disabled={busy} onClick={onClose}>
            返回
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              (preview
                ? !preview.enoughSpace || (preview.requiresReview && !accepted)
                : !m && !info?.needsReconcile)
            }
            onClick={onProceed}
          >
            {busy
              ? "正在处理…"
              : preview
                ? "开始备份"
                : "校验并恢复为新 Notebook"}
          </button>
        </div>
      </div>
    </div>
  );
}
