import { appMenu } from "./acceptance/app-menu.mjs";
import { openNotebook } from "./acceptance/open-notebook.mjs";
import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: process.env.ANYNOTE_BROWSER || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  await page.goto("http://127.0.0.1:5173");
  await openNotebook(page);
  await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
  await page.screenshot({
    path: "tmp/screenshots/light.png",
    animations: "disabled",
  });
  await appMenu(page, "theme");
  await page.screenshot({
    path: "tmp/screenshots/dark.png",
    animations: "disabled",
  });
  console.log("Clean preview screenshots saved.");
} finally {
  await browser.close();
}
