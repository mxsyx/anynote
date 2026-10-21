/** Enter a named volume, or the first available volume from the library startup screen. */
export async function openNotebook(page, title) {
  await page
    .getByRole("button", {
      name: title ? `打开 Notebook：${title}` : /^打开 Notebook：/,
      exact: !!title,
    })
    .first()
    .click({ timeout: 30000 });
}
