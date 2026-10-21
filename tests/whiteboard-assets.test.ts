import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../apps/desktop/src/WhiteboardEditor");
});

it("initializes packaged font paths before evaluating the lazy editor", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    baseURI:
      "file:///Applications/Anynote.app/Contents/Resources/app.asar/dist/index.html",
  });
  let pathAtImport: string | undefined;
  vi.doMock("../apps/desktop/src/WhiteboardEditor", () => {
    pathAtImport = window.EXCALIDRAW_ASSET_PATH;
    return { default: () => null };
  });
  const { loadWhiteboard } = await import(
    "../apps/desktop/src/whiteboard-assets"
  );
  expect(window.EXCALIDRAW_ASSET_PATH).toBeUndefined();
  await loadWhiteboard();
  expect(pathAtImport).toBe(
    "file:///Applications/Anynote.app/Contents/Resources/app.asar/dist/excalidraw/",
  );
});
