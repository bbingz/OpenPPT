/**
 * Build an OpenPPT deck from a simple markdown outline.
 *
 * Supported:
 *   # Deck title
 *   ## Page title
 *   - bullet
 *   - bullet
 *   plain paragraph lines under a page
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { OpenPptError, ErrorCodes } from "./errors.js";
import { writeDeckFileAtomic } from "./project-write.js";
import { validateDeck } from "./validate.js";
import { loadThemeColors } from "./internal/theme-io.js";
import { RESOURCE_LIMITS, assertResourceLimit } from "./resource-limits.js";
import {
  composeAgendaPages,
  composeCoverPage,
  outlineTextStyles,
  sectionPages,
} from "./internal/page-prototypes.js";

function finishSectionKind(section) {
  if (!section) return;
  const kinds = section._itemKinds;
  const blocks = section._blocks;
  delete section._itemKinds;
  delete section._blocks;
  if (Array.isArray(blocks) && blocks.length > 0) section.blocks = blocks;
  if (!Array.isArray(kinds) || kinds.length === 0) return;
  const first = kinds[0];
  if (kinds.every((kind) => kind === first)) section.listKind = first;
}

function accountString(value, context, totals) {
  if (typeof value !== "string") return;
  const bytes = Buffer.byteLength(value, "utf8");
  assertResourceLimit(
    bytes,
    RESOURCE_LIMITS.stringBytes,
    "stringBytes",
    context,
  );
  totals.bytes += bytes;
  assertResourceLimit(
    totals.bytes,
    RESOURCE_LIMITS.totalStringBytes,
    "totalStringBytes",
    context,
  );
}

/**
 * Parse outline markdown into { title, sections: [{ title, bullets, listKind? }] }.
 * bullets keep literal item text (markers stripped). listKind is set only when
 * every item in the section shares one source kind: ordered | unordered | prose.
 * @param {string} md
 */
export function parseOutlineMarkdown(md) {
  const lines = String(md).split(/\r?\n/);
  let title = "Untitled deck";
  /** @type {{ title: string, bullets: string[], listKind?: string }[]} */
  const sections = [];
  /** @type {{ title: string, bullets: string[], listKind?: string, _itemKinds?: string[] } | null} */
  let current = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) continue;

    if (/^#\s+/.test(t) && !/^##/.test(t)) {
      title = t.replace(/^#\s+/, "").trim() || title;
      continue;
    }
    if (/^##\s+/.test(t)) {
      finishSectionKind(current);
      current = {
        title: t.replace(/^##\s+/, "").trim() || "Section",
        bullets: [],
        _itemKinds: [],
        _blocks: [],
      };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { title: "Overview", bullets: [], _itemKinds: [], _blocks: [] };
      sections.push(current);
    }
    if (/^[-*+]\s+/.test(t)) {
      const text = t.replace(/^[-*+]\s+/, "").trim();
      current.bullets.push(text);
      current._itemKinds.push("unordered");
      current._blocks.push({ kind: "unordered", text });
    } else if (/^\d+\.\s+/.test(t)) {
      const match = t.match(/^(\d+)\.\s+(.*)$/);
      const text = (match ? match[2] : t.replace(/^\d+\.\s+/, "")).trim();
      const number = match ? match[1] : String(current.bullets.length + 1);
      current.bullets.push(text);
      current._itemKinds.push("ordered");
      current._blocks.push({ kind: "ordered", text, number });
    } else {
      current.bullets.push(t);
      current._itemKinds.push("prose");
      current._blocks.push({ kind: "prose", text: t });
    }
  }

  finishSectionKind(current);
  return { title, sections };
}

/**
 * Build deck IR object from outline.
 * @param {{ title: string, sections: { title: string, bullets: string[] }[] }} outline
 * @param {{ theme?: string, size?: [number, number] }} [options]
 */
export function outlineToDeck(outline, options = {}) {
  const theme = options.theme || "default";
  const colors = loadThemeColors(theme);
  if (
    options.size !== undefined &&
    (!Array.isArray(options.size) ||
      options.size.length !== 2 ||
      options.size[0] !== 960 ||
      options.size[1] !== 540)
  ) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      "from-outline currently supports only the 960x540 canvas",
      { size: options.size },
    );
  }
  const size = [960, 540];
  const sections = Array.isArray(outline.sections) ? outline.sections : [];
  const stringTotals = { bytes: 0 };
  accountString(outline.title, "title", stringTotals);
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index] || {};
    accountString(section.title, `sections[${index}].title`, stringTotals);
    const bullets = Array.isArray(section.bullets) ? section.bullets : [];
    for (let bulletIndex = 0; bulletIndex < bullets.length; bulletIndex += 1) {
      accountString(
        bullets[bulletIndex],
        `sections[${index}].bullets[${bulletIndex}]`,
        stringTotals,
      );
    }
  }
  const minPages = 1 + (sections.length >= 2 ? 1 : 0) + sections.length;
  assertResourceLimit(
    minPages,
    RESOURCE_LIMITS.pagesPerDeck,
    "pagesPerDeck",
    "from-outline",
  );

  /** @type {object[]} */
  const pages = [];
  const pushPage = (page) => {
    pages.push(page);
    assertResourceLimit(
      pages.length,
      RESOURCE_LIMITS.pagesPerDeck,
      "pagesPerDeck",
      `pages[${pages.length - 1}]`,
    );
  };
  pushPage(composeCoverPage(outline.title));
  for (const page of composeAgendaPages(sections)) pushPage(page);
  for (let i = 0; i < sections.length; i += 1) {
    for (const page of sectionPages(`sec-${i + 1}`, sections[i])) pushPage(page);
  }

  return {
    version: "openppt-1",
    title: outline.title,
    size,
    theme: { colors, textStyles: outlineTextStyles() },
    pages,
  };
}

/**
 * Read markdown file → write OpenPPT project.
 * @param {string} mdPath
 * @param {string} outDir
 * @param {{ force?: boolean, theme?: string }} [options]
 */
export function projectFromOutline(mdPath, outDir, options = {}) {
  const { force = false, theme = "default" } = options;
  const abs = resolve(mdPath);
  if (!existsSync(abs)) {
    throw new OpenPptError(ErrorCodes.IO, `Outline not found: ${abs}`);
  }
  const dest = resolve(outDir);
  const deckPath = join(dest, "deck.json");
  if (existsSync(deckPath) && !force) {
    throw new OpenPptError(
      ErrorCodes.ALREADY_EXISTS,
      `deck.json already exists in ${dest} (pass --force)`,
    );
  }
  const md = readFileSync(abs, "utf8");
  const outline = parseOutlineMarkdown(md);
  const deck = outlineToDeck(outline, { theme });
  validateDeck(JSON.parse(JSON.stringify(deck)), { checkMedia: false });
  mkdirSync(join(dest, "media"), { recursive: true });
  const keep = join(dest, "media", ".gitkeep");
  if (!existsSync(keep)) writeFileSync(keep, "", "utf8");
  writeDeckFileAtomic(deckPath, `${JSON.stringify(deck, null, 2)}\n`, { force });
  return { deckPath, pageCount: deck.pages.length, title: deck.title };
}
