import { Button } from "./components/ui/button";
import { X } from "./icons";

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
 * Backup mode shows the chunk counts and space budget; restore
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
          <Button
            variant="ghost"
            size="layout"
            disabled={busy}
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={18} />
          </Button>
        </div>
        <p className="local-backup-path">{path}</p>
        {preview ? (
          <>
            <p>
              预计复制 {preview.copyChunks} 个数据库分块，跳过{" "}
              {preview.skipChunks} 个数据库分块；
              {preview.databaseChanged ? "提交新备份" : "数据库内容未变"}。
            </p>
            <p>
              复制量 {mb(preview.copyBytes)}；额外空间预算{" "}
              {mb(preview.temporaryBytes)}；可用空间{" "}
              {mb(preview.availableBytes)}。
            </p>
            <p>
              新状态提交后清理 {preview.deleteFiles} 个旧分块，共{" "}
              {mb(preview.deleteBytes)}。
            </p>
            {!preview.enoughSpace && (
              <p className="form-error" role="alert">
                目标可用空间不足，请释放空间后重新预览。
              </p>
            )}
            <p className="muted">
              预览来自已保存的数据库切点；内容继续变化后，实际复制量可能调整。
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
                  数据库 {mb(m.database.size)}；{m.files.length}{" "}
                  个数据库分块，共 {mb(m.files.reduce((n, a) => n + a.size, 0))}
                  。
                </p>
                <p>
                  最近完整校验：
                  {m.lastFullVerifiedAt
                    ? new Date(m.lastFullVerifiedAt).toLocaleString("zh-CN")
                    : "尚未执行"}
                </p>
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
          <Button
            variant="ghost"
            size="layout"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            返回
          </Button>
          <Button
            variant="ghost"
            size="layout"
            className="primary"
            disabled={
              busy ||
              (preview ? !preview.enoughSpace : !m && !info?.needsReconcile)
            }
            onClick={onProceed}
          >
            {busy
              ? "正在处理…"
              : preview
                ? "开始备份"
                : "校验并恢复为新 Notebook"}
          </Button>
        </div>
      </div>
    </div>
  );
}
