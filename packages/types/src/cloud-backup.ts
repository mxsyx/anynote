/**
 * Public protocol types for cloud backup (design §7, §15).
 *
 * This file is the single type boundary between the core and official extensions: the core only implements the capture, account,
 * network, task, and local-state facades declared here, and extensions access the cloud only through those same facades, never touching SQLite connections,
 * absolute disk paths, or global tokens. Runtime-neutral: does not depend on Node, Electron, or a storage implementation.
 */

/** Cloud provider id; official extensions always use these three ids. */
export type CloudProviderId = "google-drive" | "dropbox" | "onedrive";

/** Verification level (design §13.1). */
export type CloudVerificationLevel =
  | "provider-checksum"
  | "download-sha256"
  | "accepted-size";

/** Vendor-opaque object reference; temporary download URLs are not written into the long-term manifest. */
export interface CloudObjectLocator {
  /** Vendor-internal object kind, e.g. `drive.file` / `path` / `graph.item`. */
  kind: string;
  /** Stable vendor-side identity, e.g. file ID, path, or driveId/itemId. */
  ref: string;
  /** Version token (a concurrency hint beyond the file ID). */
  versionToken?: string;
}

/* ------------------------------------------------------------------ *
 * Persisted targets and accounts (device-side `_local/` state, design §14.1)
 * ------------------------------------------------------------------ */

/** Account reference; the actual credential content only goes into the system secure storage. */
export interface CloudAccountRef {
  providerId: CloudProviderId;
  /** Official OAuth app Client ID or App Key; a public application identifier. */
  oauthClientId: string;
  /** Cloud account ID (the stable identity returned by the vendor). */
  accountId: string;
  /** Tenant / drive / namespace context; may be omitted for personal accounts. */
  context?: string;
  /** User-visible account display name (email or nickname). */
  displayName?: string;
}

/** A connected cloud account. */
export interface CloudBackupAccount {
  /** Local account reference ID (also the credential key in secure storage). */
  id: string;
  ref: CloudAccountRef;
  createdAt: number;
  lastRefreshedAt?: number;
  /** Reason recorded when re-login is needed, so the UI can prompt truthfully. */
  reauthReason?: string | null;
}

/** A cloud backup target (Notebook × Provider × device slot). */
export interface CloudBackupTarget {
  id: string;
  notebookId: string;
  providerId: CloudProviderId;
  accountRefId: string;
  /** Device slot ID; stored locally and not copied with Notebook export (design §9.1). */
  deviceSlotId: string;
  /** User-nameable device label. */
  deviceLabel?: string;
  /** Opaque reference to the AnynoteBackup root directory on the cloud. */
  rootRef?: string;
  /** Opaque reference to the Notebook directory. */
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
  /** Identity of the last successfully published head, used for no-change checks and commit confirmation. */
  lastHeadCommitId?: string | null;
  lastHeadManifestSha256?: string | null;
  /** Full pointer of the last successful publish; the Provider uses it to read the previous manifest and reuse assets. */
  lastHead?: CloudBackupHead | null;
  /** SHA-256 of the last uploaded database; comparing it with the capture result gives a file-level incremental decision. */
  lastDatabaseSha256?: string | null;
  /** Number of objects pending cleanup; cleanup failure only marks, never rolls back (design §8.2). */
  pendingCleanup?: number;
  credentialsMode?: "system-encrypted" | "session-only";
  createdAt?: number;
  /** Placeholder Provider flag; the UI shows Beta accordingly and makes no availability promise. */
  beta?: boolean;
}

/** Restorable backup slot summary (a restore wizard list item). */
export interface CloudBackupDeviceSlot {
  deviceSlotId: string;
  deviceLabel?: string;
  commitId?: string;
  completedAt?: string;
  databaseBytes?: number;
  assetCount?: number;
  verification?: CloudVerificationLevel;
  /** Whether this slot was written by this device; cross-device slots are read-only candidates. */
  local?: boolean;
}

/* ------------------------------------------------------------------ *
 * File format (design §7.2, §7.4)
 * ------------------------------------------------------------------ */

/** Logical directory constants; the Provider maps them to its own ID/path semantics. */
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

/** Backup root identity marker, to avoid writing managed objects into a foreign directory. */
export interface CloudBackupRootMarker {
  format: "anynote.cloud-backup-root";
  formatVersion: 1;
  app: "anynote";
  createdAt: string;
}

/** Current pointer; published only after the immutable objects are ready (design §7.4). */
export interface CloudBackupHead {
  format: "anynote.cloud-backup-head";
  formatVersion: 1;
  notebookId: string;
  deviceSlotId: string;
  commitId: string;
  /** Provider-opaque reference pointing to the full manifest. */
  manifestRef: string;
  manifestSha256: string;
  completedAt: string;
}

/** Database/asset reference within the manifest. */
export interface CloudBackupObjectRef {
  /** Application SHA-256 (hexadecimal). */
  sha256: string;
  size: number;
  locator: CloudObjectLocator;
  /** Vendor-computed checksum descriptive info, not a verification proof. */
  providerChecksum?: string;
  /** Verification level actually achieved. */
  verification?: CloudVerificationLevel;
  mimeType?: string;
}

/** Full manifest; all asset references must be resolvable. */
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
  /** Source device of this manifest; for diagnostics only, not used as identity. */
  sourceDevice?: string;
}

/* ------------------------------------------------------------------ *
 * Capability description (design §3.2, §9.2, §15.1)
 * ------------------------------------------------------------------ */

/** Static capability declaration; may be overridden per account/endpoint by `probe`. */
export interface CloudBackupCapabilities {
  resumableUpload: boolean;
  /** Whether verified conditional writes (with an expected version token) are supported. */
  conditionalHead: boolean;
  /** Vendor-computed checksum algorithm names (e.g. `sha256`, `dropbox-content-hash`). */
  providerChecksum: readonly string[];
  appScopedStorage: boolean;
  quotaAvailable: boolean;
}

/** Account/target-level capability override obtained from `probe`. */
export interface TargetCapabilities extends CloudBackupCapabilities {
  quotaBytes?: number | null;
  quotaUsedBytes?: number | null;
  accountType?: string;
}

/** Vendor auth description; the core runs the PKCE flow based on it. */
export interface OAuthProviderDescriptor {
  providerId: CloudProviderId;
  /** Authorization code endpoint. */
  authorizationEndpoint: string;
  /** Token endpoint (also used for refresh). */
  tokenEndpoint: string;
  /** Optional revocation endpoint. */
  revocationEndpoint?: string;
  scopes: readonly string[];
  /** Whether PKCE is supported/required (true for all official providers). */
  pkce: boolean;
  /** Callback form; official desktop flows uniformly use a loopback address. */
  redirect: "loopback";
  /** Callback path (loopback only); `/` allows any port registered with the vendor. */
  redirectPath?: string;
  /**
   * Preferred loopback callback ports; a random port is used when empty.
   *
   * Only used when the vendor requires pre-registered fixed callback ports; if a port is occupied it falls back, and if all are occupied it reports an
   * explicit state (design §6.1).
   */
  redirectPorts?: readonly number[];
  /** Whether a new refresh token may be returned on refresh token rotation. */
  refreshTokenRotation: boolean;
  /** Hint for how to obtain the account identifier, read by the core after the exchange. */
  accountIdClaim?: "id_token:sub" | "id_token:email" | "response:account_id";
}

/* ------------------------------------------------------------------ *
 * Runtime context (design §15.2)
 * ------------------------------------------------------------------ */

/** Read-only byte source; supports offset reads to reuse resumable transfers. */
export interface ScopedReadSource {
  size: number;
  /** Read by offset/length; the returned byte count may be smaller than the requested length. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Full sequential stream (for upload), cancellable via `signal`. */
  stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

/** A captured asset closure item. */
export interface CloudCapturedAsset extends ScopedReadSource {
  /** Relative path (already validated on the core side; escaping is forbidden). */
  path: string;
  sha256: string;
  mimeType?: string;
}

/** Consistent capture result handle; the temporary copy may be reclaimed after `release`. */
export interface CloudCaptureHandle {
  notebookId: string;
  notebookName: string;
  contentSeq: number;
  schemaVersion: number;
  database: ScopedReadSource & { sha256: string };
  assets: CloudCapturedAsset[];
  release(): Promise<void>;
}

/** Data capture facade (design §3.1 "data capture"). */
export interface NotebookCaptureAPI {
  capture(
    notebookId: string,
    options?: { signal?: AbortSignal },
  ): Promise<CloudCaptureHandle>;
}

/** Asset access facade; only allows access to pinned assets within an authorized Notebook. */
export interface ScopedReadStreamAPI {
  open(sha256: string, signal?: AbortSignal): Promise<ScopedReadSource>;
}

/** Short-lived access token provider; the core handles single-flight refresh. */
export interface AccessTokenProvider {
  getAccessToken(): Promise<{ token: string; expiryDate?: number }>;
}

/** Input for a single restricted HTTP request. */
export interface AuthorizedRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
  /** When the URL already carries credentials (e.g. an upload session URL), injecting Bearer is forbidden. */
  raw?: boolean;
  /** Response body read limit; defaults to 8MiB. */
  maxBytes?: number;
}

/** Restricted HTTP response. */
export interface AuthorizedResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

/** Account and credential facade; extensions cannot obtain refresh tokens or other Providers' tokens. */
export interface ScopedAccountAPI {
  current(): CloudAccountRef;
  /** Trusted first-party extensions may hold a short-lived access token for a limited time. */
  tokenProvider(): AccessTokenProvider;
  /** Restricted HTTP client that injects Bearer and handles the 401 refresh/redirect policy. */
  request(url: string, init?: AuthorizedRequest): Promise<AuthorizedResponse>;
  /**
   * Stream a download to a core-private temporary file; large objects do not enter memory.
   *
   * @returns The temporary file path, byte count, and optional application SHA-256.
   */
  downloadToFile(
    url: string,
    init?: AuthorizedRequest,
    options?: {
      maxBytes?: number;
      hash?: boolean;
      /**
       * Destination path relative to the core temp directory; the core validates path escapes.
       * Used during restore to place the database and assets at the relative locations declared in the manifest.
       */
      dest?: string;
    },
  ): Promise<{ filePath: string; bytes: number; sha256?: string }>;
  /**
   * Streaming upload; the request body comes from a captured asset or database source.
   *
   * @returns The vendor response (the 308 of a resumable chunk upload is returned here too).
   */
  upload(
    url: string,
    init: AuthorizedRequest & { source: AsyncIterable<Uint8Array> },
  ): Promise<AuthorizedResponse>;
}

/** Authorized HTTP client (same rules as `ScopedAccountAPI.request`). */
export type AuthorizedHTTPAPI = ScopedAccountAPI["request"];

/** Task progress and cancellation facade. */
export interface TaskProgressAPI {
  signal: AbortSignal;
  /** Report progress (0..1; when omitted, interpreted as bytes). */
  progress(bytes: number, message?: string): void;
  /** Redacted log: only duration/size/error codes are recorded. */
  log(level: "info" | "warn" | "error", message: string): void;
  /** Rate-limit budget (concurrent upload count), shared by the core per account. */
  concurrency(): number;
}

/** Local scoped state (design §14.1); isolated per Provider namespace. */
export interface ScopedLocalStateAPI {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Verification facade: unifies the interpretation of SHA-256 and vendor checksums (design §13.1). */
export interface BackupVerificationAPI {
  /** Compute the application SHA-256 of a byte stream. */
  sha256(bytes: Uint8Array): string;
  /** Incremental hasher for chunked streaming verification. */
  createHasher(): { update(chunk: Uint8Array): void; digest(): string };
}

/** The full runtime context the core hands to an extension. */
export interface BackupHostContext {
  capture: NotebookCaptureAPI;
  resources: ScopedReadStreamAPI;
  accounts: ScopedAccountAPI;
  http: AuthorizedHTTPAPI;
  /** Progress/cancellation/rate-limit facade bound to the current task. */
  tasks: TaskProgressAPI;
  /**
   * Local scoped state; the core isolates namespaces by `providerId + notebookId`,
   * so extensions can use simple keys like `slots` and `notebook.ref`.
   */
  state: ScopedLocalStateAPI;
  verifier: BackupVerificationAPI;
  /** Current Notebook; may be empty in scenarios such as capability probing. */
  notebookId?: string;
  /** Device label of the current target, for display in the backup directory and manifest. */
  deviceLabel?: string;
}

/* ------------------------------------------------------------------ *
 * Provider interface (design §15.1)
 * ------------------------------------------------------------------ */

/** `probe` input. */
export interface AccountContext {
  account: CloudAccountRef;
  ctx: BackupHostContext;
}

/** `ensureTarget` input. */
export interface TargetInput {
  notebookId: string;
  notebookName: string;
  deviceSlotId: string;
  deviceLabel?: string;
  /** Existing target reference; used to reuse directories on reconfiguration. */
  existing?: { rootRef?: string; notebookRef?: string };
}

/** Target handle: an opaque reference the extension returns to the core. */
export interface BackupTargetHandle {
  rootRef: string;
  notebookRef: string;
  deviceSlotRef?: string;
  /** The actual capability override probed this time. */
  capabilities?: TargetCapabilities;
}

/** `plan` input: the capture result and the most recent successful state. */
export interface CapturedBackupInput {
  capture: CloudCaptureHandle;
  target: BackupTargetHandle;
  /** Manifest of the last successful commit; used to reuse assets and compare databases. */
  previous?: CloudBackupManifest | null;
  /** The last successfully published head. */
  previousHead?: CloudBackupHead | null;
  /** Whether to still confirm the pointer state during a no-change check. */
  verifyOnly?: boolean;
}

/** An item in the upload plan. */
export interface CloudUploadItem {
  kind: "database" | "asset" | "manifest";
  sha256: string;
  size: number;
  /** Remote locator to reuse; if absent, the object needs uploading. */
  reuse?: CloudObjectLocator;
  assetPath?: string;
}

/** Diff plan and space budget. */
export interface CloudBackupPlan {
  commitId: string;
  items: CloudUploadItem[];
  uploadBytes: number;
  /** Nothing to upload (both the database and all assets can be reused). */
  unchanged: boolean;
  requiredBytes: number;
  availableBytes?: number | null;
  /** Whether the plan has objects pending cleanup. */
  cleanupCandidates?: number;
  /**
   * The capture result of this plan; attached by the core after `plan` so that `execute`
   * can obtain a read-only database and asset sources without the extension holding temporary paths.
   */
  capture?: CloudCaptureHandle;
}

/** A set of remote objects that have been uploaded but not yet published. */
export interface PreparedRemoteBackup {
  commitId: string;
  database: CloudBackupObjectRef;
  assets: (CloudBackupObjectRef & { path: string })[];
  /** Bytes actually transferred this time. */
  transferredBytes: number;
  /** Whether all objects have been uploaded (true when unchanged). */
  complete: boolean;
  /**
   * Manifest skeleton: the `execute` phase fills in object references and identity, but the
   * verification level is not yet determined; the `verify` phase completes it, uploads, and backfills `manifestRef`/`manifestSha256`.
   */
  manifestDraft: CloudBackupManifest;
  /** Opaque reference to the uploaded manifest; filled in after `verify` succeeds. */
  manifestRef?: CloudObjectLocator;
  manifestSha256?: string;
  /** Final manifest after read-back confirmation. */
  manifest?: CloudBackupManifest;
}

/** Publish input. */
export interface PublishInput {
  prepared: PreparedRemoteBackup;
  /** Expected current head version token; undefined when conditional writes are unsupported. */
  expectedVersionToken?: string;
  /** The most recently observed head, used for pre/post-publish checks. */
  observedHead?: CloudBackupHead | null;
}

/** Publish result. */
export interface CommittedBackup {
  commitId: string;
  head: CloudBackupHead;
  /** Publish read-back confirmation level. */
  verification: CloudVerificationLevel;
  versionToken?: string;
}

export interface ReconcileInput {
  expectedCommitId: string;
}

export interface ReconcileResult {
  /** Exact commitId of the remote head (if published). */
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
  /** Manifest reference fixed for reading; no further selection after restore starts. */
  manifestRef?: string;
}

/** Restore bundle: objects downloaded into the core-private temp directory. */
export interface RestoreBundle {
  manifest: CloudBackupManifest;
  /** Temporary database file (inside the core-private temp directory). */
  databasePath: string;
  databaseSha256: string;
  /** Temporary asset files; `path` is the relative path in the manifest. */
  assets: { path: string; sha256: string; size: number; filePath: string }[];
  /** Verification level during download. */
  verification: CloudVerificationLevel;
}

export interface CleanupPlan {
  /** Only these managed locators may be cleaned up. */
  objects: CloudObjectLocator[];
}

export interface CleanupResult {
  deleted: number;
  failed: number;
}

/** Cloud Provider implemented by an official extension (design §15.1). */
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
   * Explicitly delete the managed objects of a device slot (design §5.4).
   *
   * This is a destructive operation independent of "disconnect" and must be triggered by
   * the user after confirming the scope of impact; when unimplemented, the UI only prompts for manual cleanup and never silently substitutes managed GC.
   */
  deleteSlot?(
    input: { deviceSlotId: string },
    ctx: BackupHostContext,
  ): Promise<CleanupResult>;
}

/* ------------------------------------------------------------------ *
 * Backup center public API (shared by the SDK and first-party adapters)
 * ------------------------------------------------------------------ */

/** Target view needed by a backup center card. */
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

/** Restore landing result. */
export interface CloudRestoreResult {
  notebookId: string;
  name: string;
  databaseSha256: string;
  assets: number;
  verification: CloudVerificationLevel;
}

/** Public SDK surface for cloud backup. */
export interface CloudBackupAPI {
  listProviders(input?: object): Promise<
    {
      id: CloudProviderId;
      title: string;
      beta: boolean;
      installed: boolean;
      capabilities: CloudBackupCapabilities;
      /** Vendor scopes to be requested; shown truthfully before connecting. */
      scopes: readonly string[];
    }[]
  >;
  listAccounts(input?: object): Promise<CloudBackupAccount[]>;
  beginAuthorization(input: {
    providerId: CloudProviderId;
    /** Self-compiled builds can inject a custom OAuth Client ID. */
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
