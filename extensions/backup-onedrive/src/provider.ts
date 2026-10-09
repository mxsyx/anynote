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
  createGraphClient,
  errorStatus,
  isFolder,
  itemRef,
  parseItemRef,
  type GraphClient,
  type GraphItem,
} from "./graph.js";

/** Provider 协议版本；必须与核心 `cloudBackupProtocolVersion` 一致。 */
export const oneDriveProtocolVersion = 1;

const now = () => new Date().toISOString();

/**
 * OneDrive 能力声明（设计 §12）。
 *
 * - 大文件走 `createUploadSession`，因此支持分片续传；
 * - `conditionalHead` 保持 `false`：`If-Match`/409 冲突行为须在选定 endpoint 上实测
 *   通过后才可置为 `true`（设计 §9.2、§12.3、TODO §5 P1）；
 * - 个人账号只提供 quickXorHash/sha1Hash，不提供与应用一致的 SHA-256，因此不声明
 *   厂商 checksum，校验降级为上传后下载校验（设计 §13.1）。
 */
export const oneDriveCapabilities: CloudBackupCapabilities = Object.freeze({
  resumableUpload: true,
  conditionalHead: false,
  providerChecksum: [],
  appScopedStorage: true,
  quotaAvailable: true,
});

/** 根目录显示名（设计 §10.1、§7.2）。 */
const rootFolderName = "AnynoteBackup";

/** 受管目录引用的状态键。 */
const stateKeys = {
  drive: "drive.id",
  root: "root.item",
  notebook: "notebook.item",
  device: "device.item",
  assets: "assets.item",
  slot: "device.slot",
  slots: "slots",
  managed: "managed.objects",
} as const;

interface ResolvedFolders {
  driveId: string;
  rootId: string;
  notebookId: string;
  deviceId: string;
  assetsId: string;
  deviceSlotId: string;
}

/** 查找或创建受管目录；并发创建冲突时重新读取既有目录。 */
async function findOrCreateFolder(
  client: GraphClient,
  driveId: string,
  parentId: string,
  name: string,
): Promise<GraphItem> {
  const existing = await client.findChild(driveId, parentId, name);
  if (existing) {
    if (!isFolder(existing))
      throw Error(`云端 ${name} 已存在且不是目录，已停止写入`);
    return existing;
  }
  try {
    return await client.createFolder(driveId, parentId, name);
  } catch (error) {
    // 并发创建同名目录：重新读取以复用已有身份，避免重复目录。
    if (errorStatus(error) === 409) {
      const raced = await client.findChild(driveId, parentId, name);
      if (raced && isFolder(raced)) return raced;
    }
    throw error;
  }
}

/** 读取并校验设备槽的当前指针；不存在返回 null。 */
async function readHead(
  client: GraphClient,
  driveId: string,
  deviceFolderId: string,
): Promise<CloudBackupHead | null> {
  const file = await client.findChild(driveId, deviceFolderId, "current.json");
  if (!file) return null;
  const bytes = await client.downloadBytes(
    itemRef(driveId, file.id),
    1024 * 1024,
  );
  return parseHead(JSON.parse(Buffer.from(bytes).toString("utf8")));
}

/** 读取并严格校验清单。 */
async function readManifest(
  client: GraphClient,
  manifestRef: string,
): Promise<CloudBackupManifest> {
  const bytes = await client.downloadBytes(manifestRef, 8 * 1024 * 1024);
  return parseManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
}

/**
 * 解析并锁定受管目录层级（设计 §7.2、§10.2）。
 *
 * 目录身份以 driveId + itemId 为准，显示名只作可读性；出现多个候选时检查索引并
 * 停写，不按名称取第一项。
 *
 * @param client Graph 客户端。
 * @param ctx 运行期上下文。
 * @param input Notebook 与设备槽身份。
 * @returns 已解析的目录引用。
 */
async function resolveFolders(
  client: GraphClient,
  ctx: BackupHostContext,
  input: { notebookId: string; deviceSlotId: string },
): Promise<ResolvedFolders> {
  const { driveId } = await client.drive(),
    appRoot = await client.appRoot();
  await ctx.state.set(stateKeys.drive, driveId);

  let rootId = (await ctx.state.get<string>(stateKeys.root)) ?? undefined;
  if (rootId) {
    const existing = await client
      .getItem(driveId, rootId)
      .catch(() => undefined);
    if (!existing || !isFolder(existing)) rootId = undefined;
  }
  if (!rootId) {
    rootId = (
      await findOrCreateFolder(client, driveId, appRoot.id, rootFolderName)
    ).id;
    await ctx.state.set(stateKeys.root, rootId);
  }

  const marker = await client.findChild(driveId, rootId, "root.json");
  if (!marker)
    await client.uploadBytes({
      driveId,
      parentId: rootId,
      name: "root.json",
      mimeType: "application/json",
      bytes: Buffer.from(JSON.stringify(rootMarker())),
      conflictBehavior: "fail",
    });
  else {
    // 目录身份标记必须是本应用写入的格式，避免在陌生目录里写入受管对象。
    const bytes = await client.downloadBytes(
      itemRef(driveId, marker.id),
      64 * 1024,
    );
    parseRootMarker(JSON.parse(Buffer.from(bytes).toString("utf8")));
  }

  const notebook = await findOrCreateFolder(
      client,
      driveId,
      rootId,
      input.notebookId,
    ),
    device = await findOrCreateFolder(
      client,
      driveId,
      notebook.id,
      input.deviceSlotId,
    ),
    assets = await findOrCreateFolder(client, driveId, device.id, "assets");
  await ctx.state.set(stateKeys.notebook, notebook.id);
  await ctx.state.set(stateKeys.device, device.id);
  await ctx.state.set(stateKeys.assets, assets.id);
  await ctx.state.set(stateKeys.slot, input.deviceSlotId);
  const slots =
    (await ctx.state.get<Record<string, string>>(stateKeys.slots)) ?? {};
  slots[input.deviceSlotId] = device.id;
  await ctx.state.set(stateKeys.slots, slots);
  return {
    driveId,
    rootId,
    notebookId: notebook.id,
    deviceId: device.id,
    assetsId: assets.id,
    deviceSlotId: input.deviceSlotId,
  };
}

/** 读取当前任务已解析的受管目录。 */
async function requireFolders(
  ctx: BackupHostContext,
): Promise<ResolvedFolders> {
  const [driveId, rootId, notebookId, deviceId, assetsId, deviceSlotId] =
    await Promise.all([
      ctx.state.get<string>(stateKeys.drive),
      ctx.state.get<string>(stateKeys.root),
      ctx.state.get<string>(stateKeys.notebook),
      ctx.state.get<string>(stateKeys.device),
      ctx.state.get<string>(stateKeys.assets),
      ctx.state.get<string>(stateKeys.slot),
    ]);
  if (
    !driveId ||
    !rootId ||
    !notebookId ||
    !deviceId ||
    !assetsId ||
    !deviceSlotId
  )
    throw Error("云盘目标目录尚未创建，请重新配置该目标");
  return { driveId, rootId, notebookId, deviceId, assetsId, deviceSlotId };
}

/** 记录一个受管对象，供受管 GC 使用（设计 §14.3）。 */
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

/** 建立对象引用；校验等级在 `verify` 阶段补齐。 */
function objectRef(
  sha256: string,
  size: number,
  locator: CloudBackupObjectRef["locator"],
  mimeType?: string,
): CloudBackupObjectRef {
  return { sha256, size, locator, mimeType, verification: "accepted-size" };
}

/** 复用已有远端对象；缺失时明确失败，由下次完整备份修复。 */
async function reuseObject(
  client: GraphClient,
  driveId: string,
  parentId: string,
  name: string,
  sha256: string,
): Promise<CloudBackupObjectRef> {
  const item = await client.findChild(driveId, parentId, name);
  if (!item)
    throw Error("计划判定可复用但云端对象不存在，请重新执行备份以修复");
  return {
    sha256,
    size: item.size ?? 0,
    locator: client.locate(driveId, item),
    verification: "download-sha256",
  };
}

/**
 * 校验单个对象：Graph 不提供可信 SHA-256，统一走上传后下载校验（设计 §13.1）。
 *
 * @param ref 对象引用。
 * @param ctx 运行期上下文。
 * @param label 出错标签。
 * @returns 带校验等级的对象引用。
 */
async function verifyObject(
  ref: CloudBackupObjectRef,
  client: GraphClient,
  ctx: BackupHostContext,
  label: string,
): Promise<CloudBackupObjectRef> {
  if (ref.verification === "download-sha256") return ref;
  const downloaded = await ctx.accounts.downloadToFile(
    client.contentUrl(ref.locator.ref),
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
 * OneDrive 官方 Provider（设计 §12）。
 *
 * 使用 Microsoft Graph delegated 授权与 `Files.ReadWrite.AppFolder`，以
 * `driveId + itemId` 定位对象、`approot` 作为应用目录根；大文件使用
 * `createUploadSession` 并以 320KiB 对齐分片，服务端确认偏移后继续。
 */
export const oneDriveProvider: CloudBackupProvider = {
  id: "onedrive",
  protocolVersion: oneDriveProtocolVersion,
  capabilities: oneDriveCapabilities,
  accountDescriptor: {
    providerId: "onedrive",
    authorizationEndpoint:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["offline_access", "User.Read", "Files.ReadWrite.AppFolder"],
    pkce: true,
    redirect: "loopback",
    refreshTokenRotation: true,
    accountIdClaim: "id_token:sub",
  },

  async probe({ ctx }: AccountContext): Promise<TargetCapabilities> {
    const drive = await createGraphClient(ctx).drive();
    return {
      ...oneDriveCapabilities,
      quotaBytes: drive.quotaBytes ?? null,
      quotaUsedBytes: drive.quotaUsedBytes ?? null,
      accountType: drive.accountType,
    };
  },

  async ensureTarget(
    input: TargetInput,
    ctx: BackupHostContext,
  ): Promise<BackupTargetHandle> {
    const client = createGraphClient(ctx),
      folders = await resolveFolders(client, ctx, {
        notebookId: input.notebookId,
        deviceSlotId: input.deviceSlotId,
      }),
      drive = await client.drive();
    return {
      rootRef: itemRef(folders.driveId, folders.rootId),
      notebookRef: itemRef(folders.driveId, folders.notebookId),
      deviceSlotRef: itemRef(folders.driveId, folders.deviceId),
      capabilities: {
        ...oneDriveCapabilities,
        quotaBytes: drive.quotaBytes ?? null,
        quotaUsedBytes: drive.quotaUsedBytes ?? null,
      },
    };
  },

  async plan(
    input: CapturedBackupInput,
    ctx: BackupHostContext,
  ): Promise<CloudBackupPlan> {
    const client = createGraphClient(ctx),
      deviceRef = input.target.deviceSlotRef;
    if (!deviceRef) throw Error("云盘目标缺少设备槽引用，请重新配置");
    const device = parseItemRef(deviceRef),
      head = await readHead(client, device.driveId, device.itemId),
      previous =
        input.previousHead && head?.commitId === input.previousHead.commitId
          ? await readManifest(client, input.previousHead.manifestRef)
          : null,
      drive = await client.drive();
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
      // 远端对象被删除/移动时重新检查并修复，不只凭本机旧游标（设计 §8.1）。
      exists: async (locator) => {
        const { driveId, itemId } = parseItemRef(locator.ref);
        try {
          return !isFolder(await client.getItem(driveId, itemId));
        } catch {
          return false;
        }
      },
      availableBytes:
        drive.quotaBytes != null
          ? Math.max(0, drive.quotaBytes - (drive.quotaUsedBytes ?? 0))
          : null,
    });
  },

  async execute(
    plan: CloudBackupPlan,
    ctx: BackupHostContext,
  ): Promise<PreparedRemoteBackup> {
    const capture = plan.capture;
    if (!capture) throw Error("缺少捕获结果，无法上传");
    const client = createGraphClient(ctx),
      folders = await requireFolders(ctx);
    let transferredBytes = 0;

    const databaseItem = plan.items.find((item) => item.kind === "database"),
      database = databaseItem
        ? objectRef(
            capture.database.sha256,
            capture.database.size,
            client.locate(
              folders.driveId,
              await client.uploadObject({
                driveId: folders.driveId,
                parentId: folders.deviceId,
                name: `${capture.database.sha256}.sqlite`,
                source: capture.database,
                size: capture.database.size,
                mimeType: "application/vnd.sqlite3",
              }),
            ),
            "application/vnd.sqlite3",
          )
        : await reuseObject(
            client,
            folders.driveId,
            folders.deviceId,
            `${capture.database.sha256}.sqlite`,
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
              folders.driveId,
              await client.uploadObject({
                driveId: folders.driveId,
                parentId: folders.assetsId,
                name: `${asset.sha256}.bin`,
                source: asset,
                size: asset.size,
                mimeType: asset.mimeType ?? "application/octet-stream",
              }),
            ),
            asset.mimeType,
          )
        : await reuseObject(
            client,
            folders.driveId,
            folders.assetsId,
            `${asset.sha256}.bin`,
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
    const client = createGraphClient(ctx),
      folders = await requireFolders(ctx),
      // 数据库必须达到内容验证等级（设计 §13.1）。
      database = await verifyObject(input.database, client, ctx, "数据库");
    assertContentVerification(database, "数据库");
    // 附件默认同样下载校验；高级设置可关闭，但结果不得混入「全部已验证」。
    const verifyAssets =
      (await ctx.state.get<boolean>("verify.downloadAssets")) ?? true;
    const assets: (CloudBackupObjectRef & { path: string })[] = [];
    for (const asset of input.assets)
      assets.push({
        ...(verifyAssets
          ? await verifyObject(asset, client, ctx, `附件 ${asset.path}`)
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
      file = await client.uploadBytes({
        driveId: folders.driveId,
        parentId: folders.deviceId,
        name: `${input.commitId}.json`,
        mimeType: "application/json",
        bytes,
      }),
      // 上传后读回，确保清单内容与本地完全一致（设计 §8.2 第 7 步）。
      readBack = await client.downloadBytes(
        itemRef(folders.driveId, file.id),
        8 * 1024 * 1024,
      );
    if (Buffer.compare(Buffer.from(readBack), bytes) !== 0)
      throw Error("OneDrive 清单读回校验失败");
    const manifestRef = client.locate(folders.driveId, file);
    input.manifest = manifest;
    input.manifestRef = manifestRef;
    input.manifestSha256 = ctx.verifier.sha256(readBack);
    await trackManaged(ctx, { ...database, locator: manifestRef }, "manifest");
    return manifest;
  },

  async publish(
    input: PublishInput,
    ctx: BackupHostContext,
  ): Promise<CommittedBackup> {
    if (!input.prepared.manifestRef || !input.prepared.manifestSha256)
      throw Error("清单尚未上传，拒绝发布当前指针");
    const client = createGraphClient(ctx),
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
      // `conditionalHead` 尚未实测通过：退化为单写设备槽 + 发布前后检查（设计 §9.2）。
      conditional: false,
      write: async () => {
        const existing = await client.findChild(
          folders.driveId,
          folders.deviceId,
          "current.json",
        );
        try {
          await client.uploadBytes({
            driveId: folders.driveId,
            parentId: folders.deviceId,
            name: "current.json",
            mimeType: "application/json",
            bytes,
            itemId: existing?.id,
            // eTag 冲突处理：并发写入者已更新 current 时返回 409/412，拒绝覆盖。
            ifMatch: existing?.eTag,
            conflictBehavior: "fail",
          });
        } catch (error) {
          const status = errorStatus(error);
          if (status === 409 || status === 412) return { conflict: true };
          throw error;
        }
        return {};
      },
      read: () => readHead(client, folders.driveId, folders.deviceId),
      verification: "download-sha256",
    });
  },

  async reconcile(
    input: ReconcileInput,
    ctx: BackupHostContext,
  ): Promise<ReconcileResult> {
    const folders = await requireFolders(ctx).catch(() => null);
    if (!folders) return { head: null };
    const client = createGraphClient(ctx),
      head = await readHead(client, folders.driveId, folders.deviceId);
    return {
      committedCommitId:
        head?.commitId === input.expectedCommitId ? head.commitId : undefined,
      head,
      verification: "download-sha256",
    };
  },

  async listCurrentBackups(ctx: BackupHostContext): Promise<BackupPage> {
    const folders = await requireFolders(ctx).catch(() => null);
    if (!folders) return { slots: [] };
    const client = createGraphClient(ctx),
      devices = (
        await client.listChildren(folders.driveId, folders.notebookId)
      ).filter(isFolder),
      slots: BackupPage["slots"] = [];
    for (const device of devices) {
      const head = await readHead(client, folders.driveId, device.id).catch(
        () => null,
      );
      if (!head) continue;
      const manifest = await readManifest(client, head.manifestRef).catch(
        () => null,
      );
      slots.push({
        deviceSlotId: device.name ?? device.id,
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
    const driveId = await ctx.state.get<string>(stateKeys.drive),
      notebookId = await ctx.state.get<string>(stateKeys.notebook),
      slots =
        (await ctx.state.get<Record<string, string>>(stateKeys.slots)) ?? {};
    if (!driveId) throw Error("未找到该设备的云盘备份槽");
    const client = createGraphClient(ctx);
    let deviceId = slots[input.deviceSlotId];
    // 第二设备只读恢复：本地槽表没有远端槽时，按名称在 Notebook 目录内定位。
    if (!deviceId && notebookId) {
      const folder = await client
        .findChild(driveId, notebookId, input.deviceSlotId)
        .catch(() => null);
      if (folder && isFolder(folder)) deviceId = folder.id;
    }
    if (!deviceId) throw Error("未找到该设备的云盘备份槽");
    const head = await readHead(client, driveId, deviceId),
      manifestRef = input.manifestRef ?? head?.manifestRef;
    if (!manifestRef) throw Error("该设备槽没有可恢复的当前副本");
    const manifest = await readManifest(client, manifestRef),
      database = await client.downloadToDest(
        manifest.database.locator.ref,
        "notebook.sqlite",
      ),
      assets: RestoreBundle["assets"] = [];
    for (const asset of manifest.assets) {
      // 清单是不可信输入：相对路径经核心校验后才允许落盘（设计 §16）。
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
    const client = createGraphClient(ctx);
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
    const driveId = await ctx.state.get<string>(stateKeys.drive),
      slots =
        (await ctx.state.get<Record<string, string>>(stateKeys.slots)) ?? {},
      deviceId = slots[input.deviceSlotId];
    if (!driveId || !deviceId) return { deleted: 0, failed: 0 };
    const client = createGraphClient(ctx);
    let deleted = 0,
      failed = 0;
    const queue = [deviceId];
    while (queue.length) {
      const folderId = queue.shift()!,
        children = await client.listChildren(driveId, folderId).catch(() => []);
      for (const child of children) {
        if (isFolder(child)) {
          queue.push(child.id);
          continue;
        }
        try {
          await client.remove(itemRef(driveId, child.id));
          deleted += 1;
        } catch {
          failed += 1;
        }
      }
    }
    try {
      await client.remove(itemRef(driveId, deviceId));
    } catch {
      failed += 1;
    }
    delete slots[input.deviceSlotId];
    await ctx.state.set(stateKeys.slots, slots);
    return { deleted, failed };
  },
};

/** 备份根目录身份标记内容。 */
function rootMarker(): CloudBackupRootMarker {
  return {
    format: "anynote.cloud-backup-root",
    formatVersion: 1,
    app: "anynote",
    createdAt: now(),
  };
}
