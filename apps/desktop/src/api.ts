import type { AnynoteBridge, Operation } from "@anynote/types";
declare global {
  interface Window {
    anynote?: AnynoteBridge;
  }
}
export async function request<T>(
  op: Operation,
  input: Record<string, unknown> = {},
): Promise<T> {
  const started = performance.now();
  const record = () => {
    const entries = performance.getEntriesByName("anynote:rpc");
    if (entries.length >= 100) performance.clearMeasures("anynote:rpc");
    performance.measure("anynote:rpc", {
      start: started,
      end: performance.now(),
      detail: {
        operation: op,
        bytes: op === "getAssetRange" ? input.length : 0,
      },
    });
  };
  if (window.anynote) {
    const result = await window.anynote.request<T>(op, input);
    record();
    return result;
  }
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, input }),
  });
  const data = await response.json();
  if (data.error) throw Error(data.error);
  record();
  return data.result;
}
export function download(
  data: string,
  name: string,
  type = "application/octet-stream",
) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    url = URL.createObjectURL(new Blob([bytes], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
