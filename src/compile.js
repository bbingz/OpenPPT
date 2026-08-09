import {
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import PptxGenJS from "pptxgenjs";
import { validateDeck, resolveColor, safeProjectPath } from "./validate.js";
import { OpenPptError, ErrorCodes } from "./errors.js";

/** CSS px → inches at 96dpi (matches common web/PPT mapping). */
const PX_PER_IN = 96;

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
        slide.addImage({
          path: abs,
          ...box,
        });
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
