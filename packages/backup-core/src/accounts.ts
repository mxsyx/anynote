import type { Storage } from "@anynote/storage-sqlite/index.js";
import type {
  CloudAccountRef,
  CloudBackupAccount,
  CloudProviderId,
} from "@anynote/types/cloud-backup.js";
import { resolveOAuthClient } from "@anynote/oauth-broker";
import { providerState, readAccounts, readTargets } from "./state.js";
import { officialProviders } from "./identity.js";

export const clientKey = "oauth.client.id";

export function customClientId(
  s: Storage,
  providerId: CloudProviderId,
): string | undefined {
  const value = providerState(s, providerId, clientKey);
  return typeof value === "string" && value ? value : undefined;
}

export function cloudAppSettings(s: Storage) {
  return officialProviders.map(({ id: providerId, title }) => {
    const custom = customClientId(s, providerId);
    const { clientId, source, stage } = resolveOAuthClient(providerId, custom);
    return {
      providerId,
      title,
      customClientId: custom ?? "",
      configured: !!clientId,
      source,
      stage,
    };
  });
}

/** An app-scoped directory belongs to this complete identity, never just an email. */
export function sameCloudIdentity(
  a: CloudAccountRef,
  b: CloudAccountRef,
): boolean {
  return (
    a.providerId === b.providerId &&
    a.oauthClientId === b.oauthClientId &&
    a.accountId === b.accountId &&
    a.context === b.context
  );
}

export function assertCloudAccount(
  account: CloudBackupAccount | undefined,
  providerId: CloudProviderId,
): asserts account is CloudBackupAccount {
  if (!account || account.reauthReason) throw Error("云盘账号需要重新登录");
  if (account.ref.providerId !== providerId)
    throw Error("云盘账号与目标厂商不匹配");
}

export function assertAccountIdle(s: Storage, accountRefId: string) {
  const targets = new Set(
    readTargets(s)
      .filter((t) => t.accountRefId === accountRefId)
      .map((t) => t.id),
  );
  if (
    [...s.jobs.values()].some(
      (j) =>
        targets.has(j.targetId ?? "") &&
        ["running", "committing"].includes(j.status),
    )
  )
    throw Error("该账号还有云盘任务运行，请等待完成或取消后重试");
}

export function connectedIdentity(s: Storage, ref: CloudAccountRef) {
  return readAccounts(s).find((a) => sameCloudIdentity(a.ref, ref));
}
