import React from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  exportToBlob,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

const bootstrap = window.__anynoteBoard;
delete window.__anynoteBoard;
const send = (message) =>
  window.ipc.postMessage(
    JSON.stringify({ token: bootstrap.token, ...message }),
  );
let api;
let busy = false;
let composing = false;
let theme = bootstrap.theme;
const root = createRoot(document.getElementById("root"));
document.addEventListener(
  "compositionstart",
  () => {
    composing = true;
  },
  true,
);
document.addEventListener(
  "compositionend",
  () => {
    composing = false;
  },
  true,
);
document.addEventListener(
  "keydown",
  (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy && !event.isComposing && !composing) send({ kind: "save" });
    }
  },
  true,
);
window.addEventListener("error", () =>
  send({ kind: "error", message: "白板页面发生错误，草稿仍保留在当前窗口" }),
);
window.addEventListener("unhandledrejection", () =>
  send({ kind: "error", message: "白板操作未完成，请重试或复制场景" }),
);

function render() {
  root.render(
    <Excalidraw
      initialData={bootstrap.scene}
      langCode="zh-CN"
      theme={theme}
      autoFocus
      validateEmbeddable={() => false}
      onLinkOpen={(_, event) => event.preventDefault()}
      UIOptions={{ canvasActions: { saveToActiveFile: false, export: false } }}
      excalidrawAPI={(value) => {
        if (!api) {
          api = value;
          send({ kind: "ready" });
        }
      }}
    />,
  );
}

window.anynoteBoard = async (command) => {
  if (command.token !== bootstrap.token) return;
  if (command.kind === "resume") {
    busy = false;
    document.getElementById("root").inert = false;
    return;
  }
  if (command.kind === "theme") {
    theme = command.theme;
    render();
    return;
  }
  if (command.kind !== "capture" || (busy && command.preview) || !api) return;
  try {
    if (composing) throw new Error("请先完成输入法选词，再保存白板");
    busy = true;
    if (
      document.activeElement?.matches("textarea, input, [contenteditable=true]")
    )
      document.activeElement.blur();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    document.getElementById("root").inert = Boolean(command.preview);
    const scene = JSON.parse(
      serializeAsJSON(
        restoreElements(api.getSceneElements(), null),
        api.getAppState(),
        api.getFiles(),
        "local",
      ),
    );
    let preview = null;
    if (command.preview) {
      const blob = scene.elements.length
        ? await exportToBlob({
            elements: scene.elements,
            appState: {
              ...scene.appState,
              exportBackground: true,
              exportWithDarkMode: false,
            },
            files: scene.files,
            getDimensions: (width, height) => {
              const scale = Math.min(1, 1280 / Math.max(width, height));
              return {
                width: Math.max(1, width * scale),
                height: Math.max(1, height * scale),
                scale,
              };
            },
          })
        : await new Promise((resolve) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 64;
            const context = canvas.getContext("2d");
            context.fillStyle = scene.appState.viewBackgroundColor || "#ffffff";
            context.fillRect(0, 0, 64, 64);
            canvas.toBlob(resolve, "image/png");
          });
      preview = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("无法读取白板预览"));
        reader.readAsDataURL(blob);
      });
    }
    send({ kind: "snapshot", request: command.request, scene, preview });
  } catch (error) {
    send({
      kind: "captureError",
      request: command.request,
      message: String(error.message || error),
    });
  }
};
render();
