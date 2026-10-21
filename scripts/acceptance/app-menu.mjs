/** Follow the desktop native menu; theme switching is also available in previews. */
export async function appMenu(page, command, desktop) {
  if (desktop) {
    // A main-process click only queues IPC. Wait for renderer delivery and its
    // next paint before typing or dispatching another menu command.
    await page.evaluate((command) => {
      window.__anynoteMenuHandled = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off?.();
          reject(Error("Menu command was not delivered"));
        }, 5000);
        const off = window.anynote.onMenuCommand((value) => {
          if (value !== command) return;
          clearTimeout(timer);
          off();
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
      });
    }, command);
    await desktop.evaluate(({ Menu }, id) => {
      const item = Menu.getApplicationMenu().getMenuItemById(id);
      if (!item) throw Error(`Missing application menu: ${id}`);
      item.click();
    }, command);
    await page.evaluate(async () => {
      try {
        await window.__anynoteMenuHandled;
      } finally {
        delete window.__anynoteMenuHandled;
      }
    });
    return;
  }

  if (command.startsWith("insert.")) {
    await page.getByRole("textbox", { name: "文档内容", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/" + command.slice(7));
    await page.keyboard.press("Enter");
    return;
  }

  if (command !== "theme") {
    throw Error(
      `Application action requires the desktop native menu: ${command}`,
    );
  }

  await page.getByRole("button", { name: "切换主题", exact: true }).click();
}
