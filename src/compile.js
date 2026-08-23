import {
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import PptxGenJS from "pptxgenjs";
import { validateDeck, resolveColor, safeProjectPath } from "./validate.js";
import { OpenPptError, ErrorCodes } from "./errors.js";

/** CSS px → inches at 96dpi (matches common web/PPT mapping). */
const PX_PER_IN = 96;

/**
 * Natural pixel size for local raster images (PNG/JPEG/GIF/WEBP).
 * pptxgenjs cover/contain sizing uses options.w/h as *image aspect*, not natural
 * pixels — we need this to pass a correct aspect ratio. Returns null for SVG/unknown.
 * @param {string} absPath
 * @returns {{ width: number, height: number } | null}
 */
export function readImageSize(absPath) {
  let buf;
  try {
    buf = readFileSync(absPath);
  } catch {
    return null;
  }
  if (buf.length < 24) return null;

  // PNG
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // JPEG — scan SOF0/1/2
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        i += 2;
        continue;
      }
      if (marker === 0x00 || marker === 0xff) {
        i += 1;
        continue;
      }
      if (i + 8 >= buf.length) break;
      // SOF markers that carry dimensions
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      }
      const segLen = buf.readUInt16BE(i + 2);
      if (segLen < 2) break;
      i += 2 + segLen;
    }
    return null;
  }

  // WEBP
  if (
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP" &&
    buf.length >= 30
  ) {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16),
        height: 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16),
      };
    }
    if (chunk === "VP8 " && buf.length >= 30) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
  }

  return null;
}

/**
 * pptxgenjs `sizing.cover|contain` treats options.w/h as the *source image aspect*,
 * not the display box. When both equal the IR bounds, crop is always zero → stretch.
 * Return placement w/h (inches) with natural aspect so OOXML srcRect crops correctly.
 * @param {{ width: number, height: number }} nat
 * @param {{ w: number, h: number }} box inches
 * @param {"cover" | "contain"} mode
 */
function placementForFit(nat, box, mode) {
  const imgAr = nat.width / nat.height;
  const boxAr = box.w / box.h;
  if (mode === "contain") {
    if (imgAr > boxAr) {
      return { w: box.w, h: box.w / imgAr };
    }
    return { w: box.h * imgAr, h: box.h };
  }
  // cover: scale so image fully covers the box
  if (imgAr > boxAr) {
    return { w: box.h * imgAr, h: box.h };
  }
  return { w: box.w, h: box.w / imgAr };
}

/**
 * @param {number} px
 * @returns {number}
 */
function pxToIn(px) {
  return px / PX_PER_IN;
}

/**
 * Convert IR color to pptxgenjs color (6 hex, no #) and optional transparency.
 * #RRGGBBAA → color + transparency 0–100 (100 = fully transparent).
 * @param {string} hex
 * @returns {{ color: string, transparency?: number }}
 */
function toPptxColorParts(hex) {
  if (!hex.startsWith("#")) {
    return { color: hex };
  }
  if (hex.length === 9) {
    const rgb = hex.slice(1, 7);
    const aa = Number.parseInt(hex.slice(7, 9), 16);
    // pptxgenjs transparency: 0 opaque … 100 fully transparent
    const transparency = Math.round((1 - aa / 255) * 100);
    return { color: rgb, transparency };
  }
  return { color: hex.slice(1) };
}

/**
 * @param {string} hex
 * @returns {string} 6-digit hex without #
 */
function toPptxColor(hex) {
  return toPptxColorParts(hex).color;
}

/**
 * Map shape name to pptxgenjs shape.
 * @param {string} shape
 * @param {import("pptxgenjs").default} pptx
 */
function mapShape(shape, pptx) {
  const s = pptx.ShapeType || {};
  switch (shape) {
    case "ellipse":
      return s.ellipse || "ellipse";
    case "roundRect":
      return s.roundRect || "roundRect";
    case "rect":
    default:
      return s.rect || "rect";
  }
}

/**
 * Shared slide renderer used by file and buffer export paths.
 * @param {object} deck
 * @param {Record<string, string>} colors
 * @param {string} projectRoot
 */
function buildPresentation(deck, colors, projectRoot) {
  const [canvasW, canvasH] = deck.size;
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: "OPENPPT",
    width: pxToIn(canvasW),
    height: pxToIn(canvasH),
  });
  pptx.layout = "OPENPPT";
  pptx.author = "OpenPPT";
  if (deck.title) {
    pptx.title = deck.title;
  }

  for (const page of deck.pages) {
    const slide = pptx.addSlide();
    if (page.background?.color) {
      const bg = toPptxColorParts(
        resolveColor(page.background.color, colors, "background"),
      );
      slide.background = { color: bg.color };
    }

    for (const el of page.elements) {
      const [x, y, w, h] = el.bounds;
      const box = {
        x: pxToIn(x),
        y: pxToIn(y),
        w: pxToIn(w),
        h: pxToIn(h),
      };

      if (el.type === "text") {
        const base = el.color
          ? toPptxColorParts(resolveColor(el.color, colors, el.id))
          : { color: "111827" };
        // fontSize is IR points (pptxgenjs unit), not CSS px — see docs/IR.md
        const boxOpts = {
          ...box,
          fontSize: el.fontSize ?? 18,
          fontFace: el.fontFamily || "Arial",
          color: base.color,
          bold: Boolean(el.bold),
          align: el.align || "left",
          valign: el.valign || "top",
        };
        if (base.transparency !== undefined) {
          boxOpts.transparency = base.transparency;
        }
        if (el.href && typeof el.href === "string") {
          boxOpts.hyperlink = { url: el.href };
        }
        if (Array.isArray(el.text)) {
          const runs = el.text.map((run) => {
            const options = {};
            if (run.bold !== undefined) options.bold = Boolean(run.bold);
            if (run.italic !== undefined) options.italic = Boolean(run.italic);
            if (run.fontSize !== undefined) options.fontSize = run.fontSize;
            if (run.fontFamily) options.fontFace = run.fontFamily;
            if (run.color) {
              const parts = toPptxColorParts(
                resolveColor(run.color, colors, `${el.id}.run`),
              );
              options.color = parts.color;
              if (parts.transparency !== undefined) {
                options.transparency = parts.transparency;
              }
            }
            return { text: run.text, options };
          });
          slide.addText(runs, boxOpts);
        } else {
          slide.addText(el.text, boxOpts);
        }
      } else if (el.type === "shape") {
        const fillParts = el.fill
          ? toPptxColorParts(resolveColor(el.fill, colors, el.id))
          : { color: "2563EB" };
        const lineParts = el.lineColor
          ? toPptxColorParts(resolveColor(el.lineColor, colors, el.id))
          : fillParts;
        const fill = { color: fillParts.color };
        if (fillParts.transparency !== undefined) {
          fill.transparency = fillParts.transparency;
        }
        slide.addShape(mapShape(el.shape, pptx), {
          ...box,
          fill,
          line: {
            color: lineParts.color,
            width: el.lineWidth ?? 0,
          },
        });
      } else if (el.type === "image") {
        const abs = safeProjectPath(projectRoot, el.src);
        // Default cover: fill box without stretching (crop overflow).
        // fit=fill keeps legacy stretch; fit=contain letterboxes.
        // pptxgenjs quirk: sizing cover/contain uses options.w/h as image aspect
        // (not natural pixels). Pass natural-aspect placement + box as sizing.
        const fit = el.fit || "cover";
        /** @type {Record<string, unknown>} */
        const imgOpts = {
          path: abs,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
        };
        if (fit === "cover" || fit === "contain" || fit === "crop") {
          const nat = readImageSize(abs);
          const mode = fit === "contain" ? "contain" : "cover";
          if (nat && nat.width > 0 && nat.height > 0) {
            const place = placementForFit(nat, box, mode);
            imgOpts.w = place.w;
            imgOpts.h = place.h;
          }
          // Map crop → cover (centered). Explicit crop offsets not in IR v1.
          imgOpts.sizing = {
            type: mode,
            w: box.w,
            h: box.h,
          };
        }
        // fit=fill: no sizing → a:stretch into box (legacy)
        slide.addImage(imgOpts);
      } else if (el.type === "chart") {
        const typeMap = {
          bar: pptx.ChartType.bar,
          line: pptx.ChartType.line,
          pie: pptx.ChartType.pie,
          doughnut: pptx.ChartType.doughnut,
          area: pptx.ChartType.area,
        };
        const chartType = typeMap[el.chartType] || pptx.ChartType.bar;
        const series = el.series.map((ser) => ({
          name: ser.name,
          labels: ser.labels || ser.values.map((_, i) => String(i + 1)),
          values: ser.values,
        }));
        const chartOpts = {
          ...box,
          showTitle: Boolean(el.title),
          showLegend: el.series.length > 1,
        };
        if (el.title) chartOpts.title = el.title;
        slide.addChart(chartType, series, chartOpts);
      } else if (el.type === "table") {
        const borderColor = el.borderColor
          ? toPptxColor(resolveColor(el.borderColor, colors, el.id))
          : "CBD5E1";
        const borderW = el.borderWidth ?? 0.5;
        const defaultFs = el.fontSize ?? 12;
        const colCount = Math.max(
          ...el.rows.map((r) => (Array.isArray(r) ? r.length : 0)),
          1,
        );
        /** @type {number[]} */
        let colWIn;
        if (Array.isArray(el.colW) && el.colW.length > 0) {
          const weights = el.colW.slice(0, colCount);
          while (weights.length < colCount) weights.push(1);
          const sum = weights.reduce((a, b) => a + b, 0);
          colWIn = weights.map((w) => (box.w * w) / sum);
        } else {
          colWIn = Array.from({ length: colCount }, () => box.w / colCount);
        }

        const primaryHex = colors.primary
          ? toPptxColor(resolveColor(colors.primary, colors, "primary"))
          : "2563EB";
        const textHex = colors.text
          ? toPptxColor(resolveColor(colors.text, colors, "text"))
          : "111827";

        const tableRows = el.rows.map((row, ri) => {
          const cells = [];
          for (let ci = 0; ci < colCount; ci += 1) {
            const cell = row[ci];
            const isHeader = Boolean(el.header) && ri === 0;
            if (cell === undefined || cell === null) {
              cells.push({ text: "", options: { fontSize: defaultFs } });
              continue;
            }
            if (typeof cell === "string" || typeof cell === "number") {
              /** @type {Record<string, unknown>} */
              const options = {
                fontSize: defaultFs,
                color: isHeader ? "FFFFFF" : textHex,
                bold: isHeader,
                align: "left",
                valign: "middle",
              };
              if (isHeader) {
                options.fill = { color: primaryHex };
              }
              cells.push({ text: String(cell), options });
            } else {
              const parts = cell.color
                ? toPptxColorParts(resolveColor(cell.color, colors, el.id))
                : { color: isHeader ? "FFFFFF" : textHex };
              /** @type {Record<string, unknown>} */
              const options = {
                fontSize: cell.fontSize ?? defaultFs,
                color: parts.color,
                bold: cell.bold !== undefined ? Boolean(cell.bold) : isHeader,
                align: cell.align || "left",
                valign: "middle",
              };
              if (cell.fill) {
                options.fill = {
                  color: toPptxColor(resolveColor(cell.fill, colors, el.id)),
                };
              } else if (isHeader) {
                options.fill = { color: primaryHex };
              }
              cells.push({ text: String(cell.text ?? ""), options });
            }
          }
          return cells;
        });

        slide.addTable(tableRows, {
          ...box,
          colW: colWIn,
          border: [
            { type: "solid", pt: borderW, color: borderColor },
            { type: "solid", pt: borderW, color: borderColor },
            { type: "solid", pt: borderW, color: borderColor },
            { type: "solid", pt: borderW, color: borderColor },
          ],
          fontFace: "Arial",
          fontSize: defaultFs,
          color: textHex,
          align: "left",
          valign: "middle",
        });
      }
    }
  }

  return pptx;
}

/**
 * Resolve path for equality checks (realpath when possible).
 * @param {string} p
 */
function realOrResolve(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Compile a validated deck object to a PPTX file using pptxgenjs (open source).
 * Writes to a sibling temp file then renames — never unlinks the destination
 * before a successful write, and refuses to overwrite the source deck path.
 * @param {object} deck
 * @param {string} outputPath
 * @param {{ projectRoot: string, force?: boolean, sourcePath?: string }} options
 * @returns {Promise<{ outputPath: string, pageCount: number }>}
 */
export async function compileToPptx(deck, outputPath, options) {
  const { projectRoot, force = false, sourcePath } = options;
  const { colors } = validateDeck(deck, { projectRoot, checkMedia: true });

  const out = resolve(outputPath);
  const outKey = realOrResolve(out);

  if (sourcePath) {
    const srcKey = realOrResolve(sourcePath);
    if (srcKey === outKey) {
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        `Refusing to overwrite source deck path: ${out}`,
        { sourcePath, outputPath: out },
      );
    }
  }

  if (existsSync(out) && !force) {
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `Output already exists (pass force=true to overwrite): ${out}`,
    );
  }

  mkdirSync(dirname(out), { recursive: true });
  const pptx = buildPresentation(deck, colors, projectRoot);
  // pptxgenjs appends ".pptx" when the path does not already end with it.
  const tmp = join(
    dirname(out),
    `.openppt-export-${randomBytes(8).toString("hex")}.tmp.pptx`,
  );

  try {
    await pptx.writeFile({ fileName: tmp });
    if (!existsSync(tmp)) {
      throw new OpenPptError(ErrorCodes.EXPORT, `Export produced no temp file at ${tmp}`);
    }
    // Atomic replace of destination only after successful write.
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
      `pptxgenjs write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!existsSync(out)) {
    throw new OpenPptError(ErrorCodes.EXPORT, `Export produced no file at ${out}`);
  }

  return { outputPath: out, pageCount: deck.pages.length };
}

/**
 * Compile to in-memory PPTX bytes (ZIP).
 * @param {object} deck
 * @param {{ projectRoot: string }} options
 * @returns {Promise<Buffer>}
 */
export async function compileToBuffer(deck, options) {
  const { projectRoot } = options;
  const { colors } = validateDeck(deck, { projectRoot, checkMedia: true });
  const pptx = buildPresentation(deck, colors, projectRoot);
  const data = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
