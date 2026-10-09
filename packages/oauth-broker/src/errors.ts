/**
 * Explicit error classification for the OAuth authorization flow (design §6.1).
 *
 * Design requires explicit states for "browser refusal, user cancellation, authorization timeout, and port in use"; a family of
 * `instanceof`-checkable error types carries these states, so upper layers (IPC / settings page / task center)
 * can give actionable prompts rather than throwing raw system errors at the user.
 */

/** Base class for recognizable errors during OAuth authorization. */
export class OAuthError extends Error {
  /**
   * @param message Readable message.
   * @param options Extra info such as the original error.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // Subclasses need not set name again; instanceof is unaffected but logs are clearer.
    this.name = new.target.name;
  }
}

/** The loopback callback port cannot be listened on (usually taken by another program). */
export class OAuthPortError extends OAuthError {}

/** Failed to open the authorization page in the system browser. */
export class OAuthLaunchError extends OAuthError {}

/** The authorization session timed out before receiving a callback. */
export class OAuthTimeoutError extends OAuthError {}

/** The callback `state` does not match the expected value; it may have been intercepted or forged. */
export class OAuthStateError extends OAuthError {}
