/**
 * Offline HTML preview of an OpenPPT IR deck (not pixel-perfect vs PPTX).
 */

import {
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { resolveColor, validateDeck } from "./validate.js";
import { OpenPptError, ErrorCodes } from "./errors.js";
import { realOrResolve } from "./internal/paths.js";
import { ptToPx, TEXT_INSET_X_PX, TEXT_INSET_Y_PX } from "./internal/units.js";
import { chartSeriesPalette } from "./internal/chart-palette.js";
import {
  displayMarker,
  legacyHasExtraTypography,
  listMarkers,
  ownValue,
  paragraphLineHeight,
  splitLegacyNativeParagraphs,
  splitParagraphText,
} from "./internal/paragraphs.js";

/**
 * @param {string} hex
 */
function cssColor(hex) {
  if (!hex.startsWith("#")) return hex;
  if (hex.length === 9) {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    const a = Number.parseInt(hex.slice(7, 9), 16) / 255;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }
  return hex;
}

/** Double-quoted CSS family so apostrophes stay inside the identifier. */
function cssFontFamily(name) {
  const escaped = String(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Style attributes are double-quoted HTML; keep CSS quotes as entities.
  return `&quot;${escaped}&quot;`;
}

function themeScriptFonts(deck) {
  const fonts = deck?.theme?.fonts;
  const latin =
    fonts && Object.hasOwn(fonts, "latin") && fonts.latin ? fonts.latin : "Arial";
  const ea = fonts && Object.hasOwn(fonts, "ea") && fonts.ea ? fonts.ea : undefined;
  return { latin, ea };
}

function cssFontStack(latin, ea) {
  const primary = latin || "Arial";
  if (ea && ea !== primary) {
    return `font-family:${cssFontFamily(primary)},${cssFontFamily(ea)};`;
  }
  return `font-family:${cssFontFamily(primary)};`;
}

function ptCss(pt) {
  return `${ptToPx(pt)}px`;
}

function tryResolve(color, colors, id, fallback) {
  if (!color) return fallback;
  try {
    return cssColor(resolveColor(color, colors, id));
  } catch {
    return fallback;
  }
}

function letterSpacingCss(value) {
  return value === undefined ? "" : `letter-spacing:${ptCss(value)};`;
}

function renderTextRuns(el, parentColor, colors, fonts) {
  if (!Array.isArray(el.text)) return escapeHtml(String(el.text ?? ""));
  return el.text
    .map((run) => {
      const color = tryResolve(run.color, colors, el.id, parentColor);
      const bold = run.bold !== undefined ? Boolean(run.bold) : Boolean(el.bold);
      const italic = run.italic !== undefined ? Boolean(run.italic) : Boolean(el.italic);
      const fs = run.fontSize ?? el.fontSize ?? 18;
      const family = run.fontFamily || el.fontFamily || fonts.latin;
      const familyCss = cssFontStack(family, fonts.ea);
      const italicCss = `font-style:${italic ? "italic" : "normal"};`;
      const charSpacing = Object.hasOwn(run, "charSpacing")
        ? run.charSpacing
        : Object.hasOwn(el, "charSpacing")
          ? el.charSpacing
          : undefined;
      return `<span style="color:${color};font-weight:${bold ? "700" : "400"};font-size:${ptCss(fs)};${italicCss}${familyCss}${letterSpacingCss(charSpacing)}">${escapeHtml(run.text)}</span>`;
    })
    .join("");
}

function renderParagraphFragment(fragment, para, el, parentColor, colors, fonts) {
  const run = fragment.style || {};
  const effectiveColor = ownValue(para, "color", el.color);
  const color = tryResolve(run.color, colors, el.id, tryResolve(effectiveColor, colors, el.id, parentColor));
  const bold = run.bold !== undefined ? Boolean(run.bold) : ownValue(para, "bold", Boolean(el.bold));
  const italic = run.italic !== undefined ? Boolean(run.italic) : ownValue(para, "italic", Boolean(el.italic));
  const fs = run.fontSize ?? ownValue(para, "fontSize", el.fontSize ?? 18);
  const family = run.fontFamily || ownValue(para, "fontFamily", el.fontFamily || fonts.latin);
  const familyCss = cssFontStack(family, fonts.ea);
  const italicCss = `font-style:${italic ? "italic" : "normal"};`;
  const charSpacing = Object.hasOwn(run, "charSpacing")
    ? run.charSpacing
    : ownValue(para, "charSpacing", Object.hasOwn(el, "charSpacing") ? el.charSpacing : undefined);
  const spacingCss =
    charSpacing !== undefined ? `letter-spacing:${ptCss(charSpacing)};` : "";
  return `<span style="color:${color};font-weight:${bold ? "700" : "400"};font-size:${ptCss(fs)};${italicCss}${familyCss}${spacingCss}">${escapeHtml(fragment.text)}</span>`;
}

function renderParagraphs(el, parentColor, colors, fonts) {
  const markers = listMarkers(el.paragraphs);
  return el.paragraphs
    .map((para, index) => {
      const marker = markers[index];
      const align = ownValue(para, "align", el.align || "left");
      const lh = paragraphLineHeight(para, el);
      const spaceBefore = ownValue(
        para,
        "spaceBefore",
        Object.hasOwn(el, "spaceBefore") ? el.spaceBefore : 0,
      );
      const spaceAfter = ownValue(
        para,
        "spaceAfter",
        Object.hasOwn(el, "spaceAfter") ? el.spaceAfter : 0,
      );
      const indentPt = marker.kind === "none" ? 0 : marker.indent * (marker.level + 1);
      const hangPt = marker.kind === "none" ? 0 : marker.indent;
      const label = displayMarker(marker);
      const paraFs = ownValue(para, "fontSize", el.fontSize ?? 18);
      const paraBold = ownValue(para, "bold", Boolean(el.bold));
      const paraItalic = ownValue(para, "italic", Boolean(el.italic));
      const paraFamily = ownValue(para, "fontFamily", el.fontFamily || fonts.latin);
      const paraColor = tryResolve(
        ownValue(para, "color", el.color),
        colors,
        el.id,
        parentColor,
      );
      const paraType = `font-size:${ptCss(paraFs)};font-weight:${paraBold ? "700" : "400"};font-style:${paraItalic ? "italic" : "normal"};color:${paraColor};${cssFontStack(paraFamily, fonts.ea)}`;
      const markerHtml = label
        ? `<span class="para-marker" style="${paraType}">${escapeHtml(label)}</span>`
        : `<span class="para-marker" style="${paraType}"></span>`;
      const lines = [];
      for (const fragment of splitParagraphText(para.text)) {
        if (fragment.softBreakBefore || lines.length === 0) lines.push([]);
        lines[lines.length - 1].push(fragment);
      }
      const inner = lines
        .map((line) => {
          const maxFs = Math.max(
            paraFs,
            ...line.map((fragment) => fragment.style?.fontSize || paraFs),
          );
          const spans = line
            .map((fragment) =>
              renderParagraphFragment(fragment, para, el, parentColor, colors, fonts),
            )
            .join("");
          return `<div class="para-line" style="font-size:${ptCss(maxFs)};line-height:${lh};min-height:calc(${ptCss(maxFs)} * ${lh});">${spans || "&nbsp;"}</div>`;
        })
        .join("");
      const padLeft = Math.max(0, indentPt - hangPt);
      return `<div class="para" data-marker="${escapeHtml(label)}" style="display:flex;align-items:flex-start;text-align:${align};margin-top:${ptCss(spaceBefore)};margin-bottom:${ptCss(spaceAfter)};line-height:${lh};padding-left:${ptCss(padLeft)};${paraType}"><span class="para-gutter" style="flex:0 0 auto;min-width:${ptCss(hangPt)};width:max-content;">${markerHtml}</span><div class="para-body">${inner}</div></div>`;
    })
    .join("");
}

function leafDataset(page, el) {
  return `data-page="${escapeHtml(page.id)}" data-el-id="${escapeHtml(el.id)}"`;
}

function renderTable(el, colors, boxStyle, fonts, page) {
  const rows = Array.isArray(el.rows) ? el.rows : [];
  const defaultFs = el.fontSize ?? 12;
  const borderW = el.borderWidth ?? 0.5;
  const borderColor = tryResolve(el.borderColor, colors, el.id, "#CBD5E1");
  const primary = tryResolve(colors.primary, colors, "primary", "#2563EB");
  const textHex = tryResolve(colors.text, colors, "text", "#111827");
  const colCount = Math.max(
    ...rows.map((row) => (Array.isArray(row) ? row.length : 0)),
    1,
  );
  let colgroup = "";
  if (Array.isArray(el.colW) && el.colW.length > 0) {
    const weights = el.colW.slice(0, colCount);
    while (weights.length < colCount) weights.push(1);
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    colgroup = `<colgroup>${weights
      .map((weight) => `<col style="width:${(weight / sum) * 100}%"/>`)
      .join("")}</colgroup>`;
  }
  const cellChrome = `border:${ptCss(borderW)} solid ${borderColor};padding:${TEXT_INSET_Y_PX}px ${TEXT_INSET_X_PX}px;`;
  const trs = rows
    .map((row, ri) => {
      const cells = Array.isArray(row) ? row : [];
      const tds = [];
      for (let ci = 0; ci < colCount; ci += 1) {
        const cell = cells[ci];
        const isHeader = Boolean(el.header) && ri === 0;
        const tag = isHeader ? "th" : "td";
        let text = "";
        let fs = defaultFs;
        let color = isHeader ? "#FFFFFF" : textHex;
        let bold = isHeader;
        let align = "left";
        let fill = isHeader ? primary : "";
        if (cell !== undefined && cell !== null && typeof cell === "object") {
          text = String(cell.text ?? "");
          fs = cell.fontSize ?? defaultFs;
          color = tryResolve(cell.color, colors, el.id, color);
          bold = cell.bold !== undefined ? Boolean(cell.bold) : isHeader;
          align = cell.align || "left";
          if (cell.fill) fill = tryResolve(cell.fill, colors, el.id, fill);
        } else if (cell !== undefined && cell !== null) {
          text = String(cell);
        }
        const fillCss = fill ? `background:${fill};` : "";
        tds.push(
          `<${tag} style="${cellChrome}font-size:${ptCss(fs)};color:${color};font-weight:${bold ? "700" : "400"};text-align:${align};${fillCss}">${escapeHtml(text)}</${tag}>`,
        );
      }
      return `<tr>${tds.join("")}</tr>`;
    })
    .join("");
  const family = cssFontStack(fonts.latin, fonts.ea);
  return `<div class="el table" ${leafDataset(page, el)} style="${boxStyle}overflow:auto;background:#fff;"><table style="${family}">${colgroup}${trs}</table></div>`;
}

/**
 * @param {object} deck
 * @param {string} projectRoot
 * @returns {string} HTML document
 */
export function renderPreviewHtml(deck, projectRoot) {
  const { deck: validatedDeck, colors, mediaSnapshots } = validateDeck(deck, {
    projectRoot,
    checkMedia: true,
    captureMedia: true,
  });
  const fonts = themeScriptFonts(validatedDeck);
  const [cw, ch] = validatedDeck.size;
  const pagesHtml = validatedDeck.pages
    .map((page, pi) => {
      let bg = "#ffffff";
      if (page.background?.color) {
        try {
          bg = cssColor(resolveColor(page.background.color, colors, "bg"));
        } catch {
          bg = "#ffffff";
        }
      }
      const els = (page.elements || [])
        .map((el) => {
          const [x, y, w, h] = el.bounds;
          const style = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
          if (el.type === "shape") {
            const fill = tryResolve(el.fill, colors, el.id, "#2563EB");
            const radius = el.shape === "ellipse" ? "50%" : el.shape === "roundRect" ? "12px" : "0";
            let stroke = "";
            if (el.lineWidth > 0) {
              const line = tryResolve(el.lineColor, colors, el.id, fill);
              stroke = `border:${ptCss(el.lineWidth)} solid ${line};`;
            }
            return `<div class="el shape" ${leafDataset(page, el)} style="${style}background:${fill};border-radius:${radius};${stroke}"></div>`;
          }
          if (el.type === "text") {
            const color = tryResolve(el.color, colors, el.id, "#111827");
            const hasParagraphs = Array.isArray(el.paragraphs);
            const legacyBlocks = !hasParagraphs && legacyHasExtraTypography(el);
            const text = hasParagraphs
              ? renderParagraphs(el, color, colors, fonts)
              : legacyBlocks
                ? renderParagraphs(
                    { ...el, paragraphs: splitLegacyNativeParagraphs(el) },
                    color,
                    colors,
                    fonts,
                  )
                : renderTextRuns(el, color, colors, fonts);
            const align = el.align || "left";
            const fw = el.bold ? "700" : "400";
            const fs = el.fontSize ?? 18;
            const family = cssFontStack(el.fontFamily || fonts.latin, fonts.ea);
            const italicCss = `font-style:${el.italic ? "italic" : "normal"};`;
            const valign =
              el.valign === "middle" ? "center" : el.valign === "bottom" ? "flex-end" : "flex-start";
            const pad = `padding:${TEXT_INSET_Y_PX}px ${TEXT_INSET_X_PX}px;`;
            const lhCss = Object.hasOwn(el, "lineHeight") ? `line-height:${el.lineHeight};` : "";
            const spacingCss = !hasParagraphs && !legacyBlocks && Object.hasOwn(el, "charSpacing") && !Array.isArray(el.text)
              ? letterSpacingCss(el.charSpacing)
              : "";
            const innerFlow = hasParagraphs || legacyBlocks
              ? `flex-direction:column;justify-content:${valign};align-items:stretch;`
              : `align-items:${valign};`;
            const inner = `<div class="text-inner">${text}</div>`;
            const content = el.href
              ? `<a href="${escapeHtml(el.href)}">${inner}</a>`
              : inner;
            return `<div class="el text" ${leafDataset(page, el)} style="${style}${pad}color:${color};font-size:${ptCss(fs)};font-weight:${fw};${family}${italicCss}${lhCss}${spacingCss}text-align:${align};display:flex;${innerFlow}">${content}</div>`;
          }
          if (el.type === "image") {
            const mediaSrc = el.src;
            const snapshot = mediaSnapshots.get(mediaSrc);
            if (!snapshot?.dataUri) {
              throw new OpenPptError(
                ErrorCodes.MEDIA_MISSING,
                `No validated media snapshot for image: ${mediaSrc}`,
                { elementId: el.id, src: mediaSrc },
              );
            }
            const fit = el.fit === "contain" ? "contain" : el.fit === "fill" ? "fill" : "cover";
            return `<img class="el image" ${leafDataset(page, el)} src="${snapshot.dataUri}" alt="" style="${style}object-fit:${fit};"/>`;
          }
          if (el.type === "chart") {
            return `<div class="el chart" ${leafDataset(page, el)} style="${style}border:1px dashed #cbd5e1;background:#f8fafc;">${renderChartSvg(el, colors, w, h, fonts)}</div>`;
          }
          if (el.type === "table") {
            return renderTable(el, colors, style, fonts, page);
          }
          return "";
        })
        .join("\n");

      return `<section class="page" data-page="${escapeHtml(page.id)}" style="width:${cw}px;height:${ch}px;background:${bg};">
  <header class="page-label">P${pi + 1} · ${escapeHtml(page.id)}</header>
  ${els}
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(validatedDeck.title || "OpenPPT preview")}</title>
<style>
  body { margin:0; font-family: system-ui, sans-serif; background:#0f172a; color:#e2e8f0; }
  h1 { font-size:16px; font-weight:600; padding:16px 20px; margin:0; border-bottom:1px solid #1e293b; }
  main { display:flex; flex-direction:column; gap:24px; padding:24px; align-items:center; }
  .page { position:relative; box-shadow:0 12px 40px rgba(0,0,0,.45); overflow:hidden; }
  .page-label { position:absolute; top:4px; right:8px; font-size:11px; color:#64748b; z-index:10; }
  .el { position:absolute; box-sizing:border-box; overflow:hidden; cursor:pointer; }
  .el.selected { outline:2px solid #4f7cff; outline-offset:-2px; }
  .el a { color:inherit; text-decoration:inherit; display:block; width:100%; height:100%; }
  .text { white-space:pre-wrap; line-height:1.25; font-family:Arial,sans-serif; overflow-wrap:anywhere; }
  .text-inner { width:100%; min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }
  .para { width:100%; min-width:0; overflow-wrap:anywhere; }
  .para-body { flex:1; min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }
  .para-gutter { flex:0 0 auto; }
  .para-marker { display:inline-block; white-space:nowrap; overflow-wrap:normal; word-break:normal; }
  .image { display:block; }
  .table table { width:100%; height:100%; border-collapse:collapse; table-layout:fixed; font-family:Arial,sans-serif; color:#111; }
  .table th, .table td { text-align:left; vertical-align:middle; }
  .table th { color:#fff; }
  .chart svg { display:block; width:100%; height:100%; }
  footer { padding:12px 20px 24px; font-size:12px; color:#64748b; text-align:center; }
</style>
</head>
<body>
  <h1>OpenPPT preview — ${escapeHtml(validatedDeck.title || "untitled")} (${cw}×${ch})</h1>
  <main>
${pagesHtml}
  </main>
  <footer>Offline IR preview · not pixel-identical to PowerPoint · OpenPPT</footer>
</body>
</html>
`;
}

/* ---------- structural mini-charts (inline SVG, no scripts) ---------- */

const CHART_POINT_CAPS = { bar: 64, line: 256, area: 256, pie: 24, doughnut: 24 };
const CHART_BG = "#f8fafc";

function chartPalette(colors) {
  return chartSeriesPalette(colors).map((hex) => cssColor(hex));
}

/** Evenly sample long series so structural previews stay lightweight. */
function samplePoints(values, cap) {
  if (values.length <= cap) return values;
  const out = [];
  const step = values.length / cap;
  for (let i = 0; i < cap; i += 1) out.push(values[Math.floor(i * step)]);
  return out;
}

const fin = (n) => (Number.isFinite(n) ? Number(n.toFixed(2)) : 0);

/**
 * Render a schema-validated chart element as a small inline SVG.
 * Structural approximation only — legends, axes, and gridlines are minimal.
 * @param {object} el
 * @param {Record<string, string>} colors
 * @param {number} width
 * @param {number} height
 */
function renderChartSvg(el, colors, width, height, fonts = { latin: "Arial" }) {
  const chartFamily = cssFontStack(fonts.latin, fonts.ea).replace(/^font-family:/, "").replace(/;$/, "");
  const palette = chartPalette(colors);
  const kind = el.chartType;
  const cap = CHART_POINT_CAPS[kind] || 64;
  const series = (el.series || []).map((entry, i) => ({
    name: String(entry.name ?? `S${i + 1}`),
    values: samplePoints((entry.values || []).map((v) => (Number.isFinite(v) ? v : 0)), cap),
    labels: entry.labels,
    color: palette[i % palette.length],
  }));
  const title = el.title
    ? `<text x="6" y="13" font-size="10" font-weight="600" fill="#334155" font-family="${chartFamily}">${escapeHtml(String(el.title).slice(0, 60))}</text>`
    : "";
  const pad = { top: el.title ? 20 : 8, right: 8, bottom: 8, left: 8 };
  const labels = series[0]?.labels ? samplePoints(series[0].labels.map(String), cap) : null;
  if (labels) pad.bottom = 18;
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = Math.max(10, height - pad.top - pad.bottom);
  let body = "";

  if (kind === "pie" || kind === "doughnut") {
    body = renderPieBody(series[0], width, height, pad, palette, kind === "doughnut", chartFamily);
  } else {
    const cats = Math.max(1, ...series.map((s) => s.values.length));
    const all = series.flatMap((s) => s.values);
    const min = Math.min(0, ...all);
    const max = Math.max(0, ...all);
    const span = max - min || 1;
    const y = (v) => pad.top + ((max - v) / span) * plotH;
    const zero = y(0);
    body += `<line x1="${fin(pad.left)}" y1="${fin(zero)}" x2="${fin(pad.left + plotW)}" y2="${fin(zero)}" stroke="#cbd5e1" stroke-width="1"/>`;

    if (kind === "bar") {
      const groupW = plotW / cats;
      const barW = Math.max(1, (groupW * 0.72) / series.length);
      series.forEach((s, si) => {
        s.values.forEach((v, ci) => {
          const x = pad.left + ci * groupW + groupW * 0.14 + si * barW;
          const top = Math.min(y(v), zero);
          const h = Math.max(0.5, Math.abs(y(v) - zero));
          body += `<rect x="${fin(x)}" y="${fin(top)}" width="${fin(barW * 0.92)}" height="${fin(h)}" fill="${s.color}" rx="1"/>`;
        });
      });
    } else {
      // line / area
      series.forEach((s) => {
        const xs = (i) =>
          pad.left + (s.values.length === 1 ? plotW / 2 : (i * plotW) / (s.values.length - 1));
        const pts = s.values.map((v, i) => `${fin(xs(i))},${fin(y(v))}`).join(" ");
        if (kind === "area" && s.values.length > 1) {
          const first = `${fin(xs(0))},${fin(zero)}`;
          const last = `${fin(xs(s.values.length - 1))},${fin(zero)}`;
          body += `<polygon points="${first} ${pts} ${last}" fill="${s.color}" fill-opacity="0.18" stroke="none"/>`;
        }
        body += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.5"/>`;
      });
    }

    if (labels) {
      const shown = Math.min(labels.length, 8);
      for (let i = 0; i < shown; i += 1) {
        const idx = Math.floor((i * labels.length) / shown);
        const x = pad.left + (plotW * (idx + 0.5)) / Math.max(1, labels.length);
        body += `<text x="${fin(x)}" y="${fin(height - 5)}" font-size="7" fill="#64748b" text-anchor="middle" font-family="${chartFamily}">${escapeHtml(labels[idx].slice(0, 10))}</text>`;
      }
    }
    if (series.length > 1) {
      series.slice(0, 4).forEach((s, i) => {
        const lx = width - pad.right - 66;
        const ly = pad.top + 4 + i * 11;
        body += `<rect x="${fin(lx)}" y="${fin(ly - 6)}" width="7" height="7" fill="${s.color}" rx="1"/>`;
        body += `<text x="${fin(lx + 10)}" y="${fin(ly)}" font-size="7" fill="#475569" font-family="${chartFamily}">${escapeHtml(s.name.slice(0, 12))}</text>`;
      });
    }
  }

  return `<svg viewBox="0 0 ${fin(width)} ${fin(height)}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="chart preview">${title}${body}</svg>`;
}

function renderPieBody(first, width, height, pad, palette, doughnut, chartFamily = "Arial") {
  const values = (first?.values || []).map((v) => Math.max(0, v));
  const labels = first?.labels || null;
  const total = values.reduce((a, b) => a + b, 0);
  const cx = width / 2;
  const cy = pad.top + (height - pad.top - pad.bottom) / 2;
  const r = Math.max(6, Math.min(width - pad.left - pad.right, height - pad.top - pad.bottom) / 2 - 4);
  if (!(total > 0)) {
    return `<text x="${fin(cx)}" y="${fin(cy)}" font-size="9" fill="#94a3b8" text-anchor="middle" font-family="${chartFamily}">no data</text>`;
  }
  let body = "";
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    const frac = v / total;
    if (frac <= 0) return;
    const color = palette[i % palette.length];
    if (frac >= 0.999) {
      body += `<circle cx="${fin(cx)}" cy="${fin(cy)}" r="${fin(r)}" fill="${color}"/>`;
      angle += Math.PI * 2;
      return;
    }
    const end = angle + frac * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const large = frac > 0.5 ? 1 : 0;
    body += `<path d="M ${fin(cx)} ${fin(cy)} L ${fin(x1)} ${fin(y1)} A ${fin(r)} ${fin(r)} 0 ${large} 1 ${fin(x2)} ${fin(y2)} Z" fill="${color}"/>`;
    angle = end;
  });
  if (doughnut) {
    body += `<circle cx="${fin(cx)}" cy="${fin(cy)}" r="${fin(r * 0.55)}" fill="${CHART_BG}"/>`;
  }
  if (labels && labels.length) {
    const shown = labels.slice(0, 3).map((l) => String(l).slice(0, 8)).join(" · ");
    body += `<text x="${fin(cx)}" y="${fin(height - 5)}" font-size="7" fill="#64748b" text-anchor="middle" font-family="${chartFamily}">${escapeHtml(shown)}${labels.length > 3 ? " …" : ""}</text>`;
  }
  return body;
}

/**
 * @param {string} s
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Write preview HTML next to deck or to output path.
 * @param {object} deck
 * @param {string} projectRoot
 * @param {string} outputPath
 * @param {{ force?: boolean, sourcePath?: string }} [options]
 */
export function writePreviewHtml(deck, projectRoot, outputPath, options = {}) {
  const { force = false, sourcePath } = options;
  const out = resolve(outputPath);
  if (sourcePath && realOrResolve(sourcePath) === realOrResolve(out)) {
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `Refusing to overwrite source deck path: ${out}`,
      { sourcePath, outputPath: out },
    );
  }
  if (existsSync(out) && !force) {
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `Output already exists (pass force=true to overwrite): ${out}`,
    );
  }
  mkdirSync(dirname(out), { recursive: true });
  const html = renderPreviewHtml(deck, projectRoot);
  const tmp = join(
    dirname(out),
    `.openppt-preview-${randomBytes(8).toString("hex")}.tmp.html`,
  );
  try {
    writeFileSync(tmp, html, "utf8");
    renameSync(tmp, out);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore cleanup failures
    }
    if (err instanceof OpenPptError) throw err;
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `Preview write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return out;
}
