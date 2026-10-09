import type {
  CloudBackupHead,
  CloudVerificationLevel,
  CommittedBackup,
} from "@anynote/types/cloud-backup.js";

/** Conditional write result. */
export interface HeadWriteResult {
  /** Conditional write was rejected (a concurrent writer exists). */
  conflict?: boolean;
  /** Version token after the write, for the next conditional write. */
  versionToken?: string;
}

export interface PublishHeadOptions {
  head: CloudBackupHead;
  /** Whether verified conditional-write capability exists (design §9.2). */
  conditional: boolean;
  /** Expected head version token; undefined when conditional writes are unsupported. */
  expectedVersionToken?: string;
  /** Write the head; the implementation throws a network error when the response is lost. */
  write(
    head: CloudBackupHead,
    expectedVersionToken?: string,
  ): Promise<HeadWriteResult>;
  /** Read back the head; returns null when absent. */
  read(): Promise<CloudBackupHead | null>;
  /** Publish read-back confirmation level. */
  verification: CloudVerificationLevel;
}

/**
 * Publish the current pointer and read it back for confirmation (design §8.2, §14.2).
 *
 * Key constraints:
 * - Called only after the immutable objects are ready;
 * - A rejected conditional write means a concurrent writer exists: stop writing immediately and keep the original head;
 * - When the write response is lost, read back the head to determine whether this commit took effect, rather than blindly rewriting;
 * - When the read-back head is not this commit, treat it as unconfirmed and do not clean up old objects.
 *
 * @param options Publish arguments.
 * @returns The committed backup.
 */
export async function publishHead(
  options: PublishHeadOptions,
): Promise<CommittedBackup> {
  let result: HeadWriteResult = {};
  try {
    result = await options.write(
      options.head,
      options.conditional ? options.expectedVersionToken : undefined,
    );
  } catch (error) {
    // Response lost: read back to determine whether this commit took effect, rather than blindly rewriting.
    const observed = await options.read();
    if (observed?.commitId === options.head.commitId)
      return {
        commitId: options.head.commitId,
        head: observed,
        verification: options.verification,
      };
    throw error;
  }
  if (result.conflict)
    throw Object.assign(
      Error("云端当前指针已被其他写入者更新，已停止写入并保留远端副本"),
      { code: "head-conflict" },
    );
  const observed = await options.read();
  if (observed?.commitId !== options.head.commitId)
    throw Object.assign(Error("云端当前指针读回确认失败，未确认本次提交"), {
      code: "publish-unconfirmed",
    });
  return {
    commitId: options.head.commitId,
    head: observed,
    verification: options.verification,
    versionToken: result.versionToken,
  };
}

/**
 * Read-only confirmation when the commit result is uncertain.
 *
 * @param head The head to confirm.
 * @param read Read-back function.
 * @returns The confirmed head, or null if not committed.
 */
export async function confirmCommittedHead(
  head: CloudBackupHead,
  read: () => Promise<CloudBackupHead | null>,
): Promise<CloudBackupHead | null> {
  const observed = await read();
  return observed?.commitId === head.commitId ? observed : null;
}
