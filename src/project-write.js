import {
  existsSync,
  linkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { ErrorCodes, OpenPptError } from "./errors.js";

const LINK_FALLBACK_CODES = new Set(["EXDEV", "ENOTSUP", "ENOSYS"]);

/**
 * Install a staged file without clobbering an existing target. Filesystems that
 * cannot hard-link fall back to an exclusive create; all other link errors pass
 * through unchanged.
 * @param {string} temp
 * @param {string} target
 * @param {string | Buffer} contents
 * @param {typeof linkSync} [linkFile]
 */
export function installFileNoClobber(
  temp,
  target,
  contents,
  linkFile = linkSync,
) {
  try {
    linkFile(temp, target);
  } catch (err) {
    if (!LINK_FALLBACK_CODES.has(err?.code)) throw err;
    writeFileSync(target, contents, { flag: "wx" });
  }
}

/**
 * Atomically replace deck.json from a complete sibling temp file.
 * @param {string} deckPath
 * @param {string} contents
 * @param {{ force?: boolean, linkSync?: typeof linkSync, renameSync?: typeof renameSync, unlinkSync?: typeof unlinkSync }} [operations]
 */
export function writeDeckFileAtomic(deckPath, contents, operations = {}) {
  const force = Boolean(operations.force);
  const linkFile = operations.linkSync || linkSync;
  const renameFile = operations.renameSync || renameSync;
  const unlinkFile = operations.unlinkSync || unlinkSync;
  const temp = join(
    dirname(deckPath),
    `.openppt-deck-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temp, contents, "utf8");
    if (force) {
      renameFile(temp, deckPath);
      return;
    }
    installFileNoClobber(temp, deckPath, contents, linkFile);
  } catch (err) {
    let rollbackError = null;
    try {
      if (existsSync(temp)) unlinkFile(temp);
    } catch (cleanupErr) {
      rollbackError ||= cleanupErr;
    }
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `Deck write failed: ${err instanceof Error ? err.message : String(err)}` +
        (rollbackError
          ? `; cleanup incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          : ""),
    );
  }

  try {
    unlinkFile(temp);
  } catch {
    // The hard link is already committed; a leftover sibling temp is harmless.
  }
}
