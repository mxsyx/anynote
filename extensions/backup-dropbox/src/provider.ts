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

/** Provider 协议版本；必须与核心 `cloudBackupProtocolVersion` 一致。 */
export const dropboxProtocolVersion = 1;

const now = () => new Date().toISOString();

/**
 * `current` 条件写能力的实测结论（设计 §9.2、§11.3、TODO §5 P1）。
 *
 * Dropbox 提供基于 rev 的 `WriteMode.update`，`publish` 也在读取当前 rev 后按
 * `update` 写入并识别冲突。但设计明确要求「只有经过实测的 endpoint 行为才可声明
 * 条件写」，当前没有真实账号上的 rev 冲突实测证据，因此这里显式记录为 `false`
 * 而不是一个默认值：不宣称跨客户端原子互斥，仍按单写设备槽 + 发布前后检查兜底。
 *
 * 当真实账号实测确认「rev 不符即拒绝写入且不产生 rename 副本」后，把此处置为
 * true 即可让核心按预期版本 token 参与发布（无需改动 `publish` 逻辑）。
 */
const conditionalHeadMeasured = false;

/** Dropbox 具备真实路径语义、App Folder 范围与内容分块哈希（设计 §11）。 */
export const dropboxCapabilities: CloudBackupCapabilities = Object.freeze({
  resumableUpload: true,
  conditionalHead: conditionalHeadMeasured,
  // 远端上传后返回的 content_hash 由 Dropbox 按同一算法计算（设计 §11.2、§13.1）。
  providerChecksum: ["dropbox-content-hash"],
  appScopedStorage: true,
  quotaAvailable: true,
});

/** 备份根目录（App Folder 内，设计 §7.2）。 */
const rootDir = `/${cloudBackupLayout.root}`;

/** Notebook 目录集合。 */
const notebooksDirPath = `${rootDir}/notebooks`;

/** 根目录身份标记路径。 */
const rootMarkerPath = `${rootDir}/${cloudBackupLayout.rootMarker}`;

/** 按设计 §7.2 的逻辑布局拼接设备槽目录。 */
const dropboxDevicePath = (notebookId: string, deviceSlotId: string): string =>
  `${rootDir}/${logicalDeviceDir(notebookId, deviceSlotId)}`;

/** 受管引用的状态键；核心已按 provider + Notebook 隔离命名空间。 */
const stateKeys = {
  root: "root.path",
  notebook: "notebook.path",
  device: "device.path",
  slot: "device.slot",
  slots: "slots",
  managed: "managed.objects",
} as const;

/** 读取并校验设备槽的当前指针；不存在返回 null。 */
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

/** 读取并严格校验清单。 */
async function readManifest(
  client: DropboxClient,
  manifestRef: string,
): Promise<CloudBackupManifest> {
  const bytes = await client.downloadBytes(manifestRef, 8 * 1024 * 1024);
  return parseManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
}

/**
 * 读取当前指针与上次成功清单；用于复用对象时比对远端 content_hash（设计 §8.1）。
 *
 * 元数据/清单读取失败不代表用户删除了全部笔记，因此这里只在无法读取时返回
 * null，复用判定仍以内容寻址路径与远端 checksum 为准。
 */
async function readPrevious(
  client: DropboxClient,
  devicePath: string,
): Promise<CloudBackupManifest | null> {
  const head = await readHead(client, devicePath).catch(() => null);
  if (!head) return null;
  return readManifest(client, head.manifestRef).catch(() => null);
}

/** 读取当前分片已解析的设备槽目录。 */
async function requireDevicePath(ctx: BackupHostContext): Promise<string> {
  const devicePath = await ctx.state.get<string>(stateKeys.device);
  if (!devicePath) throw Error("云盘目标目录尚未创建，请重新配置该目标");
  return devicePath;
}

/** 记录一个受管对象，供受管 GC 使用（设计 §14.3）。 */
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

/** 由远端条目构造对象引用；有 content_hash 时即达到厂商内容校验等级。 */
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

/** 是否为写入冲突（含未解析出错误体但状态为 409 的情况）。 */
const isConflict = (error: unknown): boolean =>
  isDropboxConflict(dropboxErrorCode(error)) ||
  (error as { status?: number }).status === 409;

/**
 * 上传一个不可变对象（设计 §7.3）。
 *
 * 内容寻址路径已存在时读取远端元数据确认，而不是覆盖或改名；这也保证同一
 * 备份任务重试时不会因 `add` 的禁止覆盖语义而失败。
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
 * 复用已有不可变对象；缺失或内容不符时明确失败，由下次完整备份修复。
 *
 * 复用依赖内容寻址路径 + 远端 `content_hash`：既有清单记录了同一 sha256 的
 * Dropbox checksum 时先比对，避免把被替换的远端对象当成原副本。
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
 * 校验单个对象：已有厂商 checksum 时直接采信，否则下载后校验（设计 §13.1）。
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
 * Dropbox 官方 Provider（设计 §11）。
 *
 * 使用 App Folder 与 PKCE + refresh token 的后台访问模式，在应用根内按
 * `AnynoteBackup/notebooks/<id>/devices/<slot>` 的真实目录布局组织对象：
 * 不可变对象以内容哈希命名并先上传，完整清单上传读回后再发布 `current` 指针。
 * 大对象走 upload session 并以「同一来源重建会话」应对中断；`current` 的 rev
 * 冲突处理通过预期 rev 的条件写路径实现，是否启用由实测结论决定。
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
    // Dropbox 刷新不返回新的 refresh token；核心刷新时保留原值（设计 §6.2）。
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
    // 目录身份标记必须是本应用写入的格式，避免在陌生目录里写入受管对象。
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
      // 远端对象被移动/删除时重新检查并修复，不只凭本机旧游标（设计 §8.1）。
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
      // 数据库必须达到内容验证等级（设计 §13.1）。
      database = await verifyObject(client, input.database, "数据库");
    assertContentVerification(database, "数据库");
    // 附件默认同样需要内容校验；Dropbox 一般已由 content_hash 满足，不会重复下载。
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
      // 清单按 commitId 命名且每次运行唯一；用 overwrite 使同一任务重试幂等，
      // 不会因 add 的禁止覆盖语义失败（设计 §7.3）。
      file = await client.uploadJson({
        path: `${devicePath}/${manifestObjectPath(input.commitId)}`,
        mode: { tag: "overwrite" },
        bytes,
      }),
      // 上传后读回，确保清单内容与本地完全一致（设计 §8.2 第 7 步）。
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
      // conditionalHead 尚未实测通过：退化为单写设备槽 + 发布前后检查（设计 §9.2）。
      conditional: false,
      write: async (nextHead, expected) => {
        const existing = await client.getMetadata(currentPath),
          // 首次创建使用禁止覆盖语义；已有对象按刚读到的 rev（或核心给出的预期
          // rev）条件更新，rev 不符即冲突，绝不自动改名生成副本（设计 §11.3）。
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
          // rev 不符或并发创建：拒绝发布并保留原 head。
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
      // 路径布局由 Notebook 与设备槽决定，第二设备无需原机游标即可定位（设计 §9.1）。
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
      // Dropbox 删除目录会递归删除其中的受管对象；计数仅用于回执。
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

/** 备份根目录身份标记内容。 */
function rootMarker(): CloudBackupRootMarker {
  return {
    format: "anynote.cloud-backup-root",
    formatVersion: 1,
    app: "anynote",
    createdAt: now(),
  };
}
