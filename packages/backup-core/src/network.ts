import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { CloudBackupTarget } from "@anynote/types/cloud-backup.js";
import { environmentPause, readPolicy } from "@anynote/backup/policy.js";

export function cloudPause(s: Storage, target: CloudBackupTarget) {
  const { policy, environment } = readPolicy(s);
  return environmentPause(policy, environment, target.lastTaskBytes, true);
}

export function assertCloudOnline(s: Storage) {
  if (readPolicy(s).environment.online === false)
    throw Error("当前设备离线，请连接网络后重试；自动备份会在网络恢复后继续。");
}
