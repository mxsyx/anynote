import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir, arch } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { captureLocalNotebook } from "../.build/packages/backup/local-capture.js";
import {
  LocalBackupService,
  initializeTarget,
  guard,
  hashFile,
  inspectFilesystem,
} from "../.build/packages/backup-local/index.js";
import {
  probeReplacement,
  requireLocalFilesystem,
} from "../.build/packages/backup-local/filesystem.js";
import { syncDirectory } from "../.build/packages/backup-local/files.js";

// macOS/APFS 实盘验收（TODO §2.3）。用 hdiutil 创建并挂载真实 APFS/exFAT/FAT32 卷，
// 不需要 root 且可完整清理；外接物理盘拔盘、真实断电、独立设备与真实网络盘挂载不在本脚本范围内。
const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  assert.ok(args[i + 1] && !args[i + 1].startsWith("--"), `${name} 需要参数`);
  return args[i + 1];
}
assert.equal(process.platform, "darwin", "macOS 卷验收只能在 macOS 真机上运行");
const reportPath = resolve(
  option("--report-path") || "test-results/macos-volume-acceptance.json",
);
const baseParent = resolve(option("--base-dir") || tmpdir());
mkdirSync(baseParent, { recursive: true });
const base = mkdtempSync(join(baseParent, "anynote-macos-volume-"));
const checks = [];
const skipped = [];
const mounted = [];
const volumes = {};
const sh = (command, commandArgs) => {
  try {
    return execFileSync(command, commandArgs, {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch (error) {
    // 不带 `-quiet`：失败原因必须保留在错误里，否则只能看到退出码。
    const detail = [error.stdout, error.stderr].filter(Boolean).join("").trim();
    throw Error(
      `${command} ${commandArgs.join(" ")} 失败${detail ? "：" + detail : ""}`,
    );
  }
};

async function check(name, fn) {
  const detail = await fn();
  // 环境限制（例如本机不允许创建某类镜像）必须如实记录，不能当作通过。
  if (detail?.skip) {
    skipped.push({ name, reason: detail.skip });
    console.log(`SKIP ${name}: ${detail.skip}`);
    return detail;
  }
  checks.push(name);
  console.log(`PASS ${name}`);
  return detail;
}

/** Create a disk image, trying the format names used across macOS versions. */
function createImage(image, formats, volumeName) {
  const failures = [];
  for (const filesystem of formats)
    try {
      sh("hdiutil", [
        "create",
        "-size",
        "256m",
        "-fs",
        filesystem,
        "-volname",
        volumeName,
        image,
      ]);
      console.log(`  image ${image} created with -fs ${filesystem}`);
      return filesystem;
    } catch (error) {
      failures.push(error.message);
    }
  throw Error(
    `无法创建 ${volumeName} 镜像（尝试 ${formats.join("、")}）：${failures.join(" | ")}`,
  );
}

/** Attach an image at a deterministic mount point. */
function attachImage(image, mountPoint) {
  mkdirSync(mountPoint, { recursive: true });
  sh("hdiutil", ["attach", "-nobrowse", "-mountpoint", mountPoint, image]);
  mounted.push(mountPoint);
}

/** Detach a mount point and forget it. */
function detachImage(mountPoint) {
  sh("hdiutil", ["detach", mountPoint]);
  const i = mounted.indexOf(mountPoint);
  if (i >= 0) mounted.splice(i, 1);
}

/** Read one boolean from a `diskutil` plist. */
function plistBoolean(plist, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`).exec(
    plist,
  );
  return match ? match[1] === "true" : undefined;
}

/** Read one string from a `diskutil` plist. */
function plistString(plist, key) {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
    plist,
  )?.[1];
}

/** Compare the identity fields that must survive a re-mount. */
function assertSameVolume(before, after) {
  for (const key of [
    "filesystem",
    "deviceId",
    "diskName",
    "mountPoint",
    "volumeIdentity",
    "volumeUuid",
    "remote",
  ])
    assert.equal(after[key], before[key], `重新挂载后 ${key} 必须保持一致`);
}

async function main() {
  const storage = new Storage(join(base, "source"));
  const book = await storage.run("createNotebook", { title: "macOS 实盘验收" });
  const first = await storage.run("createNode", {
    notebookId: book.id,
    title: "验收正文",
    body: "第一版：APFS 实盘复制与校验。",
  });
  const capture = async () => {
    const temp = join(base, "capture-" + randomUUID());
    mkdirSync(temp);
    const c = await captureLocalNotebook(storage, book.id, temp);
    c.release = async () => rmSync(temp, { recursive: true, force: true });
    return c;
  };
  const engine = new LocalBackupService();

  // 1. 卷身份：APFS 卷应报告稳定 VolumeUUID、挂载点与磁盘名称。
  const apfsImage = join(base, "apfs.dmg");
  const apfsMount = join(base, "apfs-mnt");
  await check("apfs-volume-identity", async () => {
    createImage(apfsImage, ["APFS"], "ANYNOTE_APFS");
    attachImage(apfsImage, apfsMount);
    const info = await inspectFilesystem(apfsMount);
    volumes.apfs = info;
    assert.equal(info.filesystem, "apfs");
    assert.equal(info.volumeIdentity, "volume-uuid");
    assert.match(
      info.volumeUuid,
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i,
    );
    assert.equal(info.remote, false);
    assert.equal(info.mounted, true);
    assert.equal(info.maximumFileBytes, undefined);
    assert.ok(info.diskName.length > 0);
    assert.ok(info.mountPoint.startsWith("/"));
    // 与系统自己的 diskutil 报告逐字一致，证明不是自我推断。
    const plist = sh("diskutil", ["info", "-plist", apfsMount]);
    assert.equal(
      info.volumeUuid.toUpperCase(),
      plistString(plist, "VolumeUUID")?.toUpperCase(),
    );
    assert.equal(info.diskName, plistString(plist, "VolumeName"));
    // 同一卷重复探测给出同一身份。
    assert.equal(
      (await inspectFilesystem(apfsMount)).volumeUuid,
      info.volumeUuid,
    );
    // 源（内建 APFS 数据卷）与目标（镜像卷）的卷身份必须可区分。
    const source = await inspectFilesystem(storage.directory(book.id));
    assert.equal(source.filesystem, "apfs");
    assert.notEqual(source.volumeUuid, info.volumeUuid);
  });

  // 2. 能力探测：替换、读回与目录 fsync 在真实 APFS 上可用；无 FAT32 限制的计划被接受。
  await check("apfs-replacement-fsync-and-space-limits", async () => {
    await probeReplacement(apfsMount, async () => {});
    await syncDirectory(apfsMount);
    requireLocalFilesystem(volumes.apfs, 8 * 1024 ** 3);
  });

  // 3. 复制、覆盖替换、完整校验与完整恢复都在真实 APFS 镜像卷上执行。
  const target = await initializeTarget(apfsMount, [storage.root]);
  let manifest;
  await check("apfs-backup-replace-verify-restore", async () => {
    const copied = await engine.backup(target, book.id, capture, {
      sources: [storage.root],
    });
    assert.ok(copied.copiedFiles >= 2, "首次备份应复制数据库与引导文件");
    await engine.verify(target, book.id);
    // 覆盖替换：内容变化后再次备份，数据库必须被同盘替换并在校验中读到新内容。
    const second = await storage.run("createNode", {
      notebookId: book.id,
      title: "第二版",
      body: "第二版：覆盖替换后必须校验通过。",
    });
    const replaced = await engine.backup(target, book.id, capture, {
      sources: [storage.root],
    });
    assert.ok(replaced.copiedFiles >= 1, "内容变化后必须复制新数据库");
    manifest = await engine.verify(target, book.id);
    assert.equal(
      await hashFile(
        join(target.path, "notebooks", book.id, "notebook.sqlite"),
      ),
      manifest.database.sha256,
    );
    // 完整恢复：复制回本机并逐字节核对数据库、正文与资源闭包。
    const restored = join(base, "restored");
    mkdirSync(restored);
    const restoredManifest = await engine.restore(target, book.id, restored);
    const database = join(restored, "notebook.sqlite");
    assert.equal(await hashFile(database), restoredManifest.database.sha256);
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
      const bodyOf = (id) =>
        db
          .prepare(
            "SELECT r.body FROM notes t JOIN note_revisions r ON r.id=t.head_revision_id WHERE t.node_id=?",
          )
          .get(id)?.body;
      assert.equal(bodyOf(second.id), "第二版：覆盖替换后必须校验通过。");
      assert.equal(bodyOf(first.id), "第一版：APFS 实盘复制与校验。");
      for (const asset of db.prepare("SELECT path,hash FROM assets").all())
        assert.equal(
          await hashFile(join(restored, asset.path)),
          asset.hash,
          "恢复后的附件哈希必须匹配",
        );
    } finally {
      db.close();
    }
  });

  // 4. 挂载/重挂载与离线识别：卸载后必须停止发布，重挂载后身份与清单继续有效。
  await check("apfs-remount-and-offline-detection", async () => {
    detachImage(apfsMount);
    await assert.rejects(
      engine.backup(target, book.id, capture, { sources: [storage.root] }),
      (e) => e.code === "TARGET_OFFLINE",
    );
    await assert.rejects(
      guard(target),
      (e) => e.code === "TARGET_OFFLINE",
      "卸载后必须报告目标离线",
    );
    attachImage(apfsImage, apfsMount);
    assertSameVolume(volumes.apfs, await inspectFilesystem(apfsMount));
    await guard(target);
    await engine.verify(target, book.id);
    assert.equal(
      await hashFile(
        join(target.path, "notebooks", book.id, "notebook.sqlite"),
      ),
      manifest.database.sha256,
    );
    // 另一块卷占用同一挂载点时必须拒绝，绝不清理或覆盖未知内容。
    const other = join(base, "other.dmg");
    createImage(other, ["APFS"], "ANYNOTE_OTHER");
    detachImage(apfsMount);
    attachImage(other, apfsMount);
    await assert.rejects(
      guard(target),
      (e) => e.code === "TARGET_OFFLINE",
      "同一路径上的另一块卷必须被拒绝",
    );
    detachImage(apfsMount);
    attachImage(apfsImage, apfsMount);
    await guard(target);
    assert.ok(
      readFileSync(join(target.path, "backup-root.json"), "utf8").includes(
        target.id,
      ),
    );
  });

  // 5. 真实 FAT32 卷：必须报告 4GiB-1 单文件限制并按计划拒绝超限。
  await check("fat32-single-file-limit", async () => {
    const image = join(base, "fat32.dmg");
    const mountPoint = join(base, "fat32-mnt");
    createImage(image, ["MS-DOS FAT32", "MS-DOS"], "ANYNOTE_FAT32");
    attachImage(image, mountPoint);
    const info = await inspectFilesystem(mountPoint);
    volumes.fat32 = info;
    assert.equal(info.filesystem, "msdos");
    assert.equal(info.maximumFileBytes, 4 * 1024 ** 3 - 1);
    requireLocalFilesystem(info, 1024 ** 3);
    assert.throws(
      () => requireLocalFilesystem(info, 4 * 1024 ** 3),
      (e) => e.code === "UNSUPPORTED_FILESYSTEM",
    );
    const removable = plistBoolean(
      sh("diskutil", ["info", "-plist", mountPoint]),
      "RemovableMedia",
    );
    if (removable !== undefined) assert.equal(info.removable, removable);
    detachImage(mountPoint);
  });

  // 6. 真实 exFAT 卷：不应误报 FAT32 限制，且卷身份仍然稳定。
  await check("exfat-has-no-fat32-limit", async () => {
    const image = join(base, "exfat.dmg");
    const mountPoint = join(base, "exfat-mnt");
    try {
      createImage(image, ["ExFAT", "exFAT", "exfat"], "ANYNOTE_EXFAT");
    } catch (error) {
      // 部分主机/目录不允许创建 exFAT 镜像；如实跳过，不拿解析层结论冒充实盘结果。
      if (!/不被允许|not permitted/i.test(error.message)) throw error;
      return { skip: `本机无法创建 exFAT 镜像：${error.message}` };
    }
    attachImage(image, mountPoint);
    const info = await inspectFilesystem(mountPoint);
    volumes.exfat = info;
    assert.equal(info.filesystem, "exfat");
    assert.equal(info.maximumFileBytes, undefined);
    assert.equal(info.volumeIdentity, "volume-uuid");
    requireLocalFilesystem(info, 8 * 1024 ** 3);
    const removable = plistBoolean(
      sh("diskutil", ["info", "-plist", mountPoint]),
      "RemovableMedia",
    );
    if (removable !== undefined) assert.equal(info.removable, removable);
    detachImage(mountPoint);
  });

  return { book };
}

let result;
try {
  result = await main();
  mkdirSync(join(reportPath, ".."), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        passed: true,
        checks,
        skipped,
        platform: process.platform,
        arch: arch(),
        node: process.versions.node,
        macosVersion: sh("sw_vers", ["-productVersion"]).trim(),
        volumes,
        notebookId: result.book.id,
        completedAt: new Date().toISOString(),
        notExecuted: [
          "外接物理 exFAT/FAT32 盘的真实拔盘与 USB 重连（需要独立设备）",
          "真实断电后的发布/清理耐久性（需要独立测试设备）",
          "SMB/NFS/WebDAV 真实网络挂载的拒绝行为（无可用网络盘服务，仅保留解析层 fixture 覆盖）",
          "真实输入法与原生目录对话框的人工验收",
        ],
        boundary:
          "磁盘镜像是真实 APFS/exFAT/FAT32 卷，但不能替代外接物理盘、整机断电与独立设备验收；网络盘仅在解析层覆盖。",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `macOS volume acceptance passed (${checks.length} checks): ${reportPath}`,
  );
} catch (error) {
  mkdirSync(join(reportPath, ".."), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        passed: false,
        checks,
        skipped,
        error: error.message,
        platform: process.platform,
        arch: arch(),
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.error("macOS volume acceptance failed after:", checks);
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const mountPoint of [...mounted])
    try {
      detachImage(mountPoint);
    } catch {
      try {
        sh("hdiutil", ["detach", "-force", mountPoint]);
      } catch (e) {
        console.error("无法卸载镜像：", mountPoint, e.message);
      }
    }
  rmSync(base, { recursive: true, force: true });
}
