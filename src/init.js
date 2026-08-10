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

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string} themeId default|dark|magazine|report
 */
function loadThemeColors(themeId) {
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
      ErrorCodes.EXPORT,
      `deck.json already exists in ${dest} (pass --force)`,
    );
  }

  mkdirSync(join(dest, "media"), { recursive: true });
  const colors = loadThemeColors(theme);

  if (skeleton) {
    const src = join(rootDir, "templates/pitch-skeleton/deck.json");
    const raw = JSON.parse(readFileSync(src, "utf8"));
    raw.title = title;
    raw.theme = { colors };
    writeFileSync(deckPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  } else {
    const deck = {
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
    writeFileSync(deckPath, `${JSON.stringify(deck, null, 2)}\n`, "utf8");
  }

  // Keep media/.gitkeep so empty media is trackable if desired
  const keep = join(dest, "media", ".gitkeep");
  if (!existsSync(keep)) {
    writeFileSync(keep, "", "utf8");
  }

  return { deckPath, theme };
}
