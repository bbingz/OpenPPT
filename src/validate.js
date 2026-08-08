import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { OpenPptError, ErrorCodes } from "./errors.js";

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
 * Ensure path stays inside project root (no absolute / .. escape).
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
  const root = resolve(projectRoot);
  const candidate = resolve(root, userPath);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new OpenPptError(
      ErrorCodes.MEDIA_MISSING,
      `Media path escapes project root: ${userPath}`,
      { src: userPath },
    );
  }
  // Normalize separators for reporting
  void normalize(candidate);
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
  const colors = { ...(deck.theme?.colors || {}) };

  // Resolve and validate colors used on pages
  for (let pi = 0; pi < deck.pages.length; pi += 1) {
    const page = deck.pages[pi];
    const pctx = `pages[${pi}] (id=${page.id})`;

    if (page.background?.color) {
      resolveColor(page.background.color, colors, `${pctx}.background.color`);
    }

    for (let ei = 0; ei < page.elements.length; ei += 1) {
      const el = page.elements[ei];
      const ectx = `${pctx}.elements[${ei}] (id=${el.id})`;
      const [x, y, w, h] = el.bounds;

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
        if (el.color) resolveColor(el.color, colors, `${ectx}.color`);
      } else if (el.type === "shape") {
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
          const abs = safeProjectPath(projectRoot, el.src);
          if (!existsSync(abs)) {
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

// silence unused sep import if tree-shaken differently — used for clarity in older node
void sep;
void join;
