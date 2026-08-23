import { readFileSync, existsSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { OpenPptError, ErrorCodes } from "./errors.js";
import { safeProjectPath } from "./validate.js";
import { expandLayouts } from "./layout.js";
import { assertDeckResourceLimits } from "./resource-limits.js";

/**
 * Parse a JSON or YAML file into an object.
 * @param {string} sourcePath
 * @returns {object}
 */
function parseDocumentFile(sourcePath) {
  if (!existsSync(sourcePath)) {
    throw new OpenPptError(ErrorCodes.IO, `File not found: ${sourcePath}`);
  }
  const raw = readFileSync(sourcePath, "utf8");
  const ext = extname(sourcePath).toLowerCase();
  let doc;
  try {
    if (ext === ".yaml" || ext === ".yml") {
      doc = parseYaml(raw);
    } else {
      doc = JSON.parse(raw);
    }
  } catch (err) {
    throw new OpenPptError(
      ErrorCodes.IO,
      `Failed to parse file: ${err instanceof Error ? err.message : String(err)}`,
      { sourcePath },
    );
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new OpenPptError(ErrorCodes.IO, "Document root must be a JSON/YAML object", {
      sourcePath,
    });
  }
  return doc;
}

/**
 * Expand deck.pages entries that are relative file paths into page objects.
 * String entries must resolve under the project root (no escape).
 * @param {object} deck
 * @param {string} projectRoot
 */
export function expandExternalPages(deck, projectRoot) {
  if (!Array.isArray(deck.pages)) return deck;
  assertDeckResourceLimits(deck);
  const pages = deck.pages.map((entry, index) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return entry;
    }
    if (typeof entry !== "string") {
      throw new OpenPptError(
        ErrorCodes.IO,
        `pages[${index}] must be a page object or a relative path string`,
        { index },
      );
    }
    if (isAbsolute(entry)) {
      throw new OpenPptError(
        ErrorCodes.IO,
        `pages[${index}] absolute paths are not allowed: ${entry}`,
        { index, path: entry },
      );
    }
    const abs = safeProjectPath(projectRoot, entry);
    if (!existsSync(abs)) {
      throw new OpenPptError(ErrorCodes.IO, `Page file not found: ${entry}`, {
        index,
        path: entry,
        resolved: abs,
      });
    }
    const page = parseDocumentFile(abs);
    if (!page.id || !Array.isArray(page.elements)) {
      throw new OpenPptError(
        ErrorCodes.IO,
        `Page file must include id and elements: ${entry}`,
        { path: entry },
      );
    }
    return page;
  });
  const expanded = { ...deck, pages };
  assertDeckResourceLimits(expanded);
  return expanded;
}

/**
 * Load a deck IR document from a JSON or YAML file path.
 * Supports multi-file decks: pages may be strings pointing at page files under the project.
 * @param {string} filePath
 * @returns {{ deck: object, projectRoot: string, sourcePath: string }}
 */
export function loadDeck(filePath) {
  const sourcePath = resolve(filePath);
  const projectRoot = dirname(sourcePath);
  const rawDeck = parseDocumentFile(sourcePath);
  // Multi-file pages first, then layout groups → absolute leaf bounds.
  const withPages = expandExternalPages(rawDeck, projectRoot);
  const deck = expandLayouts(withPages);
  return {
    deck,
    projectRoot,
    sourcePath,
  };
}
