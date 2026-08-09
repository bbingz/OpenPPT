import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeck } from "../src/load.js";
import { compileToPptx } from "../src/compile.js";
import { importPptx } from "../src/import-pptx.js";
import { qaDeck, analyzeLayout } from "../src/qa.js";
import { writePreviewHtml } from "../src/preview.js";
import { validateDeck } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("import / qa / preview", () => {
  it("round-trips golden PPTX through lossy import and re-export", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-imp-"));
    try {
      const pptxPath = join(work, "src.pptx");
      const { deck, projectRoot, sourcePath } = loadDeck(
        join(root, "fixtures/golden/deck.json"),
      );
      await compileToPptx(deck, pptxPath, {
        projectRoot,
        force: true,
        sourcePath,
      });
      assert.ok(statSync(pptxPath).size > 1000);

      const outDir = join(work, "imported");
      const imp = await importPptx(pptxPath, outDir, { force: true });
      assert.ok(existsSync(imp.deckPath));
      assert.ok(imp.pageCount >= 2);

      const loaded = loadDeck(imp.deckPath);
      validateDeck(loaded.deck, {
        projectRoot: loaded.projectRoot,
        checkMedia: true,
      });
      // Title text should survive lossy import
      const allText = JSON.stringify(loaded.deck);
      assert.match(allText, /OpenPPT Golden Fixture/);

      const out2 = join(work, "reexport.pptx");
      const re = await compileToPptx(loaded.deck, out2, {
        projectRoot: loaded.projectRoot,
        force: true,
        sourcePath: loaded.sourcePath,
      });
      assert.ok(statSync(re.outputPath).size > 1000);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("qa flags overlapping text on a synthetic deck", () => {
    const deck = {
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p1",
          elements: [
            {
              id: "a",
              type: "text",
              bounds: [0, 0, 400, 100],
              text: "A",
            },
            {
              id: "b",
              type: "text",
              bounds: [50, 20, 400, 100],
              text: "B",
            },
          ],
        },
      ],
    };
    const result = analyzeLayout(deck);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "OVERLAP"));
  });

  it("qa passes golden fixture", () => {
    const { deck, projectRoot } = loadDeck(join(root, "fixtures/golden/deck.json"));
    const result = qaDeck(deck, { projectRoot, checkMedia: true });
    assert.equal(result.ok, true);
  });

  it("writes an HTML preview containing page markup", () => {
    const { deck, projectRoot } = loadDeck(join(root, "fixtures/golden/deck.json"));
    validateDeck(deck, { projectRoot, checkMedia: true });
    const outDir = join(root, "fixtures/golden/out");
    mkdirSync(outDir, { recursive: true });
    const htmlPath = join(outDir, "preview.html");
    writePreviewHtml(deck, projectRoot, htmlPath);
    const html = readFileSync(htmlPath, "utf8");
    assert.match(html, /OpenPPT Golden Fixture/);
    assert.match(html, /class="page"/);
  });
});
