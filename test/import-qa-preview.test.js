import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeck } from "../src/load.js";
import { compileToPptx } from "../src/compile.js";
import { importPptx, commitImportOutputs } from "../src/import-pptx.js";
import { ErrorCodes } from "../src/errors.js";
import { qaDeck, analyzeLayout } from "../src/qa.js";
import { writePreviewHtml, renderPreviewHtml } from "../src/preview.js";
import { validateDeck } from "../src/validate.js";
import { OpenPptError } from "../src/errors.js";
import { RESOURCE_LIMITS } from "../src/resource-limits.js";
import {
  grpSpXml,
  nestedGrpSpXml,
  picXml,
  pxToEmu,
  slideXmlWithBody,
  slideXmlWithText,
  spRectXml,
  textSpXml,
  theme1Xml,
  writeMinimalPptx,
} from "./helpers/pptx.js";

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

  it("qa composites transparent text instead of scoring 21:1", () => {
    const result = analyzeLayout({
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p1",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [
            {
              id: "ghost",
              type: "text",
              bounds: [100, 100, 400, 40],
              text: "invisible",
              color: "#00000000",
              fontSize: 18,
            },
          ],
        },
      ],
    });
    const issue = result.issues.find((i) => i.code === "LOW_CONTRAST");
    assert.ok(issue, "transparent black on white must not be treated as 21:1");
    assert.ok(issue.details.ratio < 2.5);
  });

  it("qa uses run-level color and the largest run fontSize", () => {
    const lowRun = analyzeLayout({
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p1",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [
            {
              id: "t",
              type: "text",
              bounds: [80, 80, 400, 40],
              color: "#111827",
              fontSize: 12,
              text: [
                { text: "ok" },
                { text: "faint", color: "#EEEEEE", fontSize: 36 },
              ],
            },
          ],
        },
      ],
    });
    assert.ok(lowRun.issues.some((i) => i.code === "LOW_CONTRAST" && /run\[1\]/.test(i.message)));

    const overflow = analyzeLayout({
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p1",
          elements: [
            {
              id: "t",
              type: "text",
              bounds: [10, 10, 80, 80],
              fontSize: 8,
              text: [
                {
                  text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                  fontSize: 48,
                },
              ],
            },
          ],
        },
      ],
    });
    assert.ok(overflow.issues.some((i) => i.code === "TEXT_OVERFLOW_RISK"));
    const capIssue = overflow.issues.find((i) => i.code === "TEXT_OVERFLOW_RISK");
    assert.equal(capIssue.details.fontSize, 48);
  });

  it("qa flags mixed-type overlap except text-on-shape", () => {
    const textOnShape = analyzeLayout({
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p1",
          elements: [
            {
              id: "s",
              type: "shape",
              bounds: [0, 0, 200, 100],
              shape: "rect",
              fill: "#2563EB",
            },
            {
              id: "t",
              type: "text",
              bounds: [10, 10, 180, 80],
              text: "label",
            },
          ],
        },
      ],
    });
    assert.equal(
      textOnShape.issues.some((i) => i.code === "OVERLAP"),
      false,
    );

    const textOnImage = analyzeLayout({
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p1",
          elements: [
            {
              id: "img",
              type: "image",
              bounds: [0, 0, 200, 100],
              src: "media/x.png",
            },
            {
              id: "t",
              type: "text",
              bounds: [10, 10, 180, 80],
              text: "caption",
            },
          ],
        },
      ],
    });
    const mixed = textOnImage.issues.find((i) => i.code === "OVERLAP");
    assert.ok(mixed);
    assert.equal(mixed.severity, "low");
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

  it("escapes script, attribute, and quote payloads in preview HTML", () => {
    const html = renderPreviewHtml(
      {
        version: "openppt-1",
        title: `</h1><script>alert(1)</script>'onclick='x`,
        size: [960, 540],
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "t",
                type: "text",
                bounds: [20, 20, 400, 40],
                text: `"><img onerror=alert(1)> and 'quote`,
              },
            ],
          },
        ],
      },
      root,
    );
    assert.doesNotMatch(html, /<script>/i);
    assert.doesNotMatch(html, /<img\s/i);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&quot;&gt;&lt;img onerror=/);
    assert.match(html, /&#39;quote/);
    assert.match(html, /&#39;onclick=&#39;/);
  });

  it("writes an HTML preview containing page markup", () => {
    const { deck, projectRoot } = loadDeck(join(root, "fixtures/golden/deck.json"));
    validateDeck(deck, { projectRoot, checkMedia: true });
    const outDir = mkdtempSync(join(tmpdir(), "openppt-preview-"));
    try {
      const htmlPath = join(outDir, "preview.html");
      writePreviewHtml(deck, projectRoot, htmlPath);
      const html = readFileSync(htmlPath, "utf8");
      assert.match(html, /OpenPPT Golden Fixture/);
      assert.match(html, /class="page"/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("fail-closes malformed unclosed-tag slides within a time bound", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-dos-"));
    try {
      const pptxPath = join(work, "malformed.pptx");
      const junk = `<p:sp ${"<p:sp ".repeat(80_000)}`;
      await writeMinimalPptx(pptxPath, {
        slides: [{ xml: `<?xml version="1.0"?><p:sld>${junk}` }],
      });
      const start = Date.now();
      let caught = null;
      try {
        await importPptx(pptxPath, join(work, "out"), { force: true });
      } catch (err) {
        caught = err;
      }
      assert.ok(Date.now() - start < 5000, "import must not hang on unclosed tags");
      if (caught) {
        assert.ok(caught instanceof OpenPptError || caught instanceof Error);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("orders imported pages from sldIdLst + rels, ignoring ghost slides", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-order-"));
    try {
      const pptxPath = join(work, "ordered.pptx");
      await writeMinimalPptx(pptxPath, {
        slides: [
          { path: "ppt/slides/slide1.xml", xml: slideXmlWithText("FIRST_FILENAME") },
          { path: "ppt/slides/slide2.xml", xml: slideXmlWithText("SECOND_FILENAME") },
          { path: "ppt/slides/slide3.xml", xml: slideXmlWithText("GHOST_SLIDE") },
        ],
        presentationRels: [
          { id: "rId2", target: "slides/slide2.xml" },
          { id: "rId3", target: "slides/slide1.xml" },
        ],
        sldIdLst: [
          { id: "256", rId: "rId2" },
          { id: "257", rId: "rId3" },
        ],
      });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const texts = loaded.deck.pages.map((page) =>
        page.elements.map((el) => el.text).join(""),
      );
      assert.deepEqual(texts, ["SECOND_FILENAME", "FIRST_FILENAME"]);
      assert.equal(
        texts.some((text) => text.includes("GHOST")),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("keeps only Fallback from AlternateContent", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-ac-"));
    try {
      const pptxPath = join(work, "ac.pptx");
      const extra = `
      <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
        <mc:Choice Requires="p14">
          <p:sp>
            <p:nvSpPr><p:cNvPr id="9" name="c"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="0" y="500000"/><a:ext cx="1828800" cy="457200"/></a:xfrm></p:spPr>
            <p:txBody><a:bodyPr/><a:p><a:r><a:t>CHOICE_TEXT</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </mc:Choice>
        <mc:Fallback>
          <p:sp>
            <p:nvSpPr><p:cNvPr id="10" name="f"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="0" y="500000"/><a:ext cx="1828800" cy="457200"/></a:xfrm></p:spPr>
            <p:txBody><a:bodyPr/><a:p><a:r><a:t>FALLBACK_TEXT</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </mc:Fallback>
      </mc:AlternateContent>`;
      await writeMinimalPptx(pptxPath, {
        slides: [{ xml: slideXmlWithText("BASE", extra) }],
      });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const blob = JSON.stringify(loaded.deck);
      assert.match(blob, /FALLBACK_TEXT/);
      assert.doesNotMatch(blob, /CHOICE_TEXT/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("preserves paragraph and line breaks from a:p and a:br", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-br-"));
    try {
      const pptxPath = join(work, "br.pptx");
      const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr>
      <p:txBody>
        <a:bodyPr/>
        <a:p><a:r><a:t>Line1</a:t></a:r><a:br/><a:r><a:t>Line2</a:t></a:r></a:p>
        <a:p><a:r><a:t>Para2</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const text = loaded.deck.pages[0].elements[0].text;
      assert.match(text, /Line1/);
      assert.match(text, /Line2/);
      assert.match(text, /Para2/);
      assert.match(text, /\n/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("parses slide relationships regardless of attribute order and quotes", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-rel-"));
    try {
      const pptxPath = join(work, "rel.pptx");
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:pic>
      <p:nvPicPr><p:cNvPr id="2" name="pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId9"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="95250" cy="95250"/></a:xfrm></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`;
      const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target='../media/image1.png' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Id="rId9"/>
</Relationships>`;
      await writeMinimalPptx(pptxPath, {
        slides: [{ xml: slide, rels }],
        extraFiles: { "ppt/media/image1.png": png },
      });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const images = loaded.deck.pages[0].elements.filter((el) => el.type === "image");
      assert.equal(images.length, 1);
      assert.match(images[0].src, /^media\//);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("expands grpSp children with OOXML group-space scale", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-grp-scale-"));
    try {
      const pptxPath = join(work, "grp.pptx");
      // Group 20×20px on slide, child space 10×10px → scale 2.
      // Child at (1,1) 4×2 in child space → slide (12,12) 8×4.
      const xml = slideXmlWithBody(
        grpSpXml({
          offX: pxToEmu(10),
          offY: pxToEmu(10),
          cx: pxToEmu(20),
          cy: pxToEmu(20),
          chCx: pxToEmu(10),
          chCy: pxToEmu(10),
          children: spRectXml({
            id: "9",
            name: "inner",
            offX: pxToEmu(1),
            offY: pxToEmu(1),
            cx: pxToEmu(4),
            cy: pxToEmu(2),
          }),
        }),
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(shapes.length, 1);
      assert.deepEqual(shapes[0].bounds, [12, 12, 8, 4]);
      assert.equal(
        imp.warnings.some((w) => /skipped \d+ grouped|child offsets are relative/i.test(w)),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("expands nested grpSp with composed transforms", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-grp-nest-"));
    try {
      const pptxPath = join(work, "nested.pptx");
      // Outer scale 2, inner additional scale 2 → child (1,1) 1×1 maps to (14,14) 4×4.
      const xml = slideXmlWithBody(
        grpSpXml({
          id: "8",
          offX: pxToEmu(10),
          offY: pxToEmu(10),
          cx: pxToEmu(20),
          cy: pxToEmu(20),
          chCx: pxToEmu(10),
          chCy: pxToEmu(10),
          children: grpSpXml({
            id: "9",
            name: "inner-g",
            offX: 0,
            offY: 0,
            cx: pxToEmu(10),
            cy: pxToEmu(10),
            chCx: pxToEmu(5),
            chCy: pxToEmu(5),
            children: spRectXml({
              id: "10",
              name: "leaf",
              offX: pxToEmu(1),
              offY: pxToEmu(1),
              cx: pxToEmu(1),
              cy: pxToEmu(1),
            }),
          }),
        }),
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(shapes.length, 1);
      assert.deepEqual(shapes[0].bounds, [14, 14, 4, 4]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("skips malformed grpSp without xfrm and records a warning", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-grp-"));
    try {
      const pptxPath = join(work, "grp.pptx");
      const xml = slideXmlWithBody(
        `${grpSpXml({
          xfrm: false,
          children: spRectXml({
            id: "9",
            name: "inner",
            offX: 0,
            offY: 0,
            cx: pxToEmu(10),
            cy: pxToEmu(10),
          }),
        })}${grpSpXml({
          id: "11",
          name: "zero",
          offX: pxToEmu(20),
          offY: pxToEmu(20),
          cx: pxToEmu(10),
          cy: pxToEmu(10),
          chCx: 0,
          chCy: 0,
          children: spRectXml({
            id: "12",
            name: "zero-child",
            offX: 0,
            offY: 0,
            cx: pxToEmu(10),
            cy: pxToEmu(10),
            fill: "00FF00",
          }),
        })}`,
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(shapes.length, 0);
      assert.ok(imp.warnings.some((w) => /grpSp|grouped/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("imports mixed run styles as IR rich text", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-runs-"));
    try {
      const pptxPath = join(work, "runs.pptx");
      const xml = slideXmlWithBody(`<p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p>
            <a:r><a:rPr b="1" sz="1800"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>Bold</a:t></a:r>
            <a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="DC2626"/></a:solidFill></a:rPr><a:t>Red</a:t></a:r>
            <a:r><a:rPr sz="2800"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>Big</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>`);
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      validateDeck(loaded.deck, { projectRoot: loaded.projectRoot, checkMedia: true });
      const el = loaded.deck.pages[0].elements[0];
      assert.equal(el.type, "text");
      assert.equal(Array.isArray(el.text), true);
      assert.equal(el.text.length, 3);
      assert.equal(el.text[0].text, "Bold");
      assert.equal(el.text[0].bold, true);
      assert.equal(el.text[1].text, "Red");
      assert.equal(el.text[1].color, "#DC2626");
      assert.equal(el.text[2].text, "Big");
      assert.equal(el.text[2].fontSize, 28);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("collapses homogeneous runs to a plain string", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-runs-same-"));
    try {
      const pptxPath = join(work, "same.pptx");
      const xml = slideXmlWithBody(`<p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="457200"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p>
            <a:r><a:rPr b="1" sz="2000"><a:solidFill><a:srgbClr val="2563EB"/></a:solidFill></a:rPr><a:t>Same</a:t></a:r>
            <a:r><a:rPr b="1" sz="2000"><a:solidFill><a:srgbClr val="2563EB"/></a:solidFill></a:rPr><a:t>Style</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>`);
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const el = loaded.deck.pages[0].elements[0];
      assert.equal(typeof el.text, "string");
      assert.equal(el.text, "SameStyle");
      assert.equal(el.fontSize, 20);
      assert.equal(el.bold, true);
      assert.equal(el.color, "#2563EB");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("keeps paragraph breaks across mixed-style runs", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-runs-br-"));
    try {
      const pptxPath = join(work, "br.pptx");
      const xml = slideXmlWithBody(`<p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:r><a:rPr b="1" sz="1800"/><a:t>A</a:t></a:r><a:br/><a:r><a:rPr sz="1800"/><a:t>B</a:t></a:r></a:p>
          <a:p><a:r><a:rPr sz="2400"/><a:t>C</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>`);
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const el = loaded.deck.pages[0].elements[0];
      assert.equal(Array.isArray(el.text), true);
      assert.equal(el.text.map((run) => run.text).join(""), "A\nB\nC");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("merges extra rich-text runs at the per-element ceiling", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-runs-cap-"));
    try {
      const pptxPath = join(work, "cap.pptx");
      const limit = RESOURCE_LIMITS.richTextRunsPerElement;
      const runXml = Array.from({ length: limit + 1 }, (_, i) =>
        `<a:r><a:rPr ${i % 2 === 0 ? 'b="1"' : 'sz="1800"'}/><a:t>r${i}</a:t></a:r>`,
      ).join("");
      const xml = slideXmlWithBody(`<p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="457200"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:p>${runXml}</a:p></p:txBody>
      </p:sp>`);
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      validateDeck(loaded.deck, { projectRoot: loaded.projectRoot, checkMedia: true });
      const el = loaded.deck.pages[0].elements[0];
      assert.equal(Array.isArray(el.text), true);
      assert.equal(el.text.length, limit);
      assert.ok(el.text[limit - 1].text.includes(`r${limit - 1}`));
      assert.ok(el.text[limit - 1].text.includes(`r${limit}`));
      assert.ok(imp.warnings.some((w) => /richTextRunsPerElement|rich-text run/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("clamps partially off-canvas group children and skips fully off-canvas ones", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-clamp-"));
    try {
      const pptxPath = join(work, "clamp.pptx");
      const xml = slideXmlWithBody(
        grpSpXml({
          offX: pxToEmu(940),
          offY: pxToEmu(10),
          cx: pxToEmu(40),
          cy: pxToEmu(20),
          chCx: pxToEmu(20),
          chCy: pxToEmu(20),
          children: `${spRectXml({
            id: "9",
            name: "partial",
            offX: pxToEmu(5),
            offY: 0,
            cx: pxToEmu(10),
            cy: pxToEmu(10),
            fill: "FF0000",
          })}${spRectXml({
            id: "10",
            name: "outside",
            offX: pxToEmu(15),
            offY: 0,
            cx: pxToEmu(5),
            cy: pxToEmu(10),
            fill: "00FF00",
          })}`,
        }),
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      validateDeck(loaded.deck, {
        projectRoot: loaded.projectRoot,
        checkMedia: true,
      });
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(shapes.length, 1);
      assert.deepEqual(shapes[0].bounds, [950, 10, 10, 10]);
      assert.equal(shapes[0].fill, "#FF0000");
      assert.ok(imp.warnings.some((w) => /clamped/i.test(w)));
      assert.ok(imp.warnings.some((w) => /skipped off-canvas element/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("preserves spTree document order across leaves and groups", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-zorder-"));
    try {
      const pptxPath = join(work, "z.pptx");
      const xml = slideXmlWithBody(
        `${textSpXml({ id: "2", name: "first", text: "FIRST", offY: 0 })}${grpSpXml({
          id: "8",
          offX: 0,
          offY: pxToEmu(50),
          cx: pxToEmu(200),
          cy: pxToEmu(50),
          chCx: pxToEmu(200),
          chCy: pxToEmu(50),
          children: textSpXml({
            id: "9",
            name: "mid",
            text: "GROUPED",
            offX: 0,
            offY: 0,
            cx: pxToEmu(200),
            cy: pxToEmu(40),
          }),
        })}${textSpXml({
          id: "10",
          name: "last",
          text: "LAST",
          offY: pxToEmu(120),
        })}`,
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const texts = loaded.deck.pages[0].elements.map((el) =>
        typeof el.text === "string"
          ? el.text
          : (el.text || []).map((run) => run.text).join(""),
      );
      assert.deepEqual(texts, ["FIRST", "GROUPED", "LAST"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("skips groups whose xfrm has non-zero rot", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-rot-"));
    try {
      const pptxPath = join(work, "rot.pptx");
      const xml = slideXmlWithBody(
        `${textSpXml({
          id: "2",
          name: "leaf",
          text: "LEAF",
          rot: 60000,
        })}${grpSpXml({
          id: "8",
          rot: 5400000,
          offX: pxToEmu(20),
          offY: pxToEmu(20),
          cx: pxToEmu(40),
          cy: pxToEmu(40),
          chCx: pxToEmu(40),
          chCy: pxToEmu(40),
          children: spRectXml({
            id: "9",
            name: "rotated-child",
            offX: 0,
            offY: 0,
            cx: pxToEmu(20),
            cy: pxToEmu(20),
          }),
        })}`,
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const page = loaded.deck.pages[0];
      const texts = page.elements.filter((el) => el.type === "text");
      const shapes = page.elements.filter((el) => el.type === "shape");
      assert.equal(texts.length, 1);
      assert.equal(texts[0].text, "LEAF");
      assert.equal(shapes.length, 0);
      assert.ok(imp.warnings.some((w) => /rot|flip/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("skips groups whose xfrm has flipH or flipV", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-flip-"));
    try {
      const pptxPath = join(work, "flip.pptx");
      const xml = slideXmlWithBody(
        grpSpXml({
          flipH: true,
          offX: pxToEmu(20),
          offY: pxToEmu(20),
          cx: pxToEmu(40),
          cy: pxToEmu(40),
          chCx: pxToEmu(40),
          chCy: pxToEmu(40),
          children: spRectXml({
            id: "9",
            name: "flipped-child",
            offX: 0,
            offY: 0,
            cx: pxToEmu(20),
            cy: pxToEmu(20),
          }),
        }),
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(shapes.length, 0);
      assert.ok(imp.warnings.some((w) => /flip|rot/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("maps schemeClr accent1 from theme1.xml for text and shape fill", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-scheme-"));
    try {
      const pptxPath = join(work, "scheme.pptx");
      const xml = slideXmlWithBody(
        `${textSpXml({
          id: "2",
          name: "t",
          text: "Accent",
          schemeText: "accent1",
        })}${spRectXml({
          id: "3",
          name: "s",
          offX: pxToEmu(10),
          offY: pxToEmu(60),
          cx: pxToEmu(40),
          cy: pxToEmu(20),
          fill: "00FF00",
        }).replace(
          '<a:srgbClr val="00FF00"/>',
          '<a:schemeClr val="accent1"/>',
        )}${textSpXml({
          id: "4",
          name: "alias",
          text: "Alias",
          offY: pxToEmu(100),
          schemeText: "tx1",
        })}`,
      );
      await writeMinimalPptx(pptxPath, {
        slides: [{ xml }],
        extraFiles: { "ppt/theme/theme1.xml": theme1Xml({ accent1: "CC3366", dk1: "112233" }) },
      });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const texts = loaded.deck.pages[0].elements.filter((el) => el.type === "text");
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(texts[0].color, "#CC3366");
      assert.equal(shapes.length, 1);
      assert.equal(shapes[0].fill, "#CC3366");
      assert.equal(texts[1].color, "#112233");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("expands a pic inside a scaled grpSp to exact slide px", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-grp-pic-"));
    try {
      const pptxPath = join(work, "pic.pptx");
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const xml = slideXmlWithBody(
        grpSpXml({
          offX: pxToEmu(10),
          offY: pxToEmu(10),
          cx: pxToEmu(20),
          cy: pxToEmu(20),
          chCx: pxToEmu(10),
          chCy: pxToEmu(10),
          children: picXml({
            id: "9",
            name: "inner-pic",
            offX: pxToEmu(1),
            offY: pxToEmu(1),
            cx: pxToEmu(4),
            cy: pxToEmu(2),
            embed: "rId9",
          }),
        }),
      );
      const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`;
      await writeMinimalPptx(pptxPath, {
        slides: [{ xml, rels }],
        extraFiles: { "ppt/media/image1.png": png },
      });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const images = loaded.deck.pages[0].elements.filter((el) => el.type === "image");
      assert.equal(images.length, 1);
      assert.deepEqual(images[0].bounds, [12, 12, 8, 4]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("expands eight nested groups and skips the ninth", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-depth-"));
    try {
      const pptxPath = join(work, "depth.pptx");
      const leaf = spRectXml({
        id: "99",
        name: "deep",
        offX: pxToEmu(10),
        offY: pxToEmu(10),
        cx: pxToEmu(20),
        cy: pxToEmu(20),
      });
      const eight = nestedGrpSpXml(8, leaf);
      const nine = nestedGrpSpXml(
        9,
        spRectXml({
          id: "98",
          name: "too-deep",
          offX: pxToEmu(10),
          offY: pxToEmu(40),
          cx: pxToEmu(20),
          cy: pxToEmu(20),
          fill: "00FF00",
        }),
      );
      const xml = slideXmlWithBody(`${eight}${nine}`);
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(shapes.length, 1);
      assert.deepEqual(shapes[0].bounds, [10, 10, 20, 20]);
      assert.equal(shapes[0].fill, "#FF0000");
      assert.ok(imp.warnings.some((w) => /nesting exceeds/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("removes newly created empty import directories on rollback", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-import-empty-dir-"));
    try {
      const dest = join(work, "fresh-out");
      assert.equal(existsSync(dest), false);
      assert.throws(
        () =>
          commitImportOutputs(
            dest,
            [
              { relativePath: "media/a.png", data: "x" },
              { relativePath: "deck.json", data: "{}" },
            ],
            true,
            {
              renameSync(from, to) {
                if (String(to).endsWith("deck.json")) {
                  throw new Error("injected commit failure");
                }
                return renameSync(from, to);
              },
            },
          ),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.EXPORT,
      );
      assert.equal(existsSync(dest), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
