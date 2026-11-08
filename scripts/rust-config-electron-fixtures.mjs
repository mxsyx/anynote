import assert from "node:assert/strict";
import { _electron } from "playwright";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

// Generates only isolated synthetic old-client data. Never reads the user's profile.
mkdirSync("tmp/rm13", { recursive: true });
const root = mkdtempSync(resolve("tmp/rm13/electron-"));
const fixtureRoot = resolve(
  `tests/fixtures/rust-migration/config/electron-${process.platform}`,
);
const values = {
  "anynote.appearance": '{"mode":"dark"}',
  "anynote.navigation.tabs": "hidden",
  "anynote.notebooks.visits":
    '{"11111111-1111-4111-8111-111111111111":1730000000000}',
  "anynote-recent": '["阅读 📚","café"]',
  "anynote-book": "11111111-1111-4111-8111-111111111111",
  "anynote-pdf-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222":
    "7",
  "anynote-image-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222":
    '{"fit":"custom","zoom":1.25,"rotate":90}',
};
writeFileSync(
  join(root, "index.html"),
  "<!doctype html><title>RM13 synthetic fixture</title>",
);
writeFileSync(
  join(root, "main.cjs"),
  `const {app,BrowserWindow}=require('electron'); app.setPath('userData',process.env.RM13_PROFILE); app.whenReady().then(()=>{const w=new BrowserWindow({show:false}); if(process.env.RM13_ORIGIN==='file') w.loadFile(${JSON.stringify(join(root, "index.html"))}); else w.loadURL('http://127.0.0.1:5173');});`,
);
const server = createServer((req, res) =>
  res.end("<!doctype html><title>RM13 dev fixture</title>"),
);
server.listen(5173, "127.0.0.1");
await once(server, "listening");
try {
  for (const origin of ["file", "dev"])
    for (const shutdown of ["clean", "crash"]) {
      const name = `${origin}-${shutdown}`;
      const profile = join(root, name);
      const app = await _electron.launch({
        args: [join(root, "main.cjs"), "--no-sandbox"],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "",
          RM13_PROFILE: profile,
          RM13_ORIGIN: origin,
        },
      });
      try {
        const versions = await app.evaluate(() => process.versions);
        assert.equal(versions.electron, "41.9.1");
        const page = await app.firstWindow();
        await page.waitForLoadState();
        await page.evaluate((values) => {
          localStorage.setItem("anynote.navigation.tabs", "visible");
          localStorage.setItem("anynote-pdf-deleted", "99");
          for (const [k, v] of Object.entries(values))
            localStorage.setItem(k, v);
          localStorage.removeItem("anynote-pdf-deleted");
          localStorage.setItem("unrelated.token", "not-a-real-secret");
        }, values);
        await app.evaluate(({ session }) =>
          session.defaultSession.flushStorageData(),
        );
        await page.waitForTimeout(2000);
        if (shutdown === "clean") await app.close();
        else {
          const child = app.process();
          child.kill("SIGKILL");
          await once(child, "exit");
        }
        const out = join(fixtureRoot, name);
        rmSync(out, { recursive: true, force: true });
        mkdirSync(out, { recursive: true });
        cpSync(
          join(profile, "Local Storage", "leveldb"),
          join(out, "leveldb"),
          { recursive: true },
        );
        writeFileSync(
          join(out, "expected.json"),
          JSON.stringify(
            {
              electron: versions.electron,
              chromium: versions.chrome,
              platform: process.platform,
              origin: origin === "file" ? "file://" : "http://127.0.0.1:5173",
              shutdown,
              flushedBeforeShutdown: true,
              values,
            },
            null,
            2,
          ) + "\n",
        );
      } finally {
        await app.close().catch(() => {});
      }
    }
  const hashes = {};
  for (const name of readdirSync(fixtureRoot))
    for (const file of readdirSync(join(fixtureRoot, name, "leveldb")))
      hashes[`${name}/leveldb/${file}`] = createHash("sha256")
        .update(readFileSync(join(fixtureRoot, name, "leveldb", file)))
        .digest("hex");
  writeFileSync(
    join(fixtureRoot, "../electron-" + process.platform + "-sha256.json"),
    JSON.stringify(hashes, null, 2) + "\n",
  );
  console.log(
    `Generated four Electron 41.9.1 synthetic fixtures: ${fixtureRoot}`,
  );
} finally {
  server.close();
}
