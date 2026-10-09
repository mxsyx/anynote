import type {
  CloudProviderId,
  OAuthProviderDescriptor,
} from "@anynote/types/cloud-backup.js";

/**
 * 官方 OAuth 应用描述（设计 §6.1、§6.3）。
 *
 * 桌面二进制与公开源码无法保密 Client Secret，因此全部按公共客户端 + PKCE
 * 处理；这里只描述端点、scope 与回调策略，不包含任何密钥。应用身份（Client
 * ID / App Key）由 `apps.ts` 单独解析。
 */
export const oauthDescriptors: Readonly<
  Record<CloudProviderId, OAuthProviderDescriptor>
> = Object.freeze({
  "google-drive": {
    providerId: "google-drive",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    // 默认最小权限：只访问本应用创建/打开的文件（设计 §10.1）。
    scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.file"],
    pkce: true,
    redirect: "loopback",
    refreshTokenRotation: false,
    accountIdClaim: "id_token:sub",
  },
  dropbox: {
    providerId: "dropbox",
    authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
    tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
    revocationEndpoint: "https://api.dropboxapi.com/2/auth/token/revoke",
    // App Folder 访问类型下按需申请读写 scope（设计 §11.1）。
    scopes: [
      "account_info.read",
      "files.metadata.read",
      "files.content.read",
      "files.content.write",
    ],
    pkce: true,
    redirect: "loopback",
    refreshTokenRotation: false,
    accountIdClaim: "response:account_id",
  },
  onedrive: {
    providerId: "onedrive",
    authorizationEndpoint:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // 使用应用目录与最小 delegated 权限（设计 §12.1）。
    scopes: ["offline_access", "User.Read", "Files.ReadWrite.AppFolder"],
    pkce: true,
    redirect: "loopback",
    refreshTokenRotation: true,
    accountIdClaim: "id_token:sub",
  },
});
