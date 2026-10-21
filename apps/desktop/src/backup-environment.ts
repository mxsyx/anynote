import { request } from "./api";

interface Connection extends EventTarget {
  saveData?: boolean;
  type?: string;
}

/** OS/browser observations only; effectiveType describes speed, not billing. */
export function observeBackupEnvironment() {
  const connection = (navigator as Navigator & { connection?: Connection })
    .connection;
  const report = () =>
    void request("reportBackupEnvironment", {
      online: navigator.onLine,
      ...(connection
        ? {
            metered:
              connection.saveData === true || connection.type === "cellular",
          }
        : {}),
    })
      .then(() => window.dispatchEvent(new Event("anynote:backup-environment")))
      .catch(() => {});
  report();
  window.addEventListener("online", report);
  window.addEventListener("offline", report);
  connection?.addEventListener("change", report);
  return () => {
    window.removeEventListener("online", report);
    window.removeEventListener("offline", report);
    connection?.removeEventListener("change", report);
  };
}
