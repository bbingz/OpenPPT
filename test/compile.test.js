import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadDeck } from "../src/load.js";
import { compileToPptx, compileToBuffer } from "../src/compile.js";
import { exportDeckFile } from "../src/index.js";
import { OpenPptError, ErrorCodes } from "../src/errors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "fixtures/golden/out");

describe("compileToPptx (shipped)", () => {
  before(() => {
    mkdirSync(outDir, { recursive: true });
  });

  it("exports golden fixture to a non-empty PPTX ZIP with slide XML and fixture text", async () => {
    const out = join(outDir, "test-deck.pptx");
    if (existsSync(out)) rmSync(out);
    const { deck, projectRoot } = loadDeck(join(root, "fixtures/golden/deck.json"));
    const result = await compileToPptx(deck, out, { projectRoot, force: true });
    assert.equal(result.pageCount, 2);
    assert.ok(existsSync(result.outputPath));
    assert.ok(statSync(result.outputPath).size > 1000);

    // PPTX is a ZIP — list entries via system unzip
    const listing = execFileSync("unzip", ["-l", result.outputPath], {
      encoding: "utf8",
    });
    assert.match(listing, /\[Content_Types\]\.xml/);
    assert.match(listing, /ppt\/slides\/slide1\.xml/);
    assert.match(listing, /ppt\/slides\/slide2\.xml/);

    // Extract slide1 and assert fixture title text is present as editable text
    const extractDir = join(outDir, "extract-test");
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    execFileSync("unzip", ["-o", result.outputPath, "ppt/slides/slide1.xml", "-d", extractDir], {
      encoding: "utf8",
    });
    const slideXml = readFileSync(join(extractDir, "ppt/slides/slide1.xml"), "utf8");
    assert.match(slideXml, /OpenPPT Golden Fixture/);
    assert.match(slideXml, /a:t/); // drawingML text run
  });

  it("exportDeckFile high-level entry also succeeds", async () => {
    const out = join(outDir, "test-deck-api.pptx");
    const result = await exportDeckFile(join(root, "fixtures/golden/deck.json"), out, {
      force: true,
    });
    assert.ok(existsSync(result.outputPath));
    assert.ok(statSync(result.outputPath).size > 0);
  });

  it("compileToBuffer returns PPTX (ZIP) bytes without writing to disk", async () => {
    const { deck, projectRoot } = loadDeck(join(root, "fixtures/golden/deck.json"));
    const buf = await compileToBuffer(deck, { projectRoot });
    assert.ok(buf.length > 1000);
    assert.equal(buf.subarray(0, 2).toString("latin1"), "PK"); // ZIP magic
  });

  it("fails closed when media is missing (compile path)", async () => {
    const { deck, projectRoot } = loadDeck(
      join(root, "fixtures/negative-missing-media/deck.json"),
    );
    await assert.rejects(
      () =>
        compileToPptx(deck, join(outDir, "should-not-exist.pptx"), {
          projectRoot,
          force: true,
        }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.MEDIA_MISSING);
        return true;
      },
    );
  });

  it("fails closed when bounds are out of canvas (compile path)", async () => {
    const { deck, projectRoot } = loadDeck(join(root, "fixtures/negative-oob/deck.json"));
    await assert.rejects(
      () =>
        compileToPptx(deck, join(outDir, "should-not-exist-oob.pptx"), {
          projectRoot,
          force: true,
        }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.BOUNDS);
        return true;
      },
    );
  });

  it("refuses to overwrite the source deck path with --force", async () => {
    const deckPath = join(root, "fixtures/golden/deck.json");
    const { deck, projectRoot, sourcePath } = loadDeck(deckPath);
    await assert.rejects(
      () =>
        compileToPptx(deck, sourcePath, {
          projectRoot,
          force: true,
          sourcePath,
        }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.EXPORT);
        assert.match(err.message, /Refusing to overwrite source deck/);
        return true;
      },
    );
    // source still present
    assert.ok(existsSync(deckPath));
  });
});
