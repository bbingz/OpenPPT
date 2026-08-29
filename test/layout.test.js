import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadDeck } from "../src/load.js";
import { expandLayouts, expandPageLayouts, deckHasGroups } from "../src/layout.js";
import { validateDeck } from "../src/validate.js";
import { compileToPptx } from "../src/compile.js";
import { analyzeLayout, issuesFailThreshold } from "../src/qa.js";
import { OpenPptError, ErrorCodes } from "../src/errors.js";
import { openPptx } from "./helpers/pptx.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bunBin = process.env.BUN_BIN || "bun";
const cli = join(root, "bin/openppt.js");

describe("layout primitives (stack/row/grid)", () => {
  it("detaches leaf-only pages from caller-owned objects", () => {
    const page = {
      id: "p",
      background: { color: "#ffffff" },
      elements: [
        {
          id: "text",
          type: "text",
          bounds: [0, 0, 100, 40],
          text: [{ text: "caller owned", bold: true }],
        },
      ],
    };
    const before = structuredClone(page);

    const expanded = expandPageLayouts(page);
    assert.notEqual(expanded, page);
    assert.notEqual(expanded.background, page.background);
    assert.notEqual(expanded.elements[0], page.elements[0]);
    assert.notEqual(expanded.elements[0].text, page.elements[0].text);

    expanded.background.color = "#000000";
    expanded.elements[0].text[0].text = "implementation write";
    assert.deepEqual(page, before);
  });

  it("expands stack with fixed + flex children", () => {
    const deck = {
      version: "openppt-1",
      size: [200, 200],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "g",
              type: "group",
              layout: "stack",
              bounds: [0, 0, 200, 200],
              gap: 10,
              children: [
                { id: "a", type: "text", height: 40, text: "A" },
                { id: "b", type: "text", flex: 1, text: "B" },
                { id: "c", type: "text", height: 30, text: "C" },
              ],
            },
          ],
        },
      ],
    };
    const out = expandLayouts(deck);
    const els = out.pages[0].elements;
    assert.equal(els.length, 3);
    // gap 10 * 2 = 20; fixed 40+30=70; free = 200-70-20 = 110 → flex child
    assert.deepEqual(els[0].bounds, [0, 0, 200, 40]);
    assert.deepEqual(els[1].bounds, [0, 50, 200, 110]);
    assert.deepEqual(els[2].bounds, [0, 170, 200, 30]);
    assert.equal(els[0].type, "text");
    assert.equal(els[0].text, "A");
    // layout hints stripped
    assert.equal(els[1].flex, undefined);
    assert.equal(els[1].height, undefined);
  });

  it("rejects flex weights that resolve to non-finite sizes", () => {
    assert.throws(
      () =>
        expandLayouts({
          version: "openppt-1",
          size: [200, 200],
          pages: [
            {
              id: "p",
              elements: [
                {
                  id: "g",
                  type: "group",
                  layout: "row",
                  bounds: [0, 0, 200, 40],
                  children: [
                    { id: "a", type: "text", flex: 1e308, text: "A" },
                    { id: "b", type: "text", flex: 1e308, text: "B" },
                  ],
                },
              ],
            },
          ],
        }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.LAYOUT);
        return true;
      },
    );
  });

  it("copies layer leaf bounds so siblings are not aliased", () => {
    const out = expandLayouts({
      version: "openppt-1",
      size: [200, 100],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "card",
              type: "group",
              layout: "layer",
              bounds: [10, 20, 100, 50],
              children: [
                { id: "bg", type: "shape", shape: "rect", fill: "#ffffff" },
                { id: "fg", type: "text", text: "Hi" },
              ],
            },
          ],
        },
      ],
    });
    const [bg, fg] = out.pages[0].elements;
    assert.deepEqual(bg.bounds, [10, 20, 100, 50]);
    assert.deepEqual(fg.bounds, [10, 20, 100, 50]);
    assert.notEqual(bg.bounds, fg.bounds);
    bg.bounds[0] = 999;
    assert.equal(fg.bounds[0], 10);
  });

  it("deckHasGroups is true only while authoring groups remain", () => {
    const authored = {
      version: "openppt-1",
      size: [100, 100],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "g",
              type: "group",
              layout: "stack",
              bounds: [0, 0, 100, 100],
              children: [{ id: "t", type: "text", height: 40, text: "x" }],
            },
          ],
        },
      ],
    };
    assert.equal(deckHasGroups(authored), true);
    assert.equal(deckHasGroups(expandLayouts(authored)), false);
    assert.equal(deckHasGroups({ pages: [] }), false);
  });

  it("expands row and nested stack", () => {
    const deck = {
      version: "openppt-1",
      size: [400, 100],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "row",
              type: "group",
              layout: "row",
              bounds: [0, 0, 400, 100],
              gap: 20,
              children: [
                {
                  id: "left",
                  type: "group",
                  layout: "stack",
                  width: 100,
                  gap: 0,
                  children: [
                    { id: "t1", type: "text", height: 50, text: "1" },
                    { id: "t2", type: "text", flex: 1, text: "2" },
                  ],
                },
                { id: "right", type: "shape", flex: 1, shape: "rect", fill: "#000000" },
              ],
            },
          ],
        },
      ],
    };
    const out = expandLayouts(deck);
    const els = out.pages[0].elements;
    assert.equal(els.length, 3);
    // left column width 100; right flex takes 400-100-20=280
    assert.deepEqual(els[0].bounds, [0, 0, 100, 50]);
    assert.deepEqual(els[1].bounds, [0, 50, 100, 50]);
    assert.deepEqual(els[2].bounds, [120, 0, 280, 100]);
  });

  it("expands layer so all children share the same bounds", () => {
    const deck = {
      version: "openppt-1",
      size: [200, 100],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "card",
              type: "group",
              layout: "layer",
              bounds: [10, 10, 180, 80],
              padding: 0,
              children: [
                {
                  id: "bg",
                  type: "shape",
                  shape: "roundRect",
                  fill: "#ffffff",
                },
                {
                  id: "inner",
                  type: "group",
                  layout: "stack",
                  padding: 10,
                  gap: 0,
                  children: [
                    { id: "t", type: "text", height: 20, text: "Hi" },
                    { id: "b", type: "text", flex: 1, text: "Body" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = expandLayouts(deck);
    const els = out.pages[0].elements;
    assert.equal(els.length, 3);
    assert.deepEqual(els[0].bounds, [10, 10, 180, 80]); // bg fills card
    assert.deepEqual(els[1].bounds, [20, 20, 160, 20]); // title after padding
    assert.deepEqual(els[2].bounds, [20, 40, 160, 40]); // flex body
  });

  it("places stack children using justify center, end, and space-between", () => {
    const deck = (justify) => ({
      version: "openppt-1",
      size: [200, 200],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "g",
              type: "group",
              layout: "stack",
              bounds: [0, 0, 200, 200],
              justify,
              children: [
                { id: "a", type: "text", height: 40, text: "A" },
                { id: "b", type: "text", height: 40, text: "B" },
              ],
            },
          ],
        },
      ],
    });
    const center = expandLayouts(deck("center")).pages[0].elements;
    assert.deepEqual(center[0].bounds, [0, 60, 200, 40]);
    assert.deepEqual(center[1].bounds, [0, 100, 200, 40]);
    const end = expandLayouts(deck("end")).pages[0].elements;
    assert.deepEqual(end[0].bounds, [0, 120, 200, 40]);
    assert.deepEqual(end[1].bounds, [0, 160, 200, 40]);
    const between = expandLayouts(deck("space-between")).pages[0].elements;
    assert.deepEqual(between[0].bounds, [0, 0, 200, 40]);
    assert.deepEqual(between[1].bounds, [0, 160, 200, 40]);
  });

  it("places row children using align center and end", () => {
    const deck = (align) => ({
      version: "openppt-1",
      size: [400, 100],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "g",
              type: "group",
              layout: "row",
              bounds: [0, 0, 400, 100],
              gap: 0,
              align,
              children: [
                { id: "a", type: "text", width: 100, height: 40, text: "A" },
                { id: "b", type: "text", width: 100, height: 40, text: "B" },
              ],
            },
          ],
        },
      ],
    });
    const center = expandLayouts(deck("center")).pages[0].elements;
    assert.deepEqual(center[0].bounds, [0, 30, 100, 40]);
    assert.deepEqual(center[1].bounds, [100, 30, 100, 40]);
    const end = expandLayouts(deck("end")).pages[0].elements;
    assert.deepEqual(end[0].bounds, [0, 60, 100, 40]);
    assert.deepEqual(end[1].bounds, [100, 60, 100, 40]);
  });

  it("expands grid into equal cells", () => {
    const deck = {
      version: "openppt-1",
      size: [220, 220],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "grid",
              type: "group",
              layout: "grid",
              columns: 2,
              gap: 20,
              bounds: [0, 0, 220, 220],
              children: [
                { id: "c1", type: "text", text: "1" },
                { id: "c2", type: "text", text: "2" },
                { id: "c3", type: "text", text: "3" },
                { id: "c4", type: "text", text: "4" },
              ],
            },
          ],
        },
      ],
    };
    const out = expandLayouts(deck);
    const els = out.pages[0].elements;
    assert.equal(els.length, 4);
    // cell = (220-20)/2 = 100
    assert.deepEqual(els[0].bounds, [0, 0, 100, 100]);
    assert.deepEqual(els[1].bounds, [120, 0, 100, 100]);
    assert.deepEqual(els[2].bounds, [0, 120, 100, 100]);
    assert.deepEqual(els[3].bounds, [120, 120, 100, 100]);
  });

  it("fails closed when fixed children overflow", () => {
    assert.throws(
      () =>
        expandLayouts({
          version: "openppt-1",
          size: [100, 100],
          pages: [
            {
              id: "p",
              elements: [
                {
                  id: "g",
                  type: "group",
                  layout: "stack",
                  bounds: [0, 0, 100, 50],
                  gap: 0,
                  children: [
                    { id: "a", type: "text", height: 40, text: "A" },
                    { id: "b", type: "text", height: 40, text: "B" },
                  ],
                },
              ],
            },
          ],
        }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.LAYOUT);
        return true;
      },
    );
  });

  it("layout-demo fixture loads, validates, and exports", async () => {
    const { deck, projectRoot, sourcePath } = loadDeck(
      join(root, "fixtures/layout-demo/deck.json"),
    );
    // groups expanded at load
    for (const page of deck.pages) {
      for (const el of page.elements) {
        assert.notEqual(el.type, "group");
        assert.ok(Array.isArray(el.bounds));
      }
    }
    validateDeck(deck, { projectRoot, checkMedia: false });
    const outDir = mkdtempSync(join(tmpdir(), "openppt-layout-"));
    try {
      const out = join(outDir, "layout.pptx");
      const result = await compileToPptx(deck, out, {
        projectRoot,
        force: true,
        sourcePath,
      });
      assert.equal(result.pageCount, 3);
      assert.ok(existsSync(out));
      const pptx = await openPptx(out);
      assert.ok(pptx.file("ppt/slides/slide1.xml"));
      assert.ok(pptx.file("ppt/slides/slide3.xml"));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("qa --fail-on med exits non-zero when only med issues exist", () => {
    const deck = {
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "emptyish",
          elements: [
            {
              id: "tiny",
              type: "text",
              bounds: [0, 0, 10, 10],
              text: "x",
            },
          ],
        },
      ],
    };
    // force a med issue via density high: stack overlapping shapes both shapes
    const dense = {
      version: "openppt-1",
      size: [100, 100],
      pages: [
        {
          id: "d",
          elements: [
            {
              id: "s1",
              type: "shape",
              bounds: [0, 0, 100, 100],
              shape: "rect",
              fill: "#000000",
            },
            {
              id: "s2",
              type: "shape",
              bounds: [0, 0, 100, 100],
              shape: "rect",
              fill: "#ffffff",
            },
            {
              id: "s3",
              type: "shape",
              bounds: [0, 0, 100, 100],
              shape: "rect",
              fill: "#ff0000",
            },
          ],
        },
      ],
    };
    const analysis = analyzeLayout(dense);
    assert.ok(analysis.issues.some((i) => i.code === "HIGH_DENSITY" || i.code === "OVERLAP"));
    // default ok ignores med-only if only density
    const medOnly = analysis.issues.filter((i) => i.severity === "med");
    if (medOnly.length) {
      assert.equal(issuesFailThreshold(medOnly, "high"), false);
      assert.equal(issuesFailThreshold(medOnly, "med"), true);
    }

    // CLI: write temp deck with sparse page (low) — use med via high density
    const dir = mkdtempSync(join(tmpdir(), "openppt-layout-qa-"));
    try {
      const path = join(dir, "dense-qa.json");
      writeFileSync(path, JSON.stringify(dense));
      const high = spawnSync(bunBin, [cli, "qa", path], { encoding: "utf8" });
      const med = spawnSync(bunBin, [cli, "qa", path, "--fail-on", "med"], {
        encoding: "utf8",
      });
      // OVERLAP bothShape is med; HIGH_DENSITY is med — ok default true if no high
      assert.equal(high.status, 0, high.stdout + high.stderr);
      assert.equal(med.status, 1, med.stdout + med.stderr);
      assert.match(med.stdout, /"ok": false/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
