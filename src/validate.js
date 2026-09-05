import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { OpenPptError, ErrorCodes } from "./errors.js";
import { expandLayouts } from "./layout.js";
import {
  assertDeckResourceLimits,
  assertResourceLimit,
  RESOURCE_LIMITS,
} from "./resource-limits.js";
import { MEDIA_EXTENSIONS } from "./internal/media-types.js";
import { resolveDeckTextStyles } from "./internal/text-styles.js";
import {
  MAX_BULLET_MARL_EMU,
  MAX_PARAGRAPH_SPACE_PT,
  bulletMarginEmu,
  countAuthoredParagraphRuns,
  countParagraphFragments,
  listMarkers,
} from "./internal/paragraphs.js";

/** Practical OOXML/pptxgenjs ceilings. Schema mirrors these maxima. */
const FONT_SIZE_MAX_PT = 4000;
const LINE_WIDTH_MAX_PT = 1584;
const IMAGE_MAX_EDGE_PX = 65535;
const IMAGE_MAX_ASPECT = 10000;
const HEX_COLOR_RE = /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const FONT_FAMILY_PUNCT = new Set([" ", "'", "-", "_", ".", "(", ")"]);

const MEDIA_OPEN_FLAGS =
  constants.O_RDONLY |
  (process.platform === "win32"
    ? 0
    : (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));

/**
 * Require images under media/ (posix-style relative path).
 * @param {string} src
 */
export function assertMediaSubtree(src) {
  if (typeof src !== "string" || src.includes("\\")) {
    throw new OpenPptError(
      ErrorCodes.MEDIA_MISSING,
      `Image src must use a canonical media/ path: ${String(src)}`,
      { src },
    );
  }
  const segments = src.split("/");
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
 * Sniff magic bytes / SVG start from an in-memory snapshot.
 * @param {Buffer | Uint8Array} bytes
 * @returns {string | null}
 */
export function sniffImageBytes(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 4) return null;
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
    buf.length >= 12 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "webp";
  }
  // SVG: text starting with optional BOM/whitespace then <svg or <?xml.
  const head = buf
    .subarray(0, 256)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (head.startsWith("<svg")) return "svg";
  if (head.startsWith("<?xml") && /<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/**
 * Sniff magic bytes / SVG start from a file path.
 * @param {string} absPath
 * @returns {string | null}
 */
export function sniffImageType(absPath) {
  return sniffImageBytes(
    readMediaSnapshot(absPath, "image inspection", { src: absPath }),
  );
}

/**
 * Natural pixel size for supported raster image bytes. SVG/unknown return null.
 * @param {Buffer | Uint8Array} bytes
 * @returns {{ width: number, height: number } | null}
 */
function svgNaturalSize(text) {
  const open = text.match(/<svg\b[^>]*>/i);
  if (!open) return null;
  const tag = open[0];
  const width = tag.match(/\bwidth\s*=\s*["']\s*([0-9.]+)\s*(?:px)?["']/i);
  const height = tag.match(/\bheight\s*=\s*["']\s*([0-9.]+)\s*(?:px)?["']/i);
  if (width && height) {
    const w = Number(width[1]);
    const h = Number(height[1]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  }
  const viewBox = tag.match(
    /\bviewBox\s*=\s*["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/i,
  );
  if (viewBox) {
    const w = Number(viewBox[1]);
    const h = Number(viewBox[2]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  }
  return null;
}

export function imageSizeFromBytes(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const asText = buf.toString("utf8");
  const head = asText.replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && /<svg[\s>]/i.test(head.slice(0, 256)))) {
    return svgNaturalSize(asText);
  }
  if (buf.length < 24) return null;

  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

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
    if (chunk === "VP8 ") {
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
 * @param {string} ext with leading dot
 * @param {string} sniffed
 */
function extensionMatchesSniff(ext, sniffed) {
  if (sniffed === "jpeg") return ext === ".jpg" || ext === ".jpeg";
  return ext === `.${sniffed}`;
}

function imageMimeType(type) {
  if (type === "jpeg") return "image/jpeg";
  if (type === "svg") return "image/svg+xml";
  return `image/${type}`;
}

/**
 * Read at most one byte beyond the per-file ceiling from one opened file.
 * Metadata, byte limits, sniffing, sizing, and consumers all bind to this read.
 * @param {string} absPath
 * @param {string} context
 * @param {Record<string, unknown>} details
 * @returns {Buffer}
 */
function readMediaSnapshot(absPath, context, details) {
  let fd;
  try {
    fd = openSync(absPath, MEDIA_OPEN_FLAGS);
  } catch {
    throw new OpenPptError(
      ErrorCodes.MEDIA_MISSING,
      `Missing local media for ${context}: ${details.src}`,
      { ...details, resolved: absPath },
    );
  }

  try {
    const mediaStat = fstatSync(fd);
    if (!mediaStat.isFile()) {
      throw new OpenPptError(
        ErrorCodes.MEDIA_MISSING,
        `Missing local media for ${context}: ${details.src}`,
        { ...details, resolved: absPath },
      );
    }

    const chunks = [];
    let byteLength = 0;
    const readCeiling = RESOURCE_LIMITS.mediaBytesPerFile + 1;
    while (byteLength < readCeiling) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, readCeiling - byteLength),
      );
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      byteLength += bytesRead;
    }
    const bytes = Buffer.concat(chunks, byteLength);
    assertResourceLimit(
      bytes.length,
      RESOURCE_LIMITS.mediaBytesPerFile,
      "mediaBytesPerFile",
      context,
    );
    return bytes;
  } catch (err) {
    if (err instanceof OpenPptError) throw err;
    throw new OpenPptError(
      ErrorCodes.MEDIA_MISSING,
      `Unable to read local media for ${context}: ${details.src}`,
      { ...details, resolved: absPath },
    );
  } finally {
    closeSync(fd);
  }
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
  let hex = value;
  if (value.startsWith("$")) {
    const key = value.slice(1);
    if (!Object.hasOwn(colors, key)) {
      throw new OpenPptError(
        ErrorCodes.THEME_COLOR,
        `Unresolved theme color token ${value} at ${context}`,
        { token: value, context },
      );
    }
    hex = colors[key];
  }
  if (typeof hex !== "string" || !HEX_COLOR_RE.test(hex)) {
    throw new OpenPptError(
      ErrorCodes.THEME_COLOR,
      `Unresolved theme color token ${value} at ${context}`,
      { token: value, context, resolved: hex },
    );
  }
  return hex;
}

function isXml10Char(cp) {
  return (
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function isXmlNoncharacter(cp) {
  if (cp >= 0xfdd0 && cp <= 0xfdef) return true;
  return (cp & 0xffff) === 0xfffe || (cp & 0xffff) === 0xffff;
}

function isSafeFontFamilyChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return false;
  if (!isXml10Char(cp) || isXmlNoncharacter(cp)) return false;
  if (FONT_FAMILY_PUNCT.has(ch)) return true;
  return /\p{L}|\p{N}|\p{M}/u.test(ch);
}

/**
 * Categories actually sent to the chart cache/workbook.
 * Omitted labels become 1-based index strings ("1","2",...).
 * @param {{ labels?: string[], values: number[] }} ser
 * @returns {string[]}
 */
export function effectiveChartLabels(ser) {
  if (Array.isArray(ser.labels)) return ser.labels.map((label) => String(label));
  return ser.values.map((_, index) => String(index + 1));
}

function chartLabelsEqual(a, b) {
  return a.length === b.length && a.every((label, index) => label === b[index]);
}

function assertFontFamily(value, ctx, extra = {}) {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length < 1) {
    throw new OpenPptError(
      ErrorCodes.SCHEMA,
      `Unsafe fontFamily at ${ctx}: ${JSON.stringify(value)}`,
      extra,
    );
  }
  for (const ch of value) {
    if (!isSafeFontFamilyChar(ch)) {
      throw new OpenPptError(
        ErrorCodes.SCHEMA,
        `Unsafe fontFamily at ${ctx}: ${JSON.stringify(value)}`,
        extra,
      );
    }
  }
}

function assertFontSize(value, ctx, extra = {}) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || value > FONT_SIZE_MAX_PT) {
    throw new OpenPptError(
      ErrorCodes.SCHEMA,
      `fontSize must be a finite number in (0, ${FONT_SIZE_MAX_PT}] at ${ctx}: ${value}`,
      extra,
    );
  }
}

function assertLineHeight(value, ctx, extra = {}) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0.5 || value > 9.99) {
    throw new OpenPptError(
      ErrorCodes.SCHEMA,
      `lineHeight must be a finite multiplier in [0.5, 9.99] at ${ctx}: ${value}`,
      extra,
    );
  }
}

function assertSpacePt(value, label, ctx, extra = {}) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > MAX_PARAGRAPH_SPACE_PT) {
    throw new OpenPptError(
      ErrorCodes.SCHEMA,
      `${label} must be a finite number in [0, ${MAX_PARAGRAPH_SPACE_PT}] at ${ctx}: ${value}`,
      extra,
    );
  }
}

function assertCharSpacing(value, ctx, extra = {}) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < -100 || value > 100) {
    throw new OpenPptError(
      ErrorCodes.SCHEMA,
      `charSpacing must be a finite number in [-100, 100] at ${ctx}: ${value}`,
      extra,
    );
  }
}

function assertBullet(bullet, ctx, extra = {}) {
  if (bullet === undefined || typeof bullet === "boolean") return;
  if (!bullet || typeof bullet !== "object" || Array.isArray(bullet)) {
    throw new OpenPptError(
      ErrorCodes.SCHEMA,
      `Invalid bullet at ${ctx}`,
      extra,
    );
  }
  if (bullet.type !== "bullet" && bullet.type !== "number") {
    throw new OpenPptError(
      ErrorCodes.SCHEMA,
      `Invalid bullet type at ${ctx}`,
      extra,
    );
  }
  if (bullet.start !== undefined) {
    if (bullet.type !== "number") {
      throw new OpenPptError(
        ErrorCodes.SCHEMA,
        `bullet.start is only allowed for numbered lists at ${ctx}`,
        extra,
      );
    }
    if (
      !Number.isInteger(bullet.start) ||
      bullet.start < 1 ||
      bullet.start > 32767
    ) {
      throw new OpenPptError(
        ErrorCodes.SCHEMA,
        `bullet.start must be an integer in [1, 32767] at ${ctx}: ${bullet.start}`,
        extra,
      );
    }
  }
  if (bullet.level !== undefined) {
    if (!Number.isInteger(bullet.level) || bullet.level < 0 || bullet.level > 8) {
      throw new OpenPptError(
        ErrorCodes.SCHEMA,
        `bullet.level must be an integer in [0, 8] at ${ctx}: ${bullet.level}`,
        extra,
      );
    }
  }
  if (bullet.indent !== undefined) {
    if (!Number.isFinite(bullet.indent) || bullet.indent < 0 || bullet.indent > 1584) {
      throw new OpenPptError(
        ErrorCodes.SCHEMA,
        `bullet.indent must be a finite number in [0, 1584] at ${ctx}: ${bullet.indent}`,
        extra,
      );
    }
  }
  const indentPt =
    bullet.indent === undefined ? 18 : bullet.indent;
  const level = bullet.level === undefined ? 0 : bullet.level;
  const marL = bulletMarginEmu(indentPt, level);
  if (marL > MAX_BULLET_MARL_EMU) {
    throw new OpenPptError(
      ErrorCodes.SCHEMA,
      `Derived bullet marL ${marL} EMU exceeds ${MAX_BULLET_MARL_EMU} at ${ctx}`,
      { ...extra, marL, indent: indentPt, level, maximum: MAX_BULLET_MARL_EMU },
    );
  }
}

function assertTypography(target, ctx, extra = {}) {
  assertLineHeight(target.lineHeight, ctx, extra);
  assertSpacePt(target.spaceBefore, "spaceBefore", ctx, extra);
  assertSpacePt(target.spaceAfter, "spaceAfter", ctx, extra);
  assertCharSpacing(target.charSpacing, ctx, extra);
}

function assertLineWidth(value, label, ctx, extra = {}) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > LINE_WIDTH_MAX_PT) {
    throw new OpenPptError(
      ErrorCodes.SCHEMA,
      `${label} must be a finite number in [0, ${LINE_WIDTH_MAX_PT}] at ${ctx}: ${value}`,
      extra,
    );
  }
}

function assertNaturalImageSize(naturalSize, ctx, details) {
  if (!naturalSize) return;
  const { width, height } = naturalSize;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new OpenPptError(
      ErrorCodes.MEDIA_TYPE,
      `Image natural size out of range at ${ctx}: ${width}×${height}`,
      details,
    );
  }
  // 0×0 is an unusable header (e.g. padded sniff buffers); cover/contain skip it.
  if (width < 1 || height < 1) return;
  if (width > IMAGE_MAX_EDGE_PX || height > IMAGE_MAX_EDGE_PX) {
    throw new OpenPptError(
      ErrorCodes.MEDIA_TYPE,
      `Image natural size out of range at ${ctx}: ${width}×${height}`,
      details,
    );
  }
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (!Number.isFinite(aspect) || aspect > IMAGE_MAX_ASPECT) {
    throw new OpenPptError(
      ErrorCodes.MEDIA_TYPE,
      `Image aspect ratio out of range at ${ctx}: ${width}×${height}`,
      details,
    );
  }
}

function validateRawTextStyles(deck, colors) {
  const fonts = deck?.theme?.fonts;
  if (fonts && typeof fonts === "object" && !Array.isArray(fonts)) {
    if (Object.hasOwn(fonts, "latin")) {
      assertFontFamily(fonts.latin, "theme.fonts.latin", { fontFamily: fonts.latin });
    }
    if (Object.hasOwn(fonts, "ea")) {
      assertFontFamily(fonts.ea, "theme.fonts.ea", { fontFamily: fonts.ea });
    }
  }
  const styles = deck?.theme?.textStyles;
  if (!styles || typeof styles !== "object" || Array.isArray(styles)) return;
  for (const name of Object.keys(styles)) {
    if (!Object.hasOwn(styles, name)) continue;
    const style = styles[name];
    const ctx = `theme.textStyles.${name}`;
    if (!style || typeof style !== "object" || Array.isArray(style)) {
      throw new OpenPptError(
        ErrorCodes.SCHEMA,
        `Invalid text style at ${ctx}`,
        { name },
      );
    }
    assertFontSize(style.fontSize, ctx, { fontSize: style.fontSize, style: name });
    assertFontFamily(style.fontFamily, ctx, {
      fontFamily: style.fontFamily,
      style: name,
    });
    assertTypography(style, ctx, { style: name });
    if (style.color) resolveColor(style.color, colors, `${ctx}.color`);
  }
}

function wrapValidateError(err) {
  if (err instanceof OpenPptError) throw err;
  throw new OpenPptError(
    ErrorCodes.SCHEMA,
    `IR schema validation failed: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
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
  const canonical = realpathOrSelf(candidate);
  assertInsideRoot(root, canonical, userPath);
  return canonical;
}

/**
 * Structural + schema validation. Fail-closed on OOB bounds and missing media.
 * @param {object} deck
 * @param {{ projectRoot?: string, checkMedia?: boolean, captureMedia?: boolean }} [options]
 * @returns {{ ok: true, deck: object, colors: Record<string, string>, mediaSnapshots: Map<string, object> }}
 */
export function validateDeck(deck, options = {}) {
  try {
    return validateDeckInner(deck, options);
  } catch (err) {
    wrapValidateError(err);
  }
}

/**
 * @param {object} deck
 * @param {{ projectRoot?: string, checkMedia?: boolean, captureMedia?: boolean }} [options]
 */
function validateDeckInner(deck, options = {}) {
  const { projectRoot, checkMedia = true, captureMedia = false } = options;
  assertDeckResourceLimits(deck);
  const externalPageIndex = Array.isArray(deck?.pages)
    ? deck.pages.findIndex((page) => typeof page === "string")
    : -1;
  if (externalPageIndex >= 0) {
    throw new OpenPptError(
      ErrorCodes.IO,
      `pages[${externalPageIndex}] is an external page path; call loadDeck() before validateDeck()`,
      { pageIndex: externalPageIndex, pagePath: deck.pages[externalPageIndex] },
    );
  }
  // Normalize authoring groups and detach validated output from caller-owned IR.
  // loadDeck already expands; expandLayouts is idempotent for leaf-only decks.
  deck = expandLayouts(deck);
  assertDeckResourceLimits(deck);

  // Canonical media paths are an IR invariant. checkMedia only controls local
  // file I/O and byte/type inspection, never path normalization.
  if (Array.isArray(deck?.pages)) {
    for (const page of deck.pages) {
      if (!page || typeof page !== "object" || !Array.isArray(page.elements)) {
        continue;
      }
      for (const element of page.elements) {
        if (element?.type === "image" && typeof element.src === "string") {
          assertMediaSubtree(element.src);
        }
      }
    }
  }

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
  const colors = Object.create(null);
  const themeColors = deck.theme?.colors || {};
  for (const key of Object.keys(themeColors)) {
    colors[key] = themeColors[key];
  }
  validateRawTextStyles(deck, colors);
  resolveDeckTextStyles(deck);
  assertDeckResourceLimits(deck);
  /** @type {Set<string>} */
  const pageIds = new Set();
  /** @type {Set<string>} */
  const elementIds = new Set();
  /** @type {Map<string, object>} canonical path to validated snapshot */
  const checkedMedia = new Map();
  /** @type {Map<string, object>} IR src to validated snapshot */
  const validatedMedia = new Map();
  /** @type {Map<string, object>} operation snapshots returned to renderers */
  const mediaSnapshots = new Map();
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
        const hasText = Object.hasOwn(el, "text");
        const hasParagraphs = Object.hasOwn(el, "paragraphs");
        if (hasText === hasParagraphs) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `Text element must have exactly one of text or paragraphs at ${ectx}`,
            { pageId: page.id, elementId: el.id },
          );
        }
        assertFontSize(el.fontSize, ectx, {
          pageId: page.id,
          elementId: el.id,
          fontSize: el.fontSize,
        });
        assertFontFamily(el.fontFamily, ectx, {
          pageId: page.id,
          elementId: el.id,
          fontFamily: el.fontFamily,
        });
        assertTypography(el, ectx, { pageId: page.id, elementId: el.id });
        if (el.color) resolveColor(el.color, colors, `${ectx}.color`);
        if (hasParagraphs) {
          if (!Array.isArray(el.paragraphs) || el.paragraphs.length < 1) {
            throw new OpenPptError(
              ErrorCodes.SCHEMA,
              `paragraphs must be a non-empty array at ${ectx}`,
              { pageId: page.id, elementId: el.id },
            );
          }
          assertResourceLimit(
            el.paragraphs.length,
            RESOURCE_LIMITS.paragraphsPerElement,
            "paragraphsPerElement",
            `${ectx}.paragraphs`,
          );
          assertResourceLimit(
            countAuthoredParagraphRuns(el.paragraphs),
            RESOURCE_LIMITS.richTextRunsPerElement,
            "richTextRunsPerElement",
            `${ectx}.paragraphs`,
          );
          assertResourceLimit(
            countParagraphFragments(el.paragraphs),
            RESOURCE_LIMITS.richTextRunsPerElement,
            "richTextRunsPerElement",
            `${ectx}.paragraphs fragments`,
          );
          for (let pi = 0; pi < el.paragraphs.length; pi += 1) {
            const para = el.paragraphs[pi];
            const pctx = `${ectx}.paragraphs[${pi}]`;
            assertFontSize(para.fontSize, pctx, {
              pageId: page.id,
              elementId: el.id,
            });
            assertFontFamily(para.fontFamily, pctx, {
              pageId: page.id,
              elementId: el.id,
              fontFamily: para.fontFamily,
            });
            assertTypography(para, pctx, { pageId: page.id, elementId: el.id });
            assertBullet(para.bullet, `${pctx}.bullet`, {
              pageId: page.id,
              elementId: el.id,
            });
            if (para.color) resolveColor(para.color, colors, `${pctx}.color`);
            if (typeof para.text === "string") {
              // plain paragraph text
            } else if (Array.isArray(para.text)) {
              for (let ri = 0; ri < para.text.length; ri += 1) {
                const run = para.text[ri];
                const rctx = `${pctx}.text[${ri}]`;
                assertFontSize(run.fontSize, rctx, {
                  pageId: page.id,
                  elementId: el.id,
                });
                assertFontFamily(run.fontFamily, rctx, {
                  pageId: page.id,
                  elementId: el.id,
                  fontFamily: run.fontFamily,
                });
                assertCharSpacing(run.charSpacing, rctx, {
                  pageId: page.id,
                  elementId: el.id,
                });
                if (run.color) resolveColor(run.color, colors, `${rctx}.color`);
              }
            } else {
              throw new OpenPptError(
                ErrorCodes.SCHEMA,
                `paragraph text must be a string or run array at ${pctx}`,
                { pageId: page.id, elementId: el.id },
              );
            }
          }
          listMarkers(el.paragraphs, { context: `${ectx}.paragraphs` });
        } else if (Array.isArray(el.text)) {
          for (let ri = 0; ri < el.text.length; ri += 1) {
            const run = el.text[ri];
            assertFontSize(run.fontSize, `${ectx}.text[${ri}]`, {
              pageId: page.id,
              elementId: el.id,
              runIndex: ri,
            });
            assertFontFamily(run.fontFamily, `${ectx}.text[${ri}]`, {
              pageId: page.id,
              elementId: el.id,
              runIndex: ri,
              fontFamily: run.fontFamily,
            });
            assertCharSpacing(run.charSpacing, `${ectx}.text[${ri}]`, {
              pageId: page.id,
              elementId: el.id,
              runIndex: ri,
            });
            if (run.color) {
              resolveColor(run.color, colors, `${ectx}.text[${ri}].color`);
            }
          }
        }
      } else if (el.type === "shape") {
        assertLineWidth(el.lineWidth, "lineWidth", ectx, {
          pageId: page.id,
          elementId: el.id,
          lineWidth: el.lineWidth,
        });
        if (el.fill) resolveColor(el.fill, colors, `${ectx}.fill`);
        if (el.lineColor) resolveColor(el.lineColor, colors, `${ectx}.lineColor`);
      } else if (el.type === "image") {
        const mediaSrc = el.src;
        if (checkMedia) {
          if (!projectRoot) {
            throw new OpenPptError(
              ErrorCodes.IO,
              "projectRoot is required when checkMedia is true",
            );
          }
          const ext = extname(mediaSrc).toLowerCase();
          if (!MEDIA_EXTENSIONS.has(ext)) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_TYPE,
              `Unsupported media extension for ${ectx}: ${mediaSrc} (allowed: ${[...MEDIA_EXTENSIONS].join(", ")})`,
              { pageId: page.id, elementId: el.id, src: mediaSrc, ext },
            );
          }
          let snapshot = validatedMedia.get(mediaSrc);
          if (!snapshot) {
            const abs = safeProjectPath(projectRoot, mediaSrc);
            snapshot = checkedMedia.get(abs);
            if (!snapshot) {
              const details = {
                pageId: page.id,
                elementId: el.id,
                src: mediaSrc,
              };
              const bytes = readMediaSnapshot(abs, ectx, details);
              totalMediaBytes += bytes.length;
              assertResourceLimit(
                totalMediaBytes,
                RESOURCE_LIMITS.mediaBytesPerDeck,
                "mediaBytesPerDeck",
                "deck media",
              );
              const type = sniffImageBytes(bytes);
              const naturalSize = imageSizeFromBytes(bytes);
              assertNaturalImageSize(naturalSize, ectx, {
                pageId: page.id,
                elementId: el.id,
                src: mediaSrc,
              });
              snapshot = Object.freeze({
                path: abs,
                type,
                byteLength: bytes.length,
                naturalSize: naturalSize ? Object.freeze(naturalSize) : null,
                dataUri: captureMedia && type
                  ? `data:${imageMimeType(type)};base64,${bytes.toString("base64")}`
                  : null,
              });
              checkedMedia.set(abs, snapshot);
            }
            validatedMedia.set(mediaSrc, snapshot);
          }
          const sniffed = snapshot.type;
          if (!sniffed) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_TYPE,
              `Unrecognized image content for ${ectx}: ${mediaSrc}`,
              { pageId: page.id, elementId: el.id, src: mediaSrc },
            );
          }
          if (!extensionMatchesSniff(ext, sniffed)) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_TYPE,
              `Extension ${ext} does not match image content (${sniffed}) at ${ectx}: ${mediaSrc}`,
              { pageId: page.id, elementId: el.id, src: mediaSrc, ext, sniffed },
            );
          }
          const fit = el.fit || "cover";
          if (
            sniffed === "svg" &&
            fit !== "fill" &&
            !(snapshot.naturalSize && snapshot.naturalSize.width > 0 && snapshot.naturalSize.height > 0)
          ) {
            throw new OpenPptError(
              ErrorCodes.MEDIA_TYPE,
              `SVG fit=${fit} requires width/height or viewBox at ${ectx}: ${mediaSrc}`,
              { pageId: page.id, elementId: el.id, src: mediaSrc, fit },
            );
          }
          if (captureMedia) mediaSnapshots.set(mediaSrc, snapshot);
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
        const isPieLike = el.chartType === "pie" || el.chartType === "doughnut";
        if (isPieLike && el.series.length > 1) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `Unsupported multi-series ${el.chartType} at ${ectx}`,
            { pageId: page.id, elementId: el.id, chartType: el.chartType },
          );
        }
        const sharedLen = el.series[0].values.length;
        const sharedLabels = effectiveChartLabels(el.series[0]);
        for (let si = 1; si < el.series.length; si += 1) {
          const ser = el.series[si];
          if (ser.values.length !== sharedLen) {
            throw new OpenPptError(
              ErrorCodes.SCHEMA,
              `Chart series values length must match at ${ectx}.series[${si}]`,
              { pageId: page.id, elementId: el.id },
            );
          }
          if (!chartLabelsEqual(sharedLabels, effectiveChartLabels(ser))) {
            throw new OpenPptError(
              ErrorCodes.SCHEMA,
              `Chart series categories must match at ${ectx}.series[${si}]`,
              { pageId: page.id, elementId: el.id },
            );
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
        assertFontSize(el.fontSize, ectx, {
          pageId: page.id,
          elementId: el.id,
        });
        assertLineWidth(el.borderWidth, "borderWidth", ectx, {
          pageId: page.id,
          elementId: el.id,
        });
        if (el.colW) {
          if (
            el.colW.some(
              (width) => !Number.isFinite(width) || width <= 0,
            )
          ) {
            throw new OpenPptError(
              ErrorCodes.SCHEMA,
              `colW must contain positive finite numbers at ${ectx}`,
              { pageId: page.id, elementId: el.id },
            );
          }
          const colCount = Math.max(...widths);
          const weights = el.colW.slice(0, colCount);
          while (weights.length < colCount) weights.push(1);
          const sum = weights.reduce((total, width) => total + width, 0);
          if (!Number.isFinite(sum) || sum <= 0) {
            throw new OpenPptError(
              ErrorCodes.SCHEMA,
              `colW total must be a positive finite number at ${ectx}`,
              { pageId: page.id, elementId: el.id, colW: el.colW },
            );
          }
          if (weights.some((width) => width / sum <= 0)) {
            throw new OpenPptError(
              ErrorCodes.SCHEMA,
              `colW normalization must produce positive finite widths at ${ectx}`,
              { pageId: page.id, elementId: el.id, colW: el.colW },
            );
          }
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
              assertFontSize(cell.fontSize, `${ectx}.rows[${ri}][${ci}]`, {
                pageId: page.id,
                elementId: el.id,
                row: ri,
                column: ci,
              });
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

  return { ok: true, deck, colors, mediaSnapshots };
}

/**
 * Absolute path to the bundled JSON Schema (for tooling).
 */
export function getSchemaPath() {
  return schemaPath;
}
