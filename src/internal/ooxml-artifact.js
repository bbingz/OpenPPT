/**
 * Post-process pptxgenjs ZIP parts for known generation defects.
 * Does not renumber every drawing id; only repairs duplicates and extra pPr.
 */

import JSZip from "jszip";
import { OpenPptError, ErrorCodes } from "../errors.js";

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

function collectCnvPrTags(xml) {
  const tagRe = /<p:cNvPr\b([^>]*?)(\/?)>/g;
  const items = [];
  let match;
  while ((match = tagRe.exec(xml))) {
    const idMatch = match[1].match(/\bid="(\d+)"/);
    if (!idMatch) {
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        "Generated slide has a cNvPr without a numeric id",
      );
    }
    items.push({
      index: match.index,
      length: match[0].length,
      attrs: match[1],
      selfClose: match[2],
      id: idMatch[1],
    });
  }
  return items;
}

function collectSpidRefs(xml) {
  const refs = new Set();
  const quoted = /\bspid=["'](\d+)["']/g;
  let match;
  while ((match = quoted.exec(xml))) refs.add(match[1]);
  const list = /\bspids=["']([^"']+)["']/g;
  while ((match = list.exec(xml))) {
    for (const part of match[1].trim().split(/\s+/)) {
      if (/^\d+$/.test(part)) refs.add(part);
    }
  }
  const cxn = /<a:(?:stCxn|endCxn)\b([^>]*?)\/?>/g;
  while ((match = cxn.exec(xml))) {
    const id = match[1].match(/\bid=["'](\d+)["']/);
    if (id) refs.add(id[1]);
  }
  return refs;
}

function repairCnvPrIds(xml) {
  const items = collectCnvPrTags(xml);
  if (items.length === 0) return xml;
  const counts = new Map();
  for (const item of items) {
    counts.set(item.id, (counts.get(item.id) || 0) + 1);
  }
  const refs = collectSpidRefs(xml);
  for (const [id, count] of counts) {
    if (count > 1 && refs.has(id)) {
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        `Ambiguous drawing id ${id} is referenced`,
      );
    }
  }
  const reserved = new Set(items.map((item) => item.id));
  const seen = new Set();
  let nextFree = 1;
  const assigned = items.map((item) => {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      return item.id;
    }
    while (reserved.has(String(nextFree))) nextFree += 1;
    const neu = String(nextFree);
    reserved.add(neu);
    nextFree += 1;
    return neu;
  });
  let out = xml;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (assigned[i] === items[i].id) continue;
    const item = items[i];
    const newAttrs = item.attrs.replace(/\bid="\d+"/, `id="${assigned[i]}"`);
    const neu = `<p:cNvPr${newAttrs}${item.selfClose}>`;
    out = `${out.slice(0, item.index)}${neu}${out.slice(item.index + item.length)}`;
  }
  return out;
}

function takePpr(inner, start) {
  const gt = inner.indexOf(">", start);
  if (gt < 0) return null;
  if (inner[gt - 1] === "/") {
    return { block: inner.slice(start, gt + 1), end: gt + 1 };
  }
  return extractBalancedBlock(inner, start, "<a:pPr", "</a:pPr>");
}

function repairParagraph(block) {
  const gt = block.indexOf(">");
  const closeAt = block.lastIndexOf("</a:p>");
  if (gt < 0 || closeAt < 0) {
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      "Malformed text paragraph in generated slide",
    );
  }
  const open = block.slice(0, gt + 1);
  const inner = block.slice(gt + 1, closeAt);
  const pPrs = [];
  let cleaned = "";
  let i = 0;
  while (i < inner.length) {
    const start = indexOfOpenTag(inner, "<a:pPr", i);
    if (start < 0) {
      cleaned += inner.slice(i);
      break;
    }
    cleaned += inner.slice(i, start);
    const extracted = takePpr(inner, start);
    if (!extracted) {
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        "Ambiguous paragraph properties in generated slide",
      );
    }
    pPrs.push(extracted.block);
    i = extracted.end;
  }
  if (pPrs.length === 0) return block;
  for (let pi = 1; pi < pPrs.length; pi += 1) {
    if (pPrs[pi] !== pPrs[0]) {
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        "Ambiguous paragraph properties in generated slide",
      );
    }
  }
  const trimmed = cleaned.replace(/^\s+/, "");
  if (pPrs.length === 1 && inner.trimStart().startsWith("<a:pPr")) return block;
  return `${open}${pPrs[0]}${trimmed}</a:p>`;
}

function repairParagraphs(xml) {
  let out = "";
  let i = 0;
  while (i < xml.length) {
    const start = indexOfOpenTag(xml, "<a:p", i);
    if (start < 0) {
      out += xml.slice(i);
      break;
    }
    out += xml.slice(i, start);
    const extracted = extractBalancedBlock(xml, start, "<a:p", "</a:p>");
    if (!extracted) {
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        "Unclosed text paragraph in generated slide",
      );
    }
    out += repairParagraph(extracted.block);
    i = extracted.end;
  }
  return out;
}

export function repairSlideXml(xml) {
  return repairCnvPrIds(repairParagraphs(xml));
}

function escapeXmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Rewrite DrawingML East Asian typefaces when theme.fonts.ea is set.
 * Leaves latin/cs and unrelated XML alone.
 * @param {string} xml
 * @param {string} ea
 */
export function applyEastAsianTypeface(xml, ea) {
  if (typeof ea !== "string" || ea.length < 1) return xml;
  const escaped = escapeXmlAttr(ea);
  let out = xml.replace(/<a:ea\b([^>]*?)>/g, (_, inner) => {
    if (/\btypeface=/.test(inner)) {
      inner = inner.replace(/\btypeface="[^"]*"/, `typeface="${escaped}"`);
    } else {
      inner = ` typeface="${escaped}"${inner}`;
    }
    return `<a:ea${inner}>`;
  });
  out = out.replace(/<a:latin\b([^>]*?)\/>/g, (full, _inner, offset, source) => {
    const rest = source.slice(offset + full.length).replace(/^\s+/, "");
    if (rest.startsWith("<a:ea")) return full;
    return `${full}<a:ea typeface="${escaped}"/>`;
  });
  return out;
}

export async function repairExportedPresentation(buffer, options = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const ea = options.ea;
  const names = Object.keys(zip.files).filter((name) =>
    /^ppt\/(slides|charts)\/[^/]+\.xml$/i.test(name) ||
    /^ppt\/theme\/[^/]+\.xml$/i.test(name),
  );
  for (const name of names) {
    let xml = await zip.file(name).async("string");
    if (/^ppt\/slides\/[^/]+\.xml$/i.test(name)) {
      xml = repairSlideXml(xml);
    }
    if (typeof ea === "string" && ea.length > 0) {
      xml = applyEastAsianTypeface(xml, ea);
    }
    zip.file(name, xml);
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}
