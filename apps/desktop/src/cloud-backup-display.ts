/** Content evidence only: pointer read-back must never be labelled as full data verification. */
export function verificationLabel(level?: string) {
  switch (level) {
    case "provider-checksum":
      return "厂商内容校验和已核对";
    case "download-sha256":
      return "已下载并核对 SHA-256";
    case "accepted-size":
      return "仅确认大小，未完成内容校验";
    default:
      return "未知（尚未取得校验证据）";
  }
}

export function formatCloudBytes(bytes?: number | null) {
  if (bytes == null) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
