import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenPptError, ErrorCodes } from "../errors.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const THEME_IDS = new Set(["default", "dark", "magazine", "report"]);

/**
 * @param {string} themeId default|dark|magazine|report
 */
export function loadThemeColors(themeId) {
  if (!THEME_IDS.has(themeId)) {
    throw new OpenPptError(
      ErrorCodes.IO,
      `Unknown theme "${themeId}" (available: default, dark, magazine, report)`,
      { themeId },
    );
  }
  const path = join(rootDir, "themes", `${themeId}.json`);
  if (!existsSync(path)) {
    throw new OpenPptError(
      ErrorCodes.IO,
      `Unknown theme "${themeId}" (available: default, dark, magazine, report)`,
      { themeId },
    );
  }
  const doc = JSON.parse(readFileSync(path, "utf8"));
  return doc.colors || {};
}
