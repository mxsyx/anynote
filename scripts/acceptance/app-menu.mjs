/** Follow the desktop native menu; theme switching is also available in previews. */
export async function appMenu(page, command, desktop) {
  if (desktop) {
    await desktop.evaluate(({ Menu }, id) => {
      const item = Menu.getApplicationMenu().getMenuItemById(id);
      if (!item) throw Error(`Missing application menu: ${id}`);
      item.click();
    }, command);
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
