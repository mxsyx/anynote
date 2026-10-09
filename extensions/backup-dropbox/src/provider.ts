import { randomUUID } from "node:crypto";
import type {
  AccountContext,
  BackupHostContext,
  BackupPage,
  BackupTargetHandle,
  CapturedBackupInput,
  CleanupPlan,
  CleanupResult,
  CloudBackupCapabilities,
  CloudBackupHead,
  CloudBackupManifest,
  CloudBackupObjectRef,
  CloudBackupPlan,
  CloudBackupProvider,
  CloudBackupRootMarker,
  CommittedBackup,
  PreparedRemoteBackup,
  PublishInput,
  ReconcileInput,
  ReconcileResult,
  RestoreBundle,
  RestoreSelection,
  ScopedReadSource,
  TargetCapabilities,
  TargetInput,
} from "@anynote/types/cloud-backup.js";
import { cloudBackupLayout } from "@anynote/types/cloud-backup.js";
import {
  assertContentVerification,
  assetObjectPath,
  buildUploadPlan,
  databaseObjectPath,
  deviceDir as logicalDeviceDir,
  manifestObjectPath,
  parseHead,
  parseManifest,
  parseRootMarker,
  publishHead,
  safeRelativePath,
  type ManagedObject,
} from "@anynote/cloud-backup-common";
import {
  createDropboxClient,
  dropboxErrorCode,
  isDropboxConflict,
  type DropboxClient,
  type DropboxEntry,
} from "./dropbox.js";

/** Provider protocol version; must match the core `cloudBackupProtocolVersion`. */
export const dropboxProtocolVersion = 1;

const now = () => new Date().toISOString();

/**
 * Measured conclusion on `current` conditional-write capability (design §9.2, §11.3, TODO §5 P1).
 *
 * Dropbox offers rev-based `WriteMode.update`, and `publish` also reads the current rev then writes via
 * `update` and detects conflicts. But the design explicitly requires that "only measured endpoint behavior may declare
 * conditional write"; there is currently no measured rev-conflict evidence on a real account, so this is explicitly recorded as `false`
 * rather than a default value: it does not claim cross-client atomic exclusion and still relies on a single-writer device slot + pre/post-publish checks.
 *
 * Once real-account testing confirms "a rev mismatch rejects the write without producing a renamed copy", setting this to
 * true lets the core participate in publish with an expected version token (no change to `publish` logic needed).
 */
const conditionalHeadMeasured = false;

/** Dropbox has real path semantics, App Folder scope, and content chunked hashing (design §11). */
export const dropboxCapabilities: CloudBackupCapabilities = Object.freeze({
  resumableUpload: true,
  conditionalHead: conditionalHeadMeasured,
  // The content_hash returned after remote upload is computed by Dropbox with the same algorithm (design §11.2, §13.1).
  providerChecksum: ["dropbox-content-hash"],
  appScopedStorage: true,
  quotaAvailable: true,
});

/** Backup root directory (inside the App Folder, design §7.2). */
const rootDir = `/${cloudBackupLayout.root}`;

/** Notebook directory set. */
const notebooksDirPath = `${rootDir}/notebooks`;

/** Root identity marker path. */
const rootMarkerPath = `${rootDir}/${cloudBackupLayout.rootMarker}`;

/** Assemble the device-slot directory per the logical layout of design §7.2. */
const dropboxDevicePath = (notebookId: string, deviceSlotId: string): string =>
  `${rootDir}/${logicalDeviceDir(notebookId, deviceSlotId)}`;

/** State key for managed references; the core already isolates the namespace by provider + Notebook. */
const stateKeys = {
  root: "root.path",
  notebook: "notebook.path",
  device: "device.path",
  slot: "device.slot",
  slots: "slots",
  managed: "managed.objects",
} as const;

/** Read and validate the device slot's current pointer; returns null when absent. */
async function readHead(
  client: DropboxClient,
  devicePath: string,
): Promise<CloudBackupHead | null> {
  const entry = await client.getMetadata(
    `${devicePath}/${cloudBackupLayout.current}`,
  );
  if (!entry) return null;
  const bytes = await client.downloadBytes(entry.pathLower, 1024 * 1024);
  return parseHead(JSON.parse(Buffer.from(bytes).toString("utf8")));
}

/** Read and strictly validate the manifest. */
async function readManifest(
  client: DropboxClient,
  manifestRef: string,
): Promise<CloudBackupManifest> {
  const bytes = await client.downloadBytes(manifestRef, 8 * 1024 * 1024);
  return parseManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
}

/**
 * Read the current pointer and last successful manifest; used to compare the remote content_hash when reusing objects (design §8.1).
 *
 * A metadata/manifest read failure does not mean the user deleted all notes, so this returns
 * null only when it cannot be read; reuse decisions still rely on the content-addressed path and remote checksum.
 */
async function readPrevious(
  client: DropboxClient,
  devicePath: string,
): Promise<CloudBackupManifest | null> {
  const head = await readHead(client, devicePath).catch(() => null);
  if (!head) return null;
  return readManifest(client, head.manifestRef).catch(() => null);
}

/** Read the device-slot directory resolved for the current chunk. */
async function requireDevicePath(ctx: BackupHostContext): Promise<string> {
  const devicePath = await ctx.state.get<string>(stateKeys.device);
  if (!devicePath) throw Error("云盘目标目录尚未创建，请重新配置该目标");
  return devicePath;
}

/** Record a managed object for managed GC (design §14.3). */
async function trackManaged(
  ctx: BackupHostContext,
  ref: CloudBackupObjectRef,
  kind: ManagedObject["kind"],
): Promise<void> {
  const managed =
    (await ctx.state.get<ManagedObject[]>(stateKeys.managed)) ?? [];
  if (
    managed.some(
      (object) =>
        object.locator.kind === ref.locator.kind &&
        object.locator.ref === ref.locator.ref,
    )
  )
    return;
  managed.push({
    locator: { kind: ref.locator.kind, ref: ref.locator.ref },
    kind,
    sha256: ref.sha256,
    registeredAt: Date.now(),
  });
  await ctx.state.set(stateKeys.managed, managed);
}

/** Build an object reference from a remote entry; when content_hash exists it reaches vendor content-verification level. */
function objectFromEntry(
  sha256: string,
  size: number,
  entry: DropboxEntry,
  mimeType?: string,
): CloudBackupObjectRef {
  return {
    sha256,
    size: entry.size ?? size,
    locator: {
      kind: "dropbox.path",
      ref: entry.pathLower,
      versionToken: entry.rev,
    },
    providerChecksum: entry.contentHash,
    verification: entry.contentHash ? "provider-checksum" : "accepted-size",
    mimeType,
  };
}

/** Whether it is a write conflict (including a 409 status with no parseable error body). */
const isConflict = (error: unknown): boolean =>
  isDropboxConflict(dropboxErrorCode(error)) ||
  (error as { status?: number }).status === 409;

/**
 * Upload an immutable object (design §7.3).
 *
 * When the content-addressed path already exists, read the remote metadata to confirm rather than overwrite or rename; this also
 * ensures a backup task retry does not fail due to `add`'s no-overwrite semantics.
 */
async function uploadImmutable(
  client: DropboxClient,
  input: { path: string; source: ScopedReadSource; size: number },
): Promise<DropboxEntry> {
  try {
    return await client.upload({
      path: input.path,
      mode: { tag: "add" },
      source: input.source,
      size: input.size,
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
    const existing = await client.getMetadata(input.path);
    if (!existing) throw error;
    if (existing.size != null && existing.size !== input.size)
      throw Error("云端同名对象大小不一致，已停止复用");
    return existing;
  }
}

/**
 * Reuse an existing immutable object; on absence or content mismatch it fails explicitly, to be fixed by the next full backup.
 *
 * Reuse relies on the content-addressed path + remote `content_hash`: when the existing manifest records the Dropbox
 * checksum for the same sha256, compare first, avoiding treating a replaced remote object as the original copy.
 */
async function reuseObject(
  client: DropboxClient,
  input: { path: string; sha256: string; size: number; expected?: string },
): Promise<CloudBackupObjectRef> {
  const entry = await client.getMetadata(input.path);
  if (!entry)
    throw Error("计划判定可复用但云端对象不存在，请重新执行备份以修复");
  if (
    input.expected &&
    entry.contentHash &&
    input.expected !== entry.contentHash
  )
    throw Object.assign(
      Error("云端对象内容与既有副本不一致，已停止复用并等待完整备份修复"),
      { code: "verification-insufficient" },
    );
  return {
    sha256: input.sha256,
    size: entry.size ?? input.size,
    locator: {
      kind: "dropbox.path",
      ref: entry.pathLower,
      versionToken: entry.rev,
    },
    providerChecksum: entry.contentHash,
    verification: entry.contentHash ? "provider-checksum" : "accepted-size",
  };
}

/**
 * Verify a single object: accept an existing vendor checksum directly, otherwise download-then-verify (design §13.1).
 */
async function verifyObject(
  client: DropboxClient,
  ref: CloudBackupObjectRef,
  label: string,
): Promise<CloudBackupObjectRef> {
  if (
    ref.verification === "provider-checksum" ||
    ref.verification === "download-sha256"
  )
    return ref;
  const downloaded = await client.downloadToDest(
    ref.locator.ref,
    `verify/${ref.sha256}.bin`,
    { maxBytes: ref.size + 1024 * 1024 },
  );
  if (downloaded.sha256 !== ref.sha256)
    throw Object.assign(
      Error(`${label} 上传后校验失败：远端内容与本地哈希不一致`),
      { code: "verification-insufficient" },
    );
  return { ...ref, verification: "download-sha256" };
}

/**
 * Dropbox official Provider (design §11).
 *
 * Uses the App Folder and the PKCE + refresh token background access mode, organizing objects under the app root as
 * `AnynoteBackup/notebooks/<id>/devices/<slot>`:
 * immutable objects are named by content hash and uploaded first; the full manifest is uploaded and read back, then the `current` pointer is published.
 * Large objects use an upload session and recover from interruption by "rebuilding the session from the same source"; `current`'s rev
 * conflict handling uses a conditional write on the expected rev, enabled or not based on measured conclusions.
 */
export const dropboxProvider: CloudBackupProvider = {
  id: "dropbox",
  protocolVersion: dropboxProtocolVersion,
  capabilities: dropboxCapabilities,
  accountDescriptor: {
    providerId: "dropbox",
    authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
    tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
    revocationEndpoint: "https://api.dropboxapi.com/2/auth/token/revoke",
    scopes: [
      "account_info.read",
      "files.metadata.read",
      "files.content.read",
      "files.content.write",
    ],
    pkce: true,
    redirect: "loopback",
    // Dropbox refresh does not return a new refresh token; the core keeps the original on refresh (design §6.2).
    refreshTokenRotation: false,
    accountIdClaim: "response:account_id",
  },

  async probe({ ctx }: AccountContext): Promise<TargetCapabilities> {
    const about = await createDropboxClient(ctx).about();
    return {
      ...dropboxCapabilities,
      quotaBytes: about.quotaBytes ?? null,
      quotaUsedBytes: about.quotaUsedBytes ?? null,
      accountType: about.accountType ?? about.account,
    };
  },

  async ensureTarget(
    input: TargetInput,
    ctx: BackupHostContext,
  ): Promise<BackupTargetHandle> {
    const client = createDropboxClient(ctx);
    await client.ensureFolder(rootDir);
    // The directory identity marker must be in the format written by this app, avoiding writes into a foreign directory.
    const marker = await client.getMetadata(rootMarkerPath);
    if (marker) {
      const bytes = await client.downloadBytes(marker.pathLower, 64 * 1024);
      parseRootMarker(JSON.parse(Buffer.from(bytes).toString("utf8")));
    } else
      await client.uploadJson({
        path: rootMarkerPath,
        mode: { tag: "add" },
        bytes: Buffer.from(JSON.stringify(rootMarker())),
      });

    const notebookPath = `${notebooksDirPath}/${input.notebookId}`,
      devicePath = dropboxDevicePath(input.notebookId, input.deviceSlotId);
    await client.ensureFolder(devicePath);
    await ctx.state.set(stateKeys.root, rootDir);
    await ctx.state.set(stateKeys.notebook, notebookPath);
    await ctx.state.set(stateKeys.device, devicePath);
    await ctx.state.set(stateKeys.slot, input.deviceSlotId);
    const slots =
      (await ctx.state.get<Record<string, string>>(stateKeys.slots)) ?? {};
    slots[input.deviceSlotId] = devicePath;
    await ctx.state.set(stateKeys.slots, slots);

    const about = await client.about();
    return {
      rootRef: rootDir,
      notebookRef: notebookPath,
      deviceSlotRef: devicePath,
      capabilities: {
        ...dropboxCapabilities,
        quotaBytes: about.quotaBytes ?? null,
        quotaUsedBytes: about.quotaUsedBytes ?? null,
      },
    };
  },

  async plan(
    input: CapturedBackupInput,
    ctx: BackupHostContext,
  ): Promise<CloudBackupPlan> {
    const client = createDropboxClient(ctx),
      devicePath = input.target.deviceSlotRef;
    if (!devicePath) throw Error("云盘目标缺少设备槽引用，请重新配置");
    const head = await readHead(client, devicePath),
      previous =
        input.previousHead && head?.commitId === input.previousHead.commitId
          ? await readManifest(client, input.previousHead.manifestRef)
          : null,
      about = await client.about();
    return buildUploadPlan({
      commitId: randomUUID(),
      databaseSha256: input.capture.database.sha256,
      databaseSize: input.capture.database.size,
      assets: input.capture.assets.map((asset) => ({
        path: asset.path,
        sha256: asset.sha256,
        size: asset.size,
      })),
      previous,
      // When a remote object is moved/deleted, re-check and repair, not relying solely on a stale local cursor (design §8.1).
      exists: async (locator) => !!(await client.getMetadata(locator.ref)),
      availableBytes:
        about.quotaBytes != null
          ? Math.max(0, about.quotaBytes - (about.quotaUsedBytes ?? 0))
          : null,
    });
  },

  async execute(
    plan: CloudBackupPlan,
    ctx: BackupHostContext,
  ): Promise<PreparedRemoteBackup> {
    const capture = plan.capture;
    if (!capture) throw Error("缺少捕获结果，无法上传");
    const client = createDropboxClient(ctx),
      devicePath = await requireDevicePath(ctx),
      deviceSlotId = await ctx.state.get<string>(stateKeys.slot),
      previous = await readPrevious(client, devicePath);
    if (!deviceSlotId) throw Error("云盘目标缺少设备槽身份，请重新配置该目标");
    let transferredBytes = 0;

    const databaseItem = plan.items.find((item) => item.kind === "database"),
      databasePath = `${devicePath}/${databaseObjectPath(capture.database.sha256)}`,
      database = databaseItem
        ? objectFromEntry(
            capture.database.sha256,
            capture.database.size,
            await uploadImmutable(client, {
              path: databasePath,
              source: capture.database,
              size: capture.database.size,
            }),
            "application/vnd.sqlite3",
          )
        : await reuseObject(client, {
            path: databasePath,
            sha256: capture.database.sha256,
            size: capture.database.size,
            expected: previous?.database.providerChecksum,
          });
    if (databaseItem) transferredBytes += capture.database.size;
    await trackManaged(ctx, database, "database");

    const assets: (CloudBackupObjectRef & { path: string })[] = [];
    for (const asset of capture.assets) {
      const item = plan.items.find(
          (candidate) =>
            candidate.kind === "asset" && candidate.sha256 === asset.sha256,
        ),
        assetPath = `${devicePath}/${assetObjectPath(asset.sha256)}`,
        ref = item
          ? objectFromEntry(
              asset.sha256,
              asset.size,
              await uploadImmutable(client, {
                path: assetPath,
                source: asset,
                size: asset.size,
              }),
              asset.mimeType,
            )
          : await reuseObject(client, {
              path: assetPath,
              sha256: asset.sha256,
              size: asset.size,
              expected: previous?.assets.find(
                (entry) => entry.sha256 === asset.sha256,
              )?.providerChecksum,
            });
      if (item) transferredBytes += asset.size;
      await trackManaged(ctx, ref, "asset");
      assets.push({ ...ref, path: asset.path });
    }

    const manifestDraft: CloudBackupManifest = {
      format: "anynote.cloud-backup-manifest",
      formatVersion: 1,
      notebookId: capture.notebookId,
      notebookName: capture.notebookName,
      deviceSlotId,
      deviceLabel: ctx.deviceLabel,
      commitId: plan.commitId,
      createdAt: now(),
      schemaVersion: capture.schemaVersion,
      contentSeq: capture.contentSeq,
      database: {
        ...database,
        schemaVersion: capture.schemaVersion,
        contentSeq: capture.contentSeq,
      },
      assets,
    };
    return {
      commitId: plan.commitId,
      database,
      assets,
      transferredBytes,
      complete: true,
      manifestDraft,
    };
  },

  async verify(
    input: PreparedRemoteBackup,
    ctx: BackupHostContext,
  ): Promise<CloudBackupManifest> {
    const client = createDropboxClient(ctx),
      devicePath = await requireDevicePath(ctx),
      // The database must reach a content-verification level (design §13.1).
      database = await verifyObject(client, input.database, "数据库");
    assertContentVerification(database, "数据库");
    // Assets likewise need content verification by default; Dropbox usually satisfies it via content_hash, so no re-download.
    const verifyAssets =
      (await ctx.state.get<boolean>("verify.downloadAssets")) ?? true;
    const assets: (CloudBackupObjectRef & { path: string })[] = [];
    for (const asset of input.assets)
      assets.push({
        ...(verifyAssets
          ? await verifyObject(client, asset, `附件 ${asset.path}`)
          : asset),
        path: asset.path,
      });

    const manifest: CloudBackupManifest = {
        ...input.manifestDraft,
        database: {
          ...database,
          schemaVersion: input.manifestDraft.database.schemaVersion,
          contentSeq: input.manifestDraft.database.contentSeq,
        },
        assets,
      },
      bytes = Buffer.from(JSON.stringify(manifest)),
      // The manifest is named by commitId and unique per run; overwrite makes a retry of the same task idempotent,
      // not failing due to add's no-overwrite semantics (design §7.3).
      file = await client.uploadJson({
        path: `${devicePath}/${manifestObjectPath(input.commitId)}`,
        mode: { tag: "overwrite" },
        bytes,
      }),
      // Read back after upload, ensuring the manifest content exactly matches the local one (design §8.2 step 7).
      readBack = await client.downloadBytes(file.pathLower, 8 * 1024 * 1024);
    if (Buffer.compare(Buffer.from(readBack), bytes) !== 0)
      throw Error("Dropbox 清单读回校验失败");
    input.manifest = manifest;
    input.manifestRef = client.locate(file);
    input.manifestSha256 = ctx.verifier.sha256(readBack);
    await trackManaged(
      ctx,
      { ...database, locator: input.manifestRef },
      "manifest",
    );
    return manifest;
  },

  async publish(
    input: PublishInput,
    ctx: BackupHostContext,
  ): Promise<CommittedBackup> {
    if (!input.prepared.manifestRef || !input.prepared.manifestSha256)
      throw Error("清单尚未上传，拒绝发布当前指针");
    const client = createDropboxClient(ctx),
      devicePath = await requireDevicePath(ctx),
      currentPath = `${devicePath}/${cloudBackupLayout.current}`,
      head: CloudBackupHead = {
        format: "anynote.cloud-backup-head",
        formatVersion: 1,
        notebookId: input.prepared.manifestDraft.notebookId,
        deviceSlotId: input.prepared.manifestDraft.deviceSlotId,
        commitId: input.prepared.commitId,
        manifestRef: input.prepared.manifestRef.ref,
        manifestSha256: input.prepared.manifestSha256,
        completedAt: now(),
      };
    return publishHead({
      head,
      // conditionalHead has not been verified: degrade to a single-writer device slot + pre/post-publish checks (design §9.2).
      conditional: false,
      write: async (nextHead, expected) => {
        const existing = await client.getMetadata(currentPath),
          // First creation uses no-overwrite semantics; an existing object is conditionally updated on the just-read rev (or the expected
          // rev from the core); a rev mismatch is a conflict, never auto-renaming to create a copy (design §11.3).
          mode = existing
            ? ({ tag: "update", rev: expected ?? existing.rev } as const)
            : ({ tag: "add" } as const);
        try {
          const entry = await client.uploadJson({
            path: currentPath,
            mode,
            bytes: Buffer.from(JSON.stringify(nextHead)),
          });
          return { versionToken: entry.rev };
        } catch (error) {
          // Rev mismatch or concurrent creation: reject the publish and keep the original head.
          if (isConflict(error)) return { conflict: true };
          throw error;
        }
      },
      read: () => readHead(client, devicePath),
      verification: "download-sha256",
    });
  },

  async reconcile(
    input: ReconcileInput,
    ctx: BackupHostContext,
  ): Promise<ReconcileResult> {
    const devicePath = await ctx.state.get<string>(stateKeys.device);
    if (!devicePath) return { head: null };
    const client = createDropboxClient(ctx),
      head = await readHead(client, devicePath);
    return {
      committedCommitId:
        head?.commitId === input.expectedCommitId ? head.commitId : undefined,
      head,
      verification: "download-sha256",
    };
  },

  async listCurrentBackups(ctx: BackupHostContext): Promise<BackupPage> {
    const notebookId = ctx.notebookId;
    if (!notebookId) return { slots: [] };
    const client = createDropboxClient(ctx),
      devices = await client.listFolder(
        `${notebooksDirPath}/${notebookId}/devices`,
      ),
      slots: BackupPage["slots"] = [];
    for (const device of devices) {
      if (!device.isFolder) continue;
      const head = await readHead(client, device.pathLower).catch(() => null);
      if (!head) continue;
      const manifest = await readManifest(client, head.manifestRef).catch(
        () => null,
      );
      slots.push({
        deviceSlotId: device.name,
        deviceLabel: manifest?.deviceLabel,
        commitId: head.commitId,
        completedAt: head.completedAt,
        databaseBytes: manifest?.database.size,
        assetCount: manifest?.assets.length,
        verification: "download-sha256",
      });
    }
    return { slots };
  },

  async download(
    input: RestoreSelection,
    ctx: BackupHostContext,
  ): Promise<RestoreBundle> {
    const notebookId = ctx.notebookId;
    if (!notebookId)
      throw Error("恢复需要已授权的 Notebook 上下文，请重新选择目标");
    const client = createDropboxClient(ctx),
      // The path layout is determined by Notebook and device slot, so a second device can locate it without the original device's cursor (design §9.1).
      devicePath = dropboxDevicePath(notebookId, input.deviceSlotId),
      head = await readHead(client, devicePath),
      manifestRef = input.manifestRef ?? head?.manifestRef;
    if (!manifestRef) throw Error("该设备槽没有可恢复的当前副本");
    const manifest = await readManifest(client, manifestRef),
      database = await client.downloadToDest(
        manifest.database.locator.ref,
        "notebook.sqlite",
      ),
      assets: RestoreBundle["assets"] = [];
    for (const asset of manifest.assets) {
      // The manifest is untrusted input: relative paths are written to disk only after core validation (design §16).
      if (safeRelativePath(asset.path) !== asset.path)
        throw Error(`云端清单包含不安全的资源路径：${asset.path}`);
      const downloaded = await client.downloadToDest(
        asset.locator.ref,
        asset.path,
      );
      assets.push({
        path: asset.path,
        sha256: asset.sha256,
        size: downloaded.bytes,
        filePath: downloaded.filePath,
      });
      ctx.tasks.progress(downloaded.bytes);
    }
    return {
      manifest,
      databasePath: database.filePath,
      databaseSha256: database.sha256 ?? "",
      assets,
      verification: "download-sha256",
    };
  },

  async cleanup(
    input: CleanupPlan,
    ctx: BackupHostContext,
  ): Promise<CleanupResult> {
    const client = createDropboxClient(ctx);
    let deleted = 0,
      failed = 0;
    for (const locator of input.objects) {
      try {
        await client.remove(locator.ref);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    return { deleted, failed };
  },

  async deleteSlot(
    input: { deviceSlotId: string },
    ctx: BackupHostContext,
  ): Promise<CleanupResult> {
    const notebookId = ctx.notebookId;
    if (!notebookId) throw Error("删除云端备份需要已授权的 Notebook 上下文");
    const client = createDropboxClient(ctx),
      devicePath = dropboxDevicePath(notebookId, input.deviceSlotId),
      entries = await client.listFolder(devicePath, { recursive: true });
    let deleted = 0,
      failed = 0;
    try {
      // Deleting a Dropbox directory recursively deletes the managed objects within; the count is only for the receipt.
      await client.remove(devicePath);
      deleted = entries.filter((entry) => !entry.isFolder).length;
    } catch {
      failed += 1;
    }
    const slots =
      (await ctx.state.get<Record<string, string>>(stateKeys.slots)) ?? {};
    delete slots[input.deviceSlotId];
    await ctx.state.set(stateKeys.slots, slots);
    return { deleted, failed };
  },
};

/** Backup root identity marker content. */
function rootMarker(): CloudBackupRootMarker {
  return {
    format: "anynote.cloud-backup-root",
    formatVersion: 1,
    app: "anynote",
    createdAt: now(),
  };
}
