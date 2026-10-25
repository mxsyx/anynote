import { useEffect, useState } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { request } from "./api";

interface Device {
  id: string;
  expiresAt: number;
  revoked: number;
}
export default function CaptureDevices({
  notebookId,
  targetId,
  onClose,
}: {
  notebookId: string;
  targetId: string;
  onClose: () => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]),
    [pair, setPair] = useState<{
      code: string;
      endpoint: string;
      expiresAt: number;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const reload = () =>
    request<Device[]>("listCaptureDevices", { notebookId, targetId }).then(
      setDevices,
    );
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [notebookId, targetId]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-overlay">
      <div
        className="form-dialog backup-config"
        role="dialog"
        aria-modal="true"
        aria-label="采集设备"
      >
        <div className="dialog-heading">
          <h2>浏览器采集设备</h2>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
        <p>
          配对授权仅允许浏览此笔记本的云端备份与上传采集。先完成一次云备份，再到浏览器扩展输入配对码。
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            void action(async () =>
              setPair(
                await request("pairCaptureDevice", { notebookId, targetId }),
              ),
            )
          }
        >
          生成一次性配对码
        </Button>
        {pair && (
          <section>
            <label>
              Worker 地址
              <Input readOnly value={pair.endpoint} />
            </label>
            <label>
              配对码
              <Input
                readOnly
                value={pair.code}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <p>
              有效至 {new Date(pair.expiresAt).toLocaleTimeString()}
              ，使用一次后失效。
            </p>
          </section>
        )}
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void action(reload)}
        >
          刷新设备
        </Button>
        {devices.map((device) => (
          <div className="snapshot-row" key={device.id}>
            <span>
              {device.id.slice(0, 8)} ·{" "}
              {device.revoked
                ? "已撤销"
                : `有效至 ${new Date(device.expiresAt).toLocaleDateString()}`}
            </span>
            <Button
              variant="ghost"
              disabled={busy || !!device.revoked}
              onClick={() =>
                void action(async () => {
                  await request("revokeCaptureDevice", {
                    notebookId,
                    targetId,
                    deviceId: device.id,
                  });
                  await reload();
                })
              }
            >
              撤销
            </Button>
          </div>
        ))}
        <p className="small-note">
          云端采集在“立即备份”或自动备份时归入本地笔记，再随同一致性备份发布。
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
