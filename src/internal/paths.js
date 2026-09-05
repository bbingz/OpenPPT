import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve path for equality checks (realpath when possible).
 * @param {string} p
 */
export function realOrResolve(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
