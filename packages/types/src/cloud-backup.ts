/**
 * 云盘备份的公共协议类型（设计 §7、§15）。
 *
 * 本文件是「核心 ⇄ 官方扩展」的唯一类型边界：核心只实现这里声明的捕获、账号、
 * 网络、任务与本机状态门面，扩展只通过同样的门面访问云盘，不接触 SQLite 连接、
 * 绝对磁盘路径或全局 token。运行时中立：不依赖 Node、Electron 或存储实现。
 */

/** 云盘厂商标识；官方扩展固定使用这三个 id。 */
export type CloudProviderId = "google-drive" | "dropbox" | "onedrive";

/** 校验等级（设计 §13.1）。 */
export type CloudVerificationLevel =
  | "provider-checksum"
  | "download-sha256"
  | "accepted-size";

/** 厂商不透明对象引用；临时下载 URL 不写入长期清单。 */
export interface CloudObjectLocator {
  /** 厂商内部对象类型，例如 `drive.file` / `path` / `graph.item`。 */
  kind: string;
  /** 厂商侧稳定身份，例如文件 ID、路径或 driveId/itemId。 */
  ref: string;
  /** 版本 token（file ID 之外的并发判定线索）。 */
  versionToken?: string;
}

/* ------------------------------------------------------------------ *
 * 持久化目标与账号（设备侧 `_local/` 状态，设计 §14.1）
 * ------------------------------------------------------------------ */

/** 账号引用；凭据实际内容只进入系统安全存储。 */
export interface CloudAccountRef {
  providerId: CloudProviderId;
  /** 官方 OAuth 应用 Client ID 或 App Key；公开应用标识。 */
  oauthClientId: string;
  /** 云盘账号 ID（厂商返回的稳定身份）。 */
  accountId: string;
  /** 租户 / drive / namespace 上下文；个人账号可省略。 */
  context?: string;
  /** 用户可见的账号显示名（邮箱或昵称）。 */
  displayName?: string;
}

/** 一个已连接的云盘账号。 */
export interface CloudBackupAccount {
  /** 本机账号引用 ID（同时是安全存储中的凭据键）。 */
  id: string;
  ref: CloudAccountRef;
  createdAt: number;
  lastRefreshedAt?: number;
  /** 需要重新登录时记录原因，便于 UI 如实提示。 */
  reauthReason?: string | null;
}

/** 一个云盘备份目标（Notebook × Provider × 设备槽）。 */
export interface CloudBackupTarget {
  id: string;
  notebookId: string;
  providerId: CloudProviderId;
  accountRefId: string;
  /** 设备槽 ID；存本机，不随 Notebook 导出复制（设计 §9.1）。 */
  deviceSlotId: string;
  /** 用户可命名的设备标签。 */
  deviceLabel?: string;
  /** 云盘侧 AnynoteBackup 根目录的不透明引用。 */
  rootRef?: string;
  /** Notebook 目录的不透明引用。 */
  notebookRef?: string;
  autoBackup?: boolean;
  intervalMinutes?: number;
  lastAttempt?: number;
  lastSuccess?: number;
  lastError?: string | null;
  failureCount?: number;
  nextAttemptAt?: number | null;
  pausedReason?: string | null;
  lastTaskBytes?: number;
  /** 最近一次成功发布的 head 身份，用于无变化检查与提交确认。 */
  lastHeadCommitId?: string | null;
  lastHeadManifestSha256?: string | null;
  /** 最近一次成功发布的完整指针；Provider 据此读取上次清单复用附件。 */
  lastHead?: CloudBackupHead | null;
  /** 最近一次上传的数据库 SHA-256；与捕获结果比对即文件级增量判定。 */
  lastDatabaseSha256?: string | null;
  /** 待清理对象数量；清理失败只标记不回滚（设计 §8.2）。 */
  pendingCleanup?: number;
  credentialsMode?: "system-encrypted" | "session-only";
  createdAt?: number;
  /** 占位 Provider 标记；UI 据此显示 Beta 且不承诺可用。 */
  beta?: boolean;
}

/** 可恢复的备份槽摘要（恢复向导列表项）。 */
export interface CloudBackupDeviceSlot {
  deviceSlotId: string;
  deviceLabel?: string;
  commitId?: string;
  completedAt?: string;
  databaseBytes?: number;
  assetCount?: number;
  verification?: CloudVerificationLevel;
  /** 该槽是否由本机写入；跨设备槽为只读候选。 */
  local?: boolean;
}

/* ------------------------------------------------------------------ *
 * 文件格式（设计 §7.2、§7.4）
 * ------------------------------------------------------------------ */

/** 逻辑目录常量；Provider 负责映射到自身 ID/路径语义。 */
export const cloudBackupLayout = {
  root: "AnynoteBackup",
  rootMarker: "root.json",
  current: "current.json",
  manifestsDir: "manifests",
  databasesDir: "databases",
  assetsDir: "assets",
  pendingDir: "pending",
  assetsPrefix: "sha256",
} as const;

/** 备份根目录身份标记，避免在陌生目录里写入受管对象。 */
export interface CloudBackupRootMarker {
  format: "anynote.cloud-backup-root";
  formatVersion: 1;
  app: "anynote";
  createdAt: string;
}

/** 当前指针；只在不可变对象就绪后发布（设计 §7.4）。 */
export interface CloudBackupHead {
  format: "anynote.cloud-backup-head";
  formatVersion: 1;
  notebookId: string;
  deviceSlotId: string;
  commitId: string;
  /** Provider 不透明引用，指向完整 manifest。 */
  manifestRef: string;
  manifestSha256: string;
  completedAt: string;
}

/** 清单中的数据库/附件引用。 */
export interface CloudBackupObjectRef {
  /** 应用 SHA-256（十六进制）。 */
  sha256: string;
  size: number;
  locator: CloudObjectLocator;
  /** 厂商计算的 checksum 说明信息，不是校验凭证。 */
  providerChecksum?: string;
  /** 实际达到的校验等级。 */
  verification?: CloudVerificationLevel;
  mimeType?: string;
}

/** 完整清单；资源引用必须全部可解析。 */
export interface CloudBackupManifest {
  format: "anynote.cloud-backup-manifest";
  formatVersion: 1;
  notebookId: string;
  notebookName?: string;
  deviceSlotId: string;
  deviceLabel?: string;
  commitId: string;
  createdAt: string;
  schemaVersion: number;
  contentSeq: number;
  database: CloudBackupObjectRef & {
    schemaVersion: number;
    contentSeq: number;
  };
  assets: (CloudBackupObjectRef & { path: string })[];
  /** 本条清单来源设备；仅用于诊断，不作为身份。 */
  sourceDevice?: string;
}

/* ------------------------------------------------------------------ *
 * 能力描述（设计 §3.2、§9.2、§15.1）
 * ------------------------------------------------------------------ */

/** 静态能力声明；可按账号/endpoint 由 `probe` 覆盖。 */
export interface CloudBackupCapabilities {
  resumableUpload: boolean;
  /** 是否具备经实测的条件写（预期版本 token）。 */
  conditionalHead: boolean;
  /** 厂商计算的 checksum 算法名（如 `sha256`、`dropbox-content-hash`）。 */
  providerChecksum: readonly string[];
  appScopedStorage: boolean;
  quotaAvailable: boolean;
}

/** `probe` 得到的账号/目标级能力覆盖。 */
export interface TargetCapabilities extends CloudBackupCapabilities {
  quotaBytes?: number | null;
  quotaUsedBytes?: number | null;
  accountType?: string;
}

/** 厂商认证描述；核心据此执行 PKCE 流程。 */
export interface OAuthProviderDescriptor {
  providerId: CloudProviderId;
  /** 授权码端点。 */
  authorizationEndpoint: string;
  /** token 端点（同时用于刷新）。 */
  tokenEndpoint: string;
  /** 可选撤销端点。 */
  revocationEndpoint?: string;
  scopes: readonly string[];
  /** 是否支持/要求 PKCE（官方均为 true）。 */
  pkce: boolean;
  /** 回调形式；官方桌面流程统一使用回环地址。 */
  redirect: "loopback";
  /** 回调路径（仅回环）；`/` 允许厂商注册的任意端口。 */
  redirectPath?: string;
  /** 刷新 token 轮换时是否可能返回新的 refresh token。 */
  refreshTokenRotation: boolean;
  /** 账号标识取法提示，供核心在交换后读取。 */
  accountIdClaim?: "id_token:sub" | "id_token:email" | "response:account_id";
}

/* ------------------------------------------------------------------ *
 * 运行期上下文（设计 §15.2）
 * ------------------------------------------------------------------ */

/** 只读字节来源；支持按 offset 读取以复用续传。 */
export interface ScopedReadSource {
  size: number;
  /** 按 offset/length 读取；返回的字节数可以小于请求长度。 */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** 全量顺序流（上传用），受 `signal` 取消。 */
  stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

/** 捕获到的资源闭包项。 */
export interface CloudCapturedAsset extends ScopedReadSource {
  /** 相对路径（已在核心侧校验，禁止逃逸）。 */
  path: string;
  sha256: string;
  mimeType?: string;
}

/** 一致性捕获结果句柄；`release` 后临时副本可被回收。 */
export interface CloudCaptureHandle {
  notebookId: string;
  notebookName: string;
  contentSeq: number;
  schemaVersion: number;
  database: ScopedReadSource & { sha256: string };
  assets: CloudCapturedAsset[];
  release(): Promise<void>;
}

/** 数据捕获门面（设计 §3.1「数据捕获」）。 */
export interface NotebookCaptureAPI {
  capture(
    notebookId: string,
    options?: { signal?: AbortSignal },
  ): Promise<CloudCaptureHandle>;
}

/** 资源访问门面；只允许访问已授权 Notebook 内被 pin 的资源。 */
export interface ScopedReadStreamAPI {
  open(sha256: string, signal?: AbortSignal): Promise<ScopedReadSource>;
}

/** 短时 access token 提供者，由核心负责 single-flight 刷新。 */
export interface AccessTokenProvider {
  getAccessToken(): Promise<{ token: string; expiryDate?: number }>;
}

/** 一次受限 HTTP 请求的输入。 */
export interface AuthorizedRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
  /** 上传会话 URL 等自带凭据时禁止注入 Bearer。 */
  raw?: boolean;
  /** 响应体读取上限；默认 8MiB。 */
  maxBytes?: number;
}

/** 受限 HTTP 响应。 */
export interface AuthorizedResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

/** 账号与凭据门面；扩展拿不到 refresh token 或其他 Provider 的 token。 */
export interface ScopedAccountAPI {
  current(): CloudAccountRef;
  /** 受信首方扩展可在有限时间内持有短时 access token。 */
  tokenProvider(): AccessTokenProvider;
  /** 注入 Bearer 并处理 401 刷新/重定向策略的受限 HTTP 客户端。 */
  request(url: string, init?: AuthorizedRequest): Promise<AuthorizedResponse>;
  /**
   * 流式下载到核心私有临时文件；大对象不进内存。
   *
   * @returns 临时文件路径、字节数与可选的应用 SHA-256。
   */
  downloadToFile(
    url: string,
    init?: AuthorizedRequest,
    options?: {
      maxBytes?: number;
      hash?: boolean;
      /**
       * 相对核心临时目录的目标路径；核心会做路径逃逸校验。
       * 恢复时用于把数据库与附件落到清单声明的相对位置。
       */
      dest?: string;
    },
  ): Promise<{ filePath: string; bytes: number; sha256?: string }>;
  /**
   * 流式上传；请求体来自捕获的资源或数据库来源。
   *
   * @returns 厂商响应（分片续传的 308 也在此返回）。
   */
  upload(
    url: string,
    init: AuthorizedRequest & { source: AsyncIterable<Uint8Array> },
  ): Promise<AuthorizedResponse>;
}

/** 已授权 HTTP 客户端（与 `ScopedAccountAPI.request` 相同的规则）。 */
export type AuthorizedHTTPAPI = ScopedAccountAPI["request"];

/** 任务进度与取消门面。 */
export interface TaskProgressAPI {
  signal: AbortSignal;
  /** 上报进度（0..1 可省略时按字节）。 */
  progress(bytes: number, message?: string): void;
  /** 脱敏日志：只记录耗时/大小/错误码。 */
  log(level: "info" | "warn" | "error", message: string): void;
  /** 限流预算（并发上传数），由核心按账号共享。 */
  concurrency(): number;
}

/** 本机作用域状态（设计 §14.1）；按 Provider 命名空间隔离。 */
export interface ScopedLocalStateAPI {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 校验门面：统一 SHA-256 与厂商 checksum 的解释（设计 §13.1）。 */
export interface BackupVerificationAPI {
  /** 计算字节流的应用 SHA-256。 */
  sha256(bytes: Uint8Array): string;
  /** 递增计算器，用于分片流式校验。 */
  createHasher(): { update(chunk: Uint8Array): void; digest(): string };
}

/** 核心交给扩展的完整运行期上下文。 */
export interface BackupHostContext {
  capture: NotebookCaptureAPI;
  resources: ScopedReadStreamAPI;
  accounts: ScopedAccountAPI;
  http: AuthorizedHTTPAPI;
  /** 绑定到当前任务的进度/取消/限流门面。 */
  tasks: TaskProgressAPI;
  /**
   * 本机作用域状态；核心按 `providerId + notebookId` 隔离命名空间，
   * 因此扩展可以用 `slots`、`notebook.ref` 这类简单键。
   */
  state: ScopedLocalStateAPI;
  verifier: BackupVerificationAPI;
  /** 当前 Notebook；能力探测等场景可以为空。 */
  notebookId?: string;
  /** 当前目标的设备标签，供备份目录与清单显示。 */
  deviceLabel?: string;
}

/* ------------------------------------------------------------------ *
 * Provider 接口（设计 §15.1）
 * ------------------------------------------------------------------ */

/** `probe` 输入。 */
export interface AccountContext {
  account: CloudAccountRef;
  ctx: BackupHostContext;
}

/** `ensureTarget` 输入。 */
export interface TargetInput {
  notebookId: string;
  notebookName: string;
  deviceSlotId: string;
  deviceLabel?: string;
  /** 已存在的目标引用；重配置时用于复用目录。 */
  existing?: { rootRef?: string; notebookRef?: string };
}

/** 目标句柄：扩展返回给核心的不透明引用。 */
export interface BackupTargetHandle {
  rootRef: string;
  notebookRef: string;
  deviceSlotRef?: string;
  /** 本次探测到的实际能力覆盖。 */
  capabilities?: TargetCapabilities;
}

/** `plan` 输入：捕获结果与最近一次成功状态。 */
export interface CapturedBackupInput {
  capture: CloudCaptureHandle;
  target: BackupTargetHandle;
  /** 上次成功提交的清单；用于复用附件与比较数据库。 */
  previous?: CloudBackupManifest | null;
  /** 上次成功发布的 head。 */
  previousHead?: CloudBackupHead | null;
  /** 无变化检查时是否仍确认指针状态。 */
  verifyOnly?: boolean;
}

/** 上传计划中的一项。 */
export interface CloudUploadItem {
  kind: "database" | "asset" | "manifest";
  sha256: string;
  size: number;
  /** 复用的远端 locator；未提供表示需要上传。 */
  reuse?: CloudObjectLocator;
  assetPath?: string;
}

/** 差异计划与空间预算。 */
export interface CloudBackupPlan {
  commitId: string;
  items: CloudUploadItem[];
  uploadBytes: number;
  /** 无需上传（数据库与全部附件均可复用）。 */
  unchanged: boolean;
  requiredBytes: number;
  availableBytes?: number | null;
  /** 计划是否有待清理对象。 */
  cleanupCandidates?: number;
  /**
   * 本次计划的捕获结果；由核心在 `plan` 之后附加，使 `execute` 能取得
   * 只读数据库与资源来源，而无需扩展自行持有临时路径。
   */
  capture?: CloudCaptureHandle;
}

/** 已上传但尚未发布的远端对象集合。 */
export interface PreparedRemoteBackup {
  commitId: string;
  database: CloudBackupObjectRef;
  assets: (CloudBackupObjectRef & { path: string })[];
  /** 本次实际传输字节。 */
  transferredBytes: number;
  /** 是否所有对象都已上传（无变化时为 true）。 */
  complete: boolean;
  /**
   * 清单骨架：`execute` 阶段填写对象引用与身份，但校验等级尚未确定；
   * `verify` 阶段补齐校验结果后上传，再回填 `manifestRef`/`manifestSha256`。
   */
  manifestDraft: CloudBackupManifest;
  /** 已上传清单的不透明引用；`verify` 成功后填写。 */
  manifestRef?: CloudObjectLocator;
  manifestSha256?: string;
  /** 读回确认后的最终清单。 */
  manifest?: CloudBackupManifest;
}

/** 发布输入。 */
export interface PublishInput {
  prepared: PreparedRemoteBackup;
  /** 期望的当前 head 版本 token；不支持条件写时为 undefined。 */
  expectedVersionToken?: string;
  /** 最近读到的 head，用于发布前后检查。 */
  observedHead?: CloudBackupHead | null;
}

/** 发布结果。 */
export interface CommittedBackup {
  commitId: string;
  head: CloudBackupHead;
  /** 发布读回确认等级。 */
  verification: CloudVerificationLevel;
  versionToken?: string;
}

export interface ReconcileInput {
  expectedCommitId: string;
}

export interface ReconcileResult {
  /** 远端 head 的确切 commitId（若已发布）。 */
  committedCommitId?: string;
  head?: CloudBackupHead | null;
  verification?: CloudVerificationLevel;
}

export interface BackupPage {
  slots: CloudBackupDeviceSlot[];
  nextCursor?: string | null;
}

export interface RestoreSelection {
  deviceSlotId: string;
  /** 固定读取的清单引用；恢复开始后不再改选。 */
  manifestRef?: string;
}

/** 恢复包：已下载到核心私有临时目录的对象。 */
export interface RestoreBundle {
  manifest: CloudBackupManifest;
  /** 数据库临时文件（核心私有临时目录内）。 */
  databasePath: string;
  databaseSha256: string;
  /** 附件临时文件；`path` 为清单中的相对路径。 */
  assets: { path: string; sha256: string; size: number; filePath: string }[];
  /** 下载期间校验等级。 */
  verification: CloudVerificationLevel;
}

export interface CleanupPlan {
  /** 只允许清理这些受管 locator。 */
  objects: CloudObjectLocator[];
}

export interface CleanupResult {
  deleted: number;
  failed: number;
}

/** 官方扩展实现的云盘 Provider（设计 §15.1）。 */
export interface CloudBackupProvider {
  id: CloudProviderId;
  protocolVersion: number;
  capabilities: CloudBackupCapabilities;
  accountDescriptor: OAuthProviderDescriptor;

  probe(ctx: AccountContext): Promise<TargetCapabilities>;
  ensureTarget(
    input: TargetInput,
    ctx: BackupHostContext,
  ): Promise<BackupTargetHandle>;
  plan(
    input: CapturedBackupInput,
    ctx: BackupHostContext,
  ): Promise<CloudBackupPlan>;
  execute(
    plan: CloudBackupPlan,
    ctx: BackupHostContext,
  ): Promise<PreparedRemoteBackup>;
  verify(
    input: PreparedRemoteBackup,
    ctx: BackupHostContext,
  ): Promise<CloudBackupManifest>;
  publish(
    input: PublishInput,
    ctx: BackupHostContext,
  ): Promise<CommittedBackup>;
  reconcile(
    input: ReconcileInput,
    ctx: BackupHostContext,
  ): Promise<ReconcileResult>;
  listCurrentBackups(ctx: BackupHostContext): Promise<BackupPage>;
  download(
    input: RestoreSelection,
    ctx: BackupHostContext,
  ): Promise<RestoreBundle>;
  cleanup(input: CleanupPlan, ctx: BackupHostContext): Promise<CleanupResult>;
  /**
   * 显式删除一个设备槽的受管对象（设计 §5.4）。
   *
   * 这是独立于「断开连接」的破坏性操作，必须由用户在确认影响范围后触发；
   * 未实现时 UI 只提示手动清理，不静默使用受管 GC 代替。
   */
  deleteSlot?(
    input: { deviceSlotId: string },
    ctx: BackupHostContext,
  ): Promise<CleanupResult>;
}

/* ------------------------------------------------------------------ *
 * 备份中心对外 API（SDK / 首方适配器共用）
 * ------------------------------------------------------------------ */

/** 备份中心卡片所需的目标视图。 */
export interface CloudBackupTargetView {
  target: CloudBackupTarget;
  account?: CloudBackupAccount;
  provider: {
    id: CloudProviderId;
    title: string;
    beta: boolean;
    installed: boolean;
  };
  capabilities?: CloudBackupCapabilities;
  quotaBytes?: number | null;
  quotaUsedBytes?: number | null;
  state:
    | "idle"
    | "waiting-network"
    | "reauth-required"
    | "quota-exceeded"
    | "permission-denied"
    | "uploading"
    | "retrying"
    | "completed"
    | "cleanup-pending";
  pendingBytes?: number;
}

/** 恢复落地结果。 */
export interface CloudRestoreResult {
  notebookId: string;
  name: string;
  databaseSha256: string;
  assets: number;
  verification: CloudVerificationLevel;
}

/** 云盘备份的公共 SDK 调用面。 */
export interface CloudBackupAPI {
  listProviders(input?: object): Promise<
    {
      id: CloudProviderId;
      title: string;
      beta: boolean;
      installed: boolean;
      capabilities: CloudBackupCapabilities;
      /** 将申请的厂商权限；用于连接前的如实展示。 */
      scopes: readonly string[];
    }[]
  >;
  listAccounts(input?: object): Promise<CloudBackupAccount[]>;
  beginAuthorization(input: {
    providerId: CloudProviderId;
    /** 自编译版本可注入自定义 OAuth Client ID。 */
    oauthClientId?: string;
  }): Promise<{ sessionId: string; authorizationUrl: string; opened: boolean }>;
  completeAuthorization(input: {
    sessionId: string;
  }): Promise<CloudBackupAccount>;
  cancelAuthorization(input: { sessionId: string }): Promise<boolean>;
  disconnectAccount(input: { accountRefId: string }): Promise<boolean>;
  listTargets(input: { notebookId: string }): Promise<CloudBackupTargetView[]>;
  probeTarget(input: {
    providerId: CloudProviderId;
    accountRefId: string;
  }): Promise<TargetCapabilities>;
  configureTarget(input: {
    notebookId: string;
    providerId: CloudProviderId;
    accountRefId: string;
    deviceLabel?: string;
    targetId?: string;
  }): Promise<CloudBackupTarget>;
  setSchedule(input: {
    notebookId: string;
    targetId: string;
    enabled: boolean;
    intervalMinutes?: number;
  }): Promise<CloudBackupTarget>;
  removeTarget(input: {
    notebookId: string;
    targetId: string;
  }): Promise<boolean>;
  testConnection(input: {
    notebookId: string;
    targetId: string;
  }): Promise<{ ok: boolean; detail?: string }>;
  run(input: { notebookId: string; targetId: string }): Promise<{ id: string }>;
  listDevices(input: {
    notebookId: string;
    targetId: string;
  }): Promise<CloudBackupDeviceSlot[]>;
  listRestorePoints(input: {
    notebookId: string;
    targetId: string;
    deviceSlotId?: string;
  }): Promise<CloudBackupDeviceSlot[]>;
  restore(input: {
    notebookId: string;
    targetId: string;
    deviceSlotId: string;
    manifestRef?: string;
  }): Promise<{ id: string }>;
  deleteBackup(input: {
    notebookId: string;
    targetId: string;
    deviceSlotId: string;
  }): Promise<boolean>;
  getTask(id: string): Promise<{ id: string; status: string } | null>;
  cancel(id: string): Promise<boolean>;
}
