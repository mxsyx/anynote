import { useEffect, useState } from "react";
import { request } from "./api";
import type { ExtensionCommand } from "@anynote/plugin-sdk/declarative";
import type { HostedExtensionStatus } from "@anynote/extension-host/contracts";

/** Extension command panel: lists authorized declarative commands and first-party hosted commands. */
export default function ExtensionCommands({
  notebookId,
  onRun,
  onHostedRun,
}: {
  notebookId: string;
  onRun: (command: ExtensionCommand) => Promise<void>;
  onHostedRun: (extensionId: string, commandId: string) => Promise<void>;
}) {
  const [commands, setCommands] = useState<ExtensionCommand[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [hosted, setHosted] = useState<HostedExtensionStatus[]>([]);
  useEffect(() => {
    let active = true;

    // First-party hosted extensions: keep only enabled, non-failed instances.
    request<HostedExtensionStatus[]>("listHostedExtensions", { notebookId })
      .then((rows) => {
        if (active)
          setHosted(rows.filter((e) => e.enabled && e.state !== "failed"));
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    request<ExtensionCommand[]>("listExtensionCommands", { notebookId })
      .then((v) => {
        if (active) setCommands(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [notebookId]);
  return (
    <section className="extension-commands" aria-label="扩展命令">
      <strong>扩展命令</strong>
      {commands.map((c) => (
        <button
          key={c.id}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRun(c);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {c.title}
          <small>{c.extensionName}</small>
        </button>
      ))}
      {hosted.flatMap((extension) =>
        extension.commands.map((command) => (
          <button
            key={command.id}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onHostedRun(extension.id, command.id);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {command.title}
            <small>{extension.name} · 首方宿主</small>
          </button>
        )),
      )}
      {!commands.length && !hosted.length && (
        <p>授权扩展后，命令将在这里出现。</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
