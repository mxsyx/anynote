/**
 * OAuth 授权流程的显式错误分类（设计 §6.1）。
 *
 * 设计要求「浏览器拒绝、用户取消、授权超时与端口占用均有明确状态」；这里用一族
 * 可 `instanceof` 判定的错误类型承载这些状态，让上层（IPC / 设置页 / 任务中心）
 * 能给出可操作提示，而不是把原始系统错误直接抛给用户。
 */

/** OAuth 授权过程中的可识别错误基类。 */
export class OAuthError extends Error {
  /**
   * @param message 可读信息。
   * @param options 原始错误等附加信息。
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // 子类无需重复设置 name，instanceof 判定不受影响但日志更清晰。
    this.name = new.target.name;
  }
}

/** 回环回调端口无法监听（通常已被其他程序占用）。 */
export class OAuthPortError extends OAuthError {}

/** 无法用系统浏览器打开授权页。 */
export class OAuthLaunchError extends OAuthError {}

/** 授权会话在收到回调前超时。 */
export class OAuthTimeoutError extends OAuthError {}

/** 回调 `state` 与预期不一致，可能被截获或伪造。 */
export class OAuthStateError extends OAuthError {}
