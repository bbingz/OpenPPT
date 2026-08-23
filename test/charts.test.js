import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeck } from "../src/load.js";
import { validateDeck } from "../src/validate.js";
import { compileToPptx } from "../src/compile.js";
import { openPptx, readPptxEntry } from "./helpers/pptx.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("charts (shipped)", () => {
  it("validates and exports chart-demo fixture with slide XML", async () => {
    const deckPath = join(root, "fixtures/chart-demo/deck.json");
    const { deck, projectRoot } = loadDeck(deckPath);
    validateDeck(deck, { projectRoot, checkMedia: true });
    assert.equal(deck.pages[0].elements.some((e) => e.type === "chart"), true);

    const outDir = mkdtempSync(join(tmpdir(), "openppt-chart-"));
    try {
      const out = join(outDir, "chart.pptx");
      const result = await compileToPptx(deck, out, {
        projectRoot,
        force: true,
        sourcePath: deckPath,
      });
      assert.ok(existsSync(result.outputPath));
      assert.ok(statSync(result.outputPath).size > 1000);

      const pptx = await openPptx(result.outputPath);
      assert.ok(pptx.file("ppt/slides/slide1.xml"));
      // pptxgenjs emits chart parts for chart slides
      assert.ok(Object.keys(pptx.files).some((name) => name.startsWith("ppt/charts/")));

      const xml = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
      assert.match(xml, /Quarterly results|a:t/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
