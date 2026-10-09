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
  TargetCapabilities,
  TargetInput,
} from "@anynote/types/cloud-backup.js";
import {
  assertContentVerification,
  buildUploadPlan,
  parseHead,
  parseManifest,
  parseRootMarker,
  publishHead,
  safeRelativePath,
  type ManagedObject,
} from "@anynote/cloud-backup-common";
import {
  createDriveClient,
  folderMime,
  propsFor,
  type DriveClient,
} from "./drive.js";

/** Provider protocol version; must match the core `cloudBackupProtocolVersion`. */
export const googleDriveProtocolVersion = 1;

const now = () => new Date().toISOString();

/** Drive has no multi-file transaction and no dependable conditional write (design §9.2). */
export const googleDriveCapabilities: CloudBackupCapabilities = Object.freeze({
  resumableUpload: true,
  conditionalHead: false,
  // Drive only provides MD5, a different algorithm from the application SHA-256, so provider-checksum cannot be declared.
  providerChecksum: [],
  appScopedStorage: false,
  quotaAvailable: true,
});

/** Logical role marker on the Drive side, to identify objects on an API with no path semantics. */
const roles = {
  root: "root",
  rootMarker: "root-marker",
  notebook: "notebook",
  device: "device",
  assets: "assets",
  database: "database",
  asset: "asset",
  manifest: "manifest",
  current: "current",
} as const;

/** Root directory display name (design §10.1). */
const rootFolderName = "AnynoteBackup";

/** State key for managed directory references. */
const stateKeys = {
  root: "root.ref",
  notebook: "notebook.ref",
  device: "device.ref",
  assets: "assets.ref",
  slot: "device.slot",
  slots: "slots",
  managed: "managed.objects",
} as const;

/** Read and validate the device slot's current pointer; returns null when absent. */
async function readHead(
  client: DriveClient,
  deviceFolderId: string,
): Promise<CloudBackupHead | null> {
  const [file] = await client.listChildren(deviceFolderId, {
    role: roles.current,
    name: "current.json",
  });
  if (!file) return null;
  const bytes = await client.downloadBytes(file.id, 1024 * 1024);
  return parseHead(JSON.parse(Buffer.from(bytes).toString("utf8")));
}

/** Read and strictly validate the manifest. */
async function readManifest(
  client: DriveClient,
  manifestFileId: string,
): Promise<CloudBackupManifest> {
  const bytes = await client.downloadBytes(manifestFileId, 8 * 1024 * 1024);
  return parseManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
}

interface ResolvedFolders {
  rootId: string;
  notebookFolderId: string;
  deviceFolderId: string;
  assetsFolderId: string;
  deviceSlotId: string;
}

/**
 * Resolve and lock the managed directory hierarchy (design §7.2, §10.2).
 *
 * Directory identity is based on file ID + controlled `appProperties`, with the display name only for readability; when multiple
 * candidates appear, check the index and stop writing, not taking the first by name.
 *
 * @param client Drive client.
 * @param ctx Runtime context.
 * @param input Notebook and device-slot identity.
 * @returns The resolved directory reference.
 */
async function resolveFolders(
  client: DriveClient,
  ctx: BackupHostContext,
  input: { notebookId: string; deviceSlotId: string },
): Promise<ResolvedFolders> {
  let rootId = (await ctx.state.get<string>(stateKeys.root)) ?? undefined;
  if (rootId) {
    const existing = await client.get(rootId).catch(() => undefined);
    if (!existing || existing.trashed) rootId = undefined;
  }
  if (!rootId) {
    rootId = (
      await client.findOrCreateFolder("root", roles.root, rootFolderName)
    ).id;
    await ctx.state.set(stateKeys.root, rootId);
  }
  const markers = await client.listChildren(rootId, {
    role: roles.rootMarker,
    name: "root.json",
  });
  if (markers.length === 0)
    await client.uploadJson({
      parentId: rootId,
      name: "root.json",
      appProperties: propsFor(roles.rootMarker, rootId),
      bytes: Buffer.from(JSON.stringify(rootMarker())),
    });
  else if (markers.length === 1) {
    // The directory identity marker must be in the format written by this app, avoiding writes into a foreign directory.
    const bytes = await client.downloadBytes(markers[0].id, 64 * 1024);
    parseRootMarker(JSON.parse(Buffer.from(bytes).toString("utf8")));
  }

  const notebookFolder = await client.findOrCreateFolder(
      rootId,
      roles.notebook,
      input.notebookId,
      input.notebookId,
    ),
    deviceFolder = await client.findOrCreateFolder(
      notebookFolder.id,
      roles.device,
      input.deviceSlotId,
      input.deviceSlotId,
    ),
    assetsFolder = await client.findOrCreateFolder(
      deviceFolder.id,
      roles.assets,
      "assets",
    );
  await ctx.state.set(stateKeys.notebook, notebookFolder.id);
  await ctx.state.set(stateKeys.device, deviceFolder.id);
  await ctx.state.set(stateKeys.assets, assetsFolder.id);
  await ctx.state.set(stateKeys.slot, input.deviceSlotId);
  const slots =
    (await ctx.state.get<Record<string, string>>(stateKeys.slots)) ?? {};
  slots[input.deviceSlotId] = deviceFolder.id;
  await ctx.state.set(stateKeys.slots, slots);
  return {
    rootId,
    notebookFolderId: notebookFolder.id,
    deviceFolderId: deviceFolder.id,
    assetsFolderId: assetsFolder.id,
    deviceSlotId: input.deviceSlotId,
  };
}

/** Read the managed directory resolved for the current task. */
async function requireFolders(
  ctx: BackupHostContext,
): Promise<ResolvedFolders> {
  const [
    rootId,
    notebookFolderId,
    deviceFolderId,
    assetsFolderId,
    deviceSlotId,
  ] = await Promise.all([
    ctx.state.get<string>(stateKeys.root),
    ctx.state.get<string>(stateKeys.notebook),
    ctx.state.get<string>(stateKeys.device),
    ctx.state.get<string>(stateKeys.assets),
    ctx.state.get<string>(stateKeys.slot),
  ]);
  if (
    !rootId ||
    !notebookFolderId ||
    !deviceFolderId ||
    !assetsFolderId ||
    !deviceSlotId
  )
    throw Error("云盘目标目录尚未创建，请重新配置该目标");
  return {
    rootId,
    notebookFolderId,
    deviceFolderId,
    assetsFolderId,
    deviceSlotId,
  };
}

/** Record a managed object for managed GC (design §14.3). */
async function trackManaged(
  ctx: BackupHostContext,
  ref: CloudBackupObjectRef,
  kind: ManagedObject["kind"],
) {
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

/** Build the object reference; the verification level is filled in during `verify`. */
function objectRef(
  sha256: string,
  size: number,
  locator: CloudBackupObjectRef["locator"],
  mimeType?: string,
): CloudBackupObjectRef {
  return { sha256, size, locator, mimeType, verification: "accepted-size" };
}

/** Reuse an existing remote object; on absence it fails explicitly, to be fixed by the next full backup. */
async function reuseObject(
  client: DriveClient,
  parentId: string,
  role: string,
  sha256: string,
): Promise<CloudBackupObjectRef> {
  const [file] = await client.listChildren(parentId, { role, owner: sha256 });
  if (!file)
    throw Error("计划判定可复用但云端对象不存在，请重新执行备份以修复");
  return {
    sha256,
    size: file.size ?? 0,
    locator: client.locate(file),
    verification: "download-sha256",
  };
}

/**
 * Verify a single object: prefer the vendor checksum, otherwise upload-then-download verification (design §13.1).
 *
 * @param ref Object reference.
 * @param ctx Runtime context.
 * @param label Error label.
 * @returns The object reference with a verification level.
 */
async function verifyObject(
  ref: CloudBackupObjectRef,
  ctx: BackupHostContext,
  label: string,
): Promise<CloudBackupObjectRef> {
  if (ref.verification === "download-sha256") return ref;
  const downloaded = await ctx.accounts.downloadToFile(
    `https://www.googleapis.com/drive/v3/files/${ref.locator.ref}?alt=media`,
    {},
    { hash: true, maxBytes: ref.size + 1024 * 1024 },
  );
  if (downloaded.sha256 !== ref.sha256)
    throw Object.assign(
      Error(`${label} 上传后校验失败：远端内容与本地哈希不一致`),
      { code: "verification-insufficient" },
    );
  return { ...ref, verification: "download-sha256" };
}

/**
 * Google Drive official Provider (design §10).
 *
 * Uses the `drive.file` scope and an identifiable app directory under My Drive, with file ID and controlled
 * `appProperties` as identity and search index, not treating the display path as identity; large files use
 * resumable upload, advancing by the server-confirmed offset.
 */
export const googleDriveProvider: CloudBackupProvider = {
  id: "google-drive",
  protocolVersion: googleDriveProtocolVersion,
  capabilities: googleDriveCapabilities,
  accountDescriptor: {
    providerId: "google-drive",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.file"],
    pkce: true,
    redirect: "loopback",
    refreshTokenRotation: false,
    accountIdClaim: "id_token:sub",
  },

  async probe({ ctx }: AccountContext): Promise<TargetCapabilities> {
    const about = await (await createDriveClient(ctx)).about();
    return {
      ...googleDriveCapabilities,
      quotaBytes: about.quotaBytes ?? null,
      quotaUsedBytes: about.quotaUsedBytes ?? null,
      accountType: about.account,
    };
  },

  async ensureTarget(
    input: TargetInput,
    ctx: BackupHostContext,
  ): Promise<BackupTargetHandle> {
    const client = await createDriveClient(ctx),
      folders = await resolveFolders(client, ctx, {
        notebookId: input.notebookId,
        deviceSlotId: input.deviceSlotId,
      }),
      about = await client.about();
    return {
      rootRef: folders.rootId,
      notebookRef: folders.notebookFolderId,
      deviceSlotRef: folders.deviceFolderId,
      capabilities: {
        ...googleDriveCapabilities,
        quotaBytes: about.quotaBytes ?? null,
        quotaUsedBytes: about.quotaUsedBytes ?? null,
      },
    };
  },

  async plan(
    input: CapturedBackupInput,
    ctx: BackupHostContext,
  ): Promise<CloudBackupPlan> {
    const client = await createDriveClient(ctx),
      deviceFolderId = input.target.deviceSlotRef;
    if (!deviceFolderId) throw Error("云盘目标缺少设备槽引用，请重新配置");
    const head = await readHead(client, deviceFolderId),
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
      // When a remote object is deleted/trashed, re-check and repair, not relying solely on a stale local cursor (design §8.1).
      exists: async (locator) => {
        const file = await client.get(locator.ref).catch(() => undefined);
        return !!file && !file.trashed;
      },
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
    const client = await createDriveClient(ctx),
      folders = await requireFolders(ctx);
    let transferredBytes = 0;

    const databaseItem = plan.items.find((item) => item.kind === "database"),
      database = databaseItem
        ? objectRef(
            capture.database.sha256,
            capture.database.size,
            client.locate(
              await client.uploadObject({
                parentId: folders.deviceFolderId,
                name: `${capture.database.sha256}.sqlite`,
                appProperties: propsFor(
                  roles.database,
                  capture.database.sha256,
                ),
                source: capture.database,
                size: capture.database.size,
                mimeType: "application/vnd.sqlite3",
              }),
            ),
            "application/vnd.sqlite3",
          )
        : await reuseObject(
            client,
            folders.deviceFolderId,
            roles.database,
            capture.database.sha256,
          );
    if (databaseItem) transferredBytes += capture.database.size;
    await trackManaged(ctx, database, "database");

    const assets: (CloudBackupObjectRef & { path: string })[] = [];
    for (const asset of capture.assets) {
      const item = plan.items.find(
        (candidate) =>
          candidate.kind === "asset" && candidate.sha256 === asset.sha256,
      );
      const ref = item
        ? objectRef(
            asset.sha256,
            asset.size,
            client.locate(
              await client.uploadObject({
                parentId: folders.assetsFolderId,
                name: `${asset.sha256}.bin`,
                appProperties: propsFor(roles.asset, asset.sha256),
                source: asset,
                size: asset.size,
                mimeType: asset.mimeType ?? "application/octet-stream",
              }),
            ),
            asset.mimeType,
          )
        : await reuseObject(
            client,
            folders.assetsFolderId,
            roles.asset,
            asset.sha256,
          );
      if (item) transferredBytes += asset.size;
      await trackManaged(ctx, ref, "asset");
      assets.push({ ...ref, path: asset.path });
    }

    const manifestDraft: CloudBackupManifest = {
      format: "anynote.cloud-backup-manifest",
      formatVersion: 1,
      notebookId: capture.notebookId,
      notebookName: capture.notebookName,
      deviceSlotId: folders.deviceSlotId,
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
    const client = await createDriveClient(ctx),
      folders = await requireFolders(ctx),
      // The database must reach a content-verification level (design §13.1).
      database = await verifyObject(input.database, ctx, "数据库");
    assertContentVerification(database, "数据库");
    // Assets likewise download-verify by default; advanced settings can disable it, but the result must not be mixed into "all verified".
    const verifyAssets =
      (await ctx.state.get<boolean>("verify.downloadAssets")) ?? true;
    const assets: (CloudBackupObjectRef & { path: string })[] = [];
    for (const asset of input.assets)
      assets.push({
        ...(verifyAssets
          ? await verifyObject(asset, ctx, `附件 ${asset.path}`)
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
      file = await client.uploadJson({
        parentId: folders.deviceFolderId,
        name: `${input.commitId}.json`,
        appProperties: propsFor(roles.manifest, input.commitId),
        bytes,
      }),
      // Read back after upload, ensuring the manifest content exactly matches the local one (design §8.2 step 7).
      readBack = await client.downloadBytes(file.id, 8 * 1024 * 1024);
    if (Buffer.compare(Buffer.from(readBack), bytes) !== 0)
      throw Error("Google Drive 清单读回校验失败");
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
    const client = await createDriveClient(ctx),
      folders = await requireFolders(ctx),
      head: CloudBackupHead = {
        format: "anynote.cloud-backup-head",
        formatVersion: 1,
        notebookId: input.prepared.manifestDraft.notebookId,
        deviceSlotId: folders.deviceSlotId,
        commitId: input.prepared.commitId,
        manifestRef: input.prepared.manifestRef.ref,
        manifestSha256: input.prepared.manifestSha256,
        completedAt: now(),
      },
      bytes = Buffer.from(JSON.stringify(head));
    return publishHead({
      head,
      // Drive has no verified conditional-write capability: degrade to a single-writer device slot + pre/post-publish checks (design §9.2).
      conditional: false,
      write: async () => {
        const [existing] = await client.listChildren(folders.deviceFolderId, {
          role: roles.current,
          name: "current.json",
        });
        await client.uploadJson({
          parentId: folders.deviceFolderId,
          name: "current.json",
          appProperties: propsFor(roles.current, folders.deviceSlotId),
          bytes,
          fileId: existing?.id,
        });
        return {};
      },
      read: () => readHead(client, folders.deviceFolderId),
      verification: "download-sha256",
    });
  },

  async reconcile(
    input: ReconcileInput,
    ctx: BackupHostContext,
  ): Promise<ReconcileResult> {
    const deviceFolderId = await ctx.state.get<string>(stateKeys.device);
    if (!deviceFolderId) return { head: null };
    const client = await createDriveClient(ctx),
      head = await readHead(client, deviceFolderId);
    return {
      committedCommitId:
        head?.commitId === input.expectedCommitId ? head.commitId : undefined,
      head,
      verification: "download-sha256",
    };
  },

  async listCurrentBackups(ctx: BackupHostContext): Promise<BackupPage> {
    const notebookFolderId = await ctx.state.get<string>(stateKeys.notebook);
    if (!notebookFolderId) return { slots: [] };
    const client = await createDriveClient(ctx),
      devices = await client.listChildren(notebookFolderId, {
        role: roles.device,
      }),
      slots: BackupPage["slots"] = [];
    for (const device of devices) {
      const head = await readHead(client, device.id).catch(() => null);
      if (!head) continue;
      const manifest = await readManifest(client, head.manifestRef).catch(
        () => null,
      );
      slots.push({
        deviceSlotId: device.appProperties?.["anynote.owner"] ?? device.id,
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
    const slots =
        (await ctx.state.get<Record<string, string>>(stateKeys.slots)) ?? {},
      deviceFolderId = slots[input.deviceSlotId];
    if (!deviceFolderId) throw Error("未找到该设备的云盘备份槽");
    const client = await createDriveClient(ctx),
      head = await readHead(client, deviceFolderId),
      manifestFileId = input.manifestRef ?? head?.manifestRef;
    if (!manifestFileId) throw Error("该设备槽没有可恢复的当前副本");
    const manifest = await readManifest(client, manifestFileId),
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
    const client = await createDriveClient(ctx);
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
    const slots =
        (await ctx.state.get<Record<string, string>>(stateKeys.slots)) ?? {},
      deviceFolderId = slots[input.deviceSlotId];
    if (!deviceFolderId) return { deleted: 0, failed: 0 };
    const client = await createDriveClient(ctx);
    let deleted = 0,
      failed = 0;
    const queue = [deviceFolderId];
    while (queue.length) {
      const folderId = queue.shift()!,
        children = await client.listChildren(folderId).catch(() => []);
      for (const child of children) {
        if (child.mimeType === folderMime) {
          queue.push(child.id);
          continue;
        }
        try {
          await client.remove(child.id);
          deleted += 1;
        } catch {
          failed += 1;
        }
      }
    }
    try {
      await client.remove(deviceFolderId);
    } catch {
      failed += 1;
    }
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
