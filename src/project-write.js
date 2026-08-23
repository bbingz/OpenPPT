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
    linkFile(temp, deckPath);
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
