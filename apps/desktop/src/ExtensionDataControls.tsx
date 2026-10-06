import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import type {
  InstalledExtension,
  ExtensionDataOverview,
  ExtensionDataReview,
} from "@anynote/plugin-sdk/declarative";

/** Extension data migration and restore controls: overview, preview, and confirmed apply. */
export default function ExtensionDataControls({
  entry,
  notebookId,
  disabled,
  onChanged,
}: {
  entry: InstalledExtension;
  notebookId: string;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [overview, setOverview] = useState<ExtensionDataOverview>({
    targets: [],
    backups: [],
  });
  const [review, setReview] = useState<ExtensionDataReview | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const generation = useRef(0),
    operationId = useRef("");
  const base = {
    notebookId,
    extensionId: entry.manifest.id,
    checksum: entry.checksum,
  };
  useEffect(() => {
    const token = ++generation.current;
    setReview(null);
    setError("");
    setNotice("");
    setBusy(false);
    request<ExtensionDataOverview>("getExtensionDataOverview", base)
      .then((next) => {
        if (generation.current === token) setOverview(next);
      })
      .catch((e) => {
        if (generation.current === token) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [notebookId, entry.manifest.id, entry.checksum]);

  /**
   * Preview one migration or restore; generates a new idempotent operation ID on success.
   *
   * @param kind Preview kind (migration or restore).
   * @param id Backup ID.
   */
  const preview = async (kind: "migration" | "restore", id: string) => {
    const token = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    setReview(null);
    try {
      const next = await request<ExtensionDataReview>(
        kind === "migration"
          ? "previewExtensionDataMigration"
          : "previewExtensionDataRestore",
        {
          ...base,
          ...(kind === "migration" ? { migrationId: id } : { backupId: id }),
        },
      );
      if (generation.current === token) {
        operationId.current = crypto.randomUUID();
        setReview(next);
      }
    } catch (e) {
      if (generation.current === token) setError((e as Error).message);
    } finally {
      if (generation.current === token) setBusy(false);
    }
  };

  /** Confirm applying the current preview (including backup) and refresh the overview. */
  const apply = async () => {
    if (!review) return;
    const token = generation.current;
    setBusy(true);
    setError("");
    try {
      await request("applyExtensionDataReview", {
        ...base,
        reviewId: review.reviewId,
        operationId: operationId.current,
      });
      if (generation.current !== token) return;
      setReview(null);
      setNotice("已保存原始数据备份并应用修改。");
      onChanged();
      const next = await request<ExtensionDataOverview>(
        "getExtensionDataOverview",
        base,
      );
      if (generation.current === token) setOverview(next);
    } catch (e) {
      if (generation.current === token) setError((e as Error).message);
    } finally {
      if (generation.current === token) setBusy(false);
    }
  };

  /** Re-read the data overview (targets and backup lists). */
  const reload = async () => {
    const token = generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await request<ExtensionDataOverview>(
        "getExtensionDataOverview",
        base,
      );
      if (generation.current === token) setOverview(next);
    } catch (e) {
      if (generation.current === token) setError((e as Error).message);
    } finally {
      if (generation.current === token) setBusy(false);
    }
  };
  const locked = disabled || busy;
  return (
    <section
      className="extension-data-controls"
      aria-label="扩展数据迁移与恢复"
    >
      <h4>数据迁移与恢复</h4>
      <p>
        修改前保存当前数据副本，备份随 Notebook 归档保留。每个扩展最多保留 32
        份。
      </p>
      <p>
        {overview.targets
          .map(
            (t) =>
              `${t.target === "settings" ? "设置" : "脚本状态"}：版本 ${t.version} / 修订 ${t.revision}`,
          )
          .join("；") || "尚无已保存的数据。"}
      </p>
      <div className="extension-actions">
        {(entry.manifest.contributes.dataMigrations ?? []).map((rule) => (
          <button
            key={rule.id}
            disabled={locked}
            onClick={() => void preview("migration", rule.id)}
          >
            预览迁移：{rule.title}
          </button>
        ))}
        <button disabled={locked} onClick={() => void reload()}>
          刷新数据备份
        </button>
      </div>
      {overview.backups.map((b) => (
        <div className="extension-data-backup" key={b.id}>
          <span>
            {b.reason} · {b.target === "settings" ? "设置" : "脚本状态"} v
            {b.version} · {new Date(b.createdAt).toLocaleString()}
          </span>
          <button
            disabled={locked}
            onClick={() => void preview("restore", b.id)}
          >
            预览恢复
          </button>
        </div>
      ))}
      {review && (
        <section
          className="extension-data-review"
          aria-label="扩展数据修改预览"
        >
          <h5>
            {review.mode === "migration"
              ? "检查扩展数据迁移"
              : "检查扩展数据恢复"}
          </h5>
          <p>
            {review.title} · 版本 {review.fromVersion} → {review.toVersion}
            。预览有效期 10 分钟。
          </p>
          {review.mode === "restore" && (
            <p>
              恢复仅还原扩展数据。旧版本数据可能需要重新迁移，或安装兼容版本后使用。
            </p>
          )}
          <p>修改前</p>
          <pre tabIndex={0} aria-label="修改前数据">
            {review.before}
          </pre>
          <p>修改后</p>
          <pre tabIndex={0} aria-label="修改后数据">
            {review.after}
          </pre>
          <div className="extension-actions">
            <button disabled={locked} onClick={() => void apply()}>
              {review.mode === "migration"
                ? "确认迁移并备份"
                : "确认恢复并备份"}
            </button>
            <button disabled={locked} onClick={() => setReview(null)}>
              取消预览
            </button>
          </div>
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
