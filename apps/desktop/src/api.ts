import type { AnynoteBridge, Operation } from "@anynote/types";

declare global {
  interface Window {
    anynote?: AnynoteBridge;
  }
}

/**
 * Call a backend operation.
 *
 * On desktop it uses the bridge exposed by Preload; the browser preview falls
 * back to the local `/api/rpc`. It also records a performance measurement for
 * diagnostics.
 *
 * @param op Operation name.
 * @param input Operation input.
 * @returns The operation result.
 */
export async function request<T>(
  op: Operation,
  input: Record<string, unknown> = {},
): Promise<T> {
  const started = performance.now();

  /** Record the duration measurement of this RPC (keeping at most 100 entries). */
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

/**
 * Download base64 data as a local file.
 *
 * @param data Base64 data.
 * @param name File name.
 * @param type MIME type.
 */
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

/**
 * Read a file as base64 (stripping the data URL prefix).
 *
 * @param file File to read.
 * @returns Base64 content.
 */
export function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
