import { resolveColor } from "../validate.js";

/** Existing preview fallback series colors, in order. */
export const CHART_PALETTE_FALLBACKS = [
  "#2563EB",
  "#7C3AED",
  "#059669",
  "#D97706",
  "#DC2626",
  "#0891B2",
  "#4B5563",
];

const PREFERRED_KEYS = ["primary", "accent", "muted"];
const SKIP_KEYS = new Set(["background", "surface", "text"]);

function rgbKey(hex) {
  const raw = hex.startsWith("#") ? hex.slice(1) : hex;
  return raw.slice(0, 6).toUpperCase();
}

/**
 * Deterministic PPTX/preview series palette.
 * Preferred theme keys, then other non-background custom keys, then fallbacks.
 * Dedupes case-insensitively on resolved RGB. Never uses background/surface/text.
 *
 * @param {Record<string, string>} colors
 * @returns {string[]} #RRGGBB colors
 */
export function chartSeriesPalette(colors = {}) {
  const seen = new Set();
  const palette = [];
  const add = (hex) => {
    if (typeof hex !== "string") return;
    const key = rgbKey(hex);
    if (!/^[0-9A-F]{6}$/.test(key) || seen.has(key)) return;
    seen.add(key);
    palette.push(`#${key}`);
  };

  for (const key of PREFERRED_KEYS) {
    if (!Object.hasOwn(colors, key) || colors[key] == null) continue;
    add(resolveColor(colors[key], colors, `theme.colors.${key}`));
  }
  for (const key of Object.keys(colors)) {
    if (SKIP_KEYS.has(key) || PREFERRED_KEYS.includes(key)) continue;
    add(resolveColor(colors[key], colors, `theme.colors.${key}`));
  }
  for (const hex of CHART_PALETTE_FALLBACKS) add(hex);
  if (palette.length === 0) add("#2563EB");
  return palette;
}
