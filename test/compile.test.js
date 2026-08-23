import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadDeck } from "../src/load.js";
import { compileToPptx, compileToBuffer } from "../src/compile.js";
import { exportDeckFile } from "../src/index.js";
import { OpenPptError, ErrorCodes } from "../src/errors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let outDir;

describe("compileToPptx (shipped)", () => {
  before(() => {
    outDir = mkdtempSync(join(tmpdir(), "openppt-compile-"));
  });

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
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

  it("embeds images with cover sizing (no stretch) by default", async () => {
    const { deck, projectRoot, sourcePath } = loadDeck(
      join(root, "fixtures/golden/deck.json"),
    );
    const out = join(outDir, "cover-sizing.pptx");
    await compileToPptx(deck, out, { projectRoot, force: true, sourcePath });
    const listing = execFileSync("unzip", ["-p", out, "ppt/slides/slide1.xml"], {
      encoding: "utf8",
    });
    // cover path writes a:srcRect; golden accent is square-in-square so crop may be 0
    assert.match(listing, /a:srcRect/);
    assert.match(listing, /a:blip/);
  });

  it("cover-crops non-matching aspect ratios (non-zero srcRect)", async () => {
    // 2×1 landscape PNG into a square box → must crop left/right
    const { deflateSync } = await import("node:zlib");
    const { writeFileSync } = await import("node:fs");
    const proj = join(outDir, "cover-ar-fixture");
    rmSync(proj, { recursive: true, force: true });
    mkdirSync(join(proj, "media"), { recursive: true });

    // Minimal valid 2×1 RGB PNG
    function crc32(buf) {
      let c = ~0;
      for (let i = 0; i < buf.length; i += 1) {
        c ^= buf[i];
        for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      }
      return ~c >>> 0;
    }
    function chunk(type, data) {
      const typeB = Buffer.from(type, "ascii");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
      return Buffer.concat([len, typeB, data, crc]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0); // w
    ihdr.writeUInt32BE(1, 4); // h
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    // filter 0 + 2 pixels * 3 bytes
    const raw = Buffer.from([0, 255, 0, 0, 0, 0, 255]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    writeFileSync(join(proj, "media/wide.png"), png);
    writeFileSync(
      join(proj, "deck.json"),
      JSON.stringify({
        version: "openppt-1",
        title: "cover-ar",
        size: [200, 200],
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "img",
                type: "image",
                bounds: [0, 0, 200, 200],
                src: "media/wide.png",
              },
            ],
          },
        ],
      }),
    );

    const { deck, projectRoot, sourcePath } = loadDeck(join(proj, "deck.json"));
    const out = join(outDir, "cover-ar.pptx");
    await compileToPptx(deck, out, { projectRoot, force: true, sourcePath });
    const xml = execFileSync("unzip", ["-p", out, "ppt/slides/slide1.xml"], {
      encoding: "utf8",
    });
    assert.match(xml, /a:srcRect/);
    const m = xml.match(/a:srcRect\s+l="(\d+)"\s+r="(\d+)"\s+t="(\d+)"\s+b="(\d+)"/);
    assert.ok(m, "srcRect attributes present");
    const [, l, r, t, b] = m.map(Number);
    // 2:1 image in 1:1 box → horizontal crop, vertical 0
    assert.ok(l > 0 && r > 0, `expected horizontal crop, got l=${l} r=${r}`);
    assert.equal(t, 0);
    assert.equal(b, 0);
    // ~25% each side for 2:1 into 1:1
    assert.ok(l > 10000 && l < 40000, `crop percentage out of range: ${l}`);
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
