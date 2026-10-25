import { decorateButtons } from "./icons.js";
import { cloudPanel } from "./cloud.js";
/* global chrome */
import "./style.css";
import { draft } from "./convert.js";
import { saveTask, tasks, deleteTask } from "./store.js";
import { downloadMedia, mediaOrigin } from "./media.js";
import { copyMarkdown, rewriteLinks } from "@anynote/capture/markdown.js";
import {
  captureLimits,
  sha256,
  captureManifestSchema,
} from "@anynote/capture/format.js";

const $ = (id) => document.getElementById(id);
decorateButtons();
function showPage() {
  const settings = location.hash === "#settings";
  $("capture-page").hidden = settings;
  $("settings-page").hidden = !settings;
  $("open-settings").hidden = settings;
  $("close-settings").hidden = !settings;
  document.title = settings ? "AnyNote 设置" : "AnyNote 采集";
}
$("open-settings").onclick = () => {
  location.hash = "settings";
};
$("close-settings").onclick = () => {
  location.hash = "capture";
};
window.addEventListener("hashchange", () => {
  showPage();
  (location.hash === "#settings"
    ? $("close-settings")
    : $("open-settings")
  ).focus();
  window.scrollTo(0, 0);
});
showPage();
let current,
  controller,
  worker,
  busy = false;
function status(message) {
  $("status").textContent = message;
  $("capture-status").textContent = message;
}
async function persist() {
  if (!current) return;
  // Network URLs (especially signed URLs) are deliberately not persisted on disk.
  await saveTask({
    ...current,
    media: current.media.map(({ url: _url, ...item }) => item),
  });
  const list = await tasks();
  $("tasks").replaceChildren(
    ...list.map((task) => {
      const option = document.createElement("option");
      option.value = task.id;
      option.textContent = task.title;
      return option;
    }),
  );
  $("tasks").value = current.id;
}
function render() {
  $("capture").hidden = !current;
  if (!current) return;
  $("title").value = current.title;
  $("body").value = current.body;
  $("source").textContent = current.source.url;
  $("media").replaceChildren(
    ...current.media.map((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.name} · ${item.status === "saved" ? "已保存" : item.error || "待下载"}`;
      return li;
    }),
    ...current.missing.map((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.name} · ${item.reason}`;
      return li;
    }),
  );
  $("download").disabled =
    busy || !current.media.some((item) => item.status !== "saved");
  for (const id of [
    "delete-task",
    "export",
    "copy",
    "cloud-upload",
    "title",
    "body",
    "tasks",
  ])
    $(id).disabled = busy;
}
async function receive(input) {
  if (!input) return;
  if (input.error) {
    status(input.error);
    await chrome.storage.session.remove("capture.pending");
    return;
  }
  if (busy) {
    status("新采集正在等待，请先完成当前下载或导出。");
    return;
  }
  try {
    current = draft(input);
    $("allow-missing").checked = false;
    await persist();
    render();
    if (location.hash === "#settings") location.hash = "capture";
    status("采集已就绪，请核对正文和媒体。");
    await chrome.storage.session.remove("capture.pending");
  } catch (error) {
    status(error.message);
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes["capture.pending"]?.newValue)
    void receive(changes["capture.pending"].newValue);
});
$("tasks").onchange = async () => {
  if (busy) return;
  current = (await tasks()).find((task) => task.id === $("tasks").value);
  $("allow-missing").checked = false;
  render();
};
for (const field of ["title", "body"])
  $(field).onchange = () => {
    if (!current) return;
    current[field] = $(field).value;
    delete current.frozen;
    void persist().catch((error) => status(error.message));
  };

$("download").onclick = async () => {
  if (!current || busy) return;
  const origins = new Set();
  for (const item of current.media.filter((m) => m.status !== "saved"))
    try {
      if (item.url && !item.url.startsWith("data:"))
        origins.add(mediaOrigin(item.url));
    } catch {}
  // Request permissions in the click stack, before any fetch or IndexedDB work.
  const permission = origins.size
    ? chrome.permissions.request({ origins: [...origins] })
    : Promise.resolve(true);
  busy = true;
  render();
  controller = new AbortController();
  try {
    if (!(await permission)) throw Error("媒体站点未获授权");
    let total = current.media.reduce((n, m) => n + (m.asset?.size || 0), 0);
    // One bounded resource at a time avoids four simultaneous decoded image buffers.
    for (const item of current.media.filter((m) => m.status !== "saved")) {
      status(`正在下载 ${item.name}`);
      try {
        const asset = await downloadMedia(
          item,
          controller.signal,
          captureLimits.totalBytes - total,
        );
        if (total + asset.size > captureLimits.totalBytes)
          throw Error("总媒体超过 80 MiB");
        total += asset.size;
        item.asset = asset;
        item.status = "saved";
        delete item.error;
        delete current.frozen;
      } catch (error) {
        item.status = "failed";
        item.error = error.message;
      }
      await persist();
      render();
    }
    status("媒体处理完成，请检查缺失项。");
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    controller = null;
    render();
  }
};

async function freeze() {
  if (!current) throw Error("请先采集内容");
  const failed = current.media.filter((m) => m.status !== "saved");
  if (
    (failed.length || current.missing.length) &&
    !$("allow-missing").checked
  ) {
    $("allow-missing").focus();
    throw Error(
      "尚有媒体或特殊内容未转换。请先下载媒体，或勾选“允许保留未下载媒体的缺失说明”后再次导出或导入云端。",
    );
  }
  if (current.frozen) return current.frozen;
  const mapping = new Map(
    current.media.map((m) => [
      `anynote-capture:${m.id}`,
      m.status === "saved" ? m.asset.path : null,
    ]),
  );
  const body = rewriteLinks(current.body, (url) =>
    mapping.has(url) ? mapping.get(url) : url,
  );
  const bytes = new TextEncoder().encode(body);
  const assets = [
    ...new Map(
      current.media
        .filter((m) => m.status === "saved")
        .map((m) => [m.asset.sha256, m.asset]),
    ).values(),
  ];
  const missing = [
    ...current.missing,
    ...failed.map((m) => ({
      name: m.name,
      reason: m.error || "用户选择保留缺失说明",
    })),
  ];
  const manifest = captureManifestSchema.parse({
    format: "anynote.capture",
    version: 1,
    captureId: crypto.randomUUID(),
    title: current.title || "采集笔记",
    source: current.source,
    body: {
      path: "content.md",
      size: bytes.length,
      sha256: await sha256(bytes),
    },
    assets,
    missing,
    complete: missing.length === 0,
  });
  current.frozen = { manifest, body };
  await persist();
  return current.frozen;
}
$("copy").onclick = () => {
  if (!current) return;
  // The clipboard call stays in the user gesture. It never waits on downloads.
  void navigator.clipboard
    .writeText(copyMarkdown(current.body))
    .then(() => status("已复制 Markdown；私有或本地媒体文件不包含在文本中。"))
    .catch((error) => status(error.message));
};
$("export").onclick = async () => {
  if (!current || busy) return;
  busy = true;
  render();
  try {
    const capture = await freeze();
    status("正在生成采集包…");
    worker = new Worker(new URL("./package-worker.js", import.meta.url), {
      type: "module",
    });
    const blob = await new Promise((resolve, reject) => {
      worker.onmessage = (e) =>
        e.data.error ? reject(Error(e.data.error)) : resolve(e.data.blob);
      worker.onerror = (e) => reject(Error(e.message || "采集包生成失败"));
      worker.postMessage(capture);
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = `${current.title.replace(/[^\p{L}\p{N}_. -]/gu, "_").slice(0, 100) || "capture"}.anyclip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status(
      capture.manifest.complete
        ? "已导出完整采集包。"
        : "已导出，包内明确记录了缺失媒体。",
    );
  } catch (error) {
    status(error.message);
  } finally {
    worker?.terminate();
    worker = null;
    busy = false;
    render();
  }
};
window.addEventListener("pagehide", () => {
  controller?.abort();
  worker?.terminate();
});
const previous = await tasks();
current = previous.at(-1);
if (current) {
  await persist();
  render();
}
await receive(
  (await chrome.storage.session.get("capture.pending"))["capture.pending"],
);

cloudPanel({
  freeze,
  status,
  openSettings: () => {
    location.hash = "settings";
  },
  setBusy: (value) => {
    if (value && busy) return false;
    busy = value;
    render();
    return true;
  },
});

$("delete-task").onclick = async () => {
  if (!current || busy || !confirm("删除这条本地采集记录及其未共享的媒体？"))
    return;
  try {
    await deleteTask(current.id);
    current = (await tasks()).at(-1);
    $("allow-missing").checked = false;
    await persist();
    if (!current) $("tasks").replaceChildren();
    render();
    status("本地记录已删除。");
  } catch (error) {
    status(error.message);
  }
};
