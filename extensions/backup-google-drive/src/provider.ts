import { mapDatabaseChunks, mapAssets } from "@anynote/cloud-backup-common";
import { createHash, randomUUID } from "node:crypto";
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
import {
  assertContentVerification,
  manifestVerification,
  buildUploadPlan,
  parseHead,
  parseManifest,
  parseRootMarker,
  publishHead,
  type ManagedObject,
} from "@anynote/cloud-backup-common";
import {
  createDriveClient,
  folderMime,
  propsFor,
  type DriveClient,
} from "./drive.js";

/** Provider protocol version; must match the core `cloudBackupProtocolVersion`. */
export const googleDriveProtocolVersion = 2;

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
  expectedHash?: string,
): Promise<CloudBackupManifest> {
  const bytes = await client.downloadBytes(manifestFileId, 8 * 1024 * 1024);
  if (
    expectedHash &&
    createHash("sha256").update(bytes).digest("hex") !== expectedHash
  )
    throw Error("云盘清单 SHA-256 校验失败");
  return parseManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
}

interface ResolvedFolders {
  rootId: string;
  notebookFolderId: string;
  deviceFolderId: string;
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
    );
  await ctx.state.set(stateKeys.notebook, notebookFolder.id);
  await ctx.state.set(stateKeys.device, deviceFolder.id);
  await ctx.state.set(stateKeys.slot, input.deviceSlotId);
  const slots =
    (await ctx.state.get<Record<string, string>>(stateKeys.slots)) ?? {};
  slots[input.deviceSlotId] = deviceFolder.id;
  await ctx.state.set(stateKeys.slots, slots);
  return {
    rootId,
    notebookFolderId: notebookFolder.id,
    deviceFolderId: deviceFolder.id,
    deviceSlotId: input.deviceSlotId,
  };
}

/** Read the managed directory resolved for the current task. */
async function requireFolders(
  ctx: BackupHostContext,
): Promise<ResolvedFolders> {
  const [rootId, notebookFolderId, deviceFolderId, deviceSlotId] =
    await Promise.all([
      ctx.state.get<string>(stateKeys.root),
      ctx.state.get<string>(stateKeys.notebook),
      ctx.state.get<string>(stateKeys.device),
      ctx.state.get<string>(stateKeys.slot),
    ]);
  if (!rootId || !notebookFolderId || !deviceFolderId || !deviceSlotId)
    throw Error("云盘目标目录尚未创建，请重新配置该目标");
  return {
    rootId,
    notebookFolderId,
    deviceFolderId,
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
      assets: input.capture.assets,
      databaseChunks: input.capture.database.chunks,
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

    const uploads = new Set(
      plan.items.map((item) => `${item.kind}:${item.sha256}`),
    );
    const transfer = async (
      chunk: ScopedReadSource & { sha256: string; mimeType?: string },
      kind: "database" | "asset",
    ) => {
      const databaseItem = uploads.has(`${kind}:${chunk.sha256}`),
        database = databaseItem
          ? objectRef(
              chunk.sha256,
              chunk.size,
              client.locate(
                await client.uploadObject({
                  parentId: folders.deviceFolderId,
                  name: `${chunk.sha256}.bin`,
                  appProperties: propsFor(roles[kind], chunk.sha256),
                  source: chunk,
                  size: chunk.size,
                  mimeType: chunk.mimeType || "application/octet-stream",
                }),
              ),
              chunk.mimeType || "application/octet-stream",
            )
          : await reuseObject(
              client,
              folders.deviceFolderId,
              roles[kind],
              chunk.sha256,
            );
      if (databaseItem) transferredBytes += chunk.size;
      await trackManaged(ctx, database, kind);

      return database;
    };
    const database = await mapDatabaseChunks(capture.database, (chunk) =>
      transfer(chunk, "database"),
    );
    const assets = await mapAssets(capture.assets, (asset) =>
      transfer(asset, "asset"),
    );

    const manifestDraft: CloudBackupManifest = {
      format: "anynote.cloud-backup-manifest",
      formatVersion: 3,
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
      database = await mapDatabaseChunks(input.database, async (chunk) => {
        const verified = await verifyObject(chunk, ctx, "数据库分块");
        assertContentVerification(verified, "数据库分块");
        return verified;
      });
    const assets = await mapAssets(input.assets, async (chunk) => {
      const verified = await verifyObject(chunk, ctx, "附件");
      assertContentVerification(verified, "附件");
      return verified;
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
      {
        sha256: input.manifestSha256,
        size: bytes.length,
        locator: input.manifestRef,
      },
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
      const manifest = await readManifest(
        client,
        head.manifestRef,
        head.manifestSha256,
      ).catch(() => null);
      slots.push({
        deviceSlotId: device.appProperties?.["anynote.owner"] ?? device.id,
        deviceLabel: manifest?.deviceLabel,
        commitId: head.commitId,
        completedAt: head.completedAt,
        databaseBytes: manifest?.database.size,
        verification: manifest ? manifestVerification(manifest) : undefined,
      });
    }
    return { slots };
  },

  async prepareRestore(
    input: RestoreSelection,
    ctx: BackupHostContext,
  ): Promise<CloudBackupManifest> {
    const slots =
        (await ctx.state.get<Record<string, string>>(stateKeys.slots)) ?? {},
      deviceFolderId = slots[input.deviceSlotId];
    if (!deviceFolderId) throw Error("未找到该设备的云盘备份槽");
    const client = await createDriveClient(ctx),
      head = await readHead(client, deviceFolderId),
      manifestFileId = input.manifestRef ?? head?.manifestRef;
    if (!manifestFileId) throw Error("该设备槽没有可恢复的当前副本");
    if (!head || manifestFileId !== head.manifestRef)
      throw Error("云盘副本已变化，请重新选择恢复版本");
    const manifest = await readManifest(
      client,
      manifestFileId,
      head.manifestSha256,
    );
    if (
      manifest.commitId !== head.commitId ||
      manifest.deviceSlotId !== input.deviceSlotId ||
      manifest.notebookId !== ctx.notebookId
    )
      throw Error("云盘恢复清单身份不匹配");
    return manifest;
  },

  async download(
    manifest: CloudBackupManifest,
    ctx: BackupHostContext,
  ): Promise<RestoreBundle> {
    const client = await createDriveClient(ctx);
    const download = async (object: CloudBackupObjectRef, path: string) => {
      const result = await client.downloadToDest(object.locator.ref, path, {
        maxBytes: object.size,
      });
      if (result.sha256 !== object.sha256 || result.bytes !== object.size)
        throw Error("下载备份对象校验失败");
      ctx.tasks.progress(result.bytes);
      return {
        sha256: object.sha256,
        size: object.size,
        filePath: result.filePath,
      };
    };
    const database = await mapDatabaseChunks(manifest.database, (chunk) =>
      download(chunk, `chunks/${chunk.sha256}.bin`),
    );
    const assets = await mapAssets(manifest.assets, (asset) =>
      download(asset, asset.path),
    );
    return {
      manifest,
      databaseChunks: database.chunks,
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
