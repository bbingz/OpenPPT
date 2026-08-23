import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import { compileToBuffer, compileToPptx } from "../src/compile.js";
import { outlineToDeck, projectFromOutline } from "../src/from-outline.js";
import { initProject } from "../src/init.js";
import { commitImportOutputs, importPptx } from "../src/import-pptx.js";
import { expandLayouts } from "../src/layout.js";
import { loadDeck } from "../src/load.js";
import { renderPreviewHtml, writePreviewHtml } from "../src/preview.js";
import { validateDeck } from "../src/validate.js";
import { ErrorCodes, OpenPptError } from "../src/errors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin/openppt.js");
const bunBin = process.env.BUN_BIN || "bun";

function deckWith(element) {
  return {
    version: "openppt-1",
    size: [960, 540],
    theme: { colors: { text: "#111827" } },
    pages: [{ id: "p1", elements: [element] }],
  };
}

describe("v1 contract hardening", () => {
  it("rejects unresolved theme tokens inside rich-text runs", () => {
    const deck = deckWith({
      id: "text",
      type: "text",
      bounds: [20, 20, 300, 60],
      text: [{ text: "missing", color: "$missing" }],
    });

    assert.throws(
      () => validateDeck(deck, { checkMedia: false }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.THEME_COLOR);
        return true;
      },
    );
  });

  it("keeps padded table columns inside the table bounds", async () => {
    const deck = deckWith({
      id: "table",
      type: "table",
      bounds: [0, 0, 192, 96],
      rows: [["A", "B", "C"]],
      colW: [1],
    });

    const bytes = await compileToBuffer(deck, { projectRoot: root });
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("ppt/slides/slide1.xml").async("string");
    const widths = [...xml.matchAll(/<a:gridCol w="(\d+)"/g)].map((m) =>
      Number(m[1]),
    );

    assert.equal(widths.length, 3);
    assert.equal(widths.reduce((sum, width) => sum + width, 0), 1828800);
  });

  it("paginates large outlines into valid TOC pages", () => {
    const deck = outlineToDeck({
      title: "Large outline",
      sections: Array.from({ length: 8 }, (_, index) => ({
        title: `Section ${index + 1}`,
        bullets: ["Body"],
      })),
    });

    validateDeck(deck, { checkMedia: false });
    assert.equal(deck.pages.length, 11); // cover + 2 TOC + 8 sections
  });

  it("rejects theme path traversal and applies --title to skeleton cover", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-hardening-"));
    try {
      const badTheme = join(work, "bad-theme");
      assert.throws(
        () => initProject(badTheme, { theme: "../package" }),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.IO);
          return true;
        },
      );
      assert.equal(existsSync(badTheme), false);

      const outlinePath = join(work, "outline.md");
      const outlineDest = join(work, "bad-outline-theme");
      writeFileSync(outlinePath, "# Deck\n## One\n- Body\n", "utf8");
      assert.throws(
        () =>
          projectFromOutline(outlinePath, outlineDest, {
            theme: "../package",
          }),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.IO,
      );
      assert.equal(existsSync(outlineDest), false);

      const { deckPath } = initProject(join(work, "skeleton"), {
        skeleton: true,
        title: "Visible title",
      });
      const deck = JSON.parse(readFileSync(deckPath, "utf8"));
      const coverTitle = deck.pages[0].elements.find(
        (element) => element.id === "cover-title",
      );
      assert.equal(deck.title, "Visible title");
      assert.equal(coverTitle.text, "Visible title");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("rejects hyperlink schemes outside http, https, and mailto", () => {
    const deck = deckWith({
      id: "link",
      type: "text",
      bounds: [20, 20, 300, 60],
      text: "unsafe",
      href: "javascript:alert(1)",
    });

    assert.throws(
      () => validateDeck(deck, { checkMedia: false }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        return true;
      },
    );
  });

  it("rejects options that do not belong to a CLI subcommand", () => {
    const fixture = join(root, "fixtures/golden/deck.json");
    const validate = spawnSync(
      bunBin,
      [cli, "validate", fixture, "--force"],
      { encoding: "utf8" },
    );
    assert.equal(validate.status, 2);
    assert.match(validate.stderr, /validate does not accept --force/);

    const qa = spawnSync(
      bunBin,
      [cli, "qa", fixture, "-o", join(tmpdir(), "ignored.json")],
      { encoding: "utf8" },
    );
    assert.equal(qa.status, 2);
    assert.match(qa.stderr, /qa does not accept -o\/--output/);
  });

  it("keeps output-bearing fixture directories out of the package manifest", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.ok(!pkg.files.includes("fixtures/golden/"));
    assert.ok(!pkg.files.includes("templates/"));
    assert.ok(pkg.files.includes("fixtures/golden/deck.json"));
    assert.ok(pkg.files.includes("templates/pitch-skeleton/deck.json"));
    assert.match(pkg.scripts["preview:golden"], /--force/);
  });

  it("preserves text alignment when expanding layout groups", () => {
    const deck = {
      version: "openppt-1",
      size: [200, 100],
      pages: [
        {
          id: "p1",
          elements: [
            {
              id: "group",
              type: "group",
              layout: "stack",
              bounds: [0, 0, 200, 100],
              children: [
                {
                  id: "centered",
                  type: "text",
                  height: 40,
                  text: "Centered",
                  align: "center",
                },
              ],
            },
          ],
        },
      ],
    };

    const expanded = expandLayouts(deck);
    assert.equal(expanded.pages[0].elements[0].align, "center");
    validateDeck(expanded, { checkMedia: false });
  });

  it("rejects duplicate group ids before groups are flattened", () => {
    const deck = {
      version: "openppt-1",
      size: [200, 100],
      pages: [
        {
          id: "p1",
          elements: [
            {
              id: "duplicate",
              type: "group",
              layout: "stack",
              bounds: [0, 0, 100, 100],
              children: [{ id: "a", type: "text", height: 40, text: "A" }],
            },
            {
              id: "duplicate",
              type: "group",
              layout: "stack",
              bounds: [100, 0, 100, 100],
              children: [{ id: "b", type: "text", height: 40, text: "B" }],
            },
          ],
        },
      ],
    };

    assert.throws(
      () => validateDeck(deck, { checkMedia: false }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        return true;
      },
    );
  });

  it("refuses to overwrite preview source or existing output without force", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-preview-guard-"));
    const deck = deckWith({
      id: "text",
      type: "text",
      bounds: [20, 20, 300, 60],
      text: "Preview",
    });
    try {
      const source = join(work, "deck.json");
      const existing = join(work, "preview.html");
      writeFileSync(source, "source sentinel", "utf8");
      writeFileSync(existing, "output sentinel", "utf8");

      assert.throws(
        () => writePreviewHtml(deck, work, source, { sourcePath: source }),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.EXPORT,
      );
      assert.equal(readFileSync(source, "utf8"), "source sentinel");
      assert.throws(
        () => writePreviewHtml(deck, work, existing),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.EXPORT,
      );
      assert.equal(readFileSync(existing, "utf8"), "output sentinel");

      writePreviewHtml(deck, work, existing, { force: true });
      assert.match(readFileSync(existing, "utf8"), /OpenPPT preview/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("keeps preview output intact and cleans its temp file when rename fails", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-preview-rollback-"));
    const deck = deckWith({
      id: "text",
      type: "text",
      bounds: [20, 20, 300, 60],
      text: "Preview",
    });
    try {
      const output = join(work, "preview.html");
      mkdirSync(output);
      writeFileSync(join(output, "sentinel"), "original", "utf8");

      assert.throws(
        () => writePreviewHtml(deck, work, output, { force: true }),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.EXPORT,
      );
      assert.equal(readFileSync(join(output, "sentinel"), "utf8"), "original");
      assert.equal(
        readdirSync(work).some((name) => name.startsWith(".openppt-preview-")),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not overwrite pre-existing import media without force", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-guard-"));
    try {
      const source = loadDeck(join(root, "fixtures/golden/deck.json"));
      const pptx = join(work, "source.pptx");
      await compileToPptx(source.deck, pptx, {
        projectRoot: source.projectRoot,
        sourcePath: source.sourcePath,
      });

      const dest = join(work, "imported");
      const media = join(dest, "media", "img-1.png");
      mkdirSync(join(dest, "media"), { recursive: true });
      writeFileSync(media, "media sentinel", "utf8");

      await assert.rejects(
        () => importPptx(pptx, dest),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.EXPORT,
      );
      assert.equal(readFileSync(media, "utf8"), "media sentinel");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("rolls back installed import files when a later no-clobber commit fails", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-rollback-"));
    try {
      const source = loadDeck(join(root, "fixtures/golden/deck.json"));
      const pptx = join(work, "source.pptx");
      await compileToPptx(source.deck, pptx, {
        projectRoot: source.projectRoot,
        sourcePath: source.sourcePath,
      });

      const dest = join(work, "imported");
      const deckTarget = join(dest, "deck.json");
      mkdirSync(deckTarget, { recursive: true });
      writeFileSync(join(deckTarget, "sentinel"), "original", "utf8");

      await assert.rejects(
        () => importPptx(pptx, dest),
        (err) =>
          err instanceof OpenPptError &&
          err.code === ErrorCodes.EXPORT &&
          /Import commit failed/.test(err.message),
      );
      assert.equal(
        readFileSync(join(deckTarget, "sentinel"), "utf8"),
        "original",
      );
      const mediaDir = join(dest, "media");
      assert.equal(
        existsSync(mediaDir) ? readdirSync(mediaDir).length : 0,
        0,
      );
      assert.equal(
        readdirSync(dest).some((name) => name.includes(".openppt-import-")),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("restores every old file when a later forced replacement fails", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-force-rollback-"));
    try {
      const media = join(work, "media", "img-1.png");
      const deckPath = join(work, "deck.json");
      mkdirSync(dirname(media), { recursive: true });
      writeFileSync(media, "old media", "utf8");
      writeFileSync(deckPath, "old deck", "utf8");

      let renameCalls = 0;
      assert.throws(
        () =>
          commitImportOutputs(
            work,
            [
              { relativePath: "media/img-1.png", data: "new media" },
              { relativePath: "deck.json", data: "new deck" },
            ],
            true,
            {
              renameSync(from, to) {
                renameCalls += 1;
                if (renameCalls === 4) throw new Error("injected rename failure");
                renameSync(from, to);
              },
            },
          ),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.EXPORT,
      );
      assert.equal(readFileSync(media, "utf8"), "old media");
      assert.equal(readFileSync(deckPath, "utf8"), "old deck");
      assert.equal(
        [...readdirSync(work), ...readdirSync(dirname(media))].some((name) =>
          name.includes(".openppt-import-"),
        ),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("returns a warning instead of false failure when backup cleanup fails", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-cleanup-warning-"));
    try {
      const deckPath = join(work, "deck.json");
      writeFileSync(deckPath, "old deck", "utf8");
      const deck = deckWith({
        id: "text",
        type: "text",
        bounds: [0, 0, 100, 40],
        text: "new deck",
      });

      const warnings = commitImportOutputs(
        work,
        [
          {
            relativePath: "deck.json",
            data: `${JSON.stringify(deck, null, 2)}\n`,
          },
        ],
        true,
        {
          unlinkSync(path) {
            if (path.endsWith(".backup")) {
              throw new Error("injected cleanup failure");
            }
            unlinkSync(path);
          },
        },
      );

      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /could not remove import backup/);
      const loaded = loadDeck(deckPath);
      validateDeck(loaded.deck, { checkMedia: false });
      assert.equal(loaded.deck.pages[0].elements[0].text, "new deck");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("rejects non-finite values in nested renderer fields", () => {
    const elements = [
      {
        id: "run-font",
        type: "text",
        bounds: [0, 0, 100, 40],
        text: [{ text: "bad", fontSize: Infinity }],
      },
      {
        id: "table-border",
        type: "table",
        bounds: [0, 0, 100, 40],
        rows: [["A"]],
        borderWidth: Infinity,
      },
      {
        id: "table-width",
        type: "table",
        bounds: [0, 0, 100, 40],
        rows: [["A"]],
        colW: [Infinity],
      },
      {
        id: "cell-font",
        type: "table",
        bounds: [0, 0, 100, 40],
        rows: [[{ text: "bad", fontSize: Infinity }]],
      },
      {
        id: "numeric-cell",
        type: "table",
        bounds: [0, 0, 100, 40],
        rows: [[Infinity]],
      },
    ];

    for (const element of elements) {
      assert.throws(
        () => validateDeck(deckWith(element), { checkMedia: false }),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.SCHEMA,
        element.id,
      );
    }
  });

  it("rejects dot segments that escape the media subtree", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-media-subtree-"));
    try {
      writeFileSync(
        join(work, "secret.png"),
        readFileSync(join(root, "fixtures/golden/media/accent.png")),
      );
      const deck = deckWith({
        id: "image",
        type: "image",
        bounds: [0, 0, 100, 100],
        src: "media/../secret.png",
      });
      assert.throws(
        () => validateDeck(deck, { projectRoot: work, checkMedia: true }),
        (err) =>
          err instanceof OpenPptError && err.code === ErrorCodes.MEDIA_MISSING,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("applies the same validation boundary to the public preview API", () => {
    const deck = deckWith({
      id: "text",
      type: "text",
      bounds: [0, 0, 100, 40],
      text: "bad token",
      color: "$missing",
    });
    assert.throws(
      () => renderPreviewHtml(deck, root),
      (err) =>
        err instanceof OpenPptError && err.code === ErrorCodes.THEME_COLOR,
    );
  });

  it("rejects unsupported custom outline canvas sizes", () => {
    assert.throws(
      () =>
        outlineToDeck(
          { title: "Small", sections: [{ title: "One", bullets: [] }] },
          { size: [320, 180] },
        ),
      (err) => err instanceof OpenPptError && err.code === ErrorCodes.LAYOUT,
    );
  });

  it("validates imported IR before committing any project files", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-validate-"));
    try {
      const source = loadDeck(join(root, "fixtures/golden/deck.json"));
      const bytes = await compileToBuffer(source.deck, {
        projectRoot: source.projectRoot,
      });
      const zip = await JSZip.loadAsync(bytes);
      const slidePath = "ppt/slides/slide1.xml";
      const xml = await zip.file(slidePath).async("string");
      const invalidXml = xml.replace(
        /(<p:sp\b[\s\S]*?<a:off )x="\d+"/,
        '$1x="-9525"',
      );
      assert.notEqual(invalidXml, xml);
      zip.file(slidePath, invalidXml);
      const pptx = join(work, "invalid.pptx");
      writeFileSync(
        pptx,
        await zip.generateAsync({ type: "nodebuffer" }),
      );

      const dest = join(work, "imported");
      await assert.rejects(
        () => importPptx(pptx, dest),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.BOUNDS,
      );
      assert.equal(existsSync(join(dest, "deck.json")), false);
      assert.equal(existsSync(join(dest, "media")), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("rejects invalid imported media before committing the project", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-media-"));
    try {
      const source = loadDeck(join(root, "fixtures/golden/deck.json"));
      const bytes = await compileToBuffer(source.deck, {
        projectRoot: source.projectRoot,
      });
      const zip = await JSZip.loadAsync(bytes);
      const mediaPath = Object.keys(zip.files).find((path) =>
        /^ppt\/media\/.*\.png$/i.test(path),
      );
      assert.ok(mediaPath);
      zip.file(mediaPath, "not an image");
      const pptx = join(work, "invalid-media.pptx");
      writeFileSync(
        pptx,
        await zip.generateAsync({ type: "nodebuffer" }),
      );

      const dest = join(work, "imported");
      await assert.rejects(
        () => importPptx(pptx, dest),
        (err) =>
          err instanceof OpenPptError && err.code === ErrorCodes.MEDIA_TYPE,
      );
      assert.equal(existsSync(join(dest, "deck.json")), false);
      assert.equal(existsSync(join(dest, "media")), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not commit media relationships unused by imported slide elements", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-unused-media-"));
    try {
      const source = loadDeck(join(root, "fixtures/golden/deck.json"));
      const bytes = await compileToBuffer(source.deck, {
        projectRoot: source.projectRoot,
      });
      const zip = await JSZip.loadAsync(bytes);
      const relsPath = "ppt/slides/_rels/slide1.xml.rels";
      const rels = await zip.file(relsPath).async("string");
      zip.file("ppt/media/unused.png", "not an image");
      zip.file(
        relsPath,
        rels.replace(
          "</Relationships>",
          '<Relationship Id="rId999" Type="unused" Target="../media/unused.png"/></Relationships>',
        ),
      );
      const pptx = join(work, "unused-media.pptx");
      writeFileSync(
        pptx,
        await zip.generateAsync({ type: "nodebuffer" }),
      );

      const dest = join(work, "imported");
      await importPptx(pptx, dest);
      const imported = loadDeck(join(dest, "deck.json"));
      validateDeck(imported.deck, {
        projectRoot: imported.projectRoot,
        checkMedia: true,
      });
      const referenced = imported.deck.pages.flatMap((page) =>
        page.elements
          .filter((element) => element.type === "image")
          .map((element) => element.src),
      );
      assert.deepEqual(
        readdirSync(join(dest, "media")).sort(),
        referenced.map((src) => src.slice("media/".length)).sort(),
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
