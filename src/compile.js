import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
 * Strip alpha from #RRGGBBAA for pptxgenjs solid colors (expects 6 hex or name).
 * @param {string} hex
 * @returns {string}
 */
function toPptxColor(hex) {
  if (!hex.startsWith("#")) return hex;
  if (hex.length === 9) return hex.slice(0, 7);
  return hex;
}

/**
 * Map shape name to pptxgenjs shape.
 * @param {string} shape
 * @param {typeof PptxGenJS} pptx
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
 * Compile a validated deck object to a PPTX file using pptxgenjs (open source).
 * @param {object} deck
 * @param {string} outputPath
 * @param {{ projectRoot: string, force?: boolean }} options
 * @returns {Promise<{ outputPath: string, pageCount: number }>}
 */
export async function compileToPptx(deck, outputPath, options) {
  const { projectRoot, force = false } = options;
  const { colors } = validateDeck(deck, { projectRoot, checkMedia: true });

  const out = resolve(outputPath);
  if (existsSync(out) && !force) {
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `Output already exists (pass force=true to overwrite): ${out}`,
    );
  }
  mkdirSync(dirname(out), { recursive: true });
  if (existsSync(out) && force) {
    unlinkSync(out);
  }

  const [canvasW, canvasH] = deck.size;
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: "OPENPPT",
    width: pxToIn(canvasW),
    height: pxToIn(canvasH),
  });
  pptx.layout = "OPENPPT";
  if (deck.title) {
    pptx.title = deck.title;
    pptx.author = "OpenPPT";
  }

  for (const page of deck.pages) {
    const slide = pptx.addSlide();
    if (page.background?.color) {
      const bg = toPptxColor(resolveColor(page.background.color, colors, "background"));
      slide.background = { color: bg.replace("#", "") };
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
        const color = el.color
          ? toPptxColor(resolveColor(el.color, colors, el.id)).replace("#", "")
          : "111827";
        slide.addText(el.text, {
          ...box,
          fontSize: el.fontSize ?? 18,
          fontFace: el.fontFamily || "Arial",
          color,
          bold: Boolean(el.bold),
          align: el.align || "left",
          valign: el.valign || "top",
        });
      } else if (el.type === "shape") {
        const fill = el.fill
          ? toPptxColor(resolveColor(el.fill, colors, el.id)).replace("#", "")
          : "2563EB";
        const lineColor = el.lineColor
          ? toPptxColor(resolveColor(el.lineColor, colors, el.id)).replace("#", "")
          : fill;
        slide.addShape(mapShape(el.shape, pptx), {
          ...box,
          fill: { color: fill },
          line: {
            color: lineColor,
            width: el.lineWidth ?? 0,
          },
        });
      } else if (el.type === "image") {
        const abs = safeProjectPath(projectRoot, el.src);
        slide.addImage({
          path: abs,
          ...box,
        });
      }
    }
  }

  try {
    await pptx.writeFile({ fileName: out });
  } catch (err) {
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
 * Load path is handled by callers; this writes bytes for advanced use.
 * @param {object} deck
 * @param {{ projectRoot: string }} options
 * @returns {Promise<Buffer>}
 */
export async function compileToBuffer(deck, options) {
  const { projectRoot } = options;
  const { colors } = validateDeck(deck, { projectRoot, checkMedia: true });
  const [canvasW, canvasH] = deck.size;
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: "OPENPPT",
    width: pxToIn(canvasW),
    height: pxToIn(canvasH),
  });
  pptx.layout = "OPENPPT";
  if (deck.title) pptx.title = deck.title;

  for (const page of deck.pages) {
    const slide = pptx.addSlide();
    if (page.background?.color) {
      const bg = toPptxColor(resolveColor(page.background.color, colors, "background"));
      slide.background = { color: bg.replace("#", "") };
    }
    for (const el of page.elements) {
      const [x, y, w, h] = el.bounds;
      const box = { x: pxToIn(x), y: pxToIn(y), w: pxToIn(w), h: pxToIn(h) };
      if (el.type === "text") {
        const color = el.color
          ? toPptxColor(resolveColor(el.color, colors, el.id)).replace("#", "")
          : "111827";
        slide.addText(el.text, {
          ...box,
          fontSize: el.fontSize ?? 18,
          fontFace: el.fontFamily || "Arial",
          color,
          bold: Boolean(el.bold),
          align: el.align || "left",
          valign: el.valign || "top",
        });
      } else if (el.type === "shape") {
        const fill = el.fill
          ? toPptxColor(resolveColor(el.fill, colors, el.id)).replace("#", "")
          : "2563EB";
        slide.addShape(mapShape(el.shape, pptx), {
          ...box,
          fill: { color: fill },
          line: { color: fill, width: el.lineWidth ?? 0 },
        });
      } else if (el.type === "image") {
        const abs = safeProjectPath(projectRoot, el.src);
        slide.addImage({ path: abs, ...box });
      }
    }
  }

  const data = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/** Re-export for tests that write intermediate files. */
export { writeFileSync };
