import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AuthoringPatchError,
  applyAuthoringPatch,
  cloneJson,
  deckHasExternalPageRefs,
  parsePatchBody,
} from "../src/internal/authoring-patch.js";

function deck() {
  return {
    version: "openppt-1",
    size: [960, 540],
    pages: [
      {
        id: "p",
        elements: [
          {
            id: "stack",
            type: "group",
            layout: "stack",
            bounds: [40, 40, 800, 400],
            children: [{ id: "t", type: "text", height: 40, text: "hi" }],
          },
        ],
      },
    ],
  };
}

describe("authoring patch helper", () => {
  it("does not mutate the input tree and ignores inherited ids", () => {
    const source = deck();
    const snapshot = cloneJson(source);
    const next = applyAuthoringPatch(source, [
      { op: "update", pageId: "p", elementId: "t", changes: { text: "bye", bold: false } },
    ]);
    assert.deepEqual(source, snapshot);
    assert.equal(next.pages[0].elements[0].children[0].text, "bye");
    assert.equal(next.pages[0].elements[0].children[0].bold, false);

    const inherited = deck();
    Object.setPrototypeOf(inherited.pages[0], { id: "p" });
    inherited.pages[0].id = undefined;
    delete inherited.pages[0].id;
    assert.throws(
      () =>
        applyAuthoringPatch(inherited, [
          { op: "update", pageId: "p", elementId: "t", changes: { text: "x" } },
        ]),
      (err) => err instanceof AuthoringPatchError && err.code === "PATCH_TARGET",
    );
  });

  it("treats index equal to length as append and rejects body extras", () => {
    const next = applyAuthoringPatch(deck(), [
      {
        op: "add",
        pageId: "p",
        index: 1,
        element: { id: "n", type: "text", bounds: [40, 40, 80, 40], text: "n" },
      },
    ]);
    assert.deepEqual(
      next.pages[0].elements.map((el) => el.id),
      ["stack", "n"],
    );
    assert.equal(deckHasExternalPageRefs({ pages: ["pages/a.json"] }), true);
    assert.throws(
      () => parsePatchBody({ operations: [{ op: "remove", pageId: "p", elementId: "t" }], extra: 1 }),
      (err) => err instanceof AuthoringPatchError && err.code === "PATCH_INVALID",
    );
  });
});
