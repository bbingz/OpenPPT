/**
 * Structural layout QA (no browser): overlaps, density, empty pages.
 */

import { validateDeck } from "./validate.js";
import { SeverityRank } from "./errors.js";
import { ptToPx, TEXT_INSET_X_PX, TEXT_INSET_Y_PX } from "./internal/units.js";
import {
  legacyHasExtraTypography,
  listMarkers,
  ownValue,
  paragraphLineHeight,
  splitParagraphText,
} from "./internal/paragraphs.js";

/**
 * Rank for a severity string (unknown → 0).
 * @param {string} severity
 */
export function severityRank(severity) {
  return SeverityRank[severity] || 0;
}

/**
 * Whether any issue meets or exceeds the fail-on threshold.
 * @param {Array<{ severity: string }>} issues
 * @param {string} failOn low|med|high|critical
 */
export function issuesFailThreshold(issues, failOn = "high") {
  const threshold = severityRank(failOn);
  if (threshold <= 0) {
    throw new Error(`Invalid fail-on severity: ${failOn}`);
  }
  return issues.some((i) => severityRank(i.severity) >= threshold);
}

/**
 * Axis-aligned rectangle intersection area.
 * @param {number[]} a [x,y,w,h]
 * @param {number[]} b
 */
function overlapArea(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * @param {object} deck validated deck
 * @returns {{ ok: boolean, issues: Array<{ severity: string, code: string, pageId: string, message: string, details?: object }> }}
 */
/**
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number, a: number } | null}
 */
function parseRgba(hex) {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#")) return null;
  const h = hex.slice(1);
  if (h.length !== 6 && h.length !== 8) return null;
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

function compositeOver(fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: bg.r, g: bg.g, b: bg.b, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}

function luminanceRgba(c) {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const lin = (ch) => (ch <= 0.03928 ? ch / 12.92 : ((ch + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a, b) {
  const l1 = luminanceRgba(a);
  const l2 = luminanceRgba(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Resolve theme token or return hex as-is when already hex.
 * @param {string | undefined} color
 * @param {Record<string, string>} colors
 */
function resolveMaybe(color, colors) {
  if (!color) return null;
  if (color.startsWith("$")) {
    const key = color.slice(1);
    return Object.hasOwn(colors, key) ? colors[key] : null;
  }
  return color;
}

function textStyleSamples(el, colors) {
  const parentColor = resolveMaybe(el.color, colors) || "#111827";
  const parentFs = el.fontSize || 18;
  if (Array.isArray(el.paragraphs)) {
    const samples = [];
    for (let pi = 0; pi < el.paragraphs.length; pi += 1) {
      const para = el.paragraphs[pi];
      const paraColor = resolveMaybe(para.color, colors) || parentColor;
      const paraFs = para.fontSize || parentFs;
      const fragments = splitParagraphText(para.text);
      for (let fi = 0; fi < fragments.length; fi += 1) {
        const run = fragments[fi].style || {};
        samples.push({
          color: resolveMaybe(run.color, colors) || paraColor,
          fontSize: run.fontSize || paraFs,
          label: `${el.id}.paragraphs[${pi}].frag[${fi}]`,
        });
      }
    }
    return samples.length
      ? samples
      : [{ color: parentColor, fontSize: parentFs, label: el.id }];
  }
  if (!Array.isArray(el.text)) {
    return [{ color: parentColor, fontSize: parentFs, label: el.id }];
  }
  return el.text.map((run, index) => ({
    color: resolveMaybe(run.color, colors) || parentColor,
    fontSize: run.fontSize || parentFs,
    label: `${el.id}.run[${index}]`,
  }));
}

function isWideChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0xff01 && cp <= 0xff60) return true;
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch);
}

function charAdvancePx(ch, fsPx, spacingPx) {
  const glyph = isWideChar(ch) ? fsPx : fsPx * 0.9;
  return Math.max(glyph + spacingPx, 0.01);
}

function fragmentTypeMetrics(fragment, para, el) {
  const run = fragment.style || {};
  const fs =
    Number(run.fontSize ?? ownValue(para || {}, "fontSize", el.fontSize ?? 18)) || 18;
  const spacing = Object.hasOwn(run, "charSpacing")
    ? run.charSpacing
    : ownValue(
        para || {},
        "charSpacing",
        Object.hasOwn(el, "charSpacing") ? el.charSpacing : 0,
      );
  return {
    fs,
    spacingPx: ptToPx(Number(spacing) || 0),
    text: fragment.text ?? "",
  };
}

function wrappedBlockHeight(fragments, para, el, usableW, lineHeight) {
  const fallbackFs = Number(ownValue(para || {}, "fontSize", el.fontSize ?? 18)) || 18;
  const lh = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 1.2;
  const lineH = (fs) => Math.max(ptToPx(fs) * lh, 0.01);
  const width = Number.isFinite(usableW) ? Math.max(usableW, 0) : 0;
  let used = 0;
  let lineW = 0;
  let lineMaxFs = 0;
  let open = false;
  let horizontalOverflow = false;
  const flush = () => {
    used += lineH(lineMaxFs || fallbackFs);
    lineW = 0;
    lineMaxFs = 0;
    open = false;
  };
  for (const fragment of fragments) {
    if (fragment.softBreakBefore) flush();
    const { fs, spacingPx, text } = fragmentTypeMetrics(fragment, para, el);
    if (text.length === 0) {
      lineMaxFs = Math.max(lineMaxFs, fs);
      open = true;
      continue;
    }
    for (const ch of text) {
      const advance = charAdvancePx(ch, ptToPx(fs), spacingPx);
      if (!(width > 0) || advance > width) horizontalOverflow = true;
      if (width > 0 && lineW > 0 && lineW + advance > width) flush();
      lineW += advance;
      lineMaxFs = Math.max(lineMaxFs, fs);
      open = true;
    }
  }
  if (open || used === 0) flush();
  return {
    used: Number.isFinite(used) ? used : 0,
    horizontalOverflow,
  };
}

function paragraphOverflow(el, w, h) {
  const innerW = Math.max(0, w - 2 * TEXT_INSET_X_PX);
  const innerH = Math.max(0, h - 2 * TEXT_INSET_Y_PX);
  const markers = listMarkers(el.paragraphs || []);
  let used = 0;
  let chars = 0;
  let maxFs = 1;
  let horizontalOverflow = false;
  for (let pi = 0; pi < (el.paragraphs || []).length; pi += 1) {
    const para = el.paragraphs[pi];
    const lh = paragraphLineHeight(para, el);
    const fragments = splitParagraphText(para.text);
    const spaceBefore =
      Number(
        ownValue(para, "spaceBefore", Object.hasOwn(el, "spaceBefore") ? el.spaceBefore : 0),
      ) || 0;
    const spaceAfter =
      Number(
        ownValue(para, "spaceAfter", Object.hasOwn(el, "spaceAfter") ? el.spaceAfter : 0),
      ) || 0;
    const indentPt =
      markers[pi]?.kind === "none"
        ? 0
        : Number(markers[pi]?.indent || 0) * ((markers[pi]?.level || 0) + 1);
    const usableW = Math.max(0, innerW - ptToPx(indentPt));
    const raw = fragments.map((fragment) => fragment.text).join("");
    chars += raw.replace(/\s/g, "").length;
    for (const fragment of fragments) {
      const { fs } = fragmentTypeMetrics(fragment, para, el);
      maxFs = Math.max(maxFs, fs);
    }
    const wrap = wrappedBlockHeight(fragments, para, el, usableW, lh);
    if (wrap.horizontalOverflow) horizontalOverflow = true;
    used += ptToPx(spaceBefore) + ptToPx(spaceAfter) + wrap.used;
  }
  const cap =
    innerH > 0 && maxFs > 0
      ? Math.floor(innerH / Math.max(ptToPx(maxFs) * 1.35, 0.01))
      : 0;
  const packed = (innerH > 0 && used > innerH) || horizontalOverflow;
  const zeroCapacity =
    innerH <= 0
      ? chars > 0 || (el.paragraphs || []).length > 0 || horizontalOverflow
      : packed;
  return {
    chars,
    cap: Number.isFinite(cap) ? cap : 0,
    used: Number.isFinite(used) ? used : 0,
    innerH: Number.isFinite(innerH) ? innerH : 0,
    usableW: Number.isFinite(innerW) ? innerW : 0,
    horizontalOverflow,
    zeroCapacity,
    packed,
  };
}

function overlapSeverity(a, b) {
  const textOnShape =
    (a.type === "text" && b.type === "shape") ||
    (b.type === "text" && a.type === "shape");
  if (textOnShape) return null;
  if (a.type === "text" && b.type === "text") return "high";
  if (a.type === "shape" && b.type === "shape") return "med";
  return "low";
}

export function analyzeLayout(deck) {
  /** @type {Array<{ severity: string, code: string, pageId: string, message: string, details?: object }>} */
  const issues = [];
  const [cw, ch] = deck.size;
  const canvasArea = cw * ch;
  const colors = deck.theme?.colors || {};
  const EDGE = 8;

  for (const page of deck.pages) {
    const els = page.elements || [];
    if (els.length === 0) {
      issues.push({
        severity: "med",
        code: "EMPTY_PAGE",
        pageId: page.id,
        message: `Page ${page.id} has no elements`,
      });
      continue;
    }

    const pageBg =
      resolveMaybe(page.background?.color, colors) ||
      resolveMaybe(colors.background, colors) ||
      "#FFFFFF";
    let pageRgba = parseRgba(pageBg) || { r: 255, g: 255, b: 255, a: 1 };
    let backgroundHeuristic = null;
    if (pageRgba.a < 0.01) {
      pageRgba = { r: 255, g: 255, b: 255, a: 1 };
      backgroundHeuristic =
        "transparent background; contrast assumes an opaque white page";
    }

    let covered = 0;
    for (let i = 0; i < els.length; i += 1) {
      const a = els[i];
      const [x, y, w, h] = a.bounds;
      covered += w * h;

      // Edge margin: non-full-bleed elements hugging the canvas edge
      const fullBleedX = x <= 0 && x + w >= cw - 0.5;
      const fullBleedY = y <= 0 && y + h >= ch - 0.5;
      if (!fullBleedX && !fullBleedY) {
        const near =
          x < EDGE || y < EDGE || x + w > cw - EDGE || y + h > ch - EDGE;
        if (near && a.type !== "shape") {
          // shapes as bars/accents often intentional at edge
          issues.push({
            severity: "low",
            code: "TIGHT_MARGIN",
            pageId: page.id,
            message: `Element ${a.id} is within ${EDGE}px of the page edge`,
            details: { bounds: a.bounds, edge: EDGE },
          });
        }
      }

      if (a.type === "text") {
        const samples = textStyleSamples(a, colors);
        for (const sample of samples) {
          const fg = parseRgba(sample.color);
          if (!fg) continue;
          const composed = compositeOver(fg, pageRgba);
          const ratio = contrastRatio(composed, pageRgba);
          if (ratio < 2.5) {
            issues.push({
              severity: "med",
              code: "LOW_CONTRAST",
              pageId: page.id,
              message: `Text ${sample.label} may have low contrast vs page background (≈${ratio.toFixed(1)}:1)`,
              details: {
                text: sample.color,
                background: pageBg,
                ratio,
                ...(backgroundHeuristic ? { heuristic: backgroundHeuristic } : {}),
              },
            });
          }
        }

        if (Array.isArray(a.paragraphs)) {
          const paraFit = paragraphOverflow(a, w, h);
          if (paraFit.zeroCapacity || paraFit.packed) {
            issues.push({
              severity: "med",
              code: "TEXT_OVERFLOW_RISK",
              pageId: page.id,
              message:
                paraFit.horizontalOverflow && !(paraFit.used > paraFit.innerH)
                  ? `Text ${a.id} may overflow (content wider than ${Math.round(paraFit.usableW)}px)`
                  : `Text ${a.id} may overflow (estimated ${Math.round(paraFit.used)}px height vs ${Math.round(paraFit.innerH)}px available)`,
              details: {
                chars: paraFit.chars,
                used: paraFit.used,
                availablePx: paraFit.innerH,
                usableW: paraFit.usableW,
                horizontalOverflow: Boolean(paraFit.horizontalOverflow),
                bounds: a.bounds,
              },
            });
          }
        } else {
          const raw = Array.isArray(a.text)
            ? a.text.map((r) => r.text).join("")
            : String(a.text ?? "");
          const chars = raw.replace(/\s/g, "").length;
          const fs = Math.max(...samples.map((sample) => sample.fontSize), 1);
          const innerW = Math.max(0, w - 2 * TEXT_INSET_X_PX);
          const innerH = Math.max(0, h - 2 * TEXT_INSET_Y_PX);
          let overflow = false;
          let cap;
          if (legacyHasExtraTypography(a)) {
            const fragments = splitParagraphText(a.text);
            const spaceBefore = Number(Object.hasOwn(a, "spaceBefore") ? a.spaceBefore : 0) || 0;
            const spaceAfter = Number(Object.hasOwn(a, "spaceAfter") ? a.spaceAfter : 0) || 0;
            const nativeParas = Math.max(
              1,
              1 + fragments.filter((fragment) => fragment.softBreakBefore).length,
            );
            const lh = Object.hasOwn(a, "lineHeight") ? a.lineHeight : 1.2;
            const wrap = wrappedBlockHeight(fragments, null, a, innerW, lh);
            const used =
              (ptToPx(spaceBefore) + ptToPx(spaceAfter)) * nativeParas + wrap.used;
            cap = innerH > 0 ? Math.floor(innerH / Math.max(ptToPx(fs) * 1.35, 0.01)) : 0;
            overflow =
              wrap.horizontalOverflow ||
              (innerH <= 0 ? chars > 0 : used > innerH);
          } else {
            const fsPx = ptToPx(fs);
            cap = Math.floor((innerW / (fsPx * 0.9)) * (innerH / (fsPx * 1.35)));
            overflow = (chars > 0 && cap <= 0) || (chars > 8 && cap > 0 && chars > cap * 1.25);
          }
          if (overflow) {
            issues.push({
              severity: "med",
              code: "TEXT_OVERFLOW_RISK",
              pageId: page.id,
              message: legacyHasExtraTypography(a)
                ? `Text ${a.id} may overflow (estimated height exceeds ${Math.round(innerH)}px available)`
                : `Text ${a.id} may overflow (~${chars} chars vs ~${cap} capacity)`,
              details: { chars, cap, fontSize: fs, availablePx: innerH, bounds: a.bounds },
            });
          }
        }
      }
      for (let j = i + 1; j < els.length; j += 1) {
        const b = els[j];
        const area = overlapArea(a.bounds, b.bounds);
        if (area <= 0) continue;
        const minArea = Math.min(a.bounds[2] * a.bounds[3], b.bounds[2] * b.bounds[3]);
        const ratio = minArea > 0 ? area / minArea : 0;
        if (ratio < 0.3) continue;
        const severity = overlapSeverity(a, b);
        if (!severity) continue;
        issues.push({
          severity,
          code: "OVERLAP",
          pageId: page.id,
          message: `Elements ${a.id} and ${b.id} overlap (~${Math.round(ratio * 100)}% of smaller)`,
          details: { a: a.id, b: b.id, ratio },
        });
      }
    }

    const density = covered / canvasArea;
    if (density > 1.6) {
      issues.push({
        severity: "med",
        code: "HIGH_DENSITY",
        pageId: page.id,
        message: `Page ${page.id} element area sum is ${density.toFixed(2)}× canvas (heavy stacking/overlap)`,
        details: { density },
      });
    }
    if (density < 0.02 && els.length > 0) {
      issues.push({
        severity: "low",
        code: "SPARSE_PAGE",
        pageId: page.id,
        message: `Page ${page.id} looks very sparse (coverage ${density.toFixed(3)})`,
        details: { density },
      });
    }
  }

  // Default ok: no high/critical (matches historical --fail-on high)
  const ok = !issuesFailThreshold(issues, "high");
  return { ok, issues };
}

/**
 * Validate + layout QA.
 * @param {object} deck
 * @param {{ projectRoot?: string, checkMedia?: boolean, failOn?: string }} [options]
 * @returns {{ ok: boolean, issues: Array<object>, failOn: string }}
 */
export function qaDeck(deck, options = {}) {
  const { deck: validatedDeck } = validateDeck(deck, {
    projectRoot: options.projectRoot,
    checkMedia: options.checkMedia !== false,
  });
  const result = analyzeLayout(validatedDeck);
  const failOn = options.failOn || "high";
  const ok = !issuesFailThreshold(result.issues, failOn);
  return { ...result, ok, failOn };
}
