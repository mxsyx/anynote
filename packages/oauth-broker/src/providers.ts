import type {
  CloudProviderId,
  OAuthProviderDescriptor,
} from "@anynote/types/cloud-backup.js";

/**
 * Official OAuth app descriptors (design §6.1, §6.3).
 *
 * Desktop binaries and public source cannot keep a Client Secret, so everything uses the public client + PKCE
 * approach; this only describes endpoints, scopes, and callback policy, with no secrets. App identity (Client
 * ID / App Key) is resolved separately by `apps.ts`.
 */
export const oauthDescriptors: Readonly<
  Record<CloudProviderId, OAuthProviderDescriptor>
> = Object.freeze({
  "google-drive": {
    providerId: "google-drive",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    // Minimal privilege by default: only access files created/opened by this app (design §10.1).
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
    // Under the App Folder access type, request read/write scopes on demand (design §11.1).
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
    // Use the app directory with minimal delegated permissions (design §12.1).
    scopes: ["offline_access", "User.Read", "Files.ReadWrite.AppFolder"],
    pkce: true,
    redirect: "loopback",
    refreshTokenRotation: true,
    accountIdClaim: "id_token:sub",
  },
});
