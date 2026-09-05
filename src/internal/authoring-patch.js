/**
 * Detached authoring-tree mutations for Studio PATCH.
 * Operates on raw JSON (groups and $style refs stay authored). Lookups use
 * own properties only; prototype-sensitive keys are rejected. Callers validate
 * and persist the returned tree — this helper never writes files.
 */

export const PATCH_OPERATION_LIMIT = 64;

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BODY_KEYS = new Set(["operations"]);
const ADD_KEYS = new Set(["op", "pageId", "parentId", "index", "element"]);
const UPDATE_KEYS = new Set(["op", "pageId", "elementId", "changes", "unset"]);
const REMOVE_KEYS = new Set(["op", "pageId", "elementId"]);

export class AuthoringPatchError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "AuthoringPatchError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function serializeAuthoringDeck(deck) {
  return `${JSON.stringify(deck, null, 2)}\n`;
}

export function deckHasExternalPageRefs(deck) {
  if (!deck || typeof deck !== "object" || !Array.isArray(deck.pages)) return false;
  return deck.pages.some((page) => typeof page === "string");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Boolean(obj) && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function own(obj, key) {
  return hasOwn(obj, key) ? obj[key] : undefined;
}

function ownStringKeys(obj) {
  return Reflect.ownKeys(obj).filter((key) => typeof key === "string");
}

function fail(status, code, message, details) {
  throw new AuthoringPatchError(status, code, message, details);
}

function assertNoPrototypeKeys(value, path, opIndex) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoPrototypeKeys(value[i], `${path}[${i}]`, opIndex);
    }
    return;
  }
  for (const key of ownStringKeys(value)) {
    if (PROTOTYPE_KEYS.has(key)) {
      fail(400, "PATCH_INVALID", `Prototype-sensitive key "${key}" is not allowed at ${path}`, {
        opIndex,
        path,
        key,
      });
    }
    assertNoPrototypeKeys(value[key], `${path}.${key}`, opIndex);
  }
}

function assertAllowedKeys(obj, allowed, label, opIndex) {
  for (const key of ownStringKeys(obj)) {
    if (!allowed.has(key)) {
      fail(400, "PATCH_INVALID", `Unknown field "${key}" on ${label}`, {
        opIndex,
        key,
        label,
      });
    }
  }
}

function requireNonemptyString(value, label, opIndex, extra = {}) {
  if (typeof value !== "string" || value.length === 0) {
    fail(400, "PATCH_INVALID", `${label} must be a nonempty string`, {
      opIndex,
      label,
      ...extra,
    });
  }
  return value;
}

function requireNonnegativeInteger(value, label, opIndex) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    fail(400, "PATCH_INVALID", `${label} must be a nonnegative integer`, {
      opIndex,
      label,
      value,
    });
  }
  return value;
}

export function parsePatchBody(body) {
  if (!isPlainObject(body)) {
    fail(400, "PATCH_INVALID", "PATCH body must be a JSON object");
  }
  assertNoPrototypeKeys(body, "body");
  assertAllowedKeys(body, BODY_KEYS, "PATCH body");
  const operations = own(body, "operations");
  if (!Array.isArray(operations)) {
    fail(400, "PATCH_INVALID", "operations must be an array");
  }
  if (operations.length < 1 || operations.length > PATCH_OPERATION_LIMIT) {
    fail(
      400,
      "PATCH_INVALID",
      `operations must contain 1..${PATCH_OPERATION_LIMIT} entries`,
      { count: operations.length },
    );
  }
  return operations;
}

function findUniquePage(deck, pageId, opIndex) {
  const pages = own(deck, "pages");
  if (!Array.isArray(pages)) {
    fail(422, "PATCH_TARGET", "deck.pages must be an array", { opIndex, pageId });
  }
  const matches = [];
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (!isPlainObject(page)) continue;
    if (own(page, "id") === pageId) matches.push(page);
  }
  if (matches.length === 0) {
    fail(422, "PATCH_TARGET", `No page with id ${pageId}`, { opIndex, pageId });
  }
  if (matches.length > 1) {
    fail(409, "PATCH_TARGET", `Page id ${pageId} is not unique`, {
      opIndex,
      pageId,
      count: matches.length,
    });
  }
  return matches[0];
}

function visitOwnElements(page, visitor) {
  function walk(list) {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i += 1) {
      const el = list[i];
      if (!isPlainObject(el)) continue;
      visitor(el, list, i);
      if (own(el, "type") === "group") {
        walk(own(el, "children"));
      }
    }
  }
  walk(own(page, "elements"));
}

function findUniqueElement(page, elementId, opIndex, pageId) {
  const matches = [];
  visitOwnElements(page, (el, list, index) => {
    if (own(el, "id") === elementId) matches.push({ el, list, index });
  });
  if (matches.length === 0) {
    fail(422, "PATCH_TARGET", `No element with id ${elementId} on page ${pageId}`, {
      opIndex,
      pageId,
      elementId,
    });
  }
  if (matches.length > 1) {
    fail(409, "PATCH_TARGET", `Element id ${elementId} is not unique on page ${pageId}`, {
      opIndex,
      pageId,
      elementId,
      count: matches.length,
    });
  }
  return matches[0];
}

function collectionForAdd(page, parentId, opIndex, pageId) {
  if (parentId === undefined) {
    const elements = own(page, "elements");
    if (!Array.isArray(elements)) {
      fail(422, "PATCH_TARGET", `Page ${pageId} has no elements array`, { opIndex, pageId });
    }
    return elements;
  }
  const found = findUniqueElement(page, parentId, opIndex, pageId);
  if (own(found.el, "type") !== "group") {
    fail(422, "PATCH_TARGET", `parentId ${parentId} is not a group on page ${pageId}`, {
      opIndex,
      pageId,
      parentId,
    });
  }
  const children = own(found.el, "children");
  if (!Array.isArray(children)) {
    fail(422, "PATCH_TARGET", `Group ${parentId} has no children array`, {
      opIndex,
      pageId,
      parentId,
    });
  }
  return children;
}

function applyAdd(deck, op, opIndex) {
  assertAllowedKeys(op, ADD_KEYS, "add operation", opIndex);
  const pageId = requireNonemptyString(own(op, "pageId"), "pageId", opIndex);
  const element = own(op, "element");
  if (!isPlainObject(element)) {
    fail(400, "PATCH_INVALID", "add.element must be an object", { opIndex, pageId });
  }
  assertNoPrototypeKeys(element, `operations[${opIndex}].element`, opIndex);
  const parentId = own(op, "parentId");
  if (parentId !== undefined) {
    requireNonemptyString(parentId, "parentId", opIndex, { pageId });
  }
  const index = own(op, "index");
  if (index !== undefined) requireNonnegativeInteger(index, "index", opIndex);

  const page = findUniquePage(deck, pageId, opIndex);
  const collection = collectionForAdd(page, parentId, opIndex, pageId);
  const inserted = cloneJson(element);
  if (index === undefined) {
    collection.push(inserted);
    return;
  }
  if (index > collection.length) {
    fail(400, "PATCH_INVALID", `index ${index} exceeds collection length ${collection.length}`, {
      opIndex,
      pageId,
      parentId,
      index,
      length: collection.length,
    });
  }
  collection.splice(index, 0, inserted);
}

function applyUpdate(deck, op, opIndex) {
  assertAllowedKeys(op, UPDATE_KEYS, "update operation", opIndex);
  const pageId = requireNonemptyString(own(op, "pageId"), "pageId", opIndex);
  const elementId = requireNonemptyString(own(op, "elementId"), "elementId", opIndex);
  const changes = own(op, "changes");
  if (!isPlainObject(changes)) {
    fail(400, "PATCH_INVALID", "update.changes must be an object", {
      opIndex,
      pageId,
      elementId,
    });
  }
  assertNoPrototypeKeys(changes, `operations[${opIndex}].changes`, opIndex);
  const unset = own(op, "unset");
  if (unset !== undefined) {
    if (!Array.isArray(unset) || unset.some((key) => typeof key !== "string" || key.length === 0)) {
      fail(400, "PATCH_INVALID", "unset must be an array of nonempty strings", { opIndex });
    }
    if (new Set(unset).size !== unset.length) {
      fail(400, "PATCH_INVALID", "unset keys must be unique", { opIndex, unset });
    }
    for (const key of unset) {
      if (PROTOTYPE_KEYS.has(key)) {
        fail(400, "PATCH_INVALID", `Prototype-sensitive key "${key}" cannot be unset`, {
          opIndex,
          key,
        });
      }
      if (key === "id" || key === "type") {
        fail(400, "PATCH_INVALID", `${key} cannot be unset`, { opIndex, key });
      }
      if (hasOwn(changes, key)) {
        fail(400, "PATCH_INVALID", `Key "${key}" is both changed and unset`, { opIndex, key });
      }
    }
  }
  for (const key of ownStringKeys(changes)) {
    if (key === "id" || key === "type") {
      fail(400, "PATCH_INVALID", `${key} cannot change`, { opIndex, key, pageId, elementId });
    }
  }

  const page = findUniquePage(deck, pageId, opIndex);
  const found = findUniqueElement(page, elementId, opIndex, pageId);
  for (const key of ownStringKeys(changes)) {
    found.el[key] = cloneJson(changes[key]);
  }
  if (Array.isArray(unset)) {
    for (const key of unset) {
      if (hasOwn(found.el, key)) delete found.el[key];
    }
  }
}

function applyRemove(deck, op, opIndex) {
  assertAllowedKeys(op, REMOVE_KEYS, "remove operation", opIndex);
  const pageId = requireNonemptyString(own(op, "pageId"), "pageId", opIndex);
  const elementId = requireNonemptyString(own(op, "elementId"), "elementId", opIndex);
  const page = findUniquePage(deck, pageId, opIndex);
  const found = findUniqueElement(page, elementId, opIndex, pageId);
  found.list.splice(found.index, 1);
}

function applyOne(deck, op, opIndex) {
  if (!isPlainObject(op)) {
    fail(400, "PATCH_INVALID", `operations[${opIndex}] must be an object`, { opIndex });
  }
  assertNoPrototypeKeys(op, `operations[${opIndex}]`, opIndex);
  const kind = own(op, "op");
  if (kind === "add") {
    applyAdd(deck, op, opIndex);
    return;
  }
  if (kind === "update") {
    applyUpdate(deck, op, opIndex);
    return;
  }
  if (kind === "remove") {
    applyRemove(deck, op, opIndex);
    return;
  }
  fail(400, "PATCH_INVALID", `Unknown op "${String(kind)}"`, { opIndex, op: kind });
}

export function applyAuthoringPatch(deck, operations) {
  if (!isPlainObject(deck)) {
    fail(422, "PATCH_INVALID", "Authoring deck must be a JSON object");
  }
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > PATCH_OPERATION_LIMIT) {
    fail(
      400,
      "PATCH_INVALID",
      `operations must contain 1..${PATCH_OPERATION_LIMIT} entries`,
      { count: Array.isArray(operations) ? operations.length : null },
    );
  }
  const next = cloneJson(deck);
  for (let i = 0; i < operations.length; i += 1) {
    applyOne(next, operations[i], i);
  }
  return next;
}
