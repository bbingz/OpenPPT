/**
 * Scaffold a new OpenPPT project directory.
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenPptError, ErrorCodes } from "./errors.js";
import { writeDeckFileAtomic } from "./project-write.js";
import { validateDeck } from "./validate.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const THEME_IDS = new Set(["default", "dark", "magazine", "report"]);

/**
 * @param {string} themeId default|dark|magazine|report
 */
function loadThemeColors(themeId) {
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

/**
 * Create a starter deck project.
 * @param {string} outDir
 * @param {{ force?: boolean, theme?: string, title?: string, skeleton?: boolean }} [options]
 * @returns {{ deckPath: string, theme: string }}
 */
export function initProject(outDir, options = {}) {
  const { force = false, theme = "default", title = "Untitled deck", skeleton = false } =
    options;
  const dest = resolve(outDir);
  const deckPath = join(dest, "deck.json");

  if (existsSync(deckPath) && !force) {
    throw new OpenPptError(
      ErrorCodes.ALREADY_EXISTS,
      `deck.json already exists in ${dest} (pass --force)`,
    );
  }

  const colors = loadThemeColors(theme);
  let deck;

  if (skeleton) {
    const src = join(rootDir, "templates/pitch-skeleton/deck.json");
    deck = JSON.parse(readFileSync(src, "utf8"));
    deck.title = title;
    deck.theme = { colors };
    const cover = deck.pages.find((page) => page.id === "cover");
    const coverTitle = cover?.elements.find((element) => element.id === "cover-title");
    if (coverTitle) coverTitle.text = title;
  } else {
    deck = {
      version: "openppt-1",
      title,
      size: [960, 540],
      theme: { colors },
      pages: [
        {
          id: "cover",
          background: { type: "solid", color: "$background" },
          elements: [
            {
              id: "cover-stack",
              type: "group",
              layout: "stack",
              bounds: [60, 160, 840, 220],
              gap: 16,
              children: [
                {
                  id: "cover-title",
                  type: "text",
                  height: 64,
                  text: title,
                  fontSize: 32,
                  bold: true,
                  color: "$primary",
                },
                {
                  id: "cover-sub",
                  type: "text",
                  height: 40,
                  text: "Edit deck.json · add media/ · export with OpenPPT",
                  fontSize: 16,
                  color: "$muted",
                },
              ],
            },
          ],
        },
        {
          id: "body",
          background: { type: "solid", color: "$surface" },
          elements: [
            {
              id: "body-title",
              type: "text",
              bounds: [48, 36, 864, 40],
              text: "Section",
              fontSize: 24,
              bold: true,
              color: "$primary",
            },
            {
              id: "body-table",
              type: "table",
              bounds: [48, 100, 864, 280],
              header: true,
              fontSize: 14,
              rows: [
                ["Item", "Status", "Note"],
                ["IR", "openppt-1", "Declarative deck"],
                ["Export", "pptxgenjs", "Editable PPTX"],
                ["Layout", "stack/row/grid/layer", "Groups expand at load"],
              ],
            },
          ],
        },
      ],
    };
  }

  validateDeck(JSON.parse(JSON.stringify(deck)), { checkMedia: false });
  mkdirSync(join(dest, "media"), { recursive: true });

  // Keep media/.gitkeep so empty media is trackable if desired
  const keep = join(dest, "media", ".gitkeep");
  if (!existsSync(keep)) {
    writeFileSync(keep, "", "utf8");
  }
  writeDeckFileAtomic(deckPath, `${JSON.stringify(deck, null, 2)}\n`, { force });

  return { deckPath, theme };
}
