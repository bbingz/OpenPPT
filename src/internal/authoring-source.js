/**
 * JSON-aware lookup of an authoring element's "id" token in deck source.
 * Walks own properties only; does not use substring search or CSS selectors.
 */

const SKIP = Symbol("skip");

function hasOwn(obj, key) {
  return Boolean(obj) && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findElementIdPath(deck, pageId, elementId) {
  const pages = hasOwn(deck, "pages") ? deck.pages : null;
  if (!Array.isArray(pages)) return { kind: "missing" };

  const fileRefs = [];
  for (let i = 0; i < pages.length; i += 1) {
    if (typeof pages[i] === "string") fileRefs.push(pages[i]);
  }
  if (fileRefs.length > 0) return { kind: "external", paths: fileRefs };

  const pageIdxs = [];
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (isPlainObject(page) && hasOwn(page, "id") && page.id === pageId) pageIdxs.push(i);
  }
  if (pageIdxs.length !== 1) return { kind: "missing" };
  const pageIndex = pageIdxs[0];
  const page = pages[pageIndex];

  const hits = [];
  function walk(list, path) {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i += 1) {
      const node = list[i];
      if (!isPlainObject(node)) continue;
      const here = path.concat(i);
      if (hasOwn(node, "id") && node.id === elementId) hits.push(here.concat("id"));
      if (hasOwn(node, "type") && node.type === "group") {
        walk(hasOwn(node, "children") ? node.children : null, here.concat("children"));
      }
    }
  }
  walk(hasOwn(page, "elements") ? page.elements : null, ["pages", pageIndex, "elements"]);
  if (hits.length !== 1) return { kind: "missing" };
  return { kind: "path", path: hits[0] };
}

function locateJsonPath(source, path) {
  let i = 0;
  const n = source.length;

  const skipWs = () => {
    while (i < n) {
      const c = source.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i += 1;
      else break;
    }
  };

  function parseString() {
    const start = i;
    if (source[i] !== '"') throw new SyntaxError("string");
    i += 1;
    while (i < n) {
      const c = source[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        i += 1;
        return { start, end: i, value: JSON.parse(source.slice(start, i)) };
      }
      i += 1;
    }
    throw new SyntaxError("unterminated string");
  }

  function parseNumber() {
    const start = i;
    if (source[i] === "-") i += 1;
    while (i < n && source[i] >= "0" && source[i] <= "9") i += 1;
    if (source[i] === ".") {
      i += 1;
      while (i < n && source[i] >= "0" && source[i] <= "9") i += 1;
    }
    if (source[i] === "e" || source[i] === "E") {
      i += 1;
      if (source[i] === "+" || source[i] === "-") i += 1;
      while (i < n && source[i] >= "0" && source[i] <= "9") i += 1;
    }
    return { start, end: i };
  }

  function parseLiteral(word) {
    const start = i;
    if (source.slice(i, i + word.length) !== word) throw new SyntaxError(word);
    i += word.length;
    return { start, end: i };
  }

  function parseValue(want) {
    skipWs();
    const c = source[i];
    if (c === "{") return parseObject(want);
    if (c === "[") return parseArray(want);
    if (c === '"') {
      const str = parseString();
      return want === SKIP || (Array.isArray(want) && want.length) ? null : { start: str.start, end: str.end };
    }
    if (c === "t") {
      const lit = parseLiteral("true");
      return want === SKIP || (Array.isArray(want) && want.length) ? null : lit;
    }
    if (c === "f") {
      const lit = parseLiteral("false");
      return want === SKIP || (Array.isArray(want) && want.length) ? null : lit;
    }
    if (c === "n") {
      const lit = parseLiteral("null");
      return want === SKIP || (Array.isArray(want) && want.length) ? null : lit;
    }
    const num = parseNumber();
    return want === SKIP || (Array.isArray(want) && want.length) ? null : num;
  }

  function parseObject(want) {
    const skip = want === SKIP;
    i += 1;
    skipWs();
    if (source[i] === "}") {
      i += 1;
      return null;
    }
    let result = null;
    while (i < n) {
      skipWs();
      const keyTok = parseString();
      skipWs();
      if (source[i] !== ":") throw new SyntaxError("colon");
      i += 1;
      const match = !skip && Array.isArray(want) && want.length > 0 && want[0] === keyTok.value;
      if (match && want.length === 1) {
        skipWs();
        const valueSpan = parseValue([]);
        if (valueSpan) result = { start: keyTok.start, end: valueSpan.end };
      } else {
        const inner = parseValue(match ? want.slice(1) : SKIP);
        if (inner) result = inner;
      }
      skipWs();
      if (source[i] === ",") {
        i += 1;
        continue;
      }
      if (source[i] === "}") {
        i += 1;
        break;
      }
      throw new SyntaxError("object");
    }
    return result;
  }

  function parseArray(want) {
    const skip = want === SKIP;
    i += 1;
    skipWs();
    if (source[i] === "]") {
      i += 1;
      return null;
    }
    let index = 0;
    let result = null;
    while (i < n) {
      const match = !skip && Array.isArray(want) && want.length > 0 && want[0] === index;
      const inner = parseValue(match ? want.slice(1) : SKIP);
      if (inner) result = inner;
      skipWs();
      if (source[i] === ",") {
        i += 1;
        index += 1;
        continue;
      }
      if (source[i] === "]") {
        i += 1;
        break;
      }
      throw new SyntaxError("array");
    }
    return result;
  }

  return parseValue(path);
}

/**
 * @param {string} source
 * @param {string} pageId
 * @param {string} elementId
 * @returns {{ kind: "ok", start: number, end: number } | { kind: "external", paths: string[] } | { kind: "invalid" } | { kind: "missing" }}
 */
export function locateAuthoringIdToken(source, pageId, elementId) {
  let data;
  try {
    data = JSON.parse(source);
  } catch {
    return { kind: "invalid" };
  }
  if (!isPlainObject(data)) return { kind: "invalid" };
  const found = findElementIdPath(data, pageId, elementId);
  if (found.kind !== "path") return found;
  try {
    const span = locateJsonPath(source, found.path);
    if (!span) return { kind: "missing" };
    return { kind: "ok", start: span.start, end: span.end };
  } catch {
    return { kind: "missing" };
  }
}

function findAuthoringHit(deck, pageId, elementId) {
  const pages = hasOwn(deck, "pages") ? deck.pages : null;
  if (!Array.isArray(pages)) return { kind: "missing" };
  const fileRefs = [];
  for (let i = 0; i < pages.length; i += 1) {
    if (typeof pages[i] === "string") fileRefs.push(pages[i]);
  }
  if (fileRefs.length > 0) return { kind: "external", paths: fileRefs };

  const pageIdxs = [];
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (isPlainObject(page) && hasOwn(page, "id") && page.id === pageId) pageIdxs.push(i);
  }
  if (pageIdxs.length !== 1) return { kind: "missing" };
  const page = pages[pageIdxs[0]];

  const hits = [];
  function walk(list, parentId) {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i += 1) {
      const node = list[i];
      if (!isPlainObject(node)) continue;
      if (hasOwn(node, "id") && node.id === elementId) hits.push({ el: node, parentId });
      if (hasOwn(node, "type") && node.type === "group") {
        walk(hasOwn(node, "children") ? node.children : null, hasOwn(node, "id") ? node.id : parentId);
      }
    }
  }
  walk(hasOwn(page, "elements") ? page.elements : null, null);
  if (hits.length !== 1) return { kind: "missing" };
  return { kind: "ok", page, el: hits[0].el, parentId: hits[0].parentId };
}

function collectIds(deck, used) {
  function walk(list) {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!isPlainObject(node)) continue;
      if (hasOwn(node, "id")) used.add(node.id);
      if (hasOwn(node, "type") && node.type === "group") {
        walk(hasOwn(node, "children") ? node.children : null);
      }
    }
  }
  const pages = hasOwn(deck, "pages") ? deck.pages : null;
  if (!Array.isArray(pages)) return;
  for (const page of pages) {
    if (!isPlainObject(page)) continue;
    if (hasOwn(page, "id")) used.add(page.id);
    walk(hasOwn(page, "elements") ? page.elements : null);
  }
}

function sameBounds(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === 4 &&
    b.length === 4 &&
    a[0] === b[0] &&
    a[1] === b[1] &&
    a[2] === b[2] &&
    a[3] === b[3]
  );
}

export function inspectAuthoringSelection(source, pageId, elementId) {
  let data;
  try {
    data = JSON.parse(source);
  } catch {
    return { kind: "invalid" };
  }
  if (!isPlainObject(data)) return { kind: "invalid" };
  const found = findAuthoringHit(data, pageId, elementId);
  if (found.kind !== "ok") return found;
  const el = found.el;
  const inGroup = found.parentId != null;
  let textMode = "none";
  let textValue = null;
  if (hasOwn(el, "paragraphs") && Array.isArray(el.paragraphs)) {
    textMode = "paragraphs";
  } else if (hasOwn(el, "text") && Array.isArray(el.text)) {
    textMode = "runs";
  } else if (hasOwn(el, "text") && typeof el.text === "string") {
    textMode = "plain";
    textValue = el.text;
  }
  const hasOwnFontSize = hasOwn(el, "fontSize");
  const hasBounds = hasOwn(el, "bounds") && Array.isArray(el.bounds) && el.bounds.length === 4;
  return {
    kind: "ok",
    pageId,
    elementId,
    type: hasOwn(el, "type") ? String(el.type) : "",
    parentId: found.parentId,
    inGroup,
    text: { mode: textMode, value: textValue },
    hasOwnFontSize,
    fontSize: hasOwnFontSize ? el.fontSize : undefined,
    geometry: inGroup ? "group-child" : hasBounds ? "absolute" : "none",
    bounds: !inGroup && hasBounds ? el.bounds.slice() : undefined,
    style: hasOwn(el, "style") ? el.style : undefined,
  };
}

export function inspectorPatchOperations(inspection, edits) {
  if (!inspection || inspection.kind !== "ok") {
    return { ok: false, reason: inspection?.kind || "missing" };
  }
  if (!isPlainObject(edits)) return { ok: false, reason: "invalid" };
  const changes = {};
  if (hasOwn(edits, "text")) {
    if (inspection.text.mode !== "plain") return { ok: false, reason: "structured-text" };
    if (edits.text !== inspection.text.value) changes.text = edits.text;
  }
  if (hasOwn(edits, "fontSize") && edits.fontSize !== inspection.fontSize) {
    changes.fontSize = edits.fontSize;
  }
  if (hasOwn(edits, "bounds")) {
    if (inspection.geometry !== "absolute") return { ok: false, reason: "group-geometry" };
    if (!sameBounds(edits.bounds, inspection.bounds)) changes.bounds = edits.bounds.slice();
  }
  const keys = Object.keys(changes);
  if (keys.length === 0) return { ok: false, reason: "noop" };
  return {
    ok: true,
    operations: [
      {
        op: "update",
        pageId: inspection.pageId,
        elementId: inspection.elementId,
        changes,
      },
    ],
  };
}

export function inspectorAddRootText(pageId, element) {
  return [{ op: "add", pageId, element }];
}

export function inspectorRemove(pageId, elementId) {
  return [{ op: "remove", pageId, elementId }];
}

export function nextRootTextId(deck, prefix = "text") {
  const used = new Set();
  collectIds(deck, used);
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}
