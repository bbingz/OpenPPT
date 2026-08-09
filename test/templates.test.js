import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeck } from "../src/load.js";
import { validateDeck } from "../src/validate.js";
import { compileToPptx } from "../src/compile.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("templates (shipped skeletons)", () => {
  it("pitch-skeleton validates and exports a 4-page PPTX", async () => {
    const deckPath = join(root, "templates/pitch-skeleton/deck.json");
    const { deck, projectRoot } = loadDeck(deckPath);
    validateDeck(deck, { projectRoot, checkMedia: true });
    assert.equal(deck.pages.length, 4);
    assert.deepEqual(
      deck.pages.map((p) => p.id),
      ["cover", "toc", "body", "final"],
    );

    const outDir = join(root, "templates/pitch-skeleton/out");
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, "pitch.pptx");
    const result = await compileToPptx(deck, out, {
      projectRoot,
      force: true,
      sourcePath: deckPath,
    });
    assert.ok(existsSync(result.outputPath));
    assert.ok(statSync(result.outputPath).size > 1000);
    assert.equal(result.pageCount, 4);
  });
});
