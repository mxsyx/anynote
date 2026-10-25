/** Experimental internal-web adapter. Session credentials never leave the MAIN world. */
export async function readChatGPT() {
  const match = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
  if (location.origin !== "https://chatgpt.com" || !match)
    throw Error("请打开已保存的 ChatGPT 对话");
  const id = match[1],
    url = location.href;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30000);
  async function json(path, headers = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok)
      throw Error(
        response.status === 401
          ? "请重新登录 ChatGPT"
          : response.status === 403
            ? "ChatGPT 拒绝访问，请在网页处理登录或验证"
            : response.status === 429
              ? "ChatGPT 请求过于频繁，请稍后重试"
              : `ChatGPT 接口失败（${response.status}）`,
      );
    if (!response.body) throw Error("ChatGPT 返回空响应");
    const reader = response.body.getReader(),
      chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 ** 2) throw Error("ChatGPT 响应超过预算");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return JSON.parse(await new Blob(chunks).text());
  }
  try {
    const session = await json("/api/auth/session");
    if (typeof session.accessToken !== "string")
      throw Error("ChatGPT 登录态不可用或接口已变化");
    const data = await json(
      `/backend-api/conversation/${encodeURIComponent(id)}`,
      { Authorization: `Bearer ${session.accessToken}` },
    );
    if (location.href !== url) throw Error("对话已切换，请重新采集");
    if (
      !data.mapping ||
      typeof data.mapping !== "object" ||
      Object.keys(data.mapping).length > 10000
    )
      throw Error("ChatGPT 对话结构已变化");
    const roots = [
      ...document.querySelectorAll("[data-message-id], [data-dil-message-id]"),
    ];
    const last = roots.at(-1),
      visible =
        last?.getAttribute("data-dil-message-id") ||
        last?.getAttribute("data-message-id");
    const currentNode =
      visible && data.mapping[visible] ? visible : data.current_node;
    if (visible && !data.mapping[visible])
      throw Error("不能确认当前显示分支，请刷新页面后重试");
    if (typeof currentNode !== "string") throw Error("无法定位当前对话分支");
    // Export only bounded type labels for troubleshooting, never arbitrary payload fields.
    const typeLabel = (value) =>
      typeof value === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(value)
        ? value
        : "unknown";
    const imageGroups = new Map();
    let imageCount = 0;
    for (const root of roots) {
      const messageId =
        root.getAttribute("data-dil-message-id") ||
        root.getAttribute("data-message-id");
      if (!messageId || !data.mapping[messageId] || imageGroups.has(messageId))
        continue;
      const groups = new Map();
      // Match the rendered search-image components, not avatars, citations or arbitrary page images.
      for (const img of root.querySelectorAll(
        '[class~="group/search-image"] img',
      )) {
        if (++imageCount > 200) throw Error("对话图片超过采集预算");
        let container = img;
        while (container.parentElement && container.parentElement !== root)
          container = container.parentElement;
        if (!groups.has(container))
          groups.set(container, { images: [], incomplete: false });
        const group = groups.get(container);
        try {
          const src = img.currentSrc || img.getAttribute("src") || "";
          const imageUrl = new URL(src);
          if (
            !["https:", "http:"].includes(imageUrl.protocol) ||
            imageUrl.username ||
            imageUrl.password ||
            src.length > 8192
          )
            throw Error("不可下载的图片地址");
          if (!group.images.some((image) => image.url === src))
            group.images.push({
              url: src,
              alt: (img.alt || "对话图片").slice(0, 240),
            });
        } catch {
          group.incomplete = true;
        }
      }
      if (groups.size) imageGroups.set(messageId, [...groups.values()]);
    }
    const nodes = Object.entries(data.mapping).map(([key, node]) => {
      const message = node.message,
        role = message?.author?.role,
        contentType = message?.content?.content_type;
      const publicMessage =
        ["user", "assistant"].includes(role) &&
        !message?.metadata?.is_visually_hidden_from_conversation &&
        (!message.recipient || message.recipient === "all") &&
        !["thoughts", "reasoning_recap"].includes(contentType) &&
        (!message.channel || ["final", "commentary"].includes(message.channel));
      const parts = Array.isArray(message?.content?.parts)
        ? message.content.parts
        : [];
      const unsupportedParts = parts.filter((p) => typeof p !== "string"),
        unsupported =
          unsupportedParts.length +
          (parts.length || contentType === "text" ? 0 : 1);
      return {
        id: key,
        parent: typeof node.parent === "string" ? node.parent : null,
        message: publicMessage
          ? {
              role,
              text: parts.filter((p) => typeof p === "string").join("\n\n"),
              unsupported,
              unsupportedTypes: unsupported
                ? [
                    ...new Set([
                      typeLabel(contentType),
                      ...unsupportedParts.map((p) =>
                        typeLabel(p?.content_type ?? p?.type),
                      ),
                    ]),
                  ].slice(0, 4)
                : [],
              imageGroups: imageGroups.get(key) || [],
            }
          : null,
      };
    });
    return {
      id,
      title:
        typeof data.title === "string"
          ? data.title.slice(0, 240)
          : "ChatGPT 对话",
      currentNode,
      nodes,
      incomplete: data.mapping[currentNode]?.message?.status === "in_progress",
    };
  } finally {
    clearTimeout(timer);
  }
}
