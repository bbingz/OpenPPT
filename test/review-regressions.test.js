import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import * as publicApi from "../src/index.js";
import * as compileModule from "../src/compile.js";
import * as validateModule from "../src/validate.js";
import { compileToBuffer } from "../src/compile.js";
import {
  createBoundedZipReader,
  importPptx,
} from "../src/import-pptx.js";
import { initProject } from "../src/init.js";
import { projectFromOutline } from "../src/from-outline.js";
import { writeDeckFileAtomic } from "../src/project-write.js";
import { renderPreviewHtml } from "../src/preview.js";
import { qaDeck } from "../src/qa.js";
import { RESOURCE_LIMITS } from "../src/resource-limits.js";
import { ErrorCodes, OpenPptError } from "../src/errors.js";

function deckWith(element) {
  return {
    version: "openppt-1",
    size: [960, 540],
    pages: [{ id: "p1", elements: [element] }],
  };
}

async function expectImportResourceLimit(zip) {
  const work = mkdtempSync(join(tmpdir(), "openppt-import-limits-"));
  try {
    const source = join(work, "hostile.pptx");
    const destination = join(work, "out");
    writeFileSync(
      source,
      await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 1 },
      }),
    );
    await assert.rejects(
      () => importPptx(source, destination),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.RESOURCE_LIMIT);
        return true;
      },
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("review regressions", () => {
  it("rejects a ZIP entry flood before importing any output", async () => {
    const zip = new JSZip();
    for (let index = 0; index < RESOURCE_LIMITS.pptxEntries + 1; index += 1) {
      zip.file(`junk/entry-${index}.bin`, "");
    }
    await expectImportResourceLimit(zip);
  });

  it("rejects an oversized inflated ZIP entry before importing any output", async () => {
    const zip = new JSZip();
    zip.file(
      "junk/oversized.bin",
      Buffer.alloc(RESOURCE_LIMITS.pptxEntryUncompressedBytes + 1, 0x61),
    );
    await expectImportResourceLimit(zip);
  });

  it("stops an entry while its actual inflate output crosses the byte ceiling", async () => {
    const source = new JSZip();
    source.file("entry.bin", Buffer.alloc(33, 0x61));
    const zip = await JSZip.loadAsync(
      await source.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
    const entry = zip.file("entry.bin");
    const internalStream = entry.internalStream.bind(entry);
    let pauseCalls = 0;
    entry.internalStream = (type) => {
      const helper = internalStream(type);
      const pause = helper.pause.bind(helper);
      helper.pause = () => {
        pauseCalls += 1;
        return pause();
      };
      return helper;
    };
    const readZipEntry = createBoundedZipReader(zip, {
      entryBytes: 32,
      totalBytes: 64,
    });

    await assert.rejects(
      () => readZipEntry("entry.bin"),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.RESOURCE_LIMIT);
        assert.equal(err.details.limit, "pptxEntryUncompressedBytes");
        return true;
      },
    );
    assert.equal(pauseCalls, 1);
  });

  it("pauses the JSZip helper directly when inflate crosses the byte ceiling", async () => {
    const handlers = new Map();
    let pauseCalls = 0;
    const helper = {
      on(event, handler) {
        handlers.set(event, handler);
        return this;
      },
      pause() {
        pauseCalls += 1;
        return this;
      },
      resume() {
        handlers.get("data")(Buffer.alloc(33, 0x61));
        return this;
      },
    };
    const zip = {
      file() {
        return {
          internalStream(type) {
            assert.equal(type, "nodebuffer");
            return helper;
          },
          nodeStream() {
            throw new Error("Node adapter should not own bounded inflate");
          },
        };
      },
    };
    const readZipEntry = createBoundedZipReader(zip, {
      entryBytes: 32,
      totalBytes: 64,
    });

    await assert.rejects(
      () => readZipEntry("entry.bin"),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.RESOURCE_LIMIT);
        return true;
      },
    );
    assert.equal(pauseCalls, 1);
  });

  it("pins JSZip to the same EOCD accepted by import preflight", async () => {
    const archive = Buffer.from(
      await compileToBuffer(
        deckWith({
          id: "text1",
          type: "text",
          bounds: [10, 10, 200, 40],
          text: "Hello",
        }),
        { projectRoot: process.cwd() },
      ),
    );
    const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const acceptedEocd = archive.lastIndexOf(signature);
    const alternateEocd = Buffer.alloc(22);
    signature.copy(alternateEocd);
    const ambiguous = Buffer.concat([
      archive,
      alternateEocd,
      Buffer.from([0x58]),
    ]);
    ambiguous.writeUInt16LE(alternateEocd.length + 1, acceptedEocd + 20);

    const work = mkdtempSync(join(tmpdir(), "openppt-import-eocd-"));
    try {
      const source = join(work, "ambiguous.pptx");
      const destination = join(work, "out");
      writeFileSync(source, ambiguous);

      const result = await importPptx(source, destination);
      assert.equal(result.pageCount, 1);
      assert.equal(existsSync(join(destination, "deck.json")), true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated relationships to one imported ZIP media entry", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-dedupe-"));
    try {
      const deck = {
        version: "openppt-1",
        size: [960, 540],
        pages: [1, 2].map((index) => ({
          id: `p${index}`,
          elements: [
            {
              id: `image${index}`,
              type: "image",
              bounds: [0, 0, 100, 100],
              src: "media/accent.png",
            },
          ],
        })),
      };
      const exported = await compileToBuffer(deck, {
        projectRoot: join(process.cwd(), "fixtures/golden"),
      });
      const zip = await JSZip.loadAsync(exported);
      const secondRelsPath = "ppt/slides/_rels/slide2.xml.rels";
      const secondRels = await zip.file(secondRelsPath).async("string");
      zip.file(
        secondRelsPath,
        secondRels.replace("image-2-1.png", "image-1-1.png"),
      );
      zip.remove("ppt/media/image-2-1.png");
      const source = join(work, "repeated-media.pptx");
      writeFileSync(source, await zip.generateAsync({ type: "nodebuffer" }));

      const imported = await importPptx(source, join(work, "out"));
      const importedDeck = JSON.parse(readFileSync(imported.deckPath, "utf8"));
      const imageSources = importedDeck.pages.flatMap((page) =>
        page.elements
          .filter((element) => element.type === "image")
          .map((element) => element.src),
      );
      const mediaFiles = readdirSync(join(work, "out", "media")).filter(
        (name) => name !== ".gitkeep",
      );

      assert.equal(new Set(imageSources).size, 1);
      assert.equal(mediaFiles.length, 1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("rejects an oversized PPTX file before reading it into memory", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-archive-limit-"));
    try {
      const source = join(work, "oversized.pptx");
      const destination = join(work, "out");
      writeFileSync(source, "");
      truncateSync(source, RESOURCE_LIMITS.pptxArchiveBytes + 1);

      await assert.rejects(
        () => importPptx(source, destination),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.RESOURCE_LIMIT);
          assert.equal(err.details.limit, "pptxArchiveBytes");
          return true;
        },
      );
      assert.equal(existsSync(destination), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("returns an OpenPptError for external page paths passed to validateDeck", () => {
    const deck = {
      version: "openppt-1",
      size: [960, 540],
      pages: ["pages/cover.json"],
    };

    assert.throws(
      () => validateModule.validateDeck(deck, { checkMedia: false }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.IO);
        assert.match(err.message, /loadDeck/);
        return true;
      },
    );
  });

  it("rejects non-canonical media paths even when media bytes are unchecked", () => {
    for (const src of [
      "media/../secret.png",
      "media//secret.png",
      "media/./secret.png",
      "media/dir\\secret.png",
    ]) {
      const deck = deckWith({
        id: "img1",
        type: "image",
        bounds: [0, 0, 100, 100],
        src,
      });

      assert.throws(
        () => validateModule.validateDeck(deck, { checkMedia: false }),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.MEDIA_MISSING);
          return true;
        },
      );
      assert.equal(validateModule.getSchemaValidator()(deck), false);
    }

    const valid = deckWith({
      id: "img1",
      type: "image",
      bounds: [0, 0, 100, 100],
      src: "media/icons/secret.png",
    });
    assert.equal(validateModule.validateDeck(valid, { checkMedia: false }).ok, true);
    assert.equal(validateModule.getSchemaValidator()(valid), true);
  });

  it("rejects finite table column weights whose normalized total overflows", () => {
    const deck = deckWith({
      id: "table1",
      type: "table",
      bounds: [0, 0, 800, 200],
      rows: [["A", "B"]],
      colW: [1e308, 1e308],
    });

    assert.throws(
      () => validateModule.validateDeck(deck, { checkMedia: false }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        assert.match(err.message, /colW/);
        return true;
      },
    );
  });

  it("normalizes large finite table weights without overflowing multiplication", async () => {
    const deck = deckWith({
      id: "table1",
      type: "table",
      bounds: [0, 0, 800, 200],
      rows: [["A", "B"]],
      colW: [1e308, 1e307],
    });

    const bytes = await compileToBuffer(deck, { projectRoot: process.cwd() });
    const zip = await JSZip.loadAsync(bytes);
    const slide = await zip.file("ppt/slides/slide1.xml").async("string");
    const widths = [...slide.matchAll(/<a:gridCol w="(\d+)"/g)].map((match) =>
      Number(match[1]),
    );

    assert.equal(widths.length, 2);
    assert.ok(widths.every(Number.isFinite));
    assert.ok(Math.abs(widths[0] / widths[1] - 10) < 0.01);
  });

  it("uses bounded image I/O and exposes the byte-only inspection helpers", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png);
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(3, 20);

    assert.equal(publicApi.sniffImageBytes(png), "png");
    assert.deepEqual(publicApi.imageSizeFromBytes(png), { width: 2, height: 3 });
    assert.equal(typeof publicApi.sniffImageType, "function");
    assert.equal("readImageSize" in compileModule, false);

    const work = mkdtempSync(join(tmpdir(), "openppt-image-io-"));
    try {
      const oversized = join(work, "oversized.png");
      writeFileSync(oversized, "");
      truncateSync(oversized, RESOURCE_LIMITS.mediaBytesPerFile + 1);
      assert.throws(
        () => publicApi.sniffImageType(oversized),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.RESOURCE_LIMIT);
          return true;
        },
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not mutate an authoring deck while expanding layout groups", () => {
    const deck = deckWith({
      id: "group1",
      type: "group",
      layout: "stack",
      bounds: [0, 0, 200, 100],
      children: [{ id: "text1", type: "text", height: 40, text: "Hello" }],
    });
    const before = structuredClone(deck);

    const result = validateModule.validateDeck(deck, { checkMedia: false });

    assert.deepEqual(deck, before);
    assert.equal(result.deck.pages[0].elements[0].type, "text");
  });

  it("compiles authoring groups without mutating the caller deck", async () => {
    const deck = deckWith({
      id: "group1",
      type: "group",
      layout: "stack",
      bounds: [0, 0, 200, 100],
      children: [{ id: "text1", type: "text", height: 40, text: "Hello" }],
    });
    const before = structuredClone(deck);

    const bytes = await compileToBuffer(deck, { projectRoot: process.cwd() });
    const zip = await JSZip.loadAsync(bytes);
    const slide = await zip.file("ppt/slides/slide1.xml").async("string");

    assert.deepEqual(deck, before);
    assert.match(slide, /Hello/);
  });

  it("previews and checks QA against normalized groups without mutation", () => {
    const deck = deckWith({
      id: "group1",
      type: "group",
      layout: "stack",
      bounds: [0, 0, 200, 100],
      children: [{ id: "text1", type: "text", height: 40, text: "Hello" }],
    });
    const before = structuredClone(deck);

    assert.match(renderPreviewHtml(deck, process.cwd()), /Hello/);
    assert.deepEqual(deck, before);
    assert.equal(qaDeck(deck, { checkMedia: false }).ok, true);
    assert.deepEqual(deck, before);
  });

  it("preserves the prior deck and cleans its sibling temp when rename fails", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-project-write-"));
    try {
      const deckPath = join(work, "deck.json");
      writeFileSync(deckPath, "sentinel", "utf8");

      assert.throws(
        () =>
          writeDeckFileAtomic(deckPath, '{"version":"new"}\n', {
            force: true,
            renameSync() {
              throw new Error("injected rename failure");
            },
          }),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.EXPORT,
      );

      assert.equal(readFileSync(deckPath, "utf8"), "sentinel");
      assert.equal(
        readdirSync(work).some((name) => name.startsWith(".openppt-deck-")),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not overwrite a concurrently created deck without force", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-project-no-clobber-"));
    try {
      const deckPath = join(work, "deck.json");
      writeFileSync(deckPath, "sentinel", "utf8");

      assert.throws(
        () => writeDeckFileAtomic(deckPath, '{"version":"new"}\n'),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.EXPORT,
      );
      assert.equal(readFileSync(deckPath, "utf8"), "sentinel");
      assert.equal(
        readdirSync(work).some((name) => name.startsWith(".openppt-deck-")),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("keeps an installed deck when sibling-temp cleanup fails", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-project-cleanup-"));
    try {
      const deckPath = join(work, "deck.json");
      let cleanupCalls = 0;

      assert.doesNotThrow(() =>
        writeDeckFileAtomic(deckPath, '{"version":"new"}\n', {
          unlinkSync(path) {
            if (path !== deckPath) {
              cleanupCalls += 1;
              const err = new Error("injected temp cleanup failure");
              err.code = "EPERM";
              throw err;
            }
            unlinkSync(path);
          },
        }),
      );

      assert.equal(readFileSync(deckPath, "utf8"), '{"version":"new"}\n');
      assert.equal(cleanupCalls, 1);
      assert.equal(
        readdirSync(work).filter((name) => name.startsWith(".openppt-deck-"))
          .length,
        1,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("force-replaces existing init and outline decks without temp residue", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-generator-replace-"));
    try {
      const destination = join(work, "project");
      initProject(destination, { title: "First" });
      initProject(destination, { title: "Second", force: true });
      assert.equal(
        JSON.parse(readFileSync(join(destination, "deck.json"), "utf8")).title,
        "Second",
      );

      const outline = join(work, "outline.md");
      writeFileSync(outline, "# From outline\n## One\n- Body\n", "utf8");
      projectFromOutline(outline, destination, { force: true });
      assert.equal(
        JSON.parse(readFileSync(join(destination, "deck.json"), "utf8")).title,
        "From outline",
      );
      assert.equal(
        readdirSync(destination).some((name) => name.startsWith(".openppt-deck-")),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
