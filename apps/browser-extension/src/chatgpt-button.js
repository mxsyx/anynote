/* global chrome */
function mount() {
  const existing = document.getElementById("anynote-capture-button");
  if (!location.pathname.includes("/c/")) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const host = document.createElement("div");
  host.id = "anynote-capture-button";
  host.style.cssText =
    "position:fixed;right:18px;bottom:90px;z-index:2147483646";
  const root = host.attachShadow({ mode: "closed" }),
    button = document.createElement("button");
  button.textContent = "采集对话";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
    path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("aria-hidden", "true");
  path.setAttribute("d", "M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  icon.append(path);
  button.prepend(icon);
  button.title = "通过 ChatGPT 网页接口采集当前对话";
  const style = document.createElement("style");
  style.textContent = `
    button { display:flex;align-items:center;gap:7px;font:500 13px system-ui;padding:10px 16px;border:1px solid #d8dde5;border-radius:8px;background:#fff;color:#344054;cursor:pointer;color-scheme:light; }
    button:hover { background:#f5f7fa;border-color:#b8c1ce; }
    button:active { background:#edf0f5; }
    button:focus-visible { outline:2px solid #2563eb;outline-offset:3px; }
  `;
  button.onclick = () => {
    void chrome.runtime.sendMessage({ type: "capture.chatgpt" }).catch(() => {
      button.textContent = "请点击扩展图标重试";
    });
  };
  root.append(style, button);
  document.documentElement.append(host);
}
if (!globalThis.anynoteCaptureMounted) {
  globalThis.anynoteCaptureMounted = true;
  mount();
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(mount, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", mount);
}
