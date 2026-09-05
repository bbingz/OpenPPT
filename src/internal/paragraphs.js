/**
 * C2 paragraph/bullet helpers. Not a public API.
 */

import { ErrorCodes, OpenPptError } from "../errors.js";

export const DEFAULT_PARAGRAPH_LINE_HEIGHT = 1.2;
export const DEFAULT_BULLET_INDENT_PT = 18;
export const MAX_NUMBERED_START = 32767;
export const MAX_PARAGRAPH_SPACE_PT = 1584;
export const EMU_PER_PT = 12700;
export const MAX_BULLET_MARL_EMU = 51206400;

export function bulletMarginEmu(indentPt, level) {
  const indent = Number.isFinite(indentPt) ? indentPt : DEFAULT_BULLET_INDENT_PT;
  const depth = Number.isInteger(level) ? level : 0;
  return Math.round(indent * EMU_PER_PT) * (depth + 1);
}

/** Vendor treats numeric 0 as absent; string "0" preserves IR zero. */
export function vendorNumeric(value) {
  if (value === 0) return "0";
  return value;
}

export function ownValue(object, key, fallback) {
  if (object && Object.hasOwn(object, key)) return object[key];
  return fallback;
}

export function legacyHasExtraTypography(el) {
  if (!el || Array.isArray(el.paragraphs)) return false;
  if (
    ["lineHeight", "charSpacing", "spaceBefore", "spaceAfter"].some((key) =>
      Object.hasOwn(el, key),
    )
  ) {
    return true;
  }
  return (
    Array.isArray(el.text) &&
    el.text.some((run) => run && Object.hasOwn(run, "charSpacing"))
  );
}

/** Native PPTX paragraphs from legacy text/run[] (A\\nB + C => A / BC). */
export function splitLegacyNativeParagraphs(el) {
  if (Array.isArray(el?.text)) {
    const paras = [[]];
    for (const run of el.text) {
      const pieces = String(run?.text ?? "").split(/\r\n|\r|\n/);
      for (let index = 0; index < pieces.length; index += 1) {
        paras[paras.length - 1].push({ ...run, text: pieces[index] });
        if (index < pieces.length - 1) paras.push([]);
      }
    }
    return paras.map((runs) => ({ text: runs.length > 0 ? runs : [{ text: "" }] }));
  }
  return String(el?.text ?? "")
    .split(/\r\n|\r|\n/)
    .map((text) => ({ text }));
}

export function splitParagraphText(text) {
  const runs = Array.isArray(text)
    ? text
    : [{ text: text == null ? "" : String(text) }];
  const fragments = [];
  for (const run of runs) {
    const pieces = String(run?.text ?? "").split(/\r\n|\r|\n/);
    for (let index = 0; index < pieces.length; index += 1) {
      fragments.push({
        text: pieces[index],
        style: run && typeof run === "object" ? run : { text: pieces[index] },
        softBreakBefore: fragments.length > 0 && index > 0,
      });
    }
  }
  return fragments.length > 0
    ? fragments
    : [{ text: "", style: { text: "" }, softBreakBefore: false }];
}

export function countParagraphFragments(paragraphs) {
  if (!Array.isArray(paragraphs)) return 0;
  let total = 0;
  for (const paragraph of paragraphs) {
    total += splitParagraphText(paragraph?.text).length;
  }
  return total;
}

export function countAuthoredParagraphRuns(paragraphs) {
  if (!Array.isArray(paragraphs)) return 0;
  let total = 0;
  for (const paragraph of paragraphs) {
    total += Array.isArray(paragraph?.text) ? paragraph.text.length : 1;
  }
  return total;
}

/**
 * Number sequences are local to one text element.
 * start resets its level; otherwise the level advances.
 * A shallower level clears deeper counters.
 * Unbulleted or unordered paragraphs end the numbered sequence.
 */
export function listMarkers(paragraphs, options = {}) {
  const counters = [];
  const context = options.context || "paragraphs";
  if (!Array.isArray(paragraphs)) return [];
  return paragraphs.map((paragraph, index) => {
    if (!paragraph || !Object.hasOwn(paragraph, "bullet") || paragraph.bullet === false) {
      counters.length = 0;
      return { kind: "none", level: 0, indent: DEFAULT_BULLET_INDENT_PT };
    }
    if (paragraph.bullet === true) {
      counters.length = 0;
      return { kind: "bullet", level: 0, indent: DEFAULT_BULLET_INDENT_PT };
    }
    const spec = paragraph.bullet;
    const level = Number.isInteger(spec?.level) ? spec.level : 0;
    const indent = Object.hasOwn(spec, "indent")
      ? spec.indent
      : DEFAULT_BULLET_INDENT_PT;
    if (spec?.type === "bullet") {
      counters.length = 0;
      return { kind: "bullet", level, indent };
    }
    if (spec?.type === "number") {
      counters.length = level + 1;
      if (Object.hasOwn(spec, "start")) counters[level] = spec.start;
      else counters[level] = (counters[level] || 0) + 1;
      if (counters[level] > MAX_NUMBERED_START) {
        throw new OpenPptError(
          ErrorCodes.SCHEMA,
          `Numbered list continuation exceeds ${MAX_NUMBERED_START} at ${context}[${index}]`,
          {
            startAt: counters[level],
            paragraphIndex: index,
            maximum: MAX_NUMBERED_START,
          },
        );
      }
      return {
        kind: "number",
        level,
        indent,
        startAt: counters[level],
      };
    }
    counters.length = 0;
    return { kind: "none", level: 0, indent: DEFAULT_BULLET_INDENT_PT };
  });
}

export function paragraphLineHeight(paragraph, element) {
  if (paragraph && Object.hasOwn(paragraph, "lineHeight")) return paragraph.lineHeight;
  if (element && Object.hasOwn(element, "lineHeight")) return element.lineHeight;
  return DEFAULT_PARAGRAPH_LINE_HEIGHT;
}

export function displayMarker(marker) {
  if (!marker || marker.kind === "none") return "";
  if (marker.kind === "bullet") return "\u2022";
  return `${marker.startAt}.`;
}
