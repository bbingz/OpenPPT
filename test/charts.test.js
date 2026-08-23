import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadDeck } from "../src/load.js";
import { validateDeck } from "../src/validate.js";
import { compileToPptx } from "../src/compile.js";

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

      const listing = execFileSync("unzip", ["-l", result.outputPath], {
        encoding: "utf8",
      });
      assert.match(listing, /ppt\/slides\/slide1\.xml/);
      // pptxgenjs emits chart parts for chart slides
      assert.match(listing, /ppt\/charts\//);

      const extractDir = join(outDir, "extract");
      mkdirSync(extractDir, { recursive: true });
      execFileSync(
        "unzip",
        ["-o", result.outputPath, "ppt/slides/slide1.xml", "-d", extractDir],
        { encoding: "utf8" },
      );
      const xml = readFileSync(join(extractDir, "ppt/slides/slide1.xml"), "utf8");
      assert.match(xml, /Quarterly results|a:t/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
