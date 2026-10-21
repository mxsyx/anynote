declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH: string;
  }
}

// Set the path before the dynamic import: static imports execute their entire
// shared dependency graph before a module body, including font registration.
export function loadWhiteboard() {
  window.EXCALIDRAW_ASSET_PATH = new URL(
    "./excalidraw/",
    document.baseURI,
  ).href;
  return import("./WhiteboardEditor");
}
