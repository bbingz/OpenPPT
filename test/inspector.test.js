import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applyAuthoringPatch } from "../src/internal/authoring-patch.js";
import {
  inspectAuthoringSelection,
  inspectorPatchOperations,
  inspectorAddRootText,
  inspectorRemove,
  nextRootTextId,
} from "../src/internal/authoring-source.js";

function styledGroupDeck() {
  return {
    version: "openppt-1",
    size: [960, 540],
    theme: { textStyles: { body: { fontSize: 20, fontFamily: "Arial" } } },
    pages: [
      {
        id: "p",
        elements: [
          {
            id: "card",
            type: "shape",
            shape: "rect",
            bounds: [40, 40, 800, 300],
            fill: "#FFFFFF",
          },
          {
            id: "title",
            type: "text",
            bounds: [60, 60, 760, 80],
            text: "Plain title",
            fontSize: 24,
          },
          {
            id: "stack",
            type: "group",
            layout: "stack",
            bounds: [60, 160, 760, 160],
            children: [
              {
                id: "child",
                type: "text",
                height: 80,
                style: "$body",
                text: "Inherited child",
              },
            ],
          },
          {
            id: "rich",
            type: "text",
            bounds: [60, 340, 760, 80],
            paragraphs: [{ text: [{ text: "Rich", bold: true }] }],
          },
        ],
      },
    ],
  };
}

function sourceOf(deck) {
  return `${JSON.stringify(deck, null, 2)}\n`;
}

describe("inspector authoring helper", () => {
  test("text-only patch keeps named style and does not mint fontSize/bounds", () => {
    const deck = styledGroupDeck();
    const source = sourceOf(deck);
    const inspection = inspectAuthoringSelection(source, "p", "child");
    expect(inspection.kind).toBe("ok");
    expect(inspection.text.mode).toBe("plain");
    expect(inspection.geometry).toBe("group-child");
    expect(inspection.style).toBe("$body");
    expect(inspection.hasOwnFontSize).toBe(false);

    const built = inspectorPatchOperations(inspection, { text: "Updated child" });
    expect(built.ok).toBe(true);
    expect(built.operations).toEqual([
      { op: "update", pageId: "p", elementId: "child", changes: { text: "Updated child" } },
    ]);
    expect(Object.keys(built.operations[0].changes)).toEqual(["text"]);

    const next = applyAuthoringPatch(deck, built.operations);
    const child = next.pages[0].elements[2].children[0];
    expect(child.text).toBe("Updated child");
    expect(child.style).toBe("$body");
    expect(child.fontSize).toBeUndefined();
    expect(child.bounds).toBeUndefined();
    expect(child.height).toBe(80);
  });

  test("group-child geometry is unsupported and does not emit bounds", () => {
    const inspection = inspectAuthoringSelection(sourceOf(styledGroupDeck()), "p", "child");
    const built = inspectorPatchOperations(inspection, { bounds: [10, 20, 30, 40] });
    expect(built.ok).toBe(false);
    expect(built.reason).toBe("group-geometry");
  });

  test("structured text is not flattened to a plain string", () => {
    const inspection = inspectAuthoringSelection(sourceOf(styledGroupDeck()), "p", "rich");
    expect(inspection.text.mode).toBe("paragraphs");
    const built = inspectorPatchOperations(inspection, { text: "flattened" });
    expect(built.ok).toBe(false);
    expect(built.reason).toBe("structured-text");
  });

  test("root absolute bounds and fontSize only send changed own fields", () => {
    const inspection = inspectAuthoringSelection(sourceOf(styledGroupDeck()), "p", "title");
    expect(inspection.geometry).toBe("absolute");
    expect(inspection.text.mode).toBe("plain");
    const built = inspectorPatchOperations(inspection, {
      text: "Plain title",
      fontSize: 28,
      bounds: [60, 60, 760, 80],
    });
    expect(built.ok).toBe(true);
    expect(built.operations[0].changes).toEqual({ fontSize: 28 });
  });

  test("add root text and remove selected leaf", () => {
    const deck = styledGroupDeck();
    const id = nextRootTextId(deck);
    expect(id).toMatch(/^text-/);
    const add = inspectorAddRootText("p", {
      id,
      type: "text",
      bounds: [40, 40, 800, 80],
      text: "New text",
      fontSize: 18,
    });
    const added = applyAuthoringPatch(deck, add);
    expect(added.pages[0].elements.at(-1).id).toBe(id);
    expect(added.pages[0].elements.at(-1).type).toBe("text");

    const remove = inspectorRemove("p", "card");
    const removed = applyAuthoringPatch(added, remove);
    expect(removed.pages[0].elements.some((el) => el.id === "card")).toBe(false);
    expect(removed.pages[0].elements.some((el) => el.id === id)).toBe(true);
  });

  test("external and invalid source do not invent a patch", () => {
    const external = inspectAuthoringSelection(
      sourceOf({ version: "openppt-1", size: [960, 540], pages: ["pages/cover.json"] }),
      "cover",
      "t",
    );
    expect(external.kind).toBe("external");
    const invalid = inspectAuthoringSelection("{", "p", "t");
    expect(invalid.kind).toBe("invalid");
  });
});

describe("inspector mutation exclusivity", () => {
  test("saveGate is initialized before inspector refresh and PATCH is blocked during PUT", () => {
    const src = readFileSync(join(import.meta.dir, "../web/app.js"), "utf8");
    const saveDecl = src.indexOf("let saveGate = null");
    const patchDecl = src.indexOf("let patchGate = null");
    const firstRefreshCall = src.indexOf("refreshInspectorEnabled()");
    expect(saveDecl).toBeGreaterThan(-1);
    expect(patchDecl).toBeGreaterThan(-1);
    expect(firstRefreshCall).toBeGreaterThan(-1);
    expect(saveDecl).toBeLessThan(firstRefreshCall);
    expect(patchDecl).toBeLessThan(firstRefreshCall);

    const allowedFn = src.slice(
      src.indexOf("function patchActionsAllowed"),
      src.indexOf("function refreshInspectorEnabled"),
    );
    expect(allowedFn).toMatch(/if \(patchGate\) return false/);
    expect(allowedFn).toMatch(/if \(saveGate\) return false/);

    const doSaveFn = src.slice(src.indexOf("async function doSave("), src.indexOf("async function doSaveInner"));
    expect(doSaveFn).toMatch(/saveGate = doSaveInner\(\)\.finally/);
    expect(doSaveFn).toMatch(/refreshInspectorEnabled\(\)/);
  });
});

describe("inspector workbench layout", () => {
  test("workbench CSS keeps inspector actions inside the viewport box", () => {
    const css = readFileSync(join(import.meta.dir, "../web/styles.css"), "utf8");
    expect(css).toMatch(/\.app\s*\{[^}]*height:\s*100%/);
    expect(css).toMatch(/\.app\s*\{[^}]*overflow:\s*auto/);
    expect(css).toMatch(/\.bench\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.editor\s*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/\.home\s*\{/);
    expect(css).not.toMatch(/\.home\s*\{[^}]*overflow:\s*hidden/);
  });
});
