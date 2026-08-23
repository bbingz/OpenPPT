/**
 * Offline HTML preview of an OpenPPT IR deck (not pixel-perfect vs PPTX).
 */

import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { resolveColor, safeProjectPath, validateDeck } from "./validate.js";
import { OpenPptError, ErrorCodes } from "./errors.js";

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

/**
 * @param {object} deck
 * @param {string} projectRoot
 * @returns {string} HTML document
 */
export function renderPreviewHtml(deck, projectRoot) {
  validateDeck(deck, { projectRoot, checkMedia: true });
  const colors = { ...(deck.theme?.colors || {}) };
  const [cw, ch] = deck.size;
  const pagesHtml = deck.pages
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
            let fill = "#2563EB";
            try {
              if (el.fill) fill = cssColor(resolveColor(el.fill, colors, el.id));
            } catch {
              /* keep default */
            }
            const radius = el.shape === "ellipse" ? "50%" : el.shape === "roundRect" ? "12px" : "0";
            return `<div class="el shape" style="${style}background:${fill};border-radius:${radius};"></div>`;
          }
          if (el.type === "text") {
            let color = "#111827";
            try {
              if (el.color) color = cssColor(resolveColor(el.color, colors, el.id));
            } catch {
              /* */
            }
            const text = Array.isArray(el.text)
              ? el.text
                  .map((r) => {
                    let c = color;
                    try {
                      if (r.color) c = cssColor(resolveColor(r.color, colors, el.id));
                    } catch {
                      /* */
                    }
                    const fw = r.bold ? "700" : "400";
                    const fs = r.fontSize || el.fontSize || 18;
                    return `<span style="color:${c};font-weight:${fw};font-size:${fs}px">${escapeHtml(r.text)}</span>`;
                  })
                  .join("")
              : escapeHtml(String(el.text ?? ""));
            const align = el.align || "left";
            const fw = el.bold ? "700" : "400";
            const fs = el.fontSize || 18;
            return `<div class="el text" style="${style}color:${color};font-size:${fs}px;font-weight:${fw};text-align:${align};display:flex;align-items:${el.valign === "middle" ? "center" : el.valign === "bottom" ? "flex-end" : "flex-start"};">${text}</div>`;
          }
          if (el.type === "image") {
            const abs = safeProjectPath(projectRoot, el.src);
            let srcAttr = "";
            if (existsSync(abs)) {
              const b64 = readFileSync(abs).toString("base64");
              const ext = abs.split(".").pop()?.toLowerCase() || "png";
              const mime =
                ext === "jpg" || ext === "jpeg"
                  ? "image/jpeg"
                  : ext === "svg"
                    ? "image/svg+xml"
                    : ext === "webp"
                      ? "image/webp"
                      : ext === "gif"
                        ? "image/gif"
                        : "image/png";
              srcAttr = `data:${mime};base64,${b64}`;
            }
            const fit = el.fit === "contain" ? "contain" : el.fit === "fill" ? "fill" : "cover";
            return `<img class="el image" src="${srcAttr}" alt="" style="${style}object-fit:${fit};"/>`;
          }
          if (el.type === "chart") {
            return `<div class="el chart" style="${style}border:1px dashed #94a3b8;display:flex;align-items:center;justify-content:center;font:14px sans-serif;color:#64748b;background:#f8fafc;">chart: ${escapeHtml(el.chartType || "?")} ${escapeHtml(el.title || "")}</div>`;
          }
          if (el.type === "table") {
            const rows = Array.isArray(el.rows) ? el.rows : [];
            const trs = rows
              .map((row, ri) => {
                const cells = Array.isArray(row) ? row : [];
                const tds = cells
                  .map((cell) => {
                    const text =
                      cell && typeof cell === "object"
                        ? String(cell.text ?? "")
                        : String(cell ?? "");
                    const tag = el.header && ri === 0 ? "th" : "td";
                    return `<${tag}>${escapeHtml(text)}</${tag}>`;
                  })
                  .join("");
                return `<tr>${tds}</tr>`;
              })
              .join("");
            return `<div class="el table" style="${style}overflow:auto;background:#fff;"><table>${trs}</table></div>`;
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
<title>${escapeHtml(deck.title || "OpenPPT preview")}</title>
<style>
  body { margin:0; font-family: system-ui, sans-serif; background:#0f172a; color:#e2e8f0; }
  h1 { font-size:16px; font-weight:600; padding:16px 20px; margin:0; border-bottom:1px solid #1e293b; }
  main { display:flex; flex-direction:column; gap:24px; padding:24px; align-items:center; }
  .page { position:relative; box-shadow:0 12px 40px rgba(0,0,0,.45); overflow:hidden; }
  .page-label { position:absolute; top:4px; right:8px; font-size:11px; color:#64748b; z-index:10; }
  .el { position:absolute; box-sizing:border-box; overflow:hidden; }
  .text { white-space:pre-wrap; line-height:1.25; }
  .image { display:block; }
  .table table { width:100%; height:100%; border-collapse:collapse; font:12px system-ui,sans-serif; color:#111; }
  .table th, .table td { border:1px solid #cbd5e1; padding:4px 6px; text-align:left; vertical-align:middle; }
  .table th { background:#2563eb; color:#fff; }
  footer { padding:12px 20px 24px; font-size:12px; color:#64748b; text-align:center; }
</style>
</head>
<body>
  <h1>OpenPPT preview — ${escapeHtml(deck.title || "untitled")} (${cw}×${ch})</h1>
  <main>
${pagesHtml}
  </main>
  <footer>Offline IR preview · not pixel-identical to PowerPoint · OpenPPT</footer>
</body>
</html>
`;
}

/**
 * @param {string} s
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function realOrResolve(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
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
