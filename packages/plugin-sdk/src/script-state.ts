import type { ScriptState } from "./declarative.js";

/** Structure and size budgets for script state. */
export const scriptStateLimits = Object.freeze({
  bytes: 64 * 1024,
  depth: 16,
  nodes: 4096,
});

/**
 * Only JSON data may cross the interpreter boundary; this module is host-side only.
 *
 * @param value Candidate script state.
 * @returns The validated script state.
 */
export function validateScriptState(value: unknown): ScriptState {
  let nodes = 0;

  /**
   * Recursively validate a value's JSON structure, node count, and depth, rejecting accessors and symbol keys.
   *
   * @param item Value to validate.
   * @param depth Current depth.
   */
  function visit(item: unknown, depth: number): void {
    if (++nodes > scriptStateLimits.nodes || depth > scriptStateLimits.depth)
      throw Error("脚本状态结构超过预算");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || !item)
      throw Error("脚本状态必须是 JSON 数据");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype
    )
      throw Error("脚本状态必须是普通 JSON 对象");
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      const field = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== "string" || !field.enumerable || !("value" in field))
        throw Error("脚本状态不能包含访问器或符号");
      visit(field.value, depth + 1);
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("脚本状态必须是 JSON 对象");
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > scriptStateLimits.bytes)
    throw Error("脚本状态超过 64KiB 预算");
  return value as ScriptState;
}
