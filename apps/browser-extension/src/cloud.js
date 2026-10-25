/* global chrome */
import {
  imageBudgetError,
  imageMime,
  imageSize,
} from "@anynote/protocol/image-safety.js";
import { readAsset } from "./store.js";
import { icon } from "./icons.js";
import { sha256, validateCapture } from "@anynote/capture/format.js";

const $ = (id) => document.getElementById(id);
let session,
  book,
  parentId = null;
export function cloudPanel({ freeze, status, setBusy, openSettings }) {
  async function call(path, { method = "GET", body, bytes } = {}) {
    if (!session) throw Error("请先配对登录云端");
    const response = await fetch(session.endpoint + path, {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": bytes ? "application/octet-stream" : "application/json",
      },
      body: bytes || (body ? JSON.stringify(body) : undefined),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw Error(
        response.status === 401
          ? "云端授权已失效，请重新配对"
          : `云端操作失败（${response.status}）`,
      );
    return response;
  }
  const json = async (path, options) => (await call(path, options)).json();
  const base = () =>
    `/v1/library/${book.notebookId}/${book.lineageId}/${book.generationId}`;
  function button(label, fn, name = "file") {
    const b = document.createElement("button");
    b.append(icon(name), document.createTextNode(label));
    b.onclick = () => void run(fn);
    return b;
  }
  async function run(fn) {
    try {
      await fn();
    } catch (error) {
      status(error.message);
    }
  }
  async function bounded(response, max) {
    if (!response.body || Number(response.headers.get("content-length")) > max)
      throw Error("资源超过侧栏读取预算，请在桌面查看");
    const reader = response.body.getReader(),
      parts = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > max) throw Error("资源超过侧栏读取预算，请在桌面查看");
        parts.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  }
  async function showNote(note, path, capture = false) {
    const heading = document.createElement("h3"),
      body = document.createElement("pre"),
      attachments = document.createElement("div");
    heading.textContent = note.title;
    body.textContent = note.body;
    for (const resource of note.resources || []) {
      async function read() {
        if (resource.size > 20 * 1024 ** 2)
          throw Error("附件超过侧栏 20 MiB 预算，请在桌面查看");
        const response = await call(
            `${path}/${capture ? "objects" : "resources"}/${resource.id}`,
          ),
          bytes = await bounded(response, resource.size);
        if (
          bytes.length !== resource.size ||
          (await sha256(bytes)) !== resource.hash
        )
          throw Error("资源校验失败");
        return bytes;
      }
      attachments.append(
        button(
          `下载附件：${resource.name}`,
          async () => {
            const url = URL.createObjectURL(
                new Blob([await read()], { type: "application/octet-stream" }),
              ),
              link = document.createElement("a");
            link.href = url;
            link.download = resource.name;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          },
          "download",
        ),
      );
      if (["image/png", "image/jpeg", "image/webp"].includes(resource.mime))
        attachments.append(
          button(
            "预览图片",
            async () => {
              const bytes = await read(),
                mime = imageMime(bytes);
              if (
                mime !== resource.mime ||
                !imageSize(bytes, mime) ||
                imageBudgetError(bytes, mime)
              )
                throw Error("图片格式或尺寸超过预算");
              const url = URL.createObjectURL(
                  new Blob([bytes], { type: mime }),
                ),
                img = document.createElement("img");
              img.alt = resource.name;
              img.style.maxWidth = "100%";
              img.onload = img.onerror = () => URL.revokeObjectURL(url);
              img.src = url;
              attachments.append(img);
            },
            "image",
          ),
        );
    }
    $("cloud-note").replaceChildren(heading, body, attachments);
  }
  async function tree(container, parent = null, page = 0) {
    const value = await json(
      `${base()}/tree?parentId=${parent || "root"}&page=${page}`,
    );
    for (const node of value.nodes) {
      const row = document.createElement("li");
      if (node.kind === "folder") {
        const detail = document.createElement("details"),
          summary = document.createElement("summary"),
          children = document.createElement("ul");
        summary.append(icon("folder"), document.createTextNode(node.title));
        detail.append(
          summary,
          button(
            "选为导入目录",
            async () => {
              parentId = node.id;
              $("cloud-target").textContent = `导入到：${node.title}`;
            },
            "check",
          ),
          children,
        );
        detail.ontoggle = () => {
          if (detail.open && !detail.dataset.loaded)
            void run(async () => {
              await tree(children, node.id);
              detail.dataset.loaded = "true";
            });
        };
        row.append(detail);
      } else
        row.append(
          button(node.title, async () => {
            const path = `${base()}/notes/${node.id}`;
            await showNote(await json(path), path);
          }),
        );
      container.append(row);
    }
    if (value.next !== null) {
      const more = button(
        "更多…",
        async () => {
          more.remove();
          await tree(container, parent, value.next);
        },
        "more",
      );
      container.append(more);
    }
  }
  async function inbox() {
    const entries = await json("/v1/captures"),
      container = $("cloud-inbox");
    container.replaceChildren();
    const labels = {
      uploading: "上传中",
      queued: "待桌面归入",
      applied: "已归入，等待备份",
      backedUp: "已备份",
      "needs-target": "需要重新选择目录",
    };
    for (const entry of entries)
      container.append(
        button(
          `${new Date(entry.createdAt).toLocaleString()} · ${labels[entry.status] || entry.status}`,
          async () => {
            const value = await json(`/v1/captures/${entry.id}`);
            if (value.cleared === 2) {
              $("cloud-note").replaceChildren(
                button(
                  "重试清理采集副本",
                  async () => {
                    await json(`/v1/captures/${entry.id}`, {
                      method: "DELETE",
                    });
                    await inbox();
                    $("cloud-note").replaceChildren();
                  },
                  "refresh",
                ),
              );
              return;
            }
            if (value.cleared === 1) {
              const path = `${base()}/notes/${value.noteId}`;
              await showNote(await json(path), path);
              return;
            }
            if (value.status === "uploading")
              throw Error("尚未提交完整，请从原采集记录重试上传");
            const response = await call(
                `/v1/captures/${entry.id}/objects/${value.manifest.body.sha256}`,
              ),
              bytes = await bounded(response, value.manifest.body.size);
            if ((await sha256(bytes)) !== value.manifest.body.sha256)
              throw Error("正文校验失败");
            await showNote(
              {
                title: value.manifest.title,
                body: new TextDecoder().decode(bytes),
                resources: value.manifest.assets.map((a) => ({
                  ...a,
                  id: a.sha256,
                  hash: a.sha256,
                })),
              },
              `/v1/captures/${entry.id}`,
              true,
            );
            if (value.status === "backedUp")
              $("cloud-note").append(
                button(
                  "清理已备份的采集副本",
                  async () => {
                    if (
                      !confirm(
                        "清理采集箱中的正文和媒体副本？正式笔记与备份不受影响。",
                      )
                    )
                      return;
                    await json(`/v1/captures/${entry.id}`, {
                      method: "DELETE",
                    });
                    await inbox();
                    $("cloud-note").replaceChildren();
                    status("采集副本已清理，回执保留。");
                  },
                  "trash",
                ),
              );
            if (value.status === "needs-target")
              $("cloud-note").append(
                button(
                  "改用当前选中的导入目录",
                  async () => {
                    await json(`/v1/captures/${entry.id}/target`, {
                      method: "POST",
                      body: { parentId, targetVersion: value.targetVersion },
                    });
                    await inbox();
                    status("目录已更新，等待桌面归入。");
                  },
                  "check",
                ),
              );
          },
          "inbox",
        ),
      );
  }
  async function refresh() {
    if (!session) return;
    const books = await json("/v1/library/notebooks");
    book = books[0];
    if (!book) throw Error("云端尚无可浏览的备份");
    parentId = null;
    $("cloud-target").textContent = "导入到：笔记本根目录";
    $("cloud-time").textContent =
      `最近备份：${new Date(book.publishedAt).toLocaleString()}；采集箱在桌面备份时归入。`;
    $("cloud-tree").replaceChildren();
    await tree($("cloud-tree"));
    await inbox();
    $("cloud-library").hidden = false;
    $("cloud-login").hidden = true;
  }
  $("cloud-connect").onclick = () =>
    void run(async () => {
      const endpoint = new URL($("cloud-endpoint").value);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== "/"
      )
        throw Error("请输入 HTTPS Worker 根地址");
      const code = $("cloud-code").value.trim();
      if (!/^[a-f0-9]{64}$/.test(code)) throw Error("请输入桌面端生成的配对码");
      if (
        !(await chrome.permissions.request({
          origins: [`${endpoint.origin}/*`],
        }))
      )
        throw Error("云端站点未获授权");
      const response = await fetch(endpoint.origin + "/v1/pairings/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw Error("配对失败，请检查配对码是否过期");
      const auth = await response.json();
      session = { ...auth, endpoint: endpoint.origin };
      $("cloud-code").value = "";
      await chrome.storage.session.set({ "capture.cloud": session });
      await refresh();
      status("云端已连接；授权仅保留在本次浏览器会话。");
    });
  $("cloud-refresh").onclick = () => void run(refresh);
  $("cloud-root").onclick = () => {
    parentId = null;
    $("cloud-target").textContent = "导入到：笔记本根目录";
  };
  $("cloud-logout").onclick = () =>
    void run(async () => {
      session = null;
      book = null;
      await chrome.storage.session.remove("capture.cloud");
      $("cloud-library").hidden = true;
      $("cloud-login").hidden = false;
      $("cloud-note").replaceChildren();
      status("已退出。永久撤销授权可在桌面端采集设备中操作。");
    });
  $("cloud-upload").onclick = () =>
    void run(async () => {
      if (!book) {
        openSettings();
        throw Error("请先在设置中配对登录并刷新目录，再返回采集页导入。");
      }
      if (!setBusy(true)) return;
      try {
        const capture = await freeze();
        await validateCapture(capture);
        const path = `/v1/captures/${capture.manifest.captureId}`;
        const plan = await json("/v1/captures/plan", {
          method: "POST",
          body: {
            manifest: capture.manifest,
            target: {
              notebookId: book.notebookId,
              lineageId: book.lineageId,
              parentId,
              observedGenerationId: book.generationId,
            },
          },
        });
        for (const hash of plan.missing) {
          let bytes;
          if (hash === capture.manifest.body.sha256)
            bytes = new TextEncoder().encode(capture.body);
          else {
            const asset = capture.manifest.assets.find(
              (a) => a.sha256 === hash,
            );
            if (!asset) throw Error("上传计划无效");
            const blob = await readAsset(asset.path);
            if (!blob) throw Error("本地资源已丢失，请重新采集");
            bytes = new Uint8Array(await blob.arrayBuffer());
          }
          if ((await sha256(bytes)) !== hash) throw Error("本地资源校验失败");
          status("正在上传采集资源…");
          await json(`${path}/objects/${hash}`, { method: "PUT", bytes });
        }
        await json(path + "/commit", { method: "POST" });
        await inbox();
        status("已保存到云端采集箱；桌面下次备份时自动归入所选目录。");
      } finally {
        setBusy(false);
      }
    });
  void run(async () => {
    session = (await chrome.storage.session.get("capture.cloud"))[
      "capture.cloud"
    ];
    if (session) await refresh();
  });
}
