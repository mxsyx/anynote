/* global chrome */
import { readSelection } from "./selection.js";
import { readChatGPT } from "./chatgpt-page.js";
import { conversationMarkdown } from "@anynote/capture/chatgpt.js";

async function configure() {
  await chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "capture.selection",
    title: "采集到 AnyNote",
    contexts: ["selection"],
  });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // Also cover ChatGPT tabs that were already open when the extension was enabled.
  for (const tab of await chrome.tabs.query({ url: "https://chatgpt.com/*" }))
    if (tab.id)
      await chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          files: ["chatgpt-button.js"],
        })
        .catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => void configure());
chrome.runtime.onStartup.addListener(() => void configure());

async function store(input) {
  // Pending source HTML lives only in session storage until the panel converts it.
  await chrome.storage.session.set({
    ["capture.pending"]: { ...input, id: crypto.randomUUID() },
  });
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "capture.selection" || !tab?.id) return;
  const reading = chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
    func: readSelection,
  });
  void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  void reading
    .then(async (results) => {
      const result = results[0];
      if (!result?.result || result.error)
        throw Error("无法读取该页面选区；嵌入页面可能需要单独授权");
      const check = await chrome.scripting.executeScript({
        target: { tabId: tab.id, documentIds: [result.documentId] },
        func: () => location.href,
      });
      if (check[0]?.result !== result.result.url)
        throw Error("页面已经切换，请重新采集");
      await store(result.result);
    })
    .catch((error) => store({ error: error.message }));
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    message?.type !== "capture.chatgpt" ||
    !sender.tab?.id ||
    sender.frameId !== 0 ||
    !sender.url?.startsWith("https://chatgpt.com/")
  )
    return;
  void chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
  void chrome.scripting
    .executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      world: "MAIN",
      func: readChatGPT,
    })
    .then(async (result) => {
      if (result[0]?.error || !result[0]?.result)
        throw Error(
          result[0]?.error?.message || "网页接口不可用，请在侧栏查看说明",
        );
      const converted = conversationMarkdown(result[0].result);
      await store({
        kind: "chatgpt",
        ...converted,
        url: sender.url,
        capturedAt: new Date().toISOString(),
      });
      reply({ ok: true });
    })
    .catch(async (error) => {
      await store({ error: error.message });
      reply({ ok: false });
    });
  return true;
});
