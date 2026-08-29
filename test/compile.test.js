import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeck } from "../src/load.js";
import { compileToPptx, compileToBuffer } from "../src/compile.js";
import { exportDeckFile } from "../src/index.js";
import { OpenPptError, ErrorCodes } from "../src/errors.js";
import { openPptx, readPptxEntry } from "./helpers/pptx.js";

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

    const pptx = await openPptx(result.outputPath);
    assert.ok(pptx.file("[Content_Types].xml"));
    assert.ok(pptx.file("ppt/slides/slide1.xml"));
    assert.ok(pptx.file("ppt/slides/slide2.xml"));

    // Read slide1 and assert fixture title text is present as editable text.
    const slideXml = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
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
    const pptx = await openPptx(result.outputPath);
    assert.ok(pptx.file("ppt/slides/slide1.xml"));
    const xml = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
    assert.match(xml, /<p:sld[\s>]|<p:cSld/);
    assert.match(xml, /a:t/);
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
    const pptx = await openPptx(out);
    const listing = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
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
    const pptx = await openPptx(out);
    const xml = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
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

  it("rejects fontSize 1e308 and does not write a PPTX", async () => {
    const out = join(outDir, "should-not-exist-fontsize.pptx");
    await assert.rejects(
      () =>
        compileToPptx(
          {
            version: "openppt-1",
            size: [960, 540],
            pages: [
              {
                id: "p1",
                elements: [
                  {
                    id: "t1",
                    type: "text",
                    bounds: [0, 0, 100, 40],
                    text: "x",
                    fontSize: 1e308,
                  },
                ],
              },
            ],
          },
          out,
          { projectRoot: outDir, force: true },
        ),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        return true;
      },
    );
    assert.equal(existsSync(out), false);
  });

  it("installs non-force exports without clobbering via exclusive link", async () => {
    const { deck, projectRoot, sourcePath } = loadDeck(
      join(root, "fixtures/golden/deck.json"),
    );
    const out = join(outDir, "exclusive-install.pptx");
    await assert.rejects(
      () =>
        compileToPptx(deck, out, {
          projectRoot,
          force: false,
          sourcePath,
          operations: {
            linkSync() {
              const err = new Error("injected exclusive-create collision");
              err.code = "EEXIST";
              throw err;
            },
            renameSync() {
              throw new Error("renameSync must not run when force is false");
            },
          },
        }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.EXPORT);
        return true;
      },
    );
    assert.equal(existsSync(out), false);
  });

  it("writes run-level hyperlinks and never emits rIdundefined", async () => {
    const out = join(outDir, "href.pptx");
    await compileToPptx(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "link",
                type: "text",
                bounds: [20, 20, 400, 40],
                href: "https://example.com/openppt",
                text: [
                  { text: "Hello", bold: true },
                  { text: "World", bold: false },
                ],
              },
            ],
          },
        ],
      },
      out,
      { projectRoot: outDir, force: true },
    );
    const pptx = await openPptx(out);
    const slide = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
    const rels = await readPptxEntry(pptx, "ppt/slides/_rels/slide1.xml.rels");
    assert.doesNotMatch(slide, /rIdundefined/);
    assert.doesNotMatch(rels, /rIdundefined/);
    assert.match(slide, /hlinkClick/);
    assert.match(rels, /example\.com\/openppt/);
  });

  it("materializes run.bold false instead of inheriting parent bold", async () => {
    const out = join(outDir, "run-bold.pptx");
    await compileToPptx(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "mixed",
                type: "text",
                bounds: [20, 20, 400, 40],
                bold: true,
                text: [
                  { text: "BOLD" },
                  { text: "plain", bold: false },
                ],
              },
            ],
          },
        ],
      },
      out,
      { projectRoot: outDir, force: true },
    );
    const pptx = await openPptx(out);
    const slide = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
    assert.match(slide, /<a:t>BOLD<\/a:t>/);
    assert.match(slide, /<a:t>plain<\/a:t>/);
    const boldRun = slide.split("<a:t>BOLD</a:t>")[0];
    const plainRun = slide.split("<a:t>plain</a:t>")[0].split("<a:r>").pop();
    assert.match(boldRun, /b="1"/);
    assert.doesNotMatch(plainRun, /b="1"/);
  });

  it("emits no stroke for zero-width shape and table borders", async () => {
    const out = join(outDir, "zero-border.pptx");
    await compileToPptx(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "s",
                type: "shape",
                bounds: [10, 10, 100, 80],
                shape: "rect",
                fill: "#2563EB",
                lineWidth: 0,
              },
              {
                id: "tbl",
                type: "table",
                bounds: [10, 120, 300, 80],
                borderWidth: 0,
                rows: [["A", "B"]],
              },
            ],
          },
        ],
      },
      out,
      { projectRoot: outDir, force: true },
    );
    const pptx = await openPptx(out);
    const slide = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
    assert.match(slide, /<a:ln[^>]*><a:noFill\/>|<a:ln[^>]*w="0"/);
  });

  it("passes RGBA transparency through background, lines, and table fills", async () => {
    const out = join(outDir, "rgba.pptx");
    await compileToPptx(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p1",
            background: { type: "solid", color: "#FF000080" },
            elements: [
              {
                id: "s",
                type: "shape",
                bounds: [10, 10, 80, 80],
                shape: "rect",
                fill: "#00FF0080",
                lineColor: "#0000FF80",
                lineWidth: 2,
              },
              {
                id: "tbl",
                type: "table",
                bounds: [10, 120, 300, 80],
                rows: [[{ text: "x", fill: "#00FF0080", color: "#00000080" }]],
              },
            ],
          },
        ],
      },
      out,
      { projectRoot: outDir, force: true },
    );
    const pptx = await openPptx(out);
    const slide = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
    assert.match(slide, /alpha|alphaModFix|alphaOff/i);
  });

  it("shows a legend or data labels for a single-series pie chart", async () => {
    const out = join(outDir, "pie.pptx");
    await compileToPptx(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "pie",
                type: "chart",
                bounds: [40, 40, 400, 300],
                chartType: "pie",
                series: [{ name: "Share", values: [40, 60], labels: ["A", "B"] }],
              },
            ],
          },
        ],
      },
      out,
      { projectRoot: outDir, force: true },
    );
    const pptx = await openPptx(out);
    const chartName = Object.keys(pptx.files).find((name) =>
      /^ppt\/charts\/chart\d+\.xml$/i.test(name),
    );
    assert.ok(chartName, "expected a chart part");
    const xml = await readPptxEntry(pptx, chartName);
    assert.match(xml, /c:legend|c:dLbls|c:showVal|c:showPercent|c:showCatName/);
  });

  it("parses SVG natural size so cover does not stretch", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const proj = join(outDir, "svg-fit");
    mkdirSync(join(proj, "media"), { recursive: true });
    writeFileSync(
      join(proj, "media/wide.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#0f0"/></svg>`,
    );
    await compileToPptx(
      {
        version: "openppt-1",
        size: [200, 200],
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "img",
                type: "image",
                bounds: [0, 0, 200, 200],
                src: "media/wide.svg",
                fit: "cover",
              },
            ],
          },
        ],
      },
      join(outDir, "svg-cover.pptx"),
      { projectRoot: proj, force: true },
    );
    const pptx = await openPptx(join(outDir, "svg-cover.pptx"));
    const xml = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
    assert.match(xml, /a:srcRect/);
  });
});
