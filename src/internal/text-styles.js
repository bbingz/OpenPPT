/**
 * Authoring text-style lookup and one-pass resolution.
 * Used only from validateDeck; not a public PreparedDeck API.
 */

import { ErrorCodes, OpenPptError } from "../errors.js";

export const TEXT_STYLE_KEYS = Object.freeze([
  "fontSize",
  "fontFamily",
  "color",
  "bold",
  "italic",
  "align",
  "valign",
  "lineHeight",
  "spaceBefore",
  "spaceAfter",
  "charSpacing",
]);

const STYLE_REF_RE = /^\$([A-Za-z][A-Za-z0-9_-]*)$/;

export function parseStyleRef(value) {
  if (typeof value !== "string") return null;
  const match = value.match(STYLE_REF_RE);
  return match ? match[1] : null;
}

export function lookupTextStyle(textStyles, name) {
  if (!textStyles || typeof textStyles !== "object" || Array.isArray(textStyles)) {
    return undefined;
  }
  if (!Object.hasOwn(textStyles, name)) return undefined;
  return textStyles[name];
}

/**
 * Copy supported style fields onto a text element when the element does not
 * already own them. Explicit false/0/empty values on the element win.
 * @param {object} element
 * @param {object} style
 */
export function applyTextStyleToElement(element, style) {
  if (!style || typeof style !== "object" || Array.isArray(style)) return;
  for (const key of TEXT_STYLE_KEYS) {
    if (Object.hasOwn(style, key) && !Object.hasOwn(element, key)) {
      element[key] = style[key];
    }
  }
}

/**
 * Resolve style: "$name" on text leaves in place. Caller must pass a detached
 * clone. Keeps the raw style reference on the element.
 * @param {object} deck
 */
export function resolveDeckTextStyles(deck) {
  if (!deck || typeof deck !== "object" || !Array.isArray(deck.pages)) return deck;
  const textStyles = deck.theme?.textStyles;
  const latin =
    deck.theme?.fonts && Object.hasOwn(deck.theme.fonts, "latin")
      ? deck.theme.fonts.latin
      : undefined;
  for (let pageIndex = 0; pageIndex < deck.pages.length; pageIndex += 1) {
    const page = deck.pages[pageIndex];
    if (!page || typeof page !== "object" || !Array.isArray(page.elements)) continue;
    for (let elementIndex = 0; elementIndex < page.elements.length; elementIndex += 1) {
      const element = page.elements[elementIndex];
      if (!element || element.type !== "text") continue;
      if (Object.hasOwn(element, "style")) {
        const context = `pages[${pageIndex}].elements[${elementIndex}] (id=${element.id})`;
        const name = parseStyleRef(element.style);
        if (!name) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `Invalid text style reference ${JSON.stringify(element.style)} at ${context}`,
            { style: element.style, pageId: page.id, elementId: element.id },
          );
        }
        const style = lookupTextStyle(textStyles, name);
        if (style === undefined) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `Unknown text style $${name} at ${context}`,
            { style: element.style, pageId: page.id, elementId: element.id },
          );
        }
        if (!style || typeof style !== "object" || Array.isArray(style)) {
          throw new OpenPptError(
            ErrorCodes.SCHEMA,
            `Invalid text style $${name} at ${context}`,
            { style: element.style, pageId: page.id, elementId: element.id },
          );
        }
        applyTextStyleToElement(element, style);
      }
      if (latin !== undefined && !Object.hasOwn(element, "fontFamily")) {
        element.fontFamily = latin;
      }
    }
  }
  return deck;
}
