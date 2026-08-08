import { readFileSync, existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { OpenPptError, ErrorCodes } from "./errors.js";

/**
 * Load a deck IR document from a JSON or YAML file path.
 * @param {string} filePath
 * @returns {{ deck: object, projectRoot: string, sourcePath: string }}
 */
export function loadDeck(filePath) {
  const sourcePath = resolve(filePath);
  if (!existsSync(sourcePath)) {
    throw new OpenPptError(ErrorCodes.IO, `Deck file not found: ${sourcePath}`);
  }
  const raw = readFileSync(sourcePath, "utf8");
  const ext = extname(sourcePath).toLowerCase();
  let deck;
  try {
    if (ext === ".yaml" || ext === ".yml") {
      deck = parseYaml(raw);
    } else {
      deck = JSON.parse(raw);
    }
  } catch (err) {
    throw new OpenPptError(
      ErrorCodes.IO,
      `Failed to parse deck file: ${err instanceof Error ? err.message : String(err)}`,
      { sourcePath },
    );
  }
  if (deck === null || typeof deck !== "object" || Array.isArray(deck)) {
    throw new OpenPptError(ErrorCodes.IO, "Deck root must be a JSON/YAML object", {
      sourcePath,
    });
  }
  return {
    deck,
    projectRoot: dirname(sourcePath),
    sourcePath,
  };
}
