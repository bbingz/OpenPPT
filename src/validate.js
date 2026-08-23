import { openSync, readSync, closeSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { OpenPptError, ErrorCodes } from "./errors.js";
import { expandLayouts, deckHasGroups } from "./layout.js";
import {
  assertDeckResourceLimits,
  assertResourceLimit,
  RESOURCE_LIMITS,
} from "./resource-limits.js";

/** Allowed image extensions for local media (lowercase, with dot). */
const MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

/**
 * Require images under media/ (posix-style relative path).
 * @param {string} src
 */
export function assertMediaSubtree(src) {
  const normalized = src.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    segments[0] === "media" &&
    segments.length > 1 &&
    segments.slice(1).every((segment) => segment && segment !== "." && segment !== "..")
  ) {
    return;
  }
  throw new OpenPptError(
    ErrorCodes.MEDIA_MISSING,
    `Image src must be under media/: ${src}`,
    { src },
  );
}

/**
 * Sniff magic bytes / SVG start; returns a canonical type label or null.
 * @param {string} absPath
 * @returns {string | null}
 */
export function sniffImageType(absPath) {
  const fd = openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    if (n < 4) return null;
    // PNG
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return "png";
    }
    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return "jpeg";
    }
    // GIF
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return "gif";
    }
    // WEBP: RIFF....WEBP
    if (
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      n >= 12 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    ) {
      return "webp";
    }
    // SVG: text starting with optional BOM/whitespace then <svg or <?xml
    const head = buf.subarray(0, n).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    if (head.startsWith("<svg") || head.startsWith("<?xml")) {
      // Cheap second check for <?xml...svg
      if (head.startsWith("<svg")) return "svg";
      try {
        const more = Buffer.alloc(256);
        const m = readSync(fd, more, 0, 256, 0);
        const text = more.subarray(0, m).toString("utf8");
        if (/<svg[\s>]/i.test(text)) return "svg";
      } catch {
        return null;
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} ext with leading dot
 * @param {string} sniffed
 */
function extensionMatchesSniff(ext, sniffed) {
  if (sniffed === "jpeg") return ext === ".jpg" || ext === ".jpeg";
  return ext === `.${sniffed}`;
}

const schemaPath = fileURLToPath(
  new URL("../schema/openppt-ir.schema.json", import.meta.url),
);

/** @type {import('ajv').ValidateFunction | null} */
let cachedValidate = null;

/**
 * @returns {import('ajv').ValidateFunction}
 */
export function getSchemaValidator() {
  if (cachedValidate) return cachedValidate;
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  cachedValidate = ajv.compile(schema);
  return cachedValidate;
}

/** Test helper: drop cached Ajv validator after schema edits in-process. */
export function clearSchemaValidatorCache() {
  cachedValidate = null;
}

/**
 * Resolve a theme color token or pass through HEX.
 * @param {string} value
 * @param {Record<string, string>} colors
 * @param {string} context
 * @returns {string}
 */
export function resolveColor(value, colors, context) {
  if (typeof value !== "string") {
    throw new OpenPptError(ErrorCodes.THEME_COLOR, `Invalid color at ${context}`);
  }
  if (value.startsWith("$")) {
    const key = value.slice(1);
    const hex = colors[key];
    if (!hex) {
      throw new OpenPptError(
        ErrorCodes.THEME_COLOR,
        `Unresolved theme color token ${value} at ${context}`,
        { token: value, context },
      );
    }
    return hex;
  }
  return value;
}

/**
 * Throw unless `candidate` sits at or under `root`. Compares path segments so a
 * legitimate in-root file whose name merely starts with ".." is not rejected.
 * @param {string} root
 * @param {string} candidate
 * @param {string} userPath original value, for the error message
 */
function assertInsideRoot(root, candidate, userPath) {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new OpenPptError(
      ErrorCodes.MEDIA_MISSING,
      `Media path escapes project root: ${userPath}`,
      { src: userPath },
    );
  }
}

/**
 * Resolve symlinks where the path exists; fall back to the literal path.
 * @param {string} p
 * @returns {string}
 */
function realpathOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Ensure path stays inside project root (no absolute / .. / symlink escape).
 * @param {string} projectRoot
 * @param {string} userPath
 * @returns {string} absolute path
 */
export function safeProjectPath(projectRoot, userPath) {
  if (!userPath || typeof userPath !== "string") {
    throw new OpenPptError(ErrorCodes.MEDIA_MISSING, "Empty media path");
  }
  if (isAbsolute(userPath)) {
    throw new OpenPptError(
      ErrorCodes.MEDIA_MISSING,
      `Absolute media paths are not allowed: ${userPath}`,
      { src: userPath },
    );
  }
  const root = realpathOrSelf(resolve(projectRoot));
  const candidate = resolve(root, userPath);
  assertInsideRoot(root, candidate, userPath);
  // A symlink inside the project must not point outside it.
  assertInsideRoot(root, realpathOrSelf(candidate), userPath);
  return candidate;
}

/**
 * Structural + schema validation. Fail-closed on OOB bounds and missing media.
 * @param {object} deck
 * @param {{ projectRoot?: string, checkMedia?: boolean }} [options]
 * @returns {{ ok: true, deck: object, colors: Record<string, string> }}
 */
export function validateDeck(deck, options = {}) {
  const { projectRoot, checkMedia = true } = options;
  assertDeckResourceLimits(deck);
  // Expand layout groups if caller passed pre-load authoring IR.
  // loadDeck already expands; expandLayouts is idempotent for leaf-only decks.
  if (deckHasGroups(deck)) {
    const expanded = expandLayouts(deck);
    deck.pages = expanded.pages;
  }
  assertDeckResourceLimits(deck);

  const validate = getSchemaValidator();
  const schemaOk = validate(deck);
  if (!schemaOk) {
    const details = (validate.errors || []).map((e) => ({
      path: e.instancePath || "/",
      message: e.message,
      params: e.params,
    }));
    throw new OpenPptError(
      ErrorCodes.SCHEMA,
      `IR schema validation failed: ${details.map((d) => `${d.path} ${d.message}`).join("; ")}`,
      { errors: details },
    );
  }

  const [canvasW, canvasH] = deck.size;
  // YAML admits .nan/.inf, which satisfy JSON Schema `type: number` and then
  // slip past every comparison below. Reject them before any bounds math.
  if (!Number.isFinite(canvasW) || !Number.isFinite(canvasH)) {
    throw new OpenPptError(
      ErrorCodes.BOUNDS,
      `Canvas size must be finite numbers: [${deck.size.join(", ")}]`,
      { size: deck.size },
    );
  }
  // PowerPoint practical max ~56in; at 96dpi → 5376px per side.
  const MAX_CANVAS_PX = 5376;
  if (canvasW > MAX_CANVAS_PX || canvasH > MAX_CANVAS_PX) {
    throw new OpenPptError(
      ErrorCodes.BOUNDS,
      `Canvas size exceeds ${MAX_CANVAS_PX}px (≈56in): [${deck.size.join(", ")}]`,
      { size: deck.size, max: MAX_CANVAS_PX },
    );
  }
  const colors = { ...(deck.theme?.colors || {}) };
  /** @type {Set<string>} */
  const pageIds = new Set();
  /** @type {Set<string>} */
  const elementIds = new Set();
  /** @type {Set<string>} */
  const checkedMedia = new Set();
  let totalMediaBytes = 0;

  // Resolve and validate colors used on pages
  for (let pi = 0; pi < deck.pages.length; pi += 1) {
    const page = deck.pages[pi];
    const pctx = `pages[${pi}] (id=${page.id})`;
    if (pageIds.has(page.id)) {
      throw new OpenPptError(
        ErrorCodes.SCHEMA,
        `Duplicate page id: ${page.id}`,
        { pageId: page.id },
      );
    }
    pageIds.add(page.id);

    if (page.background?.color) {
      resolveColor(page.background.color, colors, `${pctx}.background.color`);
    }

    for (let ei = 0; ei < page.elements.length; ei += 1) {
      const el = page.elements[ei];
      const ectx = `${pctx}.elements[${ei}] (id=${el.id})`;
      if (elementIds.has(el.id)) {
        throw new OpenPptError(
          ErrorCodes.SCHEMA,
          `Duplicate element id: ${el.id}`,
          { elementId: el.id, pageId: page.id },
        );
      }
      elementIds.add(el.id);
      const [x, y, w, h] = el.bounds;

      if (!el.bounds.every((n) => Number.isFinite(n))) {
        throw new OpenPptError(
          ErrorCodes.BOUNDS,
          `Non-finite bounds at ${ectx}: [${el.bounds.join(", ")}]`,
          { pageId: page.id, elementId: el.id, bounds: el.bounds },
        );
      }
      if (w <= 0 || h <= 0) {
        throw new OpenPptError(
          ErrorCodes.BOUNDS,
          `Non-positive bounds at ${ectx}: width=${w}, height=${h}`,
          { pageId: page.id, elementId: el.id, bounds: el.bounds },
        );
      }
      if (x < 0 || y < 0 || x + w > canvasW + 1e-9 || y + h > canvasH + 1e-9) {
        throw new OpenPptError(
          ErrorCodes.BOUNDS,
          `Element out of canvas bounds at ${ectx}: bounds=${JSON.stringify(el.bounds)} canvas=${JSON.stringify(deck.size)}`,
          { pageId: page.id, elementId: el.id, bounds: el.bounds, size: deck.size },
        );
      }

      if (el.type === "text") {
        if (el.fontSize !== undefined && !Number.isFinite(el.fontSize)) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `fontSize must be finite at ${ectx}: ${el.fontSize}`,
            { pageId: page.id, elementId: el.id, fontSize: el.fontSize },
          );
        }
        if (el.color) resolveColor(el.color, colors, `${ectx}.color`);
        if (Array.isArray(el.text)) {
          for (let ri = 0; ri < el.text.length; ri += 1) {
            const run = el.text[ri];
            if (run.fontSize !== undefined && !Number.isFinite(run.fontSize)) {
              throw new OpenPptError(
                ErrorCodes.SCHEMA,
                `fontSize must be finite at ${ectx}.text[${ri}]`,
                { pageId: page.id, elementId: el.id, runIndex: ri },
              );
            }
            if (run.color) {
              resolveColor(run.color, colors, `${ectx}.text[${ri}].color`);
            }
          }
        }
      } else if (el.type === "shape") {
        if (el.lineWidth !== undefined && !Number.isFinite(el.lineWidth)) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `lineWidth must be finite at ${ectx}: ${el.lineWidth}`,
            { pageId: page.id, elementId: el.id, lineWidth: el.lineWidth },
          );
        }
        if (el.fill) resolveColor(el.fill, colors, `${ectx}.fill`);
        if (el.lineColor) resolveColor(el.lineColor, colors, `${ectx}.lineColor`);
      } else if (el.type === "image") {
        if (checkMedia) {
          if (!projectRoot) {
            throw new OpenPptError(
              ErrorCodes.IO,
              "projectRoot is required when checkMedia is true",
            );
          }
          assertMediaSubtree(el.src);
          const ext = extname(el.src).toLowerCase();
          if (!MEDIA_EXTENSIONS.has(ext)) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_TYPE,
              `Unsupported media extension for ${ectx}: ${el.src} (allowed: ${[...MEDIA_EXTENSIONS].join(", ")})`,
              { pageId: page.id, elementId: el.id, src: el.src, ext },
            );
          }
          const abs = safeProjectPath(projectRoot, el.src);
          let mediaStat = null;
          try {
            mediaStat = statSync(abs);
          } catch {
            mediaStat = null;
          }
          if (!mediaStat?.isFile()) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_MISSING,
              `Missing local media for ${ectx}: ${el.src}`,
              { pageId: page.id, elementId: el.id, src: el.src, resolved: abs },
            );
          }
          const mediaKey = realpathOrSelf(abs);
          if (!checkedMedia.has(mediaKey)) {
            assertResourceLimit(
              mediaStat.size,
              RESOURCE_LIMITS.mediaBytesPerFile,
              "mediaBytesPerFile",
              ectx,
            );
            totalMediaBytes += mediaStat.size;
            assertResourceLimit(
              totalMediaBytes,
              RESOURCE_LIMITS.mediaBytesPerDeck,
              "mediaBytesPerDeck",
              "deck media",
            );
            checkedMedia.add(mediaKey);
          }
          const sniffed = sniffImageType(abs);
          if (!sniffed) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_TYPE,
              `Unrecognized image content for ${ectx}: ${el.src}`,
              { pageId: page.id, elementId: el.id, src: el.src },
            );
          }
          if (!extensionMatchesSniff(ext, sniffed)) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_TYPE,
              `Extension ${ext} does not match image content (${sniffed}) at ${ectx}: ${el.src}`,
              { pageId: page.id, elementId: el.id, src: el.src, ext, sniffed },
            );
          }
        }
      } else if (el.type === "chart") {
        if (!el.series || !Array.isArray(el.series) || el.series.length === 0) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `Chart requires non-empty series at ${ectx}`,
            { pageId: page.id, elementId: el.id },
          );
        }
        for (let si = 0; si < el.series.length; si += 1) {
          const ser = el.series[si];
          if (!ser || typeof ser !== "object") {
            throw new OpenPptError(
              ErrorCodes.SCHEMA,
              `Invalid series at ${ectx}.series[${si}]`,
              { pageId: page.id, elementId: el.id },
            );
          }
          if (!Array.isArray(ser.values) || ser.values.length === 0) {
            throw new OpenPptError(
              ErrorCodes.SCHEMA,
              `Chart series.values must be non-empty at ${ectx}.series[${si}]`,
              { pageId: page.id, elementId: el.id },
            );
          }
          if (!ser.values.every((v) => typeof v === "number" && Number.isFinite(v))) {
            throw new OpenPptError(
              ErrorCodes.SCHEMA,
              `Chart series.values must be finite numbers at ${ectx}.series[${si}]`,
              { pageId: page.id, elementId: el.id },
            );
          }
          if (ser.labels !== undefined) {
            if (!Array.isArray(ser.labels) || ser.labels.length !== ser.values.length) {
              throw new OpenPptError(
                ErrorCodes.SCHEMA,
                `Chart series.labels length must match values at ${ectx}.series[${si}]`,
                { pageId: page.id, elementId: el.id },
              );
            }
          }
        }
      } else if (el.type === "table") {
        if (!Array.isArray(el.rows) || el.rows.length === 0) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `Table requires non-empty rows at ${ectx}`,
            { pageId: page.id, elementId: el.id },
          );
        }
        const widths = el.rows.map((r) => (Array.isArray(r) ? r.length : 0));
        if (widths.some((w) => w === 0)) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `Table rows must be non-empty arrays at ${ectx}`,
            { pageId: page.id, elementId: el.id },
          );
        }
        if (el.fontSize !== undefined && !Number.isFinite(el.fontSize)) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `fontSize must be finite at ${ectx}`,
            { pageId: page.id, elementId: el.id },
          );
        }
        if (el.borderWidth !== undefined && !Number.isFinite(el.borderWidth)) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `borderWidth must be finite at ${ectx}`,
            { pageId: page.id, elementId: el.id },
          );
        }
        if (el.colW?.some((width) => !Number.isFinite(width))) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `colW must contain finite numbers at ${ectx}`,
            { pageId: page.id, elementId: el.id },
          );
        }
        if (el.borderColor) {
          resolveColor(el.borderColor, colors, `${ectx}.borderColor`);
        }
        for (let ri = 0; ri < el.rows.length; ri += 1) {
          const row = el.rows[ri];
          for (let ci = 0; ci < row.length; ci += 1) {
            const cell = row[ci];
            if (typeof cell === "number" && !Number.isFinite(cell)) {
              throw new OpenPptError(
                ErrorCodes.SCHEMA,
                `Numeric table cell must be finite at ${ectx}.rows[${ri}][${ci}]`,
                { pageId: page.id, elementId: el.id, row: ri, column: ci },
              );
            }
            if (cell && typeof cell === "object" && !Array.isArray(cell)) {
              if (
                cell.fontSize !== undefined &&
                !Number.isFinite(cell.fontSize)
              ) {
                throw new OpenPptError(
                  ErrorCodes.SCHEMA,
                  `fontSize must be finite at ${ectx}.rows[${ri}][${ci}]`,
                  { pageId: page.id, elementId: el.id, row: ri, column: ci },
                );
              }
              if (cell.color) {
                resolveColor(cell.color, colors, `${ectx}.rows[${ri}][${ci}].color`);
              }
              if (cell.fill) {
                resolveColor(cell.fill, colors, `${ectx}.rows[${ri}][${ci}].fill`);
              }
            }
          }
        }
      }
    }
  }

  return { ok: true, deck, colors };
}

/**
 * Absolute path to the bundled JSON Schema (for tooling).
 */
export function getSchemaPath() {
  return schemaPath;
}
