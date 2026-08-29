import {
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
  realpathSync,
  readFileSync,
  linkSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import PptxGenJS from "pptxgenjs";
import { resolveColor, validateDeck } from "./validate.js";
import { OpenPptError, ErrorCodes } from "./errors.js";
import { installFileNoClobber } from "./project-write.js";

/** CSS px → inches at 96dpi (matches common web/PPT mapping). */
const PX_PER_IN = 96;

/**
 * pptxgenjs `sizing.cover|contain` treats options.w/h as the *source image aspect*,
 * not the display box. When both equal the IR bounds, crop is always zero → stretch.
 * Return placement w/h (inches) with natural aspect so OOXML srcRect crops correctly.
 * @param {{ width: number, height: number }} nat
 * @param {{ w: number, h: number }} box inches
 * @param {"cover" | "contain"} mode
 */
function placementForFit(nat, box, mode) {
  if (
    !nat ||
    !Number.isFinite(nat.width) ||
    !Number.isFinite(nat.height) ||
    nat.width <= 0 ||
    nat.height <= 0
  ) {
    throw new OpenPptError(
      ErrorCodes.MEDIA_TYPE,
      `Image natural size is missing or out of range (${nat?.width}×${nat?.height})`,
    );
  }
  const imgAr = nat.width / nat.height;
  const boxAr = box.w / box.h;
  if (!Number.isFinite(imgAr) || !Number.isFinite(boxAr) || box.w <= 0 || box.h <= 0) {
    throw new OpenPptError(
      ErrorCodes.MEDIA_TYPE,
      `Image placement is out of range for ${mode}`,
    );
  }
  let place;
  if (mode === "contain") {
    place =
      imgAr > boxAr
        ? { w: box.w, h: box.w / imgAr }
        : { w: box.h * imgAr, h: box.h };
  } else if (imgAr > boxAr) {
    place = { w: box.h * imgAr, h: box.h };
  } else {
    place = { w: box.w, h: box.w / imgAr };
  }
  if (
    !Number.isFinite(place.w) ||
    !Number.isFinite(place.h) ||
    place.w <= 0 ||
    place.h <= 0
  ) {
    throw new OpenPptError(
      ErrorCodes.MEDIA_TYPE,
      `Image placement is out of range for ${mode}`,
    );
  }
  return place;
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
function shapeLine(width, colorParts) {
  if (!width) {
    return { type: "none" };
  }
  /** @type {Record<string, unknown>} */
  const line = {
    type: "solid",
    color: colorParts.color,
    width,
  };
  if (colorParts.transparency !== undefined) {
    line.transparency = colorParts.transparency;
  }
  return line;
}

function tableBorder(width, color) {
  if (!width) {
    const none = { type: "none" };
    return [none, none, none, none];
  }
  const edge = { type: "solid", pt: width, color };
  return [edge, edge, edge, edge];
}

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
 * @param {Map<string, object>} mediaSnapshots
 */
function buildPresentation(deck, colors, mediaSnapshots) {
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
      /** @type {Record<string, unknown>} */
      const background = { color: bg.color };
      if (bg.transparency !== undefined) background.transparency = bg.transparency;
      slide.background = background;
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
            const runColor = run.color
              ? toPptxColorParts(
                  resolveColor(run.color, colors, `${el.id}.run`),
                )
              : base;
            /** @type {Record<string, unknown>} */
            const options = {
              bold: run.bold !== undefined ? Boolean(run.bold) : Boolean(el.bold),
              fontSize: run.fontSize ?? el.fontSize ?? 18,
              fontFace: run.fontFamily || el.fontFamily || "Arial",
              color: runColor.color,
            };
            if (run.italic !== undefined) options.italic = Boolean(run.italic);
            if (runColor.transparency !== undefined) {
              options.transparency = runColor.transparency;
            }
            if (el.href && typeof el.href === "string") {
              options.hyperlink = { url: el.href };
            }
            return { text: run.text, options };
          });
          // Do not put run-overridable styles on the box: pptxgenjs ORs box.bold
          // over run.bold:false and would otherwise inherit parent transparency.
          const runBox = {
            ...box,
            align: boxOpts.align,
            valign: boxOpts.valign,
            fontFace: boxOpts.fontFace,
          };
          slide.addText(runs, runBox);
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
          line: shapeLine(el.lineWidth ?? 0, lineParts),
        });
      } else if (el.type === "image") {
        const mediaSrc = el.src;
        const snapshot = mediaSnapshots.get(mediaSrc);
        if (!snapshot?.dataUri) {
          throw new OpenPptError(
            ErrorCodes.MEDIA_MISSING,
            `No validated media snapshot for image: ${mediaSrc}`,
            { elementId: el.id, src: mediaSrc },
          );
        }
        // Default cover: fill box without stretching (crop overflow).
        // fit=fill keeps legacy stretch; fit=contain letterboxes.
        // pptxgenjs quirk: sizing cover/contain uses options.w/h as image aspect
        // (not natural pixels). Pass natural-aspect placement + box as sizing.
        const fit = el.fit || "cover";
        /** @type {Record<string, unknown>} */
        const imgOpts = {
          // PptxGenJS deduplicates by path, but uses data when both are present.
          // The path is an identity key only and is never reopened by the writer.
          path: snapshot.path,
          data: snapshot.dataUri,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
        };
        if (fit === "cover" || fit === "contain" || fit === "crop") {
          const nat = snapshot.naturalSize;
          const mode = fit === "contain" ? "contain" : "cover";
          if (!nat || !(nat.width > 0) || !(nat.height > 0)) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_TYPE,
              `Image fit=${fit} requires a natural size (SVG needs width/height or viewBox)`,
              { elementId: el.id, src: mediaSrc, fit },
            );
          }
          const place = placementForFit(nat, box, mode);
          imgOpts.w = place.w;
          imgOpts.h = place.h;
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
        const isPie = el.chartType === "pie" || el.chartType === "doughnut";
        const chartOpts = {
          ...box,
          showTitle: Boolean(el.title),
          showLegend: isPie || el.series.length > 1,
          showValue: isPie,
          showPercent: isPie,
        };
        if (el.title) chartOpts.title = el.title;
        slide.addChart(chartType, series, chartOpts);
      } else if (el.type === "table") {
        const borderColorParts = el.borderColor
          ? toPptxColorParts(resolveColor(el.borderColor, colors, el.id))
          : { color: "CBD5E1" };
        const borderColor = borderColorParts.color;
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
          colWIn = weights.map((w) => box.w * (w / sum));
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
              /** @type {Record<string, unknown>} */
              const options = {
                fontSize: defaultFs,
                align: "left",
                valign: "middle",
              };
              if (isHeader) {
                options.color = "FFFFFF";
                options.bold = true;
                options.fill = { color: primaryHex };
              } else {
                options.color = textHex;
              }
              cells.push({ text: "", options });
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
              if (parts.transparency !== undefined) {
                options.transparency = parts.transparency;
              }
              if (cell.fill) {
                const fillParts = toPptxColorParts(
                  resolveColor(cell.fill, colors, el.id),
                );
                /** @type {Record<string, unknown>} */
                const fill = { color: fillParts.color };
                if (fillParts.transparency !== undefined) {
                  fill.transparency = fillParts.transparency;
                }
                options.fill = fill;
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
          border: tableBorder(borderW, borderColor),
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
  const { projectRoot, force = false, sourcePath, operations = {} } = options;
  const renameFile = operations.renameSync || renameSync;
  const unlinkFile = operations.unlinkSync || unlinkSync;
  const linkFile = operations.linkSync || linkSync;
  const { deck: validatedDeck, colors, mediaSnapshots } = validateDeck(deck, {
    projectRoot,
    checkMedia: true,
    captureMedia: true,
  });

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
  let pptx;
  try {
    pptx = buildPresentation(validatedDeck, colors, mediaSnapshots);
  } catch (err) {
    if (err instanceof OpenPptError) throw err;
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `pptxgenjs presentation build failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
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
    if (force) {
      renameFile(tmp, out);
    } else {
      try {
        installFileNoClobber(tmp, out, readFileSync(tmp), linkFile);
      } catch (err) {
        throw new OpenPptError(
          ErrorCodes.EXPORT,
          `Output already exists (pass force=true to overwrite): ${out}`,
          { cause: err },
        );
      }
      try {
        if (existsSync(tmp)) unlinkFile(tmp);
      } catch {
        // hard link is committed; leftover sibling temp is harmless
      }
    }
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkFile(tmp);
    } catch {
      // ignore cleanup failures
    }
    if (err instanceof OpenPptError) throw err;
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `pptxgenjs write failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!existsSync(out)) {
    throw new OpenPptError(ErrorCodes.EXPORT, `Export produced no file at ${out}`);
  }

  return { outputPath: out, pageCount: validatedDeck.pages.length };
}

/**
 * Compile to in-memory PPTX bytes (ZIP).
 * @param {object} deck
 * @param {{ projectRoot: string }} options
 * @returns {Promise<Buffer>}
 */
export async function compileToBuffer(deck, options) {
  const { projectRoot } = options;
  const { deck: validatedDeck, colors, mediaSnapshots } = validateDeck(deck, {
    projectRoot,
    checkMedia: true,
    captureMedia: true,
  });
  let pptx;
  try {
    pptx = buildPresentation(validatedDeck, colors, mediaSnapshots);
  } catch (err) {
    if (err instanceof OpenPptError) throw err;
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `pptxgenjs presentation build failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const data = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
