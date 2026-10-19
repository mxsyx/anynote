/** Enter the first available volume from the library startup screen. */
export async function openNotebook(page) {
  await page
    .getByRole("button", { name: /^打开 Notebook：/ })
    .first()
    .click({ timeout: 30000 });
}
