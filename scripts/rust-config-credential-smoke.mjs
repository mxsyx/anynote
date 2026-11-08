import assert from "node:assert/strict";
import { _electron } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";

// The outer process creates an isolated D-Bus and XDG data root; no normal login keyring is accessed.
if (!process.env.RM13_PRIVATE_BUS) {
  mkdirSync("tmp/rm13", { recursive: true });
  const root = mkdtempSync(resolve("tmp/rm13/credentials-"));
  const child = spawnSync(
    "dbus-run-session",
    ["--", "node", resolve(import.meta.filename)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        RM13_PRIVATE_BUS: "1",
        RM13_ROOT: root,
        XDG_DATA_HOME: join(root, "xdg-data"),
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        GNOME_KEYRING_CONTROL: join(root, "control"),
        ELECTRON_RUN_AS_NODE: "",
        XDG_CURRENT_DESKTOP: "GNOME",
        DESKTOP_SESSION: "gnome",
      },
    },
  );
  process.exit(child.status ?? 1);
}
const root = process.env.RM13_ROOT;
mkdirSync(join(root, "control"), { recursive: true, mode: 0o700 });
mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
const daemon = spawn(
  "gnome-keyring-daemon",
  [
    "--foreground",
    "--unlock",
    "--components=secrets",
    "--control-directory",
    join(root, "control"),
  ],
  { stdio: ["pipe", "ignore", "pipe"] },
);
daemon.stderr.on("data", (chunk) => process.stderr.write(chunk));
daemon.stdin.end("rm13-synthetic-keyring-password");
let app;
try {
  await new Promise((r) => setTimeout(r, 1000));
  const main = join(root, "main.cjs");
  writeFileSync(
    main,
    `const {app,BrowserWindow}=require('electron'); app.commandLine.appendSwitch('password-store','gnome-libsecret'); app.setName('anynote-rm13-fixture'); app.setPath('userData',${JSON.stringify(join(root, "profile"))}); let window; app.whenReady().then(()=>{window=new BrowserWindow({show:false});window.loadURL('about:blank');});`,
  );
  app = await _electron.launch({
    args: [main, "--no-sandbox", "--password-store=gnome-libsecret"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
  });
  await app.firstWindow();
  const metadata = await app.evaluate(({ safeStorage, app }) => {
    if (!safeStorage.isEncryptionAvailable())
      throw Error(
        "synthetic keyring unavailable: " +
          safeStorage.getSelectedStorageBackend(),
      );
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === "basic_text") throw Error("basic_text refused");
    return {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      application: app.getName(),
      backend,
      ciphertext: safeStorage
        .encryptString('{"token":"rm13-synthetic-token"}')
        .toString("base64"),
    };
  });
  assert.equal(metadata.electron, "41.9.1");
  writeFileSync(
    join(root, "secret.bin"),
    Buffer.from(metadata.ciphertext, "base64"),
    { mode: 0o600 },
  );
  delete metadata.ciphertext;
  await app.close();
  app = undefined;
  const result = spawnSync(
    resolve("target/debug/examples/check_synthetic_credential"),
    [root],
    { stdio: "inherit", env: { ...process.env, RM13_SYNTHETIC_ONLY: "1" } },
  );
  assert.equal(result.status, 0);
  const token = Buffer.from("rm13-synthetic-token");
  function scan(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.isFile() && p !== main)
        assert(!readFileSync(p).includes(token), `plaintext found: ${p}`);
    }
  }
  scan(root);
  writeFileSync(
    join(root, "environment.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  console.log(
    `private keyring smoke and no plaintext-file scan passed: ${root}`,
  );
} finally {
  if (app) await app.close().catch(() => {});
  daemon.kill("SIGTERM");
}
