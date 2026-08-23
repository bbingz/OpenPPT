/**
 * Layout primitives: expand group elements (stack / row / grid) into
 * absolute-bounds leaf elements before schema validate / compile.
 *
 * Authoring form (not present in leaf schema after expansion):
 * {
 *   id, type: "group", bounds, layout: "stack"|"row"|"grid"|"layer",
 *   gap?, padding?, align?, justify?, columns?,
 *   children: [ leaf | nested group, with height|width|flex as needed ]
 * }
 *
 * layer: every child fills the group inner box (paint order = children order;
 * later children draw on top). Ideal for card = shape bg + nested stack content.
 */

import { OpenPptError, ErrorCodes } from "./errors.js";

const LAYOUTS = new Set(["stack", "row", "grid", "layer"]);
const ALIGNS = new Set(["start", "center", "end", "stretch"]);
const JUSTIFIES = new Set(["start", "center", "end", "space-between"]);

/**
 * @param {unknown} n
 * @param {string} label
 */
function assertFinite(n, label) {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      `${label} must be a finite number`,
      { value: n },
    );
  }
}

/**
 * Normalize padding to [top, right, bottom, left].
 * @param {unknown} padding
 * @returns {[number, number, number, number]}
 */
function normalizePadding(padding) {
  if (padding === undefined || padding === null) {
    return [0, 0, 0, 0];
  }
  if (typeof padding === "number") {
    assertFinite(padding, "padding");
    if (padding < 0) {
      throw new OpenPptError(ErrorCodes.LAYOUT, "padding must be >= 0", {
        padding,
      });
    }
    return [padding, padding, padding, padding];
  }
  if (Array.isArray(padding)) {
    if (padding.length === 2) {
      const [v, h] = padding;
      assertFinite(v, "padding[0]");
      assertFinite(h, "padding[1]");
      if (v < 0 || h < 0) {
        throw new OpenPptError(ErrorCodes.LAYOUT, "padding must be >= 0", {
          padding,
        });
      }
      return [v, h, v, h];
    }
    if (padding.length === 4) {
      for (let i = 0; i < 4; i += 1) {
        assertFinite(padding[i], `padding[${i}]`);
        if (padding[i] < 0) {
          throw new OpenPptError(ErrorCodes.LAYOUT, "padding must be >= 0", {
            padding,
          });
        }
      }
      return /** @type {[number, number, number, number]} */ (padding.slice());
    }
  }
  throw new OpenPptError(
    ErrorCodes.LAYOUT,
    "padding must be a number, [v,h], or [t,r,b,l]",
    { padding },
  );
}

/**
 * Deep-clone a plain object (IR nodes are JSON-like).
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Strip layout-only keys from a leaf child after assigning bounds.
 * @param {object} child
 * @param {number[]} bounds
 */
function toLeaf(child, bounds) {
  const leaf = clone(child);
  delete leaf.children;
  delete leaf.layout;
  delete leaf.gap;
  delete leaf.padding;
  delete leaf.justify;
  delete leaf.columns;
  delete leaf.flex;
  // height/width on children are layout hints only (unless already a group)
  delete leaf.height;
  delete leaf.width;
  leaf.bounds = bounds;
  return leaf;
}

/**
 * Enforce the deck-wide element-id contract before authoring-only group ids
 * disappear during flattening.
 * @param {object} deck
 */
function assertUniqueAuthoringIds(deck) {
  /** @type {Set<string>} */
  const ids = new Set();

  function visit(elements) {
    if (!Array.isArray(elements)) return;
    for (const element of elements) {
      if (!element || typeof element !== "object") continue;
      if (typeof element.id === "string") {
        if (ids.has(element.id)) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `Duplicate element id: ${element.id}`,
            { elementId: element.id },
          );
        }
        ids.add(element.id);
      }
      if (element.type === "group") visit(element.children);
    }
  }

  for (const page of deck.pages) visit(page?.elements);
}

/**
 * @param {object} group
 * @param {string} ctx
 * @returns {object[]} flat leaf elements
 */
function expandGroup(group, ctx) {
  if (!group.id || typeof group.id !== "string") {
    throw new OpenPptError(ErrorCodes.LAYOUT, `Group missing id at ${ctx}`, {
      ctx,
    });
  }
  if (!Array.isArray(group.bounds) || group.bounds.length !== 4) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      `Group ${group.id} requires bounds [x,y,w,h]`,
      { groupId: group.id },
    );
  }
  if (!group.bounds.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      `Group ${group.id} has non-finite bounds`,
      { groupId: group.id, bounds: group.bounds },
    );
  }
  const [gx, gy, gw, gh] = group.bounds;
  if (gw <= 0 || gh <= 0) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      `Group ${group.id} bounds must be positive`,
      { groupId: group.id, bounds: group.bounds },
    );
  }

  const layout = group.layout || "stack";
  if (!LAYOUTS.has(layout)) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      `Group ${group.id} unknown layout "${layout}" (use stack|row|grid)`,
      { groupId: group.id, layout },
    );
  }

  const gap = group.gap ?? 0;
  assertFinite(gap, `group ${group.id}.gap`);
  if (gap < 0) {
    throw new OpenPptError(ErrorCodes.LAYOUT, `Group ${group.id} gap must be >= 0`, {
      groupId: group.id,
      gap,
    });
  }

  const pad = normalizePadding(group.padding);
  const align = group.align || "stretch";
  const justify = group.justify || "start";
  if (!ALIGNS.has(align)) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      `Group ${group.id} invalid align "${align}"`,
      { groupId: group.id, align },
    );
  }
  if (!JUSTIFIES.has(justify)) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      `Group ${group.id} invalid justify "${justify}"`,
      { groupId: group.id, justify },
    );
  }

  if (!Array.isArray(group.children) || group.children.length === 0) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      `Group ${group.id} requires non-empty children`,
      { groupId: group.id },
    );
  }

  const innerX = gx + pad[3];
  const innerY = gy + pad[0];
  const innerW = gw - pad[1] - pad[3];
  const innerH = gh - pad[0] - pad[2];
  if (innerW <= 0 || innerH <= 0) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      `Group ${group.id} padding leaves no inner space`,
      { groupId: group.id, bounds: group.bounds, padding: pad },
    );
  }

  /** Validate child shell; return normalized child refs. */
  const rawChildren = group.children.map((child, i) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      throw new OpenPptError(
        ErrorCodes.LAYOUT,
        `Group ${group.id} children[${i}] must be an object`,
        { groupId: group.id, index: i },
      );
    }
    if (!child.id || typeof child.id !== "string") {
      throw new OpenPptError(
        ErrorCodes.LAYOUT,
        `Group ${group.id} children[${i}] missing id`,
        { groupId: group.id, index: i },
      );
    }
    if (!child.type || typeof child.type !== "string") {
      throw new OpenPptError(
        ErrorCodes.LAYOUT,
        `Group ${group.id} child ${child.id} missing type`,
        { groupId: group.id, childId: child.id },
      );
    }
    return child;
  });

  // layer: every child fills the group (later = on top)
  if (layout === "layer") {
    const bounds = [innerX, innerY, innerW, innerH];
    /** @type {object[]} */
    const layerLeaves = [];
    for (const child of rawChildren) {
      if (child.type === "group") {
        const nested = clone(child);
        nested.bounds = bounds;
        layerLeaves.push(...expandGroup(nested, `${ctx}/${group.id}`));
      } else {
        layerLeaves.push(toLeaf(child, bounds));
      }
    }
    return layerLeaves;
  }

  /** @type {Array<{ child: object, main: number, cross?: number, flex: number }>} */
  const items = [];
  for (const child of rawChildren) {
    const flex =
      child.flex !== undefined && child.flex !== null ? child.flex : 0;
    assertFinite(flex, `group ${group.id} child ${child.id}.flex`);
    if (flex < 0) {
      throw new OpenPptError(
        ErrorCodes.LAYOUT,
        `Group ${group.id} child ${child.id} flex must be >= 0`,
        { groupId: group.id, childId: child.id, flex },
      );
    }

    if (layout === "stack") {
      let main = child.height;
      if (main === undefined || main === null) {
        if (flex > 0) main = 0;
        else {
          throw new OpenPptError(
            ErrorCodes.LAYOUT,
            `Stack child ${child.id} needs height or flex (group ${group.id})`,
            { groupId: group.id, childId: child.id },
          );
        }
      } else {
        assertFinite(main, `child ${child.id}.height`);
        if (main <= 0) {
          throw new OpenPptError(
            ErrorCodes.LAYOUT,
            `Child ${child.id} height must be > 0`,
            { childId: child.id, height: main },
          );
        }
      }
      let cross = child.width;
      if (cross !== undefined && cross !== null) {
        assertFinite(cross, `child ${child.id}.width`);
        if (cross <= 0) {
          throw new OpenPptError(
            ErrorCodes.LAYOUT,
            `Child ${child.id} width must be > 0`,
            { childId: child.id, width: cross },
          );
        }
      }
      items.push({ child, main: main ?? 0, cross, flex });
    } else if (layout === "row") {
      let main = child.width;
      if (main === undefined || main === null) {
        if (flex > 0) main = 0;
        else {
          throw new OpenPptError(
            ErrorCodes.LAYOUT,
            `Row child ${child.id} needs width or flex (group ${group.id})`,
            { groupId: group.id, childId: child.id },
          );
        }
      } else {
        assertFinite(main, `child ${child.id}.width`);
        if (main <= 0) {
          throw new OpenPptError(
            ErrorCodes.LAYOUT,
            `Child ${child.id} width must be > 0`,
            { childId: child.id, width: main },
          );
        }
      }
      let cross = child.height;
      if (cross !== undefined && cross !== null) {
        assertFinite(cross, `child ${child.id}.height`);
        if (cross <= 0) {
          throw new OpenPptError(
            ErrorCodes.LAYOUT,
            `Child ${child.id} height must be > 0`,
            { childId: child.id, height: cross },
          );
        }
      }
      items.push({ child, main: main ?? 0, cross, flex });
    } else if (layout === "grid") {
      // equal cells — size hints ignored
      items.push({ child, main: 0, flex: 0 });
    } else {
      throw new OpenPptError(
        ErrorCodes.LAYOUT,
        `Group ${group.id} unhandled layout "${layout}"`,
        { groupId: group.id, layout },
      );
    }
  }

  /** @type {object[]} */
  const leaves = [];

  if (layout === "grid") {
    const columns = group.columns ?? 2;
    assertFinite(columns, `group ${group.id}.columns`);
    if (!Number.isInteger(columns) || columns < 1) {
      throw new OpenPptError(
        ErrorCodes.LAYOUT,
        `Group ${group.id} columns must be an integer >= 1`,
        { groupId: group.id, columns },
      );
    }
    const n = items.length;
    const rows = Math.ceil(n / columns);
    const gapX = gap;
    const gapY = gap;
    const cellW = (innerW - gapX * (columns - 1)) / columns;
    const cellH = (innerH - gapY * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) {
      throw new OpenPptError(
        ErrorCodes.LAYOUT,
        `Group ${group.id} grid cells have non-positive size`,
        { groupId: group.id, cellW, cellH, columns, rows },
      );
    }
    for (let i = 0; i < n; i += 1) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const x = innerX + col * (cellW + gapX);
      const y = innerY + row * (cellH + gapY);
      const bounds = [x, y, cellW, cellH];
      const { child } = items[i];
      if (child.type === "group") {
        const nested = clone(child);
        nested.bounds = bounds;
        leaves.push(...expandGroup(nested, `${ctx}/${group.id}`));
      } else {
        leaves.push(toLeaf(child, bounds));
      }
    }
    return leaves;
  }

  // stack or row
  const mainSize = layout === "stack" ? innerH : innerW;
  const crossSize = layout === "stack" ? innerW : innerH;
  const n = items.length;
  const gapTotal = gap * Math.max(0, n - 1);

  let fixedMain = 0;
  let flexSum = 0;
  for (const it of items) {
    if (it.flex > 0) flexSum += it.flex;
    else fixedMain += it.main;
  }

  const free = mainSize - fixedMain - gapTotal;
  if (free < -1e-6) {
    throw new OpenPptError(
      ErrorCodes.LAYOUT,
      `Group ${group.id} children overflow ${layout} axis ` +
        `(need ${fixedMain + gapTotal}px, have ${mainSize}px)`,
      {
        groupId: group.id,
        layout,
        need: fixedMain + gapTotal,
        have: mainSize,
      },
    );
  }

  /** @type {number[]} */
  const mains = items.map((it) => {
    if (it.flex > 0) {
      if (flexSum <= 0) return 0;
      return (free * it.flex) / flexSum;
    }
    return it.main;
  });

  // When no flex children, distribute leftover free space via justify
  let cursorExtra = 0;
  /** @type {number} */
  let betweenGap = gap;
  if (flexSum === 0 && free > 1e-9) {
    if (justify === "center") {
      cursorExtra = free / 2;
    } else if (justify === "end") {
      cursorExtra = free;
    } else if (justify === "space-between" && n > 1) {
      betweenGap = gap + free / (n - 1);
      cursorExtra = 0;
    }
    // start: cursorExtra = 0
  }

  let mainCursor = (layout === "stack" ? innerY : innerX) + cursorExtra;

  for (let i = 0; i < n; i += 1) {
    const it = items[i];
    const m = mains[i];
    if (m <= 0) {
      throw new OpenPptError(
        ErrorCodes.LAYOUT,
        `Group ${group.id} child ${it.child.id} resolved to non-positive size`,
        { groupId: group.id, childId: it.child.id, size: m },
      );
    }

    let c = it.cross;
    let crossOff = 0;
    if (c === undefined || c === null) {
      if (align === "stretch") {
        c = crossSize;
      } else {
        // default partial: stretch when no cross size
        c = crossSize;
      }
    } else if (c > crossSize + 1e-9) {
      throw new OpenPptError(
        ErrorCodes.LAYOUT,
        `Group ${group.id} child ${it.child.id} cross size ${c} exceeds ${crossSize}`,
        { groupId: group.id, childId: it.child.id, cross: c, crossSize },
      );
    } else if (align === "center") {
      crossOff = (crossSize - c) / 2;
    } else if (align === "end") {
      crossOff = crossSize - c;
    } else {
      // start or stretch with explicit cross
      crossOff = 0;
    }

    /** @type {number[]} */
    let bounds;
    if (layout === "stack") {
      bounds = [innerX + crossOff, mainCursor, c, m];
    } else {
      bounds = [mainCursor, innerY + crossOff, m, c];
    }

    if (it.child.type === "group") {
      const nested = clone(it.child);
      nested.bounds = bounds;
      leaves.push(...expandGroup(nested, `${ctx}/${group.id}`));
    } else {
      leaves.push(toLeaf(it.child, bounds));
    }

    mainCursor += m + (i < n - 1 ? betweenGap : 0);
  }

  return leaves;
}

/**
 * Expand all group elements on a page into absolute-bounds leaves.
 * Idempotent when no groups remain.
 * @param {object} page
 * @returns {object} page with only leaf elements
 */
export function expandPageLayouts(page) {
  if (!page || typeof page !== "object") return page;
  if (!Array.isArray(page.elements)) return page;

  /** @type {object[]} */
  const out = [];
  for (let i = 0; i < page.elements.length; i += 1) {
    const el = page.elements[i];
    if (el && el.type === "group") {
      out.push(...expandGroup(el, `page:${page.id || "?"}`));
    } else {
      out.push(el);
    }
  }
  return { ...page, elements: out };
}

/**
 * Expand layout groups across the whole deck (after multi-file page load).
 * @param {object} deck
 * @returns {object} new deck with groups flattened
 */
export function expandLayouts(deck) {
  if (!deck || typeof deck !== "object" || !Array.isArray(deck.pages)) {
    return deck;
  }
  assertUniqueAuthoringIds(deck);
  const pages = deck.pages.map((page, index) => {
    if (typeof page === "string") {
      // multi-file paths should already be expanded by loadDeck
      throw new OpenPptError(
        ErrorCodes.LAYOUT,
        `pages[${index}] is still a path string; call expandExternalPages first`,
        { index, path: page },
      );
    }
    return expandPageLayouts(page);
  });
  return { ...deck, pages };
}

/**
 * True if any page still contains a group element.
 * @param {object} deck
 */
export function deckHasGroups(deck) {
  if (!deck?.pages) return false;
  for (const page of deck.pages) {
    if (!page?.elements) continue;
    for (const el of page.elements) {
      if (el?.type === "group") return true;
    }
  }
  return false;
}
