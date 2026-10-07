/**
 * Anynote release matrix: the single source of truth for independently versioned
 * release units and the formats they exchange.
 *
 * 设计 §19.2 要求 Desktop、Worker、SDK、首方插件各自独立发布，并明确跨版本
 * 兼容窗口。此模块把这些事实收敛为一份可执行契约：它只描述版本与兼容关系，
 * 不做任何 I/O，也不依赖 Node、Electron、存储或 UI，因此桌面主进程、Worker
 * 与发布工具可以读取同一份定义。
 *
 * 维护约定：
 * - `releaseUnits[].version` 必须等于对应 package.json 的 `version`。
 * - `releaseUnits[].contract` 必须等于代码中导出的契约常量（如
 *   `apiContractVersion`）。
 * - `releaseFormats[].version` 必须等于各格式 zod schema / 表结构写入的版本。
 * - 兼容窗口一旦声明即视为对旧消费者的承诺，`legacyConsumers` 固定住需要
 *   持续通过的旧调用面 fixture。
 *
 * `tests/release-matrix.test.mjs` 会把上述约定与真实代码逐项比对。
 */

/** 独立版本、独立发布的组成部分。 */
export type ReleaseUnitId =
  | "desktop"
  | "worker"
  | "sdk"
  | "devtools"
  | "first-party"
  | "format";

/** 跨单元协商版本的接口（文件格式、协议或数据库 schema）。 */
export type FormatId =
  | "notebook-schema"
  | "notebook-archive"
  | "logical-protocol"
  | "local-backup"
  | "extension-package"
  | "extension-directory"
  | "extension-settings";

/** 单元的交付渠道。 */
export type ReleaseChannel =
  | "npm"
  | "github-release"
  | "cloudflare-deploy"
  | "internal";

/** 单元对外暴露的一个 ESM/类型入口。 */
export interface ReleaseEntrypoint {
  /** 相对包根的子路径导出，如 `.` 或 `./packages/extension-tools/cli.js`。 */
  readonly subpath: string;
  /** 类型声明文件；纯 CLI 入口可缺省。 */
  readonly types?: string;
  /** ESM 运行时入口。 */
  readonly import: string;
}

export interface ReleaseUnit {
  readonly id: ReleaseUnitId;
  /** npm 包名；桌面应用保留其应用标识。 */
  readonly package: string;
  /** 单元独立版本，等于其 package.json 的 version。 */
  readonly version: string;
  /** 公开调用面的独立契约版本；无调用面的单元省略。 */
  readonly contract?: number;
  /** 向消费者公布的运行时要求（真实 engine，不含自定义字段）。 */
  readonly engines: Readonly<Record<string, string>>;
  /** SPDX 标识；尚未选定许可证时使用 `SEE LICENSE IN LICENSE`。 */
  readonly license: string;
  readonly channel: ReleaseChannel;
  /** 是否产出可安装的 npm tarball。 */
  readonly publishable: boolean;
  /** 打包进产物的 ESM/类型入口。 */
  readonly entrypoints: readonly ReleaseEntrypoint[];
  /** CLI 单元声明的可执行文件映射。 */
  readonly bin?: Readonly<Record<string, string>>;
  /** 发布清单与文档中的一句话描述。 */
  readonly description: string;
}

export interface ReleaseFormat {
  readonly id: FormatId;
  /** 文件/表标识；无字符串标识时使用空串。 */
  readonly tag: string;
  /** 当前代码写入的整数格式版本。 */
  readonly version: number;
  /** 定义并演进该格式的单元。 */
  readonly owner: ReleaseUnitId;
}

export interface CompatibilityWindow {
  /** 消费该接口的单元。 */
  readonly consumer: ReleaseUnitId;
  /** 提供该接口的单元或格式。 */
  readonly provider: ReleaseUnitId | FormatId;
  /** 单元使用 semver range，格式使用整数 range（如 `<=2`）。 */
  readonly accepts: string;
  readonly note: string;
}

/** 固定旧公开调用面的消费者 fixture，用于持续验证向前兼容。 */
export interface LegacyConsumer {
  /** fixture 固定的单元公开调用面。 */
  readonly units: readonly ReleaseUnitId[];
  /** fixture 编写时的契约版本，按单元 id 索引。 */
  readonly contracts: Readonly<Record<string, number>>;
  /** 仓库相对目录。 */
  readonly fixture: string;
}

/** 矩阵数据自身的版本标识。 */
export const releaseMatrixFormat = "anynote.release-matrix.v1";

/**
 * 发布清单（构建产物）的版本标识。
 * `scripts/build-release-matrix.mjs` 生成，`scripts/release-matrix-smoke.mjs` 消费。
 */
export const releaseManifestFormat = "anynote.release-manifest.v1";

/** 各单元统一使用的 SPDX 许可证标识；许可证文本见仓库根 LICENSE。 */
export const releaseLicense = "MIT";

/**
 * 各组成单元的独立版本与发布渠道。桌面版本以根 package.json 为准（`release.yml`
 * 也据此校验标签），其余单元以各自 package.json 为准。
 */
const unitList: readonly ReleaseUnit[] = [
  {
    id: "desktop",
    package: "@anynote/desktop",
    version: "0.1.0",
    engines: { node: ">=24.0.0", electron: "41.9.1" },
    license: releaseLicense,
    channel: "github-release",
    publishable: false,
    entrypoints: [],
    description: "Electron 桌面应用（Main / Preload / Renderer）",
  },
  {
    id: "worker",
    package: "@anynote/cloudflare-backup",
    version: "0.1.0",
    engines: { node: ">=24.0.0" },
    license: releaseLicense,
    channel: "cloudflare-deploy",
    publishable: false,
    entrypoints: [],
    description: "Cloudflare Worker + D1 + R2 逻辑备份服务",
  },
  {
    id: "sdk",
    package: "@anynote/plugin-sdk",
    version: "0.1.0",
    contract: 1,
    engines: { node: ">=24.0.0" },
    license: releaseLicense,
    channel: "npm",
    publishable: true,
    entrypoints: [
      { subpath: ".", types: "./index.d.ts", import: "./index.js" },
    ],
    description: "插件公共 API、声明式扩展与本地备份契约",
  },
  {
    id: "devtools",
    package: "@anynote/extension-tools",
    version: "0.1.0",
    engines: { node: ">=24.0.0" },
    license: releaseLicense,
    channel: "npm",
    publishable: true,
    entrypoints: [
      {
        subpath: "./packages/extension-tools/cli.js",
        types: "./packages/extension-tools/cli.d.ts",
        import: "./packages/extension-tools/cli.js",
      },
    ],
    bin: { "anynote-extension": "./packages/extension-tools/cli.js" },
    description: "扩展脚手架、清单校验与隔离试运行 CLI",
  },
  {
    id: "first-party",
    package: "@anynote/first-party-adapters",
    version: "0.1.0",
    contract: 1,
    engines: { node: ">=24.0.0" },
    license: releaseLicense,
    channel: "npm",
    publishable: true,
    entrypoints: [
      { subpath: ".", types: "./index.d.ts", import: "./index.js" },
    ],
    description: "白板、视频、导入与本地备份的首方可移植适配器",
  },
  {
    id: "format",
    package: "@anynote/protocol",
    version: "0.1.0",
    engines: {},
    license: releaseLicense,
    channel: "internal",
    publishable: false,
    entrypoints: [],
    description: "Notebook schema、归档、逻辑备份与扩展文件格式",
  },
];
export const releaseUnits: readonly ReleaseUnit[] = Object.freeze(unitList);

/** 需要跨单元协商的格式版本。 */
const formatList: readonly ReleaseFormat[] = [
  {
    id: "notebook-schema",
    tag: "notebook.sqlite",
    version: 2,
    owner: "format",
  },
  {
    id: "notebook-archive",
    tag: "anynote.notebook",
    version: 1,
    owner: "format",
  },
  {
    id: "logical-protocol",
    tag: "anynote.logical",
    version: 1,
    owner: "format",
  },
  {
    id: "local-backup",
    tag: "anynote.local-backup",
    version: 1,
    owner: "format",
  },
  {
    id: "extension-package",
    tag: "anynote.extension",
    version: 1,
    owner: "format",
  },
  {
    id: "extension-directory",
    tag: "anynote.extension-directory",
    version: 1,
    owner: "format",
  },
  {
    id: "extension-settings",
    tag: "anynote.extension-settings",
    version: 1,
    owner: "format",
  },
];
export const releaseFormats: readonly ReleaseFormat[] =
  Object.freeze(formatList);

/**
 * 兼容窗口。`accepts` 表达“消费者接受提供者处于哪个版本区间”：
 * - 单元使用 semver range（支持 `*`、精确版本、`^`、`~`、`>=`/`<=`/`>`/`<`）。
 * - 格式使用整数 range（精确版本或 `<=`/`>=`/`<`/`>`）。
 * 设计 §19.2 要求无法兼容时明确拒绝，而不是静默降级写入。
 */
const windowList: readonly CompatibilityWindow[] = [
  {
    consumer: "desktop",
    provider: "notebook-schema",
    accepts: "<=2",
    note: "桌面可读写 schema 1（先迁移）与 2；更高 schema 明确拒绝",
  },
  {
    consumer: "desktop",
    provider: "notebook-archive",
    accepts: "1",
    note: "完整归档 anynote.notebook v1",
  },
  {
    consumer: "desktop",
    provider: "logical-protocol",
    accepts: "1",
    note: "与 Worker 仅在同一逻辑备份协议版本内互操作",
  },
  {
    consumer: "worker",
    provider: "logical-protocol",
    accepts: "1",
    note: "Worker 只接受 anynote.logical v1 请求",
  },
  {
    consumer: "desktop",
    provider: "sdk",
    accepts: "^0.1.0",
    note: "桌面宿主实现 SDK 0.1 契约（apiContractVersion 1）",
  },
  {
    consumer: "first-party",
    provider: "sdk",
    accepts: "^0.1.0",
    note: "首方适配器只使用 SDK 0.1 的公开导出",
  },
  {
    consumer: "desktop",
    provider: "extension-package",
    accepts: "1",
    note: "签名扩展包 anynote.extension.v1",
  },
  {
    consumer: "desktop",
    provider: "extension-directory",
    accepts: "1",
    note: "扩展目录 anynote.extension-directory.v1",
  },
  {
    consumer: "desktop",
    provider: "extension-settings",
    accepts: "1",
    note: "扩展设置 anynote.extension-settings.v1",
  },
  {
    consumer: "desktop",
    provider: "local-backup",
    accepts: "1",
    note: "本地磁盘备份清单 anynote.local-backup v1",
  },
];
export const compatibilityWindows: readonly CompatibilityWindow[] =
  Object.freeze(windowList);

/**
 * 旧消费者 fixture 清单。首个版本尚无历史发布，这里的 fixture 即 0.1 消费者；
 * 后续版本必须继续通过，除非在矩阵中显式提升兼容窗口并更新 fixture。
 */
const legacyList: readonly LegacyConsumer[] = [
  {
    units: ["sdk", "first-party"],
    contracts: { sdk: 1, "first-party": 1 },
    fixture: "tests/fixtures/legacy-consumer",
  },
];
export const legacyConsumers: readonly LegacyConsumer[] =
  Object.freeze(legacyList);

const unitById = new Map<ReleaseUnitId, ReleaseUnit>(
  releaseUnits.map((unit) => [unit.id, unit]),
);
const formatById = new Map<FormatId, ReleaseFormat>(
  releaseFormats.map((format) => [format.id, format]),
);

/** 是否为格式标识（而非单元标识）。 */
export function isFormatId(value: string): value is FormatId {
  return formatById.has(value as FormatId);
}

export function getReleaseUnit(id: ReleaseUnitId): ReleaseUnit {
  const unit = unitById.get(id);
  if (!unit) throw Error(`未知发布单元: ${id}`);
  return unit;
}

export function getReleaseFormat(id: FormatId): ReleaseFormat {
  const format = formatById.get(id);
  if (!format) throw Error(`未知发布格式: ${id}`);
  return format;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(value: string): Semver | undefined {
  const match = semverPattern.exec(value.trim());
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
      }
    : undefined;
}

function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function upperBound(semver: Semver, operator: "caret" | "tilde"): Semver {
  if (operator === "tilde")
    return { major: semver.major, minor: semver.minor + 1, patch: 0 };
  if (semver.major > 0) return { major: semver.major + 1, minor: 0, patch: 0 };
  if (semver.minor > 0) return { major: 0, minor: semver.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: semver.patch + 1 };
}

function satisfiesComparator(target: Semver, comparator: string): boolean {
  const token = comparator.trim();
  if (!token) return true;
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(\d+\.\d+\.\d+)$/.exec(token);
  if (!match) return false;
  const bound = parseSemver(match[2]) as Semver;
  switch (match[1]) {
    case ">=":
      return compareSemver(target, bound) >= 0;
    case ">":
      return compareSemver(target, bound) > 0;
    case "<=":
      return compareSemver(target, bound) <= 0;
    case "<":
      return compareSemver(target, bound) < 0;
    case "^":
      return (
        compareSemver(target, bound) >= 0 &&
        compareSemver(target, upperBound(bound, "caret")) < 0
      );
    case "~":
      return (
        compareSemver(target, bound) >= 0 &&
        compareSemver(target, upperBound(bound, "tilde")) < 0
      );
    default:
      return compareSemver(target, bound) === 0;
  }
}

/** 判断版本是否落在 semver range 内（支持子集：`*`、精确、`^`、`~`、比较符）。 */
export function satisfiesRange(version: string, range: string): boolean {
  const target = parseSemver(version);
  if (!target) return false;
  const normalized = range.trim();
  if (!normalized || normalized === "*") return true;
  return normalized
    .split(/[\s,]+/)
    .filter(Boolean)
    .every((comparator) => satisfiesComparator(target, comparator));
}

/** 判断整数格式版本是否落在格式 range 内。 */
export function satisfiesFormatRange(version: number, range: string): boolean {
  const match = /^(<=|>=|<|>|=)?\s*(\d+)$/.exec(range.trim());
  if (!Number.isInteger(version) || !match) return false;
  const bound = Number(match[2]);
  switch (match[1]) {
    case "<=":
      return version <= bound;
    case ">=":
      return version >= bound;
    case "<":
      return version < bound;
    case ">":
      return version > bound;
    default:
      return version === bound;
  }
}

export type CompatibilityVerdict =
  | { readonly compatible: true; readonly window: CompatibilityWindow }
  | { readonly compatible: false; readonly reason: string };

/**
 * 校验“消费者 + 提供者 + 提供者版本”是否落在声明的兼容窗口内。
 * 消费者未声明该提供者时返回不兼容，遵循“无法兼容就明确拒绝”。
 */
export function checkReleaseCompatibility(
  consumer: ReleaseUnitId,
  provider: ReleaseUnitId | FormatId,
  version: string | number,
): CompatibilityVerdict {
  const window = compatibilityWindows.find(
    (candidate) =>
      candidate.consumer === consumer && candidate.provider === provider,
  );
  if (!window)
    return {
      compatible: false,
      reason: `${consumer} 未声明对 ${provider} 的兼容窗口`,
    };
  const accepted = isFormatId(provider)
    ? typeof version === "number" &&
      satisfiesFormatRange(version, window.accepts)
    : typeof version === "string" && satisfiesRange(version, window.accepts);
  return accepted
    ? { compatible: true, window }
    : {
        compatible: false,
        reason: `${consumer} 接受 ${provider} ${window.accepts}，当前 ${version} 超出兼容窗口`,
      };
}

/** `checkReleaseCompatibility` 的断言版本，越界即抛错。 */
export function assertReleaseCompatibility(
  consumer: ReleaseUnitId,
  provider: ReleaseUnitId | FormatId,
  version: string | number,
): void {
  const verdict = checkReleaseCompatibility(consumer, provider, version);
  if (!verdict.compatible) throw Error(verdict.reason);
}

/** 返回单元或格式的当前版本字符串，便于日志与校验。 */
export function releaseVersion(id: ReleaseUnitId | FormatId): string {
  return isFormatId(id)
    ? String(getReleaseFormat(id).version)
    : getReleaseUnit(id).version;
}
