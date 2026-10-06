import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import type { HostedExtensionStatus } from "@anynote/extension-host/contracts";
import type { NoteNode } from "@anynote/types";

/** Display labels for hosted extension runtime states. */
const states = {
  disabled: "未授权",
  idle: "等待命令激活",
  activating: "激活中",
  active: "运行中",
  failed: "运行失败",
};

/** First-party extension host panel: authorize/disable and run commands. */
export default function HostedExtensionsPanel({
  notebookId,
  onCreated,
}: {
  notebookId: string;
  onCreated: (note: NoteNode) => Promise<void>;
}) {
  const [extensions, setExtensions] = useState<HostedExtensionStatus[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setExtensions([]);
    setBusy(false);
    setError("");
    request<HostedExtensionStatus[]>("listHostedExtensions", { notebookId })
      .then((rows) => {
        if (generation.current === version) setExtensions(rows);
      })
      .catch((e) => {
        if (generation.current === version) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [notebookId]);

  /**
   * Run one hosted action and re-fetch the status when done.
   *
   * @param fn Action to run.
   */
  async function action(fn: () => Promise<unknown>) {
    const version = generation.current;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (generation.current === version) setError((e as Error).message);
    } finally {
      if (generation.current === version) {
        try {
          const rows = await request<HostedExtensionStatus[]>(
            "listHostedExtensions",
            { notebookId },
          );
          if (generation.current === version) setExtensions(rows);
        } catch (e) {
          if (generation.current === version) setError((e as Error).message);
        }
        if (generation.current === version) setBusy(false);
      }
    }
  }
  return (
    <section className="extension-install" aria-label="首方扩展宿主">
      <h2>首方扩展宿主</h2>
      <p>
        随应用发布的扩展在独立进程中运行。授权仅适用于当前
        Notebook、本次应用会话；命令首次执行时激活。停用保留已创建的笔记。
      </p>
      {extensions.map((extension) => (
        <div className="feature-card" key={extension.id}>
          <div>
            <h3>
              {extension.name} <small>v{extension.version}</small>
            </h3>
            <p>来源：随应用发布 · 受信 Node 扩展</p>
            <small>
              权限：当前 Notebook 的笔记写入。此执行等级具有 Node
              系统能力，仅加载应用内置代码。
            </small>
            <p role="status">{states[extension.state]}</p>
            {extension.error && <p className="form-error">{extension.error}</p>}
            {extension.commands.map((command) => (
              <button
                key={command.id}
                disabled={
                  !extension.enabled || busy || extension.state === "failed"
                }
                onClick={() =>
                  void action(async () => {
                    const version = generation.current;
                    const note = await request<NoteNode>(
                      "executeHostedExtensionCommand",
                      {
                        notebookId,
                        extensionId: extension.id,
                        commandId: command.id,
                      },
                    );
                    if (generation.current === version) await onCreated(note);
                  })
                }
              >
                {command.title}
              </button>
            ))}
          </div>
          <button
            disabled={busy}
            onClick={() =>
              void action(() =>
                request("configureHostedExtension", {
                  notebookId,
                  extensionId: extension.id,
                  enabled: !extension.enabled,
                }),
              )
            }
          >
            {extension.enabled
              ? `停用${extension.name}`
              : `授权${extension.name}`}
          </button>
          {extension.state === "failed" && (
            <button
              disabled={busy}
              onClick={() =>
                void action(() =>
                  request("configureHostedExtension", {
                    notebookId,
                    extensionId: extension.id,
                    enabled: true,
                  }),
                )
              }
            >
              重新授权
            </button>
          )}
        </div>
      ))}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
