/**
 * Original C3 page prototypes. Load shipped JSON fragments and fill
 * placeholders structurally (function replacers only — never JS $-patterns).
 * Body fit uses the same CJK/Latin wrap metrics as QA (em / 0.9em, 1.2 lh).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCodes, OpenPptError } from "../errors.js";
import { RESOURCE_LIMITS, assertResourceLimit } from "../resource-limits.js";
import { ptToPx, TEXT_INSET_X_PX, TEXT_INSET_Y_PX } from "./units.js";

const pagesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "pages",
);

export const PAGE_PROTOTYPE_NAMES = Object.freeze([
  "narrative",
  "two-column",
  "three-card",
  "kpi-row",
  "sequence",
]);

const SLOTS_PER_PAGE = 3;
const BODY_PT = 20;
const TITLE_PT = 26;
const COVER_PT = 34;
const MIN_PT = 18;
const LINE_HEIGHT = 1.2;
const PANEL_W = 864;
const PANEL_H = 468;
const TITLE_H = 56;
const TITLE_LH = 1.25;
const GAP = 16;
const KICKER_H = 40;
const MIN_BODY_H = Math.ceil(ptToPx(BODY_PT) * LINE_HEIGHT + 2 * TEXT_INSET_Y_PX);
const ROW_W = 864;
const ROW_H = 396;
const COL_GAP = 24;
const COL_W = (ROW_W - COL_GAP) / 2;
const CARD_GAP = 20;
const CARD_W = (ROW_W - CARD_GAP * 2) / 3;
const CARD_PAD = 40;
const CARD_INNER_W = CARD_W - CARD_PAD;
const CARD_INNER_H = ROW_H - CARD_PAD;
const STEP_INDEX_W = 56;
const STEP_GAP = 20;
const STEP_H = 120;
const STEP_TEXT_W = ROW_W - STEP_INDEX_W - STEP_GAP;
const KPI_GAP = 24;
const KPI_W = (ROW_W - KPI_GAP * 2) / 3;
const KPI_VALUE_H = 80;
const KPI_STACK_GAP = 12;
const KPI_LABEL_H = ROW_H - KPI_VALUE_H - KPI_STACK_GAP;
const TOC_LIST_H = 380;
const TOC_LIST_W = 832;

export const OUTLINE_TEXT_STYLES = Object.freeze({
  title: Object.freeze({ fontSize: TITLE_PT, bold: true, color: "$primary" }),
  body: Object.freeze({
    fontSize: BODY_PT,
    color: "$text",
    lineHeight: LINE_HEIGHT,
  }),
  muted: Object.freeze({
    fontSize: MIN_PT,
    color: "$muted",
    lineHeight: TITLE_LH,
  }),
  kpiValue: Object.freeze({
    fontSize: 32,
    bold: true,
    color: "$primary",
    align: "center",
  }),
  kpiLabel: Object.freeze({ fontSize: MIN_PT, color: "$muted", align: "center" }),
  stepIndex: Object.freeze({
    fontSize: 24,
    bold: true,
    color: "$primary",
    align: "center",
  }),
});

export function outlineTextStyles() {
  return JSON.parse(JSON.stringify(OUTLINE_TEXT_STYLES));
}

export function loadPagePrototype(name) {
  if (!PAGE_PROTOTYPE_NAMES.includes(name)) {
    throw new OpenPptError(ErrorCodes.IO, `Unknown page prototype "${name}"`, {
      name,
    });
  }
  const path = join(pagesDir, `${name}.json`);
  if (!existsSync(path)) {
    throw new OpenPptError(
      ErrorCodes.IO,
      `Page prototype not found: ${path}`,
      { name, path },
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Substitute {{KEY}} structurally. Exact-node placeholders keep the author
 * value as-is. Mixed template strings use a function replacer so $&, $$, $`,
 * $' in author text stay literal.
 * @param {unknown} node
 * @param {Record<string, unknown>} vars
 */
export function fillPrototype(node, vars) {
  if (typeof node === "string") {
    const exact = node.match(/^\{\{([A-Z][A-Z0-9_]*)\}\}$/);
    if (exact && Object.hasOwn(vars, exact[1])) return vars[exact[1]];
    return node.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, key) => {
      if (!Object.hasOwn(vars, key)) return match;
      return String(vars[key]);
    });
  }
  if (Array.isArray(node)) return node.map((item) => fillPrototype(item, vars));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = fillPrototype(value, vars);
  }
  return out;
}

function rewriteElementIds(node, prefix) {
  if (Array.isArray(node)) {
    for (const child of node) rewriteElementIds(child, prefix);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.id === "string") node.id = `${prefix}-${node.id}`;
  if (Array.isArray(node.elements)) rewriteElementIds(node.elements, prefix);
  if (Array.isArray(node.children)) rewriteElementIds(node.children, prefix);
}

function findGroup(page, id) {
  const stack = [...(page.elements || [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.type === "group" && node.id === id) return node;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return null;
}

function trimGroupChildren(page, groupId, count) {
  const group = findGroup(page, groupId);
  if (!group || !Array.isArray(group.children)) return;
  group.children = group.children.slice(0, Math.max(0, count));
}

function materialize(name, pageId, vars, trim) {
  const page = fillPrototype(loadPagePrototype(name), vars);
  if (trim) trimGroupChildren(page, trim.groupId, trim.count);
  rewriteElementIds(page, pageId);
  page.id = pageId;
  return page;
}

function isWideChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0xff01 && cp <= 0xff60) return true;
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(
    ch,
  );
}

function charAdvancePx(ch, fsPx) {
  const glyph = isWideChar(ch) ? fsPx : fsPx * 0.9;
  return Math.max(glyph, 0.01);
}

export function measureUsedHeight(text, fontSizePt, boxW, lineHeight = LINE_HEIGHT) {
  const fsPx = ptToPx(fontSizePt);
  const lineH = Math.max(fsPx * lineHeight, 0.01);
  const usableW = Math.max(0, Number(boxW) - 2 * TEXT_INSET_X_PX);
  let used = 0;
  let lineW = 0;
  let open = false;
  let horizontalOverflow = false;
  const flush = () => {
    used += lineH;
    lineW = 0;
    open = false;
  };
  const raw = String(text ?? "");
  if (raw.length === 0) {
    return { used: lineH, horizontalOverflow: false };
  }
  for (const ch of raw) {
    if (ch === "\n" || ch === "\r") {
      flush();
      continue;
    }
    const advance = charAdvancePx(ch, fsPx);
    if (!(usableW > 0) || advance > usableW) horizontalOverflow = true;
    if (usableW > 0 && lineW > 0 && lineW + advance > usableW) flush();
    lineW += advance;
    open = true;
  }
  if (open || used === 0) flush();
  return {
    used: Number.isFinite(used) ? used : 0,
    horizontalOverflow,
  };
}

export function fitsBox(text, fontSizePt, boxW, boxH, lineHeight = LINE_HEIGHT) {
  const innerH = Math.max(0, Number(boxH) - 2 * TEXT_INSET_Y_PX);
  const measured = measureUsedHeight(text, fontSizePt, boxW, lineHeight);
  return !measured.horizontalOverflow && measured.used <= innerH;
}

function snapBoundary(prefix) {
  if (!prefix) return 0;
  const marks = [". ", "。", "！", "？", "! ", "? ", "\n"];
  let best = -1;
  for (const mark of marks) {
    const at = prefix.lastIndexOf(mark);
    if (at >= 0) best = Math.max(best, at + mark.length);
  }
  if (best > 0) return best;
  const space = prefix.lastIndexOf(" ");
  if (space > 0) return space + 1;
  return prefix.length;
}

export function splitTextToFit(text, fontSizePt, boxW, boxH) {
  const chars = [...String(text ?? "")];
  if (chars.length === 0) return [""];
  if (fitsBox(chars.join(""), fontSizePt, boxW, boxH)) return [chars.join("")];
  const chunks = [];
  let offset = 0;
  while (offset < chars.length) {
    const first = chars[offset];
    if (!fitsBox(first, fontSizePt, boxW, boxH)) {
      throw new OpenPptError(
        ErrorCodes.RESOURCE_LIMIT,
        `Resource limit exceeded at text: glyph does not fit a readable ${fontSizePt}pt box`,
        { context: "text", fontSizePt, boxW, boxH },
      );
    }
    let best = 1;
    let low = 1;
    let high = chars.length - offset;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const slice = chars.slice(offset, offset + mid).join("");
      if (fitsBox(slice, fontSizePt, boxW, boxH)) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const prefix = chars.slice(offset, offset + best).join("");
    const snapAt = snapBoundary(prefix);
    const snapCount = [...prefix.slice(0, snapAt)].length;
    const cut = snapCount > 0 && snapCount < best ? snapCount : best;
    chunks.push(chars.slice(offset, offset + cut).join(""));
    offset += cut;
  }
  return chunks;
}

function narrativeBodyBox(titleH = TITLE_H) {
  return {
    w: PANEL_W,
    h: PANEL_H - titleH - GAP - KICKER_H - GAP,
  };
}

function findById(node, id) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  return findById(node.elements, id) || findById(node.children, id);
}

export function measureTitleLayout(title, boxW = PANEL_W) {
  const text = String(title ?? "");
  if (!text) return { fontSize: TITLE_PT, height: TITLE_H, dedicated: false };
  for (const fontSize of [TITLE_PT, MIN_PT]) {
    const measured = measureUsedHeight(text, fontSize, boxW, TITLE_LH);
    const need = Math.ceil(measured.used + 2 * TEXT_INSET_Y_PX);
    if (!measured.horizontalOverflow && need <= PANEL_H) {
      const height = Math.max(TITLE_H, need);
      return {
        fontSize,
        height,
        dedicated: PANEL_H - height - GAP - KICKER_H - GAP < MIN_BODY_H,
      };
    }
  }
  throw new OpenPptError(
    ErrorCodes.RESOURCE_LIMIT,
    "Resource limit exceeded at title: section title does not fit a dedicated page at 18pt",
    { context: "title" },
  );
}

function lexicalNumber(value, fallback) {
  if (value == null || value === "") return String(fallback);
  return String(value);
}

function availableStepHeight(contentH, count) {
  const n = Math.max(1, count);
  const gap = 16;
  return (contentH - gap * (n - 1)) / n;
}

function markerFits(label, stepH) {
  const text = lexicalNumber(label, "");
  if (!text) return false;
  return (
    fitsBox(text, 24, STEP_INDEX_W, stepH) ||
    fitsBox(text, MIN_PT, STEP_INDEX_W, stepH)
  );
}

function reflowSequenceSteps(page) {
  const group = findGroup(page, `${page.id}-steps`);
  if (!group?.children?.length || !Array.isArray(group.bounds)) return false;
  const available = group.bounds[3];
  const n = group.children.length;
  const gap = group.gap ?? 16;
  const each = (available - gap * Math.max(0, n - 1)) / n;
  if (!(each >= MIN_BODY_H)) return false;
  for (const child of group.children) child.height = each;
  return true;
}

function applyTitleToPage(page, fit) {
  const titleEl = findById(page, `${page.id}-title`);
  if (titleEl) {
    if (Array.isArray(titleEl.bounds) && titleEl.bounds.length === 4) {
      titleEl.bounds[3] = fit.height;
    } else {
      titleEl.height = fit.height;
    }
    if (fit.fontSize !== TITLE_PT) titleEl.fontSize = fit.fontSize;
  }
  const y = 36 + fit.height + GAP;
  const h = 36 + PANEL_H - y;
  for (const name of ["row", "grid", "steps"]) {
    const group = findGroup(page, `${page.id}-${name}`);
    if (group && Array.isArray(group.bounds) && group.bounds.length === 4) {
      group.bounds[1] = y;
      group.bounds[3] = Math.max(MIN_BODY_H, h);
    }
  }
}

export function parseKpiItem(text) {
  const raw = String(text);
  const match = raw.match(/^(.+?)\s*[:：]\s*(.+)$/u);
  if (!match) return null;
  const label = match[1].trim();
  const value = match[2].trim();
  if (!label || !value) return null;
  if (!/\p{L}/u.test(label)) return null;
  if (!/\d/.test(value)) return null;
  return { label, value };
}

/**
 * Deterministic layout pick. Sequence only for explicit ordered listKind.
 * KPI only when every item is an explicit label + numeric value.
 * Card/column/sequence/KPI require measured >=18pt capacity, not char count.
 * @param {{ title?: string, bullets?: string[], listKind?: string, blocks?: object[] }} section
 * @param {{ rowH?: number, stepH?: number }} [geometry]
 */
export function classifySection(section, geometry = {}) {
  const items = Array.isArray(section?.bullets)
    ? section.bullets.map((item) => String(item))
    : [];
  const blocks = Array.isArray(section?.blocks) ? section.blocks : null;
  const mixed = Boolean(blocks && new Set(blocks.map((block) => block.kind)).size > 1);
  if (items.length === 0) return { kind: "empty", items };
  if (!mixed && section?.listKind === "ordered" && items.length >= 1) {
    const numbered = items.map((text, index) => ({
      text,
      number: lexicalNumber(blocks?.[index]?.number, index + 1),
    }));
    const contentH = geometry.rowH ?? ROW_H;
    const sequenceChunks = chunkItems(numbered, SLOTS_PER_PAGE);
    const everyChunkFits = sequenceChunks.every((chunk) => {
      const stepH = availableStepHeight(contentH, chunk.length);
      return (
        stepH >= MIN_BODY_H &&
        chunk.every(
          (item) =>
            markerFits(item.number, stepH) &&
            fitsBox(item.text, BODY_PT, STEP_TEXT_W, stepH),
        )
      );
    });
    if (everyChunkFits) {
      return { kind: "sequence", items, numbered };
    }
    return { kind: "narrative", items, numbered };
  }
  const rowH = geometry.rowH ?? ROW_H;
  const cardInnerH = rowH - CARD_PAD;
  const kpis = items.map(parseKpiItem);
  if (!mixed && items.length >= 2 && kpis.every(Boolean)) {
    if (
      kpis.every(
        (kpi) =>
          fitsBox(kpi.value, 32, KPI_W, KPI_VALUE_H) &&
          fitsBox(kpi.label, MIN_PT, KPI_W, Math.max(MIN_BODY_H, rowH - KPI_VALUE_H - KPI_STACK_GAP)),
      )
    ) {
      return { kind: "kpi", items, kpis };
    }
    return { kind: "narrative", items };
  }
  if (mixed) {
    return { kind: "narrative", items, pieces: displayBlocks(blocks) };
  }
  if (items.length === 1) return { kind: "narrative", items };
  const unorderedPeers =
    section?.listKind === "unordered" ||
    (section?.listKind == null && !blocks);
  if (
    unorderedPeers &&
    items.length === 2 &&
    items.every((item) => fitsBox(item, BODY_PT, COL_W, rowH))
  ) {
    return { kind: "two-column", items };
  }
  if (
    unorderedPeers &&
    items.length >= 3 &&
    items.every((item) => fitsBox(item, BODY_PT, CARD_INNER_W, cardInnerH))
  ) {
    return { kind: "three-card", items };
  }
  return { kind: "narrative", items };
}

function displayBlock(block) {
  if (!block || typeof block !== "object") return "";
  const text = String(block.text ?? "");
  if (block.kind === "ordered" && block.number != null && String(block.number) !== "") {
    return `${lexicalNumber(block.number, text)}. ${text}`;
  }
  return text;
}

function displayBlocks(blocks) {
  return (blocks || []).map(displayBlock).filter((item) => item.length > 0);
}

export function composeNarrative(pageId, title, body, options = {}) {
  const kicker = options.kicker || "";
  const keepKicker = Boolean(options.keepKicker) || Boolean(kicker);
  const page = materialize("narrative", pageId, {
    TITLE: title,
    BODY: body ?? "",
    KICKER: kicker,
  });
  const panel = findGroup(page, `${pageId}-panel`);
  if (panel?.children) {
    if (!keepKicker) {
      panel.children = panel.children.filter(
        (child) => child.id !== `${pageId}-kicker`,
      );
    }
    if (!String(body ?? "").length) {
      panel.children = panel.children.filter(
        (child) => child.id !== `${pageId}-body`,
      );
    }
  }
  return page;
}

export function composeTwoColumn(pageId, title, left, right) {
  return materialize("two-column", pageId, {
    TITLE: title,
    BODY_A: left,
    BODY_B: right,
  });
}

export function composeThreeCard(pageId, title, items) {
  const slice = items.slice(0, SLOTS_PER_PAGE);
  const vars = { TITLE: title, BODY_1: "", BODY_2: "", BODY_3: "" };
  slice.forEach((item, index) => {
    vars[`BODY_${index + 1}`] = item;
  });
  return materialize("three-card", pageId, vars, {
    groupId: "grid",
    count: slice.length,
  });
}

export function composeKpiRow(pageId, title, kpis) {
  const slice = kpis.slice(0, SLOTS_PER_PAGE);
  const vars = {
    TITLE: title,
    VALUE_1: "",
    LABEL_1: "",
    VALUE_2: "",
    LABEL_2: "",
    VALUE_3: "",
    LABEL_3: "",
  };
  slice.forEach((kpi, index) => {
    vars[`VALUE_${index + 1}`] = kpi.value;
    vars[`LABEL_${index + 1}`] = kpi.label;
  });
  return materialize("kpi-row", pageId, vars, {
    groupId: "row",
    count: slice.length,
  });
}

export function composeSequence(pageId, title, items, startAt = 1) {
  const slice = items.slice(0, SLOTS_PER_PAGE);
  const vars = {
    TITLE: title,
    STEP_1_N: "",
    STEP_1_T: "",
    STEP_2_N: "",
    STEP_2_T: "",
    STEP_3_N: "",
    STEP_3_T: "",
  };
  slice.forEach((item, index) => {
    const text = typeof item === "string" ? item : item.text;
    const number =
      typeof item === "string"
        ? String(startAt + index)
        : lexicalNumber(item.number, startAt + index);
    vars[`STEP_${index + 1}_N`] = number;
    vars[`STEP_${index + 1}_T`] = text;
  });
  return materialize("sequence", pageId, vars, {
    groupId: "steps",
    count: slice.length,
  });
}

export function chunkItems(items, size = SLOTS_PER_PAGE) {
  const chunks = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

function assertSlotPageBudget(itemCount, extraPages = 0) {
  const needed = extraPages + Math.ceil(Math.max(0, itemCount) / SLOTS_PER_PAGE);
  assertResourceLimit(
    needed,
    RESOURCE_LIMITS.pagesPerDeck,
    "pagesPerDeck",
    "sectionPages",
  );
}

export function paginateNarrative(baseId, title, items, options = {}) {
  const titleFit = options.titleFit || measureTitleLayout(title);
  const showTitle = options.showTitle !== false;
  const titleH = showTitle ? titleFit.height : 0;
  const box = narrativeBodyBox(showTitle ? titleH : 0);
  const queue = items.map((item) => String(item)).filter((item) => item.length > 0);
  if (queue.length === 0) {
    const page = composeNarrative(baseId, title, "", { keepKicker: false });
    if (showTitle) applyTitleToPage(page, titleFit);
    return [page];
  }
  const pages = [];
  let pageIndex = 0;
  while (queue.length) {
    const continued = pageIndex > 0 || options.continued;
    const pageId = pageIndex === 0 ? baseId : `${baseId}-p${pageIndex + 1}`;
    const parts = [];
    while (queue.length) {
      const item = queue[0];
      const candidate = parts.length ? `${parts.join("\n")}\n${item}` : item;
      if (fitsBox(candidate, BODY_PT, box.w, box.h)) {
        parts.push(queue.shift());
        continue;
      }
      if (parts.length === 0) {
        const chunks = splitTextToFit(item, BODY_PT, box.w, box.h);
        parts.push(chunks[0]);
        const rest = chunks.slice(1).join("");
        if (rest) queue[0] = rest;
        else queue.shift();
      }
      break;
    }
    const page = composeNarrative(pageId, showTitle ? title : title, parts.join("\n"), {
      kicker: continued ? "Continued" : "",
      keepKicker: true,
    });
    if (showTitle) applyTitleToPage(page, titleFit);
    else {
      const panel = findGroup(page, `${pageId}-panel`);
      if (panel?.children) {
        panel.children = panel.children.filter(
          (child) => child.id !== `${pageId}-title`,
        );
      }
    }
    pages.push(page);
    pageIndex += 1;
    assertResourceLimit(
      pages.length,
      RESOURCE_LIMITS.pagesPerDeck,
      "pagesPerDeck",
      `section ${baseId}`,
    );
  }
  return pages;
}

export function composeCoverPage(title) {
  const text = String(title ?? "");
  const width = 840;
  const tryFit = (fontSize, maxH) => {
    const measured = measureUsedHeight(text, fontSize, width, 1.25);
    const need = Math.ceil(measured.used + 2 * TEXT_INSET_Y_PX);
    if (measured.horizontalOverflow || need > maxH) return null;
    return { fontSize, height: Math.max(80, need) };
  };
  const fitted =
    tryFit(COVER_PT, 80) ||
    tryFit(COVER_PT, 240) ||
    tryFit(TITLE_PT, 400) ||
    tryFit(MIN_PT, PANEL_H);
  if (!fitted) {
    throw new OpenPptError(
      ErrorCodes.RESOURCE_LIMIT,
      "Resource limit exceeded at title: cover title does not fit a dedicated page at 18pt",
      { context: "title", limit: "stringBytes", actual: text.length },
    );
  }
  return {
    id: "cover",
    background: { type: "solid", color: "$background" },
    elements: [
      {
        id: "cover-stack",
        type: "group",
        layout: "stack",
        bounds: [60, fitted.height > 80 ? 36 : 160, 840, fitted.height],
        gap: 0,
        children: [
          {
            id: "cover-title",
            type: "text",
            height: fitted.height,
            text,
            fontSize: fitted.fontSize,
            bold: true,
            color: "$primary",
          },
        ],
      },
    ],
  };
}

export function composeAgendaPages(sections) {
  if (!Array.isArray(sections) || sections.length < 2) return [];
  const entries = sections.map((section, index) => {
    const label = `${String(index + 1).padStart(2, "0")}  ${section.title}`;
    const measured = measureUsedHeight(label, MIN_PT, TOC_LIST_W, 1.25);
    const height = Math.max(36, Math.ceil(measured.used + 2 * TEXT_INSET_Y_PX));
    if (height > TOC_LIST_H || measured.horizontalOverflow) {
      throw new OpenPptError(
        ErrorCodes.RESOURCE_LIMIT,
        "Resource limit exceeded at title: agenda title does not fit a readable 18pt row",
        { context: "title", sectionTitle: section.title },
      );
    }
    return { label, height, index };
  });
  const chunks = [];
  let chunk = [];
  let used = 0;
  for (const entry of entries) {
    const gap = chunk.length ? 16 : 0;
    if (chunk.length && used + gap + entry.height > TOC_LIST_H) {
      chunks.push(chunk);
      chunk = [];
      used = 0;
    }
    used += (chunk.length ? 16 : 0) + entry.height;
    chunk.push(entry);
  }
  if (chunk.length) chunks.push(chunk);

  return chunks.map((items, chunkIndex) => {
    const suffix = chunkIndex === 0 ? "" : `-${chunkIndex + 1}`;
    return {
      id: `toc${suffix}`,
      background: { type: "solid", color: "$surface" },
      elements: [
        {
          id: `toc-h${suffix}`,
          type: "text",
          bounds: [48, 32, 864, 56],
          text:
            chunks.length === 1
              ? "Agenda"
              : `Agenda ${chunkIndex + 1}/${chunks.length}`,
          fontSize: TITLE_PT,
          bold: true,
          color: "$primary",
        },
        {
          id: `toc-list${suffix}`,
          type: "group",
          layout: "stack",
          bounds: [64, 108, TOC_LIST_W, TOC_LIST_H],
          gap: 16,
          children: items.map((entry) => ({
            id: `toc-${entry.index + 1}`,
            type: "text",
            height: entry.height,
            text: entry.label,
            fontSize: MIN_PT,
            color: "$text",
          })),
        },
      ],
    };
  });
}

export function sectionPages(baseId, section) {
  const title = section.title;
  const titleFit = measureTitleLayout(title);
  const rowH = Math.max(
    MIN_BODY_H,
    36 + PANEL_H - (36 + titleFit.height + GAP),
  );
  const classified = classifySection(section, { rowH, stepH: Math.min(STEP_H, rowH) });
  const decorate = (page) => {
    applyTitleToPage(page, titleFit);
    return page;
  };
  if (classified.kind === "empty") {
    const page = composeNarrative(baseId, title, "", { keepKicker: false });
    return [decorate(page)];
  }
  const pieces = classified.pieces
    ? classified.pieces
    : classified.numbered
      ? classified.numbered.map((item) => `${item.number}. ${item.text}`)
      : classified.items;
  if (titleFit.dedicated) {
    const heading = composeNarrative(baseId, title, "", { keepKicker: false });
    applyTitleToPage(heading, titleFit);
    return [
      heading,
      ...paginateNarrative(`${baseId}-body`, title, pieces, {
        titleFit,
        showTitle: false,
        continued: true,
      }),
    ];
  }
  if (classified.kind === "sequence") {
    assertSlotPageBudget(
      classified.numbered.length,
      titleFit.dedicated ? 1 : 0,
    );
    const sequencePages = [];
    const chunks = chunkItems(classified.numbered, SLOTS_PER_PAGE);
    for (let index = 0; index < chunks.length; index += 1) {
      const page = composeSequence(
        index === 0 ? baseId : `${baseId}-p${index + 1}`,
        title,
        chunks[index],
      );
      applyTitleToPage(page, titleFit);
      if (!reflowSequenceSteps(page)) {
        return paginateNarrative(baseId, title, pieces, { titleFit });
      }
      sequencePages.push(page);
    }
    return sequencePages;
  }
  if (classified.kind === "kpi") {
    assertSlotPageBudget(classified.kpis.length, titleFit.dedicated ? 1 : 0);
    return chunkItems(classified.kpis, SLOTS_PER_PAGE).map((chunk, index) =>
      decorate(
        composeKpiRow(
          index === 0 ? baseId : `${baseId}-p${index + 1}`,
          title,
          chunk,
        ),
      ),
    );
  }
  if (classified.kind === "two-column") {
    return [decorate(composeTwoColumn(baseId, title, classified.items[0], classified.items[1]))];
  }
  if (classified.kind === "three-card") {
    assertSlotPageBudget(classified.items.length, titleFit.dedicated ? 1 : 0);
    return chunkItems(classified.items, SLOTS_PER_PAGE).map((chunk, index) => {
      const pageId = index === 0 ? baseId : `${baseId}-p${index + 1}`;
      if (chunk.length === 2) {
        return decorate(composeTwoColumn(pageId, title, chunk[0], chunk[1]));
      }
      if (chunk.length === 1) {
        return paginateNarrative(pageId, title, [chunk[0]], { titleFit })[0];
      }
      return decorate(composeThreeCard(pageId, title, chunk));
    });
  }
  return paginateNarrative(baseId, title, pieces, { titleFit });
}
