/**
 * Lossy PPTX → OpenPPT IR importer.
 * Extracts text, simple shapes, images, plain tables, and best-effort charts.
 */

import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, basename, extname } from "node:path";
import JSZip from "jszip";
import { OpenPptError, ErrorCodes } from "./errors.js";
import { installFileNoClobber } from "./project-write.js";
import {
  assertResourceLimit,
  RESOURCE_LIMITS,
} from "./resource-limits.js";
import { validateDeck } from "./validate.js";
import { emuToPx } from "./internal/units.js";

const PPTX_OPEN_FLAGS =
  constants.O_RDONLY |
  (process.platform === "win32"
    ? 0
    : (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;

function isXmlNameEnd(ch) {
  return (
    ch === undefined ||
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === ">" ||
    ch === "/"
  );
}

/**
 * Linear extract of well-formed `<open ...> ... </close>` blocks.
 * Unclosed tags stop the scan instead of backtracking.
 * @param {string} xml
 * @param {string} open
 * @param {string} close
 * @returns {string[]}
 */
function sliceBlocks(xml, open, close) {
  const blocks = [];
  let from = 0;
  while (from < xml.length) {
    const start = xml.indexOf(open, from);
    if (start < 0) break;
    if (!isXmlNameEnd(xml[start + open.length])) {
      from = start + open.length;
      continue;
    }
    const end = xml.indexOf(close, start + open.length);
    if (end < 0) break;
    blocks.push(xml.slice(start, end + close.length));
    from = end + close.length;
  }
  return blocks;
}

const GRP_SP_MAX_DEPTH = 8;
const IDENTITY_GROUP_XFRM = Object.freeze({
  offX: 0,
  offY: 0,
  extCx: 1,
  extCy: 1,
  chOffX: 0,
  chOffY: 0,
  chExtCx: 1,
  chExtCy: 1,
});
const SCHEME_COLOR_NAMES = [
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
];
const SCHEME_COLOR_ALIASES = {
  tx1: "dk1",
  bg1: "lt1",
  tx2: "dk2",
  bg2: "lt2",
};
const SHAPE_CHILD_SPECS = [
  { kind: "grpSp", open: "<p:grpSp", close: "</p:grpSp>" },
  { kind: "sp", open: "<p:sp", close: "</p:sp>" },
  { kind: "pic", open: "<p:pic", close: "</p:pic>" },
  { kind: "graphicFrame", open: "<p:graphicFrame", close: "</p:graphicFrame>" },
  { kind: "cxnSp", open: "<p:cxnSp", close: "</p:cxnSp>" },
];

function indexOfOpenTag(xml, open, from = 0) {
  let start = from;
  while (start < xml.length) {
    const at = xml.indexOf(open, start);
    if (at < 0) return -1;
    if (isXmlNameEnd(xml[at + open.length])) return at;
    start = at + open.length;
  }
  return -1;
}

/**
 * Depth-counting extract of one well-formed open/close pair starting at `start`.
 * Nested same-name tags increment depth. Unclosed input returns null.
 * @param {string} xml
 * @param {number} start
 * @param {string} open
 * @param {string} close
 * @returns {{ block: string, end: number } | null}
 */
function extractBalancedBlock(xml, start, open, close) {
  let depth = 1;
  let i = start + open.length;
  while (i < xml.length && depth > 0) {
    const nextOpen = indexOfOpenTag(xml, open, i);
    const nextClose = xml.indexOf(close, i);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + open.length;
    } else {
      depth -= 1;
      i = nextClose + close.length;
    }
  }
  if (depth !== 0) return null;
  return { block: xml.slice(start, i), end: i };
}

function unescapeXmlText(t) {
  return t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

function collectTagTexts(xml, open, close) {
  const out = [];
  let from = 0;
  while (from < xml.length) {
    const start = xml.indexOf(open, from);
    if (start < 0) break;
    if (!isXmlNameEnd(xml[start + open.length])) {
      from = start + open.length;
      continue;
    }
    const openEnd = xml.indexOf(">", start + open.length);
    if (openEnd < 0) break;
    const end = xml.indexOf(close, openEnd + 1);
    if (end < 0) break;
    out.push(xml.slice(openEnd + 1, end));
    from = end + close.length;
  }
  return out;
}

/**
 * @param {string} xml
 * @param {RegExp} re
 */
function matchAll(xml, re) {
  return [...xml.matchAll(re)];
}

/**
 * @param {string} xml
 * @param {string} name
 */
function attrAny(xml, name) {
  const dq = `${name}="`;
  const dqi = xml.indexOf(dq);
  if (dqi >= 0) {
    const end = xml.indexOf('"', dqi + dq.length);
    if (end >= 0) return xml.slice(dqi + dq.length, end);
  }
  const sq = `${name}='`;
  const sqi = xml.indexOf(sq);
  if (sqi >= 0) {
    const end = xml.indexOf("'", sqi + sq.length);
    if (end >= 0) return xml.slice(sqi + sq.length, end);
  }
  return null;
}

/**
 * @param {string} xml
 * @param {string} attr
 */
function attr(xml, attrName) {
  return attrAny(xml, attrName);
}

function sourcePartFromRelsPath(relsPath) {
  const normalized = relsPath.replace(/\\/g, "/");
  if (normalized === "_rels/.rels" || normalized.endsWith("/_rels/.rels")) {
    return "";
  }
  return normalized.replace(/\/_rels\/([^/]+)\.rels$/, "/$1");
}

function relsPathForPart(partPath) {
  const normalized = String(partPath).replace(/\\/g, "/").replace(/^\/+/, "");
  const slash = normalized.lastIndexOf("/");
  const dir = slash >= 0 ? normalized.slice(0, slash) : "";
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  return dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`;
}

function zipHasFile(zip, path) {
  if (!path || path.endsWith("/")) return false;
  const entry = zip.file(path);
  return Boolean(entry && !entry.dir);
}

const SLIDE_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";

function resolveZipTarget(relsPath, target) {
  const normalized = String(target).replace(/\\/g, "/");
  if (normalized.startsWith("/")) return normalized.replace(/^\/+/, "");
  const sourcePart = sourcePartFromRelsPath(relsPath);
  const base = sourcePart ? sourcePart.split("/").slice(0, -1) : [];
  const out = [];
  for (const part of [...base, ...normalized.split("/")]) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function parseRelationships(relXml) {
  const out = [];
  let from = 0;
  const open = "<Relationship";
  while (from < relXml.length) {
    const start = relXml.indexOf(open, from);
    if (start < 0) break;
    if (!isXmlNameEnd(relXml[start + open.length])) {
      from = start + open.length;
      continue;
    }
    const end = relXml.indexOf(">", start + open.length);
    if (end < 0) break;
    const tag = relXml.slice(start, end + 1);
    const id = attrAny(tag, "Id");
    const target = attrAny(tag, "Target");
    const type = attrAny(tag, "Type");
    if (id && target) out.push({ id, target, type });
    from = end + 1;
  }
  return out;
}

function innerXml(block, localName) {
  const openEnd = block.indexOf(">");
  const close = `</${localName}>`;
  const closeAt = block.lastIndexOf(close);
  if (openEnd < 0 || closeAt < 0 || closeAt <= openEnd) return "";
  return block.slice(openEnd + 1, closeAt);
}

function resolveAlternateContent(xml) {
  const blocks = sliceBlocks(xml, "<mc:AlternateContent", "</mc:AlternateContent>");
  let out = xml;
  for (const block of blocks) {
    const fallback = firstBlock(block, "<mc:Fallback", "</mc:Fallback>");
    const choice = firstBlock(block, "<mc:Choice", "</mc:Choice>");
    const keep = fallback
      ? innerXml(fallback, "mc:Fallback")
      : choice
        ? innerXml(choice, "mc:Choice")
        : "";
    const at = out.indexOf(block);
    if (at >= 0) {
      out = out.slice(0, at) + keep + out.slice(at + block.length);
    }
  }
  return out;
}

function openTagByName(xml, open, from = 0) {
  const start = indexOfOpenTag(xml, open, from);
  if (start < 0) return null;
  const end = xml.indexOf(">", start);
  if (end < 0) return null;
  return xml.slice(start, end + 1);
}

function attrInt(tag, name) {
  const raw = attrAny(tag, name);
  if (raw == null || !/^-?\d+$/.test(raw)) return null;
  return Number(raw);
}

function parseNamedOffExt(xml, offName, extName) {
  const off = openTagByName(xml, offName);
  const ext = openTagByName(xml, extName);
  if (!off || !ext) return null;
  const x = attrInt(off, "x");
  const y = attrInt(off, "y");
  const cx = attrInt(ext, "cx");
  const cy = attrInt(ext, "cy");
  if (x == null || y == null || cx == null || cy == null) return null;
  return { x, y, cx, cy };
}

function parseOffExt(xml) {
  return parseNamedOffExt(xml, "<a:off", "<a:ext");
}

function parseChOffExt(xml) {
  return parseNamedOffExt(xml, "<a:chOff", "<a:chExt");
}

function xfrmOpenTag(xfrmXml) {
  const gt = xfrmXml.indexOf(">");
  return gt >= 0 ? xfrmXml.slice(0, gt + 1) : xfrmXml;
}

function xfrmHasRotOrFlip(xfrmXml) {
  const openTag = xfrmOpenTag(xfrmXml);
  const rot = attrAny(openTag, "rot");
  if (rot != null && Number(rot) !== 0 && Number.isFinite(Number(rot))) return true;
  const flipH = attrAny(openTag, "flipH");
  const flipV = attrAny(openTag, "flipV");
  return (
    flipH === "1" ||
    flipH === "true" ||
    flipV === "1" ||
    flipV === "true"
  );
}

function parseGroupXfrm(grpXml) {
  const pr = firstBlock(grpXml, "<p:grpSpPr", "</p:grpSpPr>");
  if (!pr) return null;
  const xfrm = firstBlock(pr, "<a:xfrm", "</a:xfrm>");
  if (!xfrm) return null;
  const offExt = parseOffExt(xfrm);
  const ch = parseChOffExt(xfrm);
  if (!offExt || !ch) return null;
  if (ch.cx === 0 || ch.cy === 0) return null;
  return {
    offX: offExt.x,
    offY: offExt.y,
    extCx: offExt.cx,
    extCy: offExt.cy,
    chOffX: ch.x,
    chOffY: ch.y,
    chExtCx: ch.cx,
    chExtCy: ch.cy,
    rotOrFlip: xfrmHasRotOrFlip(xfrm),
  };
}

function hexFromColorChoice(block) {
  const srgbStart = indexOfOpenTag(block, "<a:srgbClr", 0);
  if (srgbStart >= 0) {
    const end = block.indexOf(">", srgbStart);
    const tag = end >= 0 ? block.slice(srgbStart, end + 1) : "";
    const val = attrAny(tag, "val");
    if (val && /^[0-9A-Fa-f]{6}$/.test(val)) return `#${val}`;
  }
  const sysStart = indexOfOpenTag(block, "<a:sysClr", 0);
  if (sysStart >= 0) {
    const end = block.indexOf(">", sysStart);
    const tag = end >= 0 ? block.slice(sysStart, end + 1) : "";
    const last = attrAny(tag, "lastClr");
    if (last && /^[0-9A-Fa-f]{6}$/.test(last)) return `#${last}`;
  }
  return null;
}

function parseClrScheme(themeXml) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!themeXml) return map;
  const scheme = firstBlock(themeXml, "<a:clrScheme", "</a:clrScheme>");
  if (!scheme) return map;
  for (const name of SCHEME_COLOR_NAMES) {
    const block = firstBlock(scheme, `<a:${name}`, `</a:${name}>`);
    if (!block) continue;
    const hex = hexFromColorChoice(block);
    if (hex) map.set(name, hex);
  }
  return map;
}

function resolveSchemeColor(val, ctx) {
  if (!val || !ctx) return null;
  const key = SCHEME_COLOR_ALIASES[val] || val;
  const hex = ctx.schemeColors instanceof Map ? ctx.schemeColors.get(key) : null;
  if (hex) return hex;
  if (ctx.importFlags && !ctx.importFlags.unresolvedScheme) {
    ctx.importFlags.unresolvedScheme = true;
    ctx.warnings.push(
      `unresolved schemeClr '${val}'; falling back to default`,
    );
  }
  return null;
}

function parseColorFromFragment(fragment, ctx) {
  const srgbStart = indexOfOpenTag(fragment, "<a:srgbClr", 0);
  if (srgbStart >= 0) {
    const end = fragment.indexOf(">", srgbStart);
    const tag = end >= 0 ? fragment.slice(srgbStart, end + 1) : "";
    const val = attrAny(tag, "val");
    if (val && /^[0-9A-Fa-f]{6}$/.test(val)) return `#${val}`;
  }
  const schemeStart = indexOfOpenTag(fragment, "<a:schemeClr", 0);
  if (schemeStart >= 0) {
    const end = fragment.indexOf(">", schemeStart);
    const tag = end >= 0 ? fragment.slice(schemeStart, end + 1) : "";
    const val = attrAny(tag, "val");
    if (val) return resolveSchemeColor(val, ctx);
  }
  return null;
}

const UNSUPPORTED_SPPR_FILLS = new Set([
  "a:gradFill",
  "a:blipFill",
  "a:pattFill",
  "a:grpFill",
]);

/**
 * Skip one comment, CDATA, PI, or closing/declaration tag as a single unit.
 * @param {string} xml
 * @param {number} start index of "<"
 * @returns {number | null} index after the unit, or null if this is an element
 */
function skipXmlNonElement(xml, start) {
  if (xml.startsWith("<!--", start)) {
    const end = xml.indexOf("-->", start + 4);
    return end < 0 ? xml.length : end + 3;
  }
  if (xml.startsWith("<![CDATA[", start)) {
    const end = xml.indexOf("]]>", start + 9);
    return end < 0 ? xml.length : end + 3;
  }
  if (xml.startsWith("<?", start)) {
    const end = xml.indexOf("?>", start + 2);
    return end < 0 ? xml.length : end + 2;
  }
  if (xml.startsWith("</", start) || xml.startsWith("<!", start)) {
    const gt = xml.indexOf(">", start);
    return gt < 0 ? xml.length : gt + 1;
  }
  return null;
}

/**
 * Top-level children of `p:spPr` only. Nested `a:ln` / effect fills are ignored.
 * @param {string} parentXml
 * @param {string} parentName
 * @returns {{ name: string, block: string }[]}
 */
function directChildElements(parentXml, parentName) {
  const inner = innerXml(parentXml, parentName);
  const children = [];
  let i = 0;
  while (i < inner.length) {
    const start = inner.indexOf("<", i);
    if (start < 0) break;
    const skipped = skipXmlNonElement(inner, start);
    if (skipped != null) {
      i = skipped;
      continue;
    }
    let nameEnd = start + 1;
    while (nameEnd < inner.length && !isXmlNameEnd(inner[nameEnd])) nameEnd += 1;
    const name = inner.slice(start + 1, nameEnd);
    if (!name) {
      i = start + 1;
      continue;
    }
    const gt = inner.indexOf(">", start);
    if (gt < 0) break;
    if (inner[gt - 1] === "/") {
      children.push({ name, block: inner.slice(start, gt + 1) });
      i = gt + 1;
      continue;
    }
    const extracted = extractBalancedBlock(
      inner,
      start,
      `<${name}`,
      `</${name}>`,
    );
    if (!extracted) break;
    children.push({ name, block: extracted.block });
    i = extracted.end;
  }
  return children;
}

/**
 * @param {string | null} spPr
 * @param {object} ctx
 * @returns {{ fillHex: string | null, noFill: boolean, unsupported: string | null }}
 */
function parseDirectSpPrFill(spPr, ctx) {
  /** @type {{ fillHex: string | null, noFill: boolean, unsupported: string | null }} */
  const result = { fillHex: null, noFill: false, unsupported: null };
  if (!spPr) return result;
  for (const child of directChildElements(spPr, "p:spPr")) {
    if (child.name === "a:noFill") {
      result.noFill = true;
      result.fillHex = null;
      result.unsupported = null;
    } else if (child.name === "a:solidFill") {
      result.noFill = false;
      result.fillHex = parseColorFromFragment(child.block, ctx);
      result.unsupported = null;
    } else if (UNSUPPORTED_SPPR_FILLS.has(child.name)) {
      result.noFill = false;
      result.fillHex = null;
      result.unsupported = child.name;
    }
  }
  return result;
}

function mapChildEmu(parent, child) {
  const scaleX = parent.extCx / parent.chExtCx;
  const scaleY = parent.extCy / parent.chExtCy;
  return {
    x: parent.offX + (child.x - parent.chOffX) * scaleX,
    y: parent.offY + (child.y - parent.chOffY) * scaleY,
    cx: child.cx * scaleX,
    cy: child.cy * scaleY,
  };
}

function composeGroupXfrm(parent, childGroup) {
  const mapped = mapChildEmu(parent, {
    x: childGroup.offX,
    y: childGroup.offY,
    cx: childGroup.extCx,
    cy: childGroup.extCy,
  });
  return {
    offX: mapped.x,
    offY: mapped.y,
    extCx: mapped.cx,
    extCy: mapped.cy,
    chOffX: childGroup.chOffX,
    chOffY: childGroup.chOffY,
    chExtCx: childGroup.chExtCx,
    chExtCy: childGroup.chExtCy,
  };
}

function emuRectToBounds(rect) {
  return [
    emuToPx(rect.x),
    emuToPx(rect.y),
    Math.max(1, emuToPx(rect.cx)),
    Math.max(1, emuToPx(rect.cy)),
  ];
}

function boundsFromXml(xml, parentXfrm) {
  const emu = parseOffExt(xml);
  if (!emu) return null;
  return emuRectToBounds(mapChildEmu(parentXfrm, emu));
}

function extractParagraphText(paragraphXml) {
  const parts = [];
  let i = 0;
  while (i < paragraphXml.length) {
    const t = paragraphXml.indexOf("<a:t", i);
    const br = paragraphXml.indexOf("<a:br", i);
    if (t < 0 && br < 0) break;
    if (br >= 0 && (t < 0 || br < t)) {
      if (!isXmlNameEnd(paragraphXml[br + 5])) {
        i = br + 5;
        continue;
      }
      parts.push("\n");
      const end = paragraphXml.indexOf(">", br);
      i = end < 0 ? br + 5 : end + 1;
      continue;
    }
    if (!isXmlNameEnd(paragraphXml[t + 4])) {
      i = t + 4;
      continue;
    }
    const openEnd = paragraphXml.indexOf(">", t + 4);
    if (openEnd < 0) break;
    const close = paragraphXml.indexOf("</a:t>", openEnd + 1);
    if (close < 0) break;
    parts.push(unescapeXmlText(paragraphXml.slice(openEnd + 1, close)));
    i = close + 6;
  }
  return parts.join("");
}

function extractPlainText(xml) {
  const paras = sliceBlocks(xml, "<a:p", "</a:p>");
  if (paras.length === 0) {
    return collectTagTexts(xml, "<a:t", "</a:t>").map(unescapeXmlText).join("");
  }
  return paras.map(extractParagraphText).join("\n");
}

function parseRunProperties(fragment, ctx) {
  /** @type {{ bold?: boolean, fontSize?: number, color?: string }} */
  const style = {};
  const sz = fragment.match(/\bsz="(\d+)"/);
  if (sz) style.fontSize = Math.max(1, Math.round(Number(sz[1]) / 100));
  if (/\bb="1"/.test(fragment)) style.bold = true;
  const color = parseColorFromFragment(fragment, ctx);
  if (color) style.color = color;
  return style;
}

function runStyleFromR(rXml, ctx) {
  const rPrBlock = firstBlock(rXml, "<a:rPr", "</a:rPr>");
  if (rPrBlock) return parseRunProperties(rPrBlock, ctx);
  const start = indexOfOpenTag(rXml, "<a:rPr", 0);
  if (start < 0) return {};
  const end = rXml.indexOf(">", start);
  if (end < 0) return {};
  return parseRunProperties(rXml.slice(start, end + 1), ctx);
}

function resolvedRunStyle(style) {
  return {
    bold: style.bold === true,
    fontSize: style.fontSize ?? 18,
    color: style.color ?? "#111827",
  };
}

function runStylesEqual(a, b) {
  const ra = resolvedRunStyle(a);
  const rb = resolvedRunStyle(b);
  return (
    ra.bold === rb.bold &&
    ra.fontSize === rb.fontSize &&
    ra.color.toUpperCase() === rb.color.toUpperCase()
  );
}

function appendNewline(runs) {
  if (runs.length) {
    runs[runs.length - 1].text += "\n";
    return;
  }
  runs.push({ text: "\n" });
}

function extractParagraphRuns(paragraphXml, ctx) {
  /** @type {{ text: string, bold?: boolean, fontSize?: number, color?: string }[]} */
  const runs = [];
  let i = 0;
  while (i < paragraphXml.length) {
    const rStart = indexOfOpenTag(paragraphXml, "<a:r", i);
    const brStart = indexOfOpenTag(paragraphXml, "<a:br", i);
    if (rStart < 0 && brStart < 0) break;
    if (brStart >= 0 && (rStart < 0 || brStart < rStart)) {
      appendNewline(runs);
      const end = paragraphXml.indexOf(">", brStart);
      i = end < 0 ? brStart + 5 : end + 1;
      continue;
    }
    const close = paragraphXml.indexOf("</a:r>", rStart + 4);
    if (close < 0) break;
    const rXml = paragraphXml.slice(rStart, close + 6);
    const text = collectTagTexts(rXml, "<a:t", "</a:t>")
      .map(unescapeXmlText)
      .join("");
    runs.push({ text, ...runStyleFromR(rXml, ctx) });
    i = close + 6;
  }
  return runs;
}

function extractRichRuns(xml, ctx) {
  const paras = sliceBlocks(xml, "<a:p", "</a:p>");
  if (paras.length === 0) {
    const plain = collectTagTexts(xml, "<a:t", "</a:t>")
      .map(unescapeXmlText)
      .join("");
    return plain ? [{ text: plain }] : [];
  }
  /** @type {{ text: string, bold?: boolean, fontSize?: number, color?: string }[]} */
  const runs = [];
  for (let pi = 0; pi < paras.length; pi += 1) {
    if (pi > 0) appendNewline(runs);
    runs.push(...extractParagraphRuns(paras[pi], ctx));
  }
  return runs;
}

function trimRichRuns(runs) {
  if (runs.length === 0) return [];
  const out = runs.map((run) => ({ ...run }));
  out[0].text = out[0].text.replace(/^\s+/, "");
  out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, "");
  return out.filter((run) => run.text.length > 0);
}

function capRichRuns(runs, warnings, pageIndex, elementId) {
  const limit = RESOURCE_LIMITS.richTextRunsPerElement;
  if (runs.length <= limit) return runs;
  const head = runs.slice(0, limit - 1);
  const tail = runs.slice(limit - 1);
  const merged = {
    ...tail[0],
    text: tail.map((run) => run.text).join(""),
  };
  warnings.push(
    `page ${pageIndex}: merged ${runs.length - limit + 1} extra rich-text run(s) on ${elementId} (richTextRunsPerElement=${limit})`,
  );
  return [...head, merged];
}

function collapseHomogeneousRuns(runs) {
  if (runs.length === 0) return null;
  const first = runs[0];
  if (!runs.every((run) => runStylesEqual(run, first))) return null;
  const resolved = resolvedRunStyle(first);
  return {
    text: runs.map((run) => run.text).join(""),
    fontSize: resolved.fontSize,
    bold: resolved.bold,
    color: resolved.color,
  };
}

function serializeRichRuns(runs) {
  return runs.map((run) => {
    /** @type {{ text: string, bold?: boolean, fontSize?: number, color?: string }} */
    const out = { text: run.text };
    if (run.bold) out.bold = true;
    if (run.color) out.color = run.color;
    if (run.fontSize != null) out.fontSize = run.fontSize;
    return out;
  });
}

function parseSldIdLst(presXml) {
  const ids = [];
  let from = 0;
  const open = "<p:sldId";
  while (from < presXml.length) {
    const start = presXml.indexOf(open, from);
    if (start < 0) break;
    if (!isXmlNameEnd(presXml[start + open.length])) {
      from = start + open.length;
      continue;
    }
    const end = presXml.indexOf(">", start + open.length);
    if (end < 0) break;
    const tag = presXml.slice(start, end + 1);
    const rid = attrAny(tag, "r:id") || attrAny(tag, "r:Id");
    if (rid) ids.push(rid);
    from = end + 1;
  }
  return ids;
}

/**
 * Lossy parse of a single chart XML into IR chart fields.
 * @param {string} chartXml
 * @returns {{ chartType: string, title?: string, series: object[] } | null}
 */
function firstBlock(xml, open, close) {
  return sliceBlocks(xml, open, close)[0] || null;
}

function firstTagText(xml, open, close) {
  return collectTagTexts(xml, open, close)[0] || null;
}

export function parseChartXml(chartXml) {
  /** @type {string} */
  let chartType = "bar";
  if (chartXml.includes("<c:lineChart")) chartType = "line";
  else if (chartXml.includes("<c:pieChart")) chartType = "pie";
  else if (chartXml.includes("<c:doughnutChart")) chartType = "doughnut";
  else if (chartXml.includes("<c:areaChart")) chartType = "area";
  else if (chartXml.includes("<c:barChart")) chartType = "bar";
  else return null;

  const titleBlock = firstBlock(chartXml, "<c:title", "</c:title>");
  const title = titleBlock ? firstTagText(titleBlock, "<a:t", "</a:t>") : null;

  /** @type {object[]} */
  const series = [];
  const serBlocks = sliceBlocks(chartXml, "<c:ser", "</c:ser>");
  /** @type {string[] | undefined} */
  let sharedLabels;
  for (let si = 0; si < serBlocks.length; si += 1) {
    const ser = serBlocks[si];
    const txBlock = firstBlock(ser, "<c:tx", "</c:tx>");
    const name =
      (txBlock && firstTagText(txBlock, "<c:v", "</c:v>")) || `Series ${si + 1}`;
    const valBlock = firstBlock(ser, "<c:val", "</c:val>");
    const numCache = valBlock ? firstBlock(valBlock, "<c:numCache", "</c:numCache>") : null;
    const values = numCache
      ? collectTagTexts(numCache, "<c:v", "</c:v>")
          .map((text) => Number(text))
          .filter((n) => Number.isFinite(n))
      : [];
    const catBlock = firstBlock(ser, "<c:cat", "</c:cat>");
    const catCache = catBlock
      ? firstBlock(catBlock, "<c:strCache", "</c:strCache>") ||
        firstBlock(catBlock, "<c:numCache", "</c:numCache>")
      : null;
    if (catCache) {
      const labels = collectTagTexts(catCache, "<c:v", "</c:v>");
      if (labels.length) sharedLabels = labels;
    }
    if (values.length === 0) continue;
    /** @type {{ name: string, values: number[], labels?: string[] }} */
    const entry = { name, values };
    if (sharedLabels && sharedLabels.length === values.length) {
      entry.labels = sharedLabels;
    }
    series.push(entry);
  }
  if (series.length === 0) return null;
  /** @type {{ chartType: string, title?: string, series: object[] }} */
  const out = { chartType, series };
  if (title) out.title = title;
  return out;
}

function nextElementId(ctx, kind) {
  return `p${ctx.pageIndex}-${kind}${ctx.ids.n++}`;
}

const PARAGRAPH_ALIGN = Object.freeze({
  l: "left",
  ctr: "center",
  r: "right",
});

function parseParagraphAlign(xml, ctx) {
  const paragraph = firstBlock(xml, "<a:p", "</a:p>") || xml;
  const pPrOpen = openTagByName(paragraph, "<a:pPr");
  const algn = pPrOpen ? attrAny(pPrOpen, "algn") : null;
  if (!algn) return "left";
  if (PARAGRAPH_ALIGN[algn]) return PARAGRAPH_ALIGN[algn];
  ctx.warnings.push(
    `page ${ctx.pageIndex}: dropped unsupported paragraph align '${algn}'`,
  );
  return "left";
}

function buildTextElement(sp, bounds, ctx) {
  const extracted = trimRichRuns(extractRichRuns(sp, ctx));
  if (extracted.length === 0) return null;
  const id = nextElementId(ctx, "t");
  const runs = capRichRuns(
    extracted,
    ctx.warnings,
    ctx.pageIndex,
    id,
  );
  const align = parseParagraphAlign(sp, ctx);
  const collapsed = collapseHomogeneousRuns(runs);
  if (collapsed) {
    return {
      id,
      type: "text",
      bounds,
      text: collapsed.text,
      fontSize: collapsed.fontSize,
      bold: collapsed.bold,
      color: collapsed.color,
      align,
    };
  }
  const first = resolvedRunStyle(runs[0]);
  return {
    id,
    type: "text",
    bounds,
    text: serializeRichRuns(runs),
    fontSize: first.fontSize,
    bold: first.bold,
    color: first.color,
    align,
  };
}

function parseSpBlock(sp, ctx) {
  const bounds = boundsFromXml(sp, ctx.parentXfrm);
  if (!bounds) return;
  const spPr = firstBlock(sp, "<p:spPr", "</p:spPr>");
  const fill = parseDirectSpPrFill(spPr, ctx);
  const prst = attr(spPr || "", "prst") || "rect";
  const textEl = buildTextElement(sp, bounds, ctx);
  const shapeMap = {
    rect: "rect",
    roundRect: "roundRect",
    ellipse: "ellipse",
    circle: "ellipse",
  };

  if (fill.fillHex && !fill.noFill) {
    ctx.elements.push({
      id: nextElementId(ctx, "s"),
      type: "shape",
      bounds,
      shape: shapeMap[prst] || "rect",
      fill: fill.fillHex,
    });
  } else if (fill.unsupported) {
    ctx.warnings.push(
      `page ${ctx.pageIndex}: dropped unsupported shape fill ${fill.unsupported}`,
    );
  }

  if (textEl) ctx.elements.push(textEl);
}

function parsePicBlock(pic, ctx) {
  const bounds = boundsFromXml(pic, ctx.parentXfrm);
  const blip = openTagByName(pic, "<a:blip");
  const embed = blip ? attrAny(blip, "r:embed") : null;
  if (!bounds) {
    ctx.warnings.push(
      `page ${ctx.pageIndex}: skipped picture; missing transform`,
    );
    return;
  }
  if (!embed) {
    ctx.warnings.push(
      `page ${ctx.pageIndex}: skipped picture; missing embed relationship`,
    );
    return;
  }
  const mediaPath = ctx.relIdToMediaPath.get(embed);
  if (!mediaPath) {
    ctx.warnings.push(
      `page ${ctx.pageIndex}: skipped picture; missing media for ${embed}`,
    );
    return;
  }
  ctx.elements.push({
    id: nextElementId(ctx, "i"),
    type: "image",
    bounds,
    src: mediaPath,
  });
}

function parseGraphicFrameBlock(frame, ctx) {
  const bounds = boundsFromXml(frame, ctx.parentXfrm);
  if (!bounds) return;

  if (/<a:tbl[\s>]/.test(frame)) {
    const rowXmls = sliceBlocks(frame, "<a:tr", "</a:tr>");
    if (rowXmls.length === 0) return;
    /** @type {string[][]} */
    const rows = [];
    for (const rowXml of rowXmls) {
      const cells = sliceBlocks(rowXml, "<a:tc", "</a:tc>").map((cellXml) => {
        return extractPlainText(cellXml).trim();
      });
      if (cells.length) rows.push(cells);
    }
    if (rows.length === 0) return;
    ctx.elements.push({
      id: nextElementId(ctx, "tbl"),
      type: "table",
      bounds,
      header: true,
      rows,
    });
    return;
  }

  const chartEmbed = frame.match(
    /<c:chart[^>]*r:id="(rId\d+)"|r:id="(rId\d+)"[^>]*\/?>/,
  );
  const chartRid = chartEmbed?.[1] || chartEmbed?.[2];
  if (chartRid && ctx.relIdToChartXml.has(chartRid)) {
    const parsed = parseChartXml(ctx.relIdToChartXml.get(chartRid) || "");
    if (parsed) {
      ctx.elements.push({
        id: nextElementId(ctx, "ch"),
        type: "chart",
        bounds,
        chartType: parsed.chartType,
        ...(parsed.title ? { title: parsed.title } : {}),
        series: parsed.series,
      });
    }
  }
}

function nextShapeChild(xml, from) {
  let best = null;
  for (const spec of SHAPE_CHILD_SPECS) {
    const start = indexOfOpenTag(xml, spec.open, from);
    if (start < 0) continue;
    if (!best || start < best.start) best = { ...spec, start };
  }
  return best;
}

function expandGroupBlock(groupXml, ctx, depth) {
  if (depth >= GRP_SP_MAX_DEPTH) {
    ctx.warnings.push(
      `page ${ctx.pageIndex}: skipped grouped shape container (p:grpSp); nesting exceeds ${GRP_SP_MAX_DEPTH}`,
    );
    return;
  }
  const xfrm = parseGroupXfrm(groupXml);
  if (!xfrm) {
    ctx.warnings.push(
      `page ${ctx.pageIndex}: skipped grouped shape container (p:grpSp); missing or invalid a:xfrm`,
    );
    return;
  }
  if (xfrm.rotOrFlip) {
    ctx.warnings.push(
      `page ${ctx.pageIndex}: skipped grouped shape container (p:grpSp); rot/flip is not represented in IR`,
    );
    return;
  }
  parseShapeTree(
    innerXml(groupXml, "p:grpSp"),
    {
      ...ctx,
      parentXfrm: composeGroupXfrm(ctx.parentXfrm, xfrm),
    },
    depth + 1,
  );
}

function parseShapeTree(xml, ctx, depth) {
  let from = 0;
  while (from < xml.length) {
    const next = nextShapeChild(xml, from);
    if (!next) break;
    const extracted = extractBalancedBlock(xml, next.start, next.open, next.close);
    if (!extracted) {
      if (next.kind === "grpSp") {
        ctx.warnings.push(
          `page ${ctx.pageIndex}: skipped grouped shape container(s) (p:grpSp); unclosed group`,
        );
      }
      break;
    }
    from = extracted.end;
    if (next.kind === "grpSp") {
      expandGroupBlock(extracted.block, ctx, depth);
    } else if (next.kind === "sp") {
      parseSpBlock(extracted.block, ctx);
    } else if (next.kind === "pic") {
      parsePicBlock(extracted.block, ctx);
    } else if (next.kind === "graphicFrame") {
      parseGraphicFrameBlock(extracted.block, ctx);
    } else if (next.kind === "cxnSp") {
      ctx.warnings.push(
        `page ${ctx.pageIndex}: skipped connector (p:cxnSp); not represented in IR`,
      );
    }
  }
}

/**
 * Parse one slide XML into IR elements (lossy).
 * @param {string} slideXml
 * @param {Map<string, string>} relIdToMediaPath  rId → media/foo.png relative path
 * @param {Map<string, string>} relIdToChartXml  rId → chart XML string
 * @param {number} pageIndex
 * @param {string[]} [warnings]
 * @param {{ schemeColors?: Map<string, string>, importFlags?: { unresolvedScheme?: boolean } }} [extras]
 */
function parseSlide(
  slideXml,
  relIdToMediaPath,
  relIdToChartXml,
  pageIndex,
  warnings = [],
  extras = {},
) {
  /** @type {object[]} */
  const elements = [];

  let background;
  const bgBlock = firstBlock(slideXml, "<p:bg", "</p:bg>");
  const bgVal = bgBlock && attrAny(bgBlock, "val");
  if (bgBlock && bgVal && /^[0-9A-Fa-f]{6}$/.test(bgVal)) {
    background = { type: "solid", color: `#${bgVal}` };
  }

  parseShapeTree(
    slideXml,
    {
      relIdToMediaPath,
      relIdToChartXml,
      pageIndex,
      warnings,
      elements,
      ids: { n: 0 },
      parentXfrm: IDENTITY_GROUP_XFRM,
      schemeColors: extras.schemeColors || new Map(),
      importFlags: extras.importFlags || {},
    },
    0,
  );

  return { background, elements };
}

/**
 * Import is lossy: intersect element bounds with the slide canvas so
 * validateDeck is not fail-closed by off-canvas group transforms.
 * @param {object[]} elements
 * @param {[number, number]} canvas
 * @param {string[]} warnings
 * @param {number} pageIndex
 */
function clampImportedElements(elements, canvas, warnings, pageIndex) {
  const [cw, ch] = canvas;
  const out = [];
  for (const el of elements) {
    const bounds = el.bounds;
    if (
      !Array.isArray(bounds) ||
      bounds.length !== 4 ||
      !bounds.every((n) => Number.isFinite(n))
    ) {
      warnings.push(
        `page ${pageIndex}: skipped off-canvas element ${el.id} bounds=${JSON.stringify(bounds)}`,
      );
      continue;
    }
    const [x, y, w, h] = bounds;
    const ix = Math.max(0, x);
    const iy = Math.max(0, y);
    const ix2 = Math.min(cw, x + w);
    const iy2 = Math.min(ch, y + h);
    const nw = ix2 - ix;
    const nh = iy2 - iy;
    if (nw < 1 || nh < 1) {
      warnings.push(
        `page ${pageIndex}: skipped off-canvas element ${el.id} bounds=[${x}, ${y}, ${w}, ${h}] canvas=[${cw}, ${ch}]`,
      );
      continue;
    }
    if (ix !== x || iy !== y || nw !== w || nh !== h) {
      warnings.push(
        `page ${pageIndex}: clamped element ${el.id} from [${x}, ${y}, ${w}, ${h}] to [${ix}, ${iy}, ${nw}, ${nh}]`,
      );
      out.push({ ...el, bounds: [ix, iy, nw, nh] });
      continue;
    }
    out.push(el);
  }
  return out;
}

/** Read one regular PPTX file without allocating beyond the archive ceiling. */
function readPptxSnapshot(absPptx) {
  let fd;
  try {
    fd = openSync(absPptx, PPTX_OPEN_FLAGS);
  } catch {
    throw new OpenPptError(ErrorCodes.IO, `PPTX not found or unreadable: ${absPptx}`);
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new OpenPptError(ErrorCodes.IO, `PPTX is not a regular file: ${absPptx}`);
    }
    assertResourceLimit(
      stat.size,
      RESOURCE_LIMITS.pptxArchiveBytes,
      "pptxArchiveBytes",
      "PPTX archive",
    );

    const chunks = [];
    let byteLength = 0;
    const readCeiling = RESOURCE_LIMITS.pptxArchiveBytes + 1;
    while (byteLength < readCeiling) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, readCeiling - byteLength),
      );
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      byteLength += bytesRead;
    }
    assertResourceLimit(
      byteLength,
      RESOURCE_LIMITS.pptxArchiveBytes,
      "pptxArchiveBytes",
      "PPTX archive",
    );
    return Buffer.concat(chunks, byteLength);
  } catch (err) {
    if (err instanceof OpenPptError) throw err;
    throw new OpenPptError(
      ErrorCodes.IO,
      `Unable to read PPTX: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse the classic ZIP central directory before JSZip allocates entry objects.
 * ZIP64 and multi-disk inputs exceed this importer's bounded, local-file scope.
 * @param {Buffer} archive
 * @returns {Buffer} a view pinned to the validated end record
 */
function assertZipCentralDirectoryLimits(archive) {
  const minimumEocd = 22;
  const searchStart = Math.max(0, archive.length - minimumEocd - 0xffff);
  let eocd = -1;
  for (let offset = archive.length - minimumEocd; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
    const commentBytes = archive.readUInt16LE(offset + 20);
    if (offset + minimumEocd + commentBytes === archive.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new OpenPptError(ErrorCodes.IO, "Invalid PPTX ZIP end record");
  }

  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralBytes = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new OpenPptError(
      ErrorCodes.IO,
      "ZIP64 and multi-disk PPTX archives are not supported",
    );
  }
  assertResourceLimit(
    entryCount,
    RESOURCE_LIMITS.pptxEntries,
    "pptxEntries",
    "PPTX central directory",
  );
  if (centralOffset + centralBytes !== eocd) {
    throw new OpenPptError(ErrorCodes.IO, "Invalid PPTX ZIP central directory bounds");
  }

  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > eocd ||
      archive.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE
    ) {
      throw new OpenPptError(ErrorCodes.IO, "Invalid PPTX ZIP central directory entry");
    }
    const compressedBytes = archive.readUInt32LE(cursor + 20);
    const uncompressedBytes = archive.readUInt32LE(cursor + 24);
    const nameBytes = archive.readUInt16LE(cursor + 28);
    const extraBytes = archive.readUInt16LE(cursor + 30);
    const commentBytes = archive.readUInt16LE(cursor + 32);
    const startDisk = archive.readUInt16LE(cursor + 34);
    if (
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      startDisk !== 0
    ) {
      throw new OpenPptError(
        ErrorCodes.IO,
        "ZIP64 and multi-disk PPTX entries are not supported",
      );
    }
    assertResourceLimit(
      uncompressedBytes,
      RESOURCE_LIMITS.pptxEntryUncompressedBytes,
      "pptxEntryUncompressedBytes",
      `PPTX entry ${index + 1}`,
    );
    totalUncompressed += uncompressedBytes;
    assertResourceLimit(
      totalUncompressed,
      RESOURCE_LIMITS.pptxUncompressedBytes,
      "pptxUncompressedBytes",
      "PPTX archive",
    );
    cursor += 46 + nameBytes + extraBytes + commentBytes;
  }
  if (cursor !== eocd) {
    throw new OpenPptError(ErrorCodes.IO, "Invalid PPTX ZIP central directory size");
  }

  // ZIP comments are irrelevant to PPTX. Removing them ensures JSZip's
  // last-signature scan cannot select an end record that preflight rejected.
  archive.writeUInt16LE(0, eocd + 20);
  const pinnedArchive = archive.subarray(0, eocd + minimumEocd);
  for (let offset = pinnedArchive.length - 4; offset > eocd; offset -= 1) {
    if (pinnedArchive.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      throw new OpenPptError(ErrorCodes.IO, "Ambiguous PPTX ZIP end record");
    }
  }
  return pinnedArchive;
}

/**
 * Create a cached reader that enforces actual inflate limits while streaming.
 * @param {import('jszip')} zip
 * @param {{ entryBytes?: number, totalBytes?: number }} [limits]
 */
export function createBoundedZipReader(zip, limits = {}) {
  const entryBytes =
    limits.entryBytes ?? RESOURCE_LIMITS.pptxEntryUncompressedBytes;
  const totalBytes = limits.totalBytes ?? RESOURCE_LIMITS.pptxUncompressedBytes;
  /** @type {Map<string, Buffer>} */
  const cache = new Map();
  let totalInflatedBytes = 0;

  /** @param {string} path */
  return async function readZipEntry(path) {
    if (cache.has(path)) return cache.get(path);
    const entry = zip.file(path);
    if (!entry) return null;

    let bytes;
    try {
      bytes = await new Promise((resolveEntry, rejectEntry) => {
        const chunks = [];
        let byteLength = 0;
        let settled = false;
        const helper = entry.internalStream("nodebuffer");

        const fail = (err) => {
          if (settled) return;
          settled = true;
          helper.pause();
          rejectEntry(err);
        };
        helper.on("data", (chunk) => {
          if (settled) return;
          const part = Buffer.from(chunk);
          byteLength += part.length;
          try {
            assertResourceLimit(
              byteLength,
              entryBytes,
              "pptxEntryUncompressedBytes",
              `PPTX entry ${path}`,
            );
            assertResourceLimit(
              totalInflatedBytes + byteLength,
              totalBytes,
              "pptxUncompressedBytes",
              "PPTX archive",
            );
          } catch (err) {
            fail(err);
            return;
          }
          chunks.push(part);
        });
        helper.on("error", (err) => fail(err));
        helper.on("end", () => {
          if (settled) return;
          settled = true;
          resolveEntry(Buffer.concat(chunks, byteLength));
        });
        helper.resume();
      });
    } catch (err) {
      if (err instanceof OpenPptError) throw err;
      throw new OpenPptError(
        ErrorCodes.IO,
        `Unable to inflate PPTX entry ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    totalInflatedBytes += bytes.length;
    cache.set(path, bytes);
    return bytes;
  };
}

/** @param {(path: string) => Promise<Buffer | null>} readZipEntry @param {string} path */
async function readZipText(readZipEntry, path) {
  const bytes = await readZipEntry(path);
  return bytes ? bytes.toString("utf8") : null;
}

/**
 * Commit a complete import as one rollback-safe set of file replacements.
 * @param {string} dest
 * @param {{ relativePath: string, data: string | Buffer }[]} outputs
 * @param {boolean} force
 * @param {{ linkSync?: typeof linkSync, renameSync?: typeof renameSync, unlinkSync?: typeof unlinkSync }} [operations]
 * @returns {string[]} cleanup warnings
 */
export function commitImportOutputs(dest, outputs, force, operations = {}) {
  const linkFile = operations.linkSync || linkSync;
  const renameFile = operations.renameSync || renameSync;
  const unlinkFile = operations.unlinkSync || unlinkSync;
  const transaction = randomBytes(8).toString("hex");
  const records = outputs.map((output, index) => {
    const target = join(dest, output.relativePath);
    return {
      ...output,
      target,
      temp: join(
        dirname(target),
        `.openppt-import-${transaction}-${index}.tmp`,
      ),
      backup: null,
      installed: false,
    };
  });

  for (const record of records) {
    if (
      force &&
      existsSync(record.target) &&
      lstatSync(record.target).isDirectory()
    ) {
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        `Import target is a directory: ${record.target}`,
      );
    }
  }

  const createdDirs = [];
  function trackAndMkdir(dir) {
    const missing = [];
    let cur = dir;
    while (cur && !existsSync(cur)) {
      missing.push(cur);
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    mkdirSync(dir, { recursive: true });
    createdDirs.push(...missing);
  }

  try {
    for (const record of records) {
      trackAndMkdir(dirname(record.target));
      writeFileSync(record.temp, record.data);
    }
  } catch (err) {
    for (const record of records) {
      try {
        if (existsSync(record.temp)) unlinkFile(record.temp);
      } catch {
        // keep the original write error
      }
    }
    for (const dir of [...new Set(createdDirs)].sort((a, b) => b.length - a.length)) {
      try {
        rmdirSync(dir);
      } catch {
        // directory not empty or already gone
      }
    }
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `Import staging failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    for (const record of records) {
      if (!force) {
        // A hard link is an atomic no-clobber install because temp and target
        // share a directory/filesystem. EEXIST enters the rollback path.
        installFileNoClobber(
          record.temp,
          record.target,
          record.data,
          linkFile,
        );
        record.installed = true;
        continue;
      }
      if (existsSync(record.target)) {
        record.backup = `${record.temp}.backup`;
        renameFile(record.target, record.backup);
      }
      renameFile(record.temp, record.target);
      record.installed = true;
    }
  } catch (err) {
    let rollbackError = null;
    for (const record of [...records].reverse()) {
      try {
        if (record.installed && existsSync(record.target)) {
          unlinkFile(record.target);
        }
        if (record.backup && existsSync(record.backup)) {
          renameFile(record.backup, record.target);
        }
        if (existsSync(record.temp)) unlinkFile(record.temp);
      } catch (rollbackErr) {
        rollbackError ||= rollbackErr;
      }
    }
    const uniqueDirs = [...new Set(createdDirs)].sort(
      (a, b) => b.length - a.length,
    );
    for (const dir of uniqueDirs) {
      try {
        rmdirSync(dir);
      } catch {
        // directory not empty or already gone
      }
    }
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `Import commit failed: ${err instanceof Error ? err.message : String(err)}` +
        (rollbackError
          ? `; rollback incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          : ""),
    );
  }

  const cleanupWarnings = [];
  for (const record of records) {
    if (!force && existsSync(record.temp)) {
      try {
        unlinkFile(record.temp);
      } catch (err) {
        cleanupWarnings.push(
          `could not remove import temp ${record.temp}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!record.backup || !existsSync(record.backup)) continue;
    try {
      unlinkFile(record.backup);
    } catch (err) {
      cleanupWarnings.push(
        `could not remove import backup ${record.backup}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return cleanupWarnings;
}

/**
 * Validate the complete imported deck, including extracted media, before any
 * destination file is touched.
 * @param {object} deck
 * @param {{ relativePath: string, data: Buffer }[]} mediaOutputs
 */
function validateImportedDeck(deck, mediaOutputs) {
  const stagingRoot = mkdtempSync(join(tmpdir(), "openppt-import-validate-"));
  try {
    for (const output of mediaOutputs) {
      const path = join(stagingRoot, output.relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, output.data);
    }
    validateDeck(deck, { projectRoot: stagingRoot, checkMedia: true });
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Import a .pptx file into an OpenPPT project directory (lossy).
 * @param {string} pptxPath
 * @param {string} outDir
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ deckPath: string, pageCount: number, warnings: string[] }>}
 */
export async function importPptx(pptxPath, outDir, options = {}) {
  const { force = false } = options;
  const absPptx = resolve(pptxPath);
  if (!existsSync(absPptx)) {
    throw new OpenPptError(ErrorCodes.IO, `PPTX not found: ${absPptx}`);
  }
  const dest = resolve(outDir);

  const buf = readPptxSnapshot(absPptx);
  const pinnedBuf = assertZipCentralDirectoryLimits(buf);
  let zip;
  try {
    zip = await JSZip.loadAsync(pinnedBuf);
  } catch (err) {
    throw new OpenPptError(
      ErrorCodes.IO,
      `Unable to open PPTX ZIP: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const readZipEntry = createBoundedZipReader(zip);
  const warnings = [
    "import is lossy: masters/animations/fonts not reconstructed; charts/tables are best-effort",
  ];

  // Slide size from presentation.xml sldSz
  let size = [960, 540];
  const presXml = await readZipText(readZipEntry, "ppt/presentation.xml");
  if (presXml) {
    const sldSzTagStart = presXml.indexOf("<p:sldSz");
    if (sldSzTagStart >= 0) {
      const sldSzTagEnd = presXml.indexOf(">", sldSzTagStart);
      const sldSzTag =
        sldSzTagEnd >= 0 ? presXml.slice(sldSzTagStart, sldSzTagEnd + 1) : "";
      const cx = attrAny(sldSzTag, "cx");
      const cy = attrAny(sldSzTag, "cy");
      if (cx && cy) {
        size = [emuToPx(cx), emuToPx(cy)];
      }
    }
  }

  const presentationRelsXml =
    (await readZipText(readZipEntry, "ppt/_rels/presentation.xml.rels")) || "";
  const presentationRels = parseRelationships(presentationRelsXml);
  const relById = new Map();
  const ridToSlide = new Map();
  let themePath = "ppt/theme/theme1.xml";
  for (const rel of presentationRels) {
    relById.set(rel.id, rel);
    const target = resolveZipTarget(
      "ppt/_rels/presentation.xml.rels",
      rel.target,
    );
    if (rel.type === SLIDE_REL_TYPE && zipHasFile(zip, target)) {
      ridToSlide.set(rel.id, target);
    }
    if (
      /^ppt\/theme\/theme\d+\.xml$/i.test(target) ||
      (rel.type && /\/theme$/i.test(rel.type))
    ) {
      themePath = target;
    }
  }
  const schemeColors = parseClrScheme(
    (await readZipText(readZipEntry, themePath)) || "",
  );
  const importFlags = { unresolvedScheme: false };

  let slidePaths = [];
  if (presXml) {
    const seen = new Set();
    for (const rid of parseSldIdLst(presXml)) {
      const rel = relById.get(rid);
      if (!rel || rel.type !== SLIDE_REL_TYPE) {
        warnings.push(
          `skipped sldIdLst relationship ${rid}; unresolved slide relationship`,
        );
        continue;
      }
      const target = resolveZipTarget(
        "ppt/_rels/presentation.xml.rels",
        rel.target,
      );
      if (!zipHasFile(zip, target)) {
        warnings.push(
          `skipped sldIdLst relationship ${rid}; missing slide part ${target}`,
        );
        continue;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      slidePaths.push(target);
    }
  }
  if (slidePaths.length === 0) {
    warnings.push(
      "presentation sldIdLst missing or empty; falling back to slide relationships",
    );
    const seen = new Set();
    for (const rel of presentationRels) {
      const target = ridToSlide.get(rel.id);
      if (!target || seen.has(target) || !zipHasFile(zip, target)) continue;
      seen.add(target);
      slidePaths.push(target);
    }
  }

  assertResourceLimit(
    slidePaths.length,
    RESOURCE_LIMITS.pagesPerDeck,
    "pagesPerDeck",
    "PPTX slides",
  );

  if (slidePaths.length === 0) {
    throw new OpenPptError(ErrorCodes.IO, "No slides found in PPTX");
  }

  /** @type {object[]} */
  const pages = [];
  /** @type {{ relativePath: string, data: Buffer }[]} */
  const mediaOutputs = [];
  /** @type {Map<string, { relativePath: string, data: Buffer }>} */
  const mediaTargetToOutput = new Map();
  let mediaIndex = 0;
  let totalImportedMediaBytes = 0;

  for (let si = 0; si < slidePaths.length; si += 1) {
    const slidePath = slidePaths[si];
    const slideXml = await readZipText(readZipEntry, slidePath);
    if (!slideXml) continue;

    // Relationships for images + charts
    const relPath = relsPathForPart(slidePath);
    const relXml = (await readZipText(readZipEntry, relPath)) || "";
    /** @type {Map<string, string>} */
    const relIdToMedia = new Map();
    /** @type {Map<string, string>} */
    const relIdToChartXml = new Map();
    for (const rm of parseRelationships(relXml)) {
      const rId = rm.id;
      let target = resolveZipTarget(relPath, rm.target);
      if (/charts\/chart\d+\.xml$/i.test(target)) {
        const chartXml = await readZipText(readZipEntry, target);
        if (chartXml) relIdToChartXml.set(rId, chartXml);
        continue;
      }
      if (!zipHasFile(zip, target)) continue;
      const ext = extname(target).toLowerCase() || ".png";
      const allowed = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
      if (!allowed.has(ext)) {
        // not an image relationship (could be notes, etc.)
        continue;
      }
      let mediaOutput = mediaTargetToOutput.get(target);
      if (!mediaOutput) {
        const bytes = await readZipEntry(target);
        assertResourceLimit(
          bytes.length,
          RESOURCE_LIMITS.mediaBytesPerFile,
          "mediaBytesPerFile",
          `PPTX media ${target}`,
        );
        totalImportedMediaBytes += bytes.length;
        assertResourceLimit(
          totalImportedMediaBytes,
          RESOURCE_LIMITS.mediaBytesPerDeck,
          "mediaBytesPerDeck",
          "PPTX imported media",
        );
        const localName = `img-${++mediaIndex}${ext}`;
        mediaOutput = {
          relativePath: `media/${localName}`,
          data: bytes,
        };
        mediaTargetToOutput.set(target, mediaOutput);
        mediaOutputs.push(mediaOutput);
      }
      relIdToMedia.set(rId, mediaOutput.relativePath);
    }

    const xmlWithFallback = resolveAlternateContent(slideXml);
    const { background, elements } = parseSlide(
      xmlWithFallback,
      relIdToMedia,
      relIdToChartXml,
      si + 1,
      warnings,
      { schemeColors, importFlags },
    );
    pages.push({
      id: `page-${si + 1}`,
      ...(background ? { background } : {}),
      elements: clampImportedElements(elements, size, warnings, si + 1),
    });
  }

  const title =
    (await readZipText(readZipEntry, "docProps/core.xml"))?.match(
      /<dc:title>([^<]*)<\/dc:title>/,
    )?.[1] || basename(absPptx, ".pptx");

  const deck = {
    version: "openppt-1",
    title,
    size,
    theme: {
      colors: {
        primary: "#2563EB",
        text: "#111827",
        muted: "#6B7280",
        background: "#FFFFFF",
        surface: "#F8FAFC",
        accent: "#F59E0B",
      },
    },
    pages,
  };

  const referencedMedia = new Set(
    pages.flatMap((page) =>
      page.elements
        .filter((element) => element.type === "image")
        .map((element) => element.src),
    ),
  );
  const usedMediaOutputs = mediaOutputs.filter((output) =>
    referencedMedia.has(output.relativePath),
  );
  validateImportedDeck(deck, usedMediaOutputs);

  const deckPath = join(dest, "deck.json");
  warnings.push(
    ...commitImportOutputs(
      dest,
      [
        ...usedMediaOutputs,
        {
          relativePath: "deck.json",
          data: `${JSON.stringify(deck, null, 2)}\n`,
        },
      ],
      force,
    ),
  );
  return { deckPath, pageCount: pages.length, warnings };
}
