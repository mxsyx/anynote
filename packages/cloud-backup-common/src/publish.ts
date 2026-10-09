import type {
  CloudBackupHead,
  CloudVerificationLevel,
  CommittedBackup,
} from "@anynote/types/cloud-backup.js";

/** 条件写结果。 */
export interface HeadWriteResult {
  /** 条件写被拒绝（存在并发写入者）。 */
  conflict?: boolean;
  /** 写入后的版本 token，供下次条件写使用。 */
  versionToken?: string;
}

export interface PublishHeadOptions {
  head: CloudBackupHead;
  /** 是否具备经实测的条件写能力（设计 §9.2）。 */
  conditional: boolean;
  /** 期望的 head 版本 token；不具备条件写时为 undefined。 */
  expectedVersionToken?: string;
  /** 写入 head；请求响应丢失时实现会抛出网络错误。 */
  write(
    head: CloudBackupHead,
    expectedVersionToken?: string,
  ): Promise<HeadWriteResult>;
  /** 读回 head；不存在时返回 null。 */
  read(): Promise<CloudBackupHead | null>;
  /** 发布读回确认等级。 */
  verification: CloudVerificationLevel;
}

/**
 * 发布当前指针并读回确认（设计 §8.2、§14.2）。
 *
 * 关键约束：
 * - 只有不可变对象就绪后才调用；
 * - 条件写被拒绝表示存在并发写入者，立即停写并保留原 head；
 * - 写请求响应丢失时通过读回 head 判断本次 commit 是否已生效，而不是盲目重写；
 * - 读回的 head 不是本次 commit 时视为未确认，调用方不得清理旧对象。
 *
 * @param options 发布参数。
 * @returns 已提交备份。
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
    // 响应丢失：读回判断本次 commit 是否已经生效，而不是重新盲写。
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
 * 提交结果不确定时只读确认。
 *
 * @param head 待确认的 head。
 * @param read 读回函数。
 * @returns 已确认的 head，或 null 表示未提交。
 */
export async function confirmCommittedHead(
  head: CloudBackupHead,
  read: () => Promise<CloudBackupHead | null>,
): Promise<CloudBackupHead | null> {
  const observed = await read();
  return observed?.commitId === head.commitId ? observed : null;
}
