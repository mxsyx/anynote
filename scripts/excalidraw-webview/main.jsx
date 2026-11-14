import React from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

const send = (value) => window.ipc.postMessage(JSON.stringify(value));
window.addEventListener("error", (event) =>
  send({ kind: "error", message: event.message }),
);
window.addEventListener("unhandledrejection", (event) =>
  send({ kind: "error", message: String(event.reason) }),
);
window.addEventListener("securitypolicyviolation", (event) =>
  send({
    kind: "csp",
    blocked: event.blockedURI,
    directive: event.violatedDirective,
  }),
);
let api;
const snapshot = () => ({
  elements: api.getSceneElements(),
  files: api.getFiles(),
  zoom: api.getAppState().zoom.value,
  scrollX: api.getAppState().scrollX,
  scrollY: api.getAppState().scrollY,
  viewport: [innerWidth, innerHeight, devicePixelRatio],
  activeElement: document.activeElement?.tagName,
  activeTool: api.getAppState().activeTool.type,
  loadedFonts: [...document.fonts]
    .filter((font) => font.status === "loaded")
    .map((font) => font.family),
  canvas: [...document.querySelectorAll("canvas")].map((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  })),
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 150));
window.probe = async ({ id, action }) => {
  try {
    if (!api) throw Error("editor not ready");
    if (action === "save") {
      send({
        id,
        kind: "save",
        scene: JSON.parse(
          serializeAsJSON(
            api.getSceneElements(),
            api.getAppState(),
            api.getFiles(),
            "local",
          ),
        ),
      });
      return;
    }
    if (action === "seed") {
      const imageId = "probe.image";
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      const context = canvas.getContext("2d");
      context.fillStyle = "#1971c2";
      context.fillRect(0, 0, 32, 32);
      api.addFiles([
        {
          id: imageId,
          dataURL: canvas.toDataURL(),
          mimeType: "image/png",
          created: 1,
        },
      ]);
      const elements = convertToExcalidrawElements([
        {
          type: "rectangle",
          id: "probe.box",
          x: 320,
          y: 200,
          width: 180,
          height: 100,
          label: { text: "本地白板\n中文 / English", fontFamily: 2 },
        },
        {
          type: "ellipse",
          id: "probe.ellipse",
          x: 650,
          y: 200,
          width: 160,
          height: 100,
        },
        {
          type: "arrow",
          x: 510,
          y: 250,
          width: 130,
          height: 0,
          start: { id: "probe.box" },
          end: { id: "probe.ellipse" },
        },
        {
          type: "text",
          x: 320,
          y: 380,
          text: "Excalidraw → Rust → WebView",
          fontFamily: 1,
        },
      ]);
      const image = {
        ...elements[0],
        id: "probe.image.element",
        type: "image",
        x: 700,
        y: 380,
        width: 100,
        height: 100,
        fileId: imageId,
        status: "saved",
        scale: [1, 1],
        crop: null,
        boundElements: null,
      };
      api.updateScene({
        elements: restoreElements([...elements, image], null),
        captureUpdate: "IMMEDIATELY",
      });
      await tick();
    }
    if (action === "export") {
      const blob = await exportToBlob({
        elements: api.getSceneElements(),
        appState: { ...api.getAppState(), exportBackground: true },
        files: api.getFiles(),
      });
      const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      send({ id, kind: "export", dataURL });
      return;
    }
    if (action === "dark") {
      api.updateScene({ appState: { theme: "dark" } });
      await tick();
    }
    send({ id, kind: "snapshot", ...snapshot() });
  } catch (error) {
    send({ id, kind: "error", message: String(error) });
  }
};

createRoot(document.getElementById("root")).render(
  <Excalidraw
    initialData={window.__initialScene || undefined}
    langCode="zh-CN"
    excalidrawAPI={(value) => {
      api = value;
      setTimeout(
        () =>
          send({
            kind: "ready",
            userAgent: navigator.userAgent,
            ...snapshot(),
          }),
        300,
      );
    }}
  />,
);
