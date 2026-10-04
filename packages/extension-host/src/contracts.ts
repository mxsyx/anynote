export interface HostedExtensionManifest {
  id: string;
  name: string;
  version: string;
  runtime: "trusted-first-party";
  permissions: string[];
  commands: { id: string; title: string }[];
}
export interface HostedExtensionStatus extends HostedExtensionManifest {
  enabled: boolean;
  state: "disabled" | "idle" | "activating" | "active" | "failed";
  error?: string;
}
/** The launcher is supplied by the application, never by a renderer/manifest. */
export interface HostProcess {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
  kill(): unknown;
}
export interface BundledExtension {
  manifest: HostedExtensionManifest;
  entry: string;
}
