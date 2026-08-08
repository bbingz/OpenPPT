import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { OpenPptError, ErrorCodes } from "./errors.js";

/** Allowed image extensions for local media (lowercase, with dot). */
const MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

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
          const ext = extname(el.src).toLowerCase();
          if (!MEDIA_EXTENSIONS.has(ext)) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_MISSING,
              `Unsupported media type for ${ectx}: ${el.src} (allowed: ${[...MEDIA_EXTENSIONS].join(", ")})`,
              { pageId: page.id, elementId: el.id, src: el.src, ext },
            );
          }
          // Prefer media/ subtree; still allow other in-project image paths with allowlist.
          const abs = safeProjectPath(projectRoot, el.src);
          let isFile = false;
          try {
            isFile = statSync(abs).isFile();
          } catch {
            isFile = false;
          }
          if (!isFile) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_MISSING,
              `Missing local media for ${ectx}: ${el.src}`,
              { pageId: page.id, elementId: el.id, src: el.src, resolved: abs },
            );
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
