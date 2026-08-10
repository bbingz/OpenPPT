/**
 * Structural layout QA (no browser): overlaps, density, empty pages.
 */

import { validateDeck } from "./validate.js";
import { SeverityRank } from "./errors.js";

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
 * Relative luminance 0–1 for #RRGGBB / #RRGGBBAA (ignores alpha for contrast).
 * @param {string} hex
 */
function luminance(hex) {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#")) return null;
  const h = hex.slice(1);
  if (h.length !== 6 && h.length !== 8) return null;
  const r = Number.parseInt(h.slice(0, 2), 16) / 255;
  const g = Number.parseInt(h.slice(2, 4), 16) / 255;
  const b = Number.parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Resolve theme token or return hex as-is when already hex.
 * @param {string | undefined} color
 * @param {Record<string, string>} colors
 */
function resolveMaybe(color, colors) {
  if (!color) return null;
  if (color.startsWith("$")) return colors[color.slice(1)] || null;
  return color;
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
    const pageLum = luminance(pageBg);

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

      // Low contrast text vs page background (rough)
      if (a.type === "text" && pageLum !== null) {
        const rawColor = resolveMaybe(a.color, colors) || "#111827";
        const textLum = luminance(rawColor);
        if (textLum !== null) {
          const ratio =
            (Math.max(pageLum, textLum) + 0.05) /
            (Math.min(pageLum, textLum) + 0.05);
          if (ratio < 2.5) {
            issues.push({
              severity: "med",
              code: "LOW_CONTRAST",
              pageId: page.id,
              message: `Text ${a.id} may have low contrast vs page background (≈${ratio.toFixed(1)}:1)`,
              details: { text: rawColor, background: pageBg, ratio },
            });
          }
        }
      }

      // CJK-aware text capacity heuristic (rough)
      if (a.type === "text") {
        const raw = Array.isArray(a.text)
          ? a.text.map((r) => r.text).join("")
          : String(a.text ?? "");
        const chars = raw.replace(/\s/g, "").length;
        const fs = a.fontSize || 18;
        // CJK ≈ full-width; latin average ~0.55em — use 0.9em as mixed default
        const cap = Math.floor((w / (fs * 0.9)) * (h / (fs * 1.35)));
        if (chars > 8 && cap > 0 && chars > cap * 1.25) {
          issues.push({
            severity: "med",
            code: "TEXT_OVERFLOW_RISK",
            pageId: page.id,
            message: `Text ${a.id} may overflow (~${chars} chars vs ~${cap} capacity)`,
            details: { chars, cap, fontSize: fs, bounds: a.bounds },
          });
        }
      }
      for (let j = i + 1; j < els.length; j += 1) {
        const b = els[j];
        // Skip intentional text-over-shape of same area class loosely: only flag significant overlap
        const area = overlapArea(a.bounds, b.bounds);
        if (area <= 0) continue;
        const minArea = Math.min(a.bounds[2] * a.bounds[3], b.bounds[2] * b.bounds[3]);
        const ratio = minArea > 0 ? area / minArea : 0;
        // Text on shape is common (label on ellipse) — only high severity when both text or both shapes with >30%
        const bothText = a.type === "text" && b.type === "text";
        const bothShape = a.type === "shape" && b.type === "shape";
        if (ratio >= 0.3 && (bothText || bothShape)) {
          issues.push({
            severity: bothText ? "high" : "med",
            code: "OVERLAP",
            pageId: page.id,
            message: `Elements ${a.id} and ${b.id} overlap (~${Math.round(ratio * 100)}% of smaller)`,
            details: { a: a.id, b: b.id, ratio },
          });
        } else if (ratio >= 0.85 && a.type !== b.type) {
          // nearly full cover text-on-shape is OK; ignore
        }
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
  validateDeck(deck, {
    projectRoot: options.projectRoot,
    checkMedia: options.checkMedia !== false,
  });
  const result = analyzeLayout(deck);
  const failOn = options.failOn || "high";
  const ok = !issuesFailThreshold(result.issues, failOn);
  return { ...result, ok, failOn };
}
