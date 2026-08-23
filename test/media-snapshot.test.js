import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { compileToBuffer, compileToPptx } from "../src/compile.js";
import { renderPreviewHtml } from "../src/preview.js";
import { validateDeck } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function imagePages() {
  return [
    {
      id: "p1",
      elements: [
        {
          id: "image",
          type: "image",
          bounds: [100, 100, 200, 200],
          src: "media/image.png",
        },
      ],
    },
  ];
}

function imageDeck(getPages = imagePages) {
  return {
    version: "openppt-1",
    size: [960, 540],
    get pages() {
      return getPages();
    },
  };
}

async function readEmbeddedPng(pptxBytes) {
  const zip = await JSZip.loadAsync(pptxBytes);
  const mediaEntries = Object.keys(zip.files).filter((name) =>
    /^ppt\/media\/.*\.png$/.test(name),
  );
  assert.equal(mediaEntries.length, 1);
  return {
    bytes: await zip.file(mediaEntries[0]).async("nodebuffer"),
    slideXml: await zip.file("ppt/slides/slide1.xml").async("string"),
  };
}

describe("validated media snapshots", () => {
  it("rejects a project-local FIFO without blocking", (context) => {
    if (process.platform === "win32") {
      context.skip("POSIX FIFO regression");
      return;
    }
    const work = mkdtempSync(join(tmpdir(), "openppt-media-fifo-"));
    const mediaDir = join(work, "media");
    const mediaPath = join(mediaDir, "image.png");
    mkdirSync(mediaDir);

    try {
      const fifo = spawnSync("mkfifo", [mediaPath]);
      if (fifo.status !== 0) {
        context.skip("mkfifo is unavailable");
        return;
      }
      const validateUrl = pathToFileURL(join(root, "src/validate.js")).href;
      const script = `
        const { validateDeck } = await import(${JSON.stringify(validateUrl)});
        const deck = ${JSON.stringify(imageDeck())};
        try {
          validateDeck(deck, {
            projectRoot: ${JSON.stringify(work)},
            checkMedia: true,
          });
          process.exit(2);
        } catch (error) {
          process.exit(error?.code === "MEDIA_MISSING" ? 0 : 3);
        }
      `;
      const probe = spawnSync(process.execPath, ["-e", script], {
        timeout: 2_000,
      });
      assert.equal(probe.error, undefined, probe.error?.message);
      assert.equal(probe.status, 0, probe.stderr?.toString());
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("emits one media payload for repeated references to the same snapshot", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-media-dedupe-"));
    const mediaDir = join(work, "media");
    const mediaPath = join(mediaDir, "image.png");
    const original = readFileSync(join(root, "fixtures/golden/media/accent.png"));
    mkdirSync(mediaDir);
    writeFileSync(mediaPath, original);

    try {
      const pages = imagePages();
      pages[0].elements.push({
        ...pages[0].elements[0],
        id: "image-copy",
        bounds: [400, 100, 200, 200],
      });
      const output = await compileToBuffer(imageDeck(() => pages), {
        projectRoot: work,
      });
      const zip = await JSZip.loadAsync(output);
      const mediaEntries = Object.keys(zip.files).filter((name) =>
        /^ppt\/media\/.*\.png$/.test(name),
      );
      assert.equal(mediaEntries.length, 1);
      assert.deepEqual(
        await zip.file(mediaEntries[0]).async("nodebuffer"),
        original,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("embeds the bytes validated before a later path replacement", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-media-snapshot-"));
    const mediaDir = join(work, "media");
    const mediaPath = join(mediaDir, "image.png");
    const original = readFileSync(join(root, "fixtures/golden/media/accent.png"));
    const replacement = readFileSync(
      join(root, "demos/hello-openppt/media/mark.png"),
    );
    mkdirSync(mediaDir);
    copyFileSync(join(root, "fixtures/golden/media/accent.png"), mediaPath);

    const originalWrite = PptxGenJS.prototype.write;
    PptxGenJS.prototype.write = function writeAfterReplacement(options) {
      writeFileSync(mediaPath, replacement);
      return originalWrite.call(this, options);
    };

    try {
      const output = await compileToBuffer(imageDeck(), { projectRoot: work });
      const { bytes: embedded } = await readEmbeddedPng(output);
      assert.deepEqual(embedded, original);
      assert.notDeepEqual(embedded, replacement);
    } finally {
      PptxGenJS.prototype.write = originalWrite;
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("uses validated bytes and dimensions when the path changes before build", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-build-snapshot-"));
    const mediaDir = join(work, "media");
    const mediaPath = join(mediaDir, "image.png");
    const outputPath = join(work, "deck.pptx");
    const original = readFileSync(join(root, "fixtures/golden/media/accent.png"));
    const replacement = readFileSync(
      join(root, "demos/sspai-113139/media/book.png"),
    );
    mkdirSync(mediaDir);
    writeFileSync(mediaPath, original);

    try {
      let validationReads = 0;
      validateDeck(
        imageDeck(() => {
          validationReads += 1;
          return imagePages();
        }),
        { projectRoot: work, checkMedia: true },
      );

      writeFileSync(mediaPath, original);
      let operationReads = 0;
      const deck = imageDeck(() => {
        operationReads += 1;
        if (operationReads === validationReads + 1) {
          writeFileSync(mediaPath, replacement);
        }
        return imagePages();
      });
      await compileToPptx(deck, outputPath, {
        projectRoot: work,
        force: true,
      });
      assert.ok(operationReads >= validationReads + 1);

      const output = readFileSync(outputPath);
      const { bytes: embedded, slideXml } = await readEmbeddedPng(output);
      assert.deepEqual(embedded, original);
      assert.notDeepEqual(embedded, replacement);
      assert.match(slideXml, /<a:srcRect l="0" r="0" t="0" b="0"\/>/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("previews the bytes validated before a later path replacement", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-preview-snapshot-"));
    const mediaDir = join(work, "media");
    const mediaPath = join(mediaDir, "image.png");
    const original = readFileSync(join(root, "fixtures/golden/media/accent.png"));
    const replacement = readFileSync(
      join(root, "demos/hello-openppt/media/mark.png"),
    );
    mkdirSync(mediaDir);
    writeFileSync(mediaPath, original);

    try {
      let validationReads = 0;
      validateDeck(
        imageDeck(() => {
          validationReads += 1;
          return imagePages();
        }),
        { projectRoot: work, checkMedia: true },
      );

      writeFileSync(mediaPath, original);
      let operationReads = 0;
      const deck = imageDeck(() => {
        operationReads += 1;
        if (operationReads === validationReads + 1) {
          writeFileSync(mediaPath, replacement);
        }
        return imagePages();
      });
      const html = renderPreviewHtml(deck, work);
      assert.equal(operationReads, validationReads + 1);
      const match = html.match(/data:image\/png;base64,([^\"]+)/);
      assert.ok(match);
      const embedded = Buffer.from(match[1], "base64");
      assert.deepEqual(embedded, original);
      assert.notDeepEqual(embedded, replacement);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
