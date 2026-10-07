/** Manifest of a first-party extension. */
export interface HostedExtensionManifest {
  id: string;
  name: string;
  version: string;
  runtime: "trusted-first-party";
  permissions: string[];
  commands: { id: string; title: string }[];
}

/** Runtime status of a first-party extension under a Notebook. */
export interface HostedExtensionStatus extends HostedExtensionManifest {
  enabled: boolean;
  state: "disabled" | "idle" | "activating" | "active" | "failed";
  error?: string;
}

/** Launcher provided by the app; never from the renderer or a manifest. */
export interface HostProcess {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
  kill(): unknown;
}

/** Bundled first-party extension: manifest + entry file path. */
export interface BundledExtension {
  manifest: HostedExtensionManifest;
  entry: string;
}

/**
 * Lifecycle observation of one "extension × Notebook" session.
 *
 * Emitted so the host can record plugin startup and crashes for diagnostics
 * without the extension code itself gaining any new capability.
 */
export interface HostedExtensionEvent {
  kind: "start" | "ready" | "crash" | "stop" | "error";
  extensionId: string;
  notebookId: string;
  error?: string;
}
