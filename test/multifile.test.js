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

describe("multi-file decks + rich text", () => {
  it("loads page paths, expands rich text, exports PPTX", async () => {
    const deckPath = join(root, "fixtures/multi-file/deck.json");
    const { deck, projectRoot, sourcePath } = loadDeck(deckPath);
    assert.equal(deck.pages.length, 2);
    assert.equal(typeof deck.pages[0], "object");
    assert.equal(deck.pages[0].id, "cover");
    assert.equal(deck.pages[1].id, "body");
    assert.ok(Array.isArray(deck.pages[0].elements[0].text));

    validateDeck(deck, { projectRoot, checkMedia: true });

    const outDir = mkdtempSync(join(tmpdir(), "openppt-multifile-"));
    try {
      const out = join(outDir, "multi.pptx");
      const result = await compileToPptx(deck, out, {
        projectRoot,
        force: true,
        sourcePath,
      });
      assert.ok(existsSync(result.outputPath));
      assert.ok(statSync(result.outputPath).size > 1000);
      assert.equal(result.pageCount, 2);

      const extractDir = join(outDir, "extract");
      mkdirSync(extractDir, { recursive: true });
      execFileSync(
        "unzip",
        ["-o", result.outputPath, "ppt/slides/slide1.xml", "-d", extractDir],
        { encoding: "utf8" },
      );
      const xml = readFileSync(join(extractDir, "ppt/slides/slide1.xml"), "utf8");
      assert.match(xml, /OpenPPT/);
      assert.match(xml, /multi-file/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
