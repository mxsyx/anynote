import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import type {
  InstalledExtension,
  ExtensionSettingsSnapshot,
  ExtensionSettingsValues,
} from "@anynote/plugin-sdk/declarative";

/** Edit an extension's settings form under the current Notebook (handling version conflicts and defaults). */
export default function ExtensionSettingsForm({
  entry,
  notebookId,
  disabled,
}: {
  entry: InstalledExtension;
  notebookId: string;
  disabled: boolean;
}) {
  const form = entry.manifest.contributes.settings!;
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<ExtensionSettingsSnapshot | null>(
      null,
    ),
    [draft, setDraft] = useState<Record<string, string | boolean>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const base = {
    notebookId,
    extensionId: entry.manifest.id,
    checksum: entry.checksum,
  };

  /**
   * Receive a settings snapshot, fill the draft, and report an error when incompatible.
   *
   * @param next The received settings snapshot.
   */
  const receive = (next: ExtensionSettingsSnapshot) => {
    setSnapshot(next);
    setDraft(
      Object.fromEntries(
        form.fields.map((f) => [
          f.key,
          f.kind === "boolean"
            ? Boolean(next.values[f.key])
            : String(next.values[f.key]),
        ]),
      ),
    );
    if (!next.compatible)
      setError("设置版本不兼容，原始数据已保留，需先迁移。");
  };
  useEffect(() => {
    const token = ++generation.current;
    setSnapshot(null);
    setError("");
    setNotice("");
    request<ExtensionSettingsSnapshot>("getInstalledExtensionSettings", base)
      .then((next) => {
        if (generation.current === token) receive(next);
      })
      .catch((e) => {
        if (generation.current === token) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [notebookId, entry.manifest.id, entry.checksum]);

  /** Manually reload settings. */
  const load = async () => {
    const token = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await request<ExtensionSettingsSnapshot>(
        "getInstalledExtensionSettings",
        base,
      );
      if (generation.current === token) receive(next);
    } catch (e) {
      if (generation.current === token) setError((e as Error).message);
    } finally {
      if (generation.current === token) setBusy(false);
    }
  };

  /** Validate the draft and save settings (with the expected revision). */
  const save = async () => {
    if (!snapshot) return;
    const token = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const values: ExtensionSettingsValues = {};
      for (const f of form.fields) {
        const raw = draft[f.key];
        if (f.kind === "number") {
          const value = Number(raw);
          if (
            typeof raw !== "string" ||
            !raw.trim() ||
            !Number.isFinite(value) ||
            (f.integer && !Number.isInteger(value)) ||
            value < (f.min ?? -1e9) ||
            value > (f.max ?? 1e9)
          )
            throw Error(
              `${f.label}：请输入范围内的${f.integer ? "整数" : "数字"}。`,
            );
          values[f.key] = value;
        } else values[f.key] = raw;
      }
      const next = await request<ExtensionSettingsSnapshot>(
        "saveInstalledExtensionSettings",
        { ...base, values, expectedRevision: snapshot.revision },
      );
      if (generation.current === token) {
        receive(next);
        setNotice("已保存当前 Notebook 设置。");
      }
    } catch (e) {
      if (generation.current === token) setError((e as Error).message);
    } finally {
      if (generation.current === token) setBusy(false);
    }
  };
  const locked = disabled || busy || !snapshot || !snapshot.compatible;
  return (
    <form
      className="extension-settings-form"
      aria-label="当前 Notebook 设置"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h4>当前 Notebook 设置</h4>
      <p>更改需保存后才会应用于扩展命令。设置随 Notebook 归档保留。</p>
      <div className="extension-settings-fields">
        {form.fields.map((f) => (
          <label key={f.key}>
            <span>{f.label}</span>
            {f.kind === "boolean" ? (
              <input
                type="checkbox"
                checked={draft[f.key] === true}
                disabled={locked}
                onChange={(e) =>
                  setDraft({ ...draft, [f.key]: e.target.checked })
                }
              />
            ) : (
              <input
                type={f.kind === "number" ? "number" : "text"}
                value={String(draft[f.key] ?? "")}
                min={f.kind === "number" ? f.min : undefined}
                max={f.kind === "number" ? f.max : undefined}
                step={f.kind === "number" ? (f.integer ? 1 : "any") : undefined}
                maxLength={
                  f.kind === "text" ? (f.maxLength ?? 2000) : undefined
                }
                disabled={locked}
                onChange={(e) =>
                  setDraft({ ...draft, [f.key]: e.target.value })
                }
              />
            )}
            {f.description && <small>{f.description}</small>}
          </label>
        ))}
      </div>
      <div className="extension-actions">
        <button type="submit" disabled={locked}>
          保存扩展设置
        </button>
        <button
          type="button"
          disabled={locked}
          onClick={() => {
            setDraft(
              Object.fromEntries(
                form.fields.map((f) => [
                  f.key,
                  f.kind === "boolean" ? f.default : String(f.default),
                ]),
              ),
            );
            setNotice("已填入默认值，保存后生效。");
            setError("");
          }}
        >
          填入默认值
        </button>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void load()}
        >
          重新加载设置
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}
