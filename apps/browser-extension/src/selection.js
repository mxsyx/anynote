/** Executed in the selected frame. The result is captured before focus moves to the panel. */
export function readSelection() {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && active.type === "password")
    throw Error("密码输入框不能采集");
  let html = "";
  if (
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLInputElement
  ) {
    const text = active.value.slice(
      active.selectionStart ?? 0,
      active.selectionEnd ?? 0,
    );
    const pre = document.createElement("pre");
    pre.textContent = text;
    html = pre.outerHTML;
  } else {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed)
      throw Error("选区已消失，请重新选择");
    const wrapper = document.createElement("div");
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i),
        fragment = range.cloneContents();
      // Read runtime image choices before losing the live DOM context.
      const original = [...document.images].filter((image) =>
        range.intersectsNode(image),
      );
      [...fragment.querySelectorAll("img")].forEach((image, j) => {
        image.setAttribute(
          "src",
          original[j]?.currentSrc || image.getAttribute("src") || "",
        );
      });
      let root = fragment;
      let parent =
        range.commonAncestorContainer.nodeType === 1
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      for (
        let depth = 0;
        parent && parent !== document.body && depth < 8;
        depth++, parent = parent.parentElement
      ) {
        if (
          ![
            "LI",
            "UL",
            "OL",
            "TABLE",
            "TBODY",
            "THEAD",
            "TR",
            "TD",
            "TH",
            "PRE",
            "CODE",
            "BLOCKQUOTE",
          ].includes(parent.tagName)
        )
          continue;
        const context = parent.cloneNode(false);
        context.append(root);
        root = context;
      }
      wrapper.append(root);
    }
    html = wrapper.innerHTML;
  }
  if (!html || html.length > 10_000_000) throw Error("选区为空或超过预算");
  return {
    kind: "selection",
    title: document.title.slice(0, 240) || "网页选区",
    html,
    url: location.href,
    baseUrl: document.baseURI,
    capturedAt: new Date().toISOString(),
  };
}
