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

  it("qa treats fontSize as points and warns nonempty zero-capacity text", () => {
    const crowded = analyzeLayout({
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "t",
              type: "text",
              bounds: [100, 100, 400, 100],
              text: "A".repeat(70),
              fontSize: 24,
            },
          ],
        },
      ],
    });
    assert.ok(
      crowded.issues.some((i) => i.code === "TEXT_OVERFLOW_RISK"),
      "70 glyphs at 24pt in 400x100 must overflow once capacity uses CSS px",
    );

    const tiny = analyzeLayout({
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "t",
              type: "text",
              bounds: [100, 100, 20, 20],
              text: "X",
              fontSize: 200,
            },
          ],
        },
      ],
    });
    const zero = tiny.issues.find((i) => i.code === "TEXT_OVERFLOW_RISK");
    assert.ok(zero, "a single character with zero estimated capacity must warn");
    assert.equal(zero.details.chars, 1);
    assert.ok(zero.details.cap <= 0);
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

  it("preview maps point fonts, default insets, run styles, and table/shape strokes", () => {
    const html = renderPreviewHtml(
      {
        version: "openppt-1",
        title: "Style mapping",
        size: [960, 540],
        theme: { colors: { primary: "#0F766E", text: "#111827", background: "#FFFFFF" } },
        pages: [
          {
            id: "style",
            background: { type: "solid", color: "$background" },
            elements: [
              {
                id: "plain",
                type: "text",
                bounds: [40, 20, 880, 80],
                text: "POINT SIZE",
                fontSize: 24,
                fontFamily: "Arial",
                bold: true,
                align: "center",
                valign: "middle",
              },
              {
                id: "runs",
                type: "text",
                bounds: [40, 130, 400, 100],
                fontFamily: "Arial",
                fontSize: 18,
                bold: true,
                text: [
                  { text: "A\nB" },
                  { text: "C", bold: false, italic: true, color: "#DC2626" },
                  { text: "\nD", fontFamily: "Rock'n'Roll One", fontSize: 12 },
                ],
              },
              {
                id: "shape",
                type: "shape",
                shape: "roundRect",
                bounds: [500, 130, 400, 100],
                fill: "#DBEAFE",
                lineColor: "#DC2626",
                lineWidth: 3,
              },
              {
                id: "table",
                type: "table",
                bounds: [40, 300, 860, 150],
                header: true,
                fontSize: 18,
                borderWidth: 1.5,
                borderColor: "#334155",
                colW: [1, 3],
                rows: [
                  ["LABEL", "VALUE"],
                  [
                    {
                      text: "cell A",
                      fontSize: 15,
                      bold: true,
                      color: "#7C3AED",
                      fill: "#EDE9FE",
                      align: "right",
                    },
                    42,
                  ],
                ],
              },
            ],
          },
        ],
      },
      root,
    );
    assert.match(html, /font-size:32px/);
    assert.match(html, /font-size:24px/);
    assert.match(html, /font-size:16px/);
    assert.match(html, /font-size:20px/);
    assert.match(html, /padding:4\.8px 9\.6px/);
    assert.match(html, /font-family:&quot;Arial&quot;/);
    assert.match(html, /class="text-inner"/);
    assert.match(html, /font-style:italic/);
    assert.match(html, /font-weight:400/);
    assert.match(html, /Rock'n'Roll One/);
    assert.match(html, /border:4px solid #DC2626/);
    assert.match(html, /border:2px solid #334155/);
    assert.match(html, /width:25%/);
    assert.match(html, /width:75%/);
    assert.match(html, /background:#0F766E/);
    assert.match(html, /background:#EDE9FE/);
    assert.match(html, /text-align:right/);
  });

  it("preview defaults omitted fontFamily to Arial like compile", () => {
    const html = renderPreviewHtml(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              {
                id: "t",
                type: "text",
                bounds: [50, 50, 500, 100],
                text: [{ text: "Default font" }],
                fontSize: 24,
              },
              {
                id: "plain",
                type: "text",
                bounds: [50, 160, 500, 40],
                text: "also default",
                fontSize: 18,
              },
            ],
          },
        ],
      },
      root,
    );
    assert.match(html, /font-family:&quot;Arial&quot;/);
    assert.equal((html.match(/font-family:&quot;Arial&quot;/g) || []).length >= 2, true);
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

function spPrShapeXml({
  id = "2",
  name = "s",
  offX = 0,
  offY = 0,
  cx = pxToEmu(40),
  cy = pxToEmu(20),
  spPrInner = "",
  text,
}) {
  const txBody =
    text == null
      ? ""
      : `<p:txBody><a:bodyPr/><a:p><a:pPr/><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>`;
  return `<p:sp>
      <p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${text != null ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        ${spPrInner}
      </p:spPr>
      ${txBody}
    </p:sp>`;
}

describe("import batch 1 correctness", () => {
  it("scopes shape fill/noFill to direct p:spPr children, not a:ln", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-fill-"));
    try {
      const pptxPath = join(work, "fill.pptx");
      const xml = slideXmlWithBody(
        `${spPrShapeXml({
          id: "2",
          name: "filled-noborder",
          spPrInner: `<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:ln w="25400"><a:noFill/></a:ln>`,
        })}${spPrShapeXml({
          id: "3",
          name: "outline-only",
          offY: pxToEmu(40),
          spPrInner: `<a:noFill/><a:ln w="25400"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln>`,
        })}`,
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(shapes.length, 1);
      assert.equal(shapes[0].fill, "#FF0000");
      assert.equal(
        loaded.deck.pages[0].elements.some((el) => el.fill === "#00FF00"),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("skips XML comments, CDATA, and PIs as units when reading p:spPr fill", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-comment-fill-"));
    try {
      const pptxPath = join(work, "comment-fill.pptx");
      const xml = slideXmlWithBody(
        `${spPrShapeXml({
          id: "2",
          name: "commented",
          spPrInner: `<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><!-- ignored <a:foo/> <a:noFill/> -->`,
        })}${spPrShapeXml({
          id: "3",
          name: "cdata",
          offY: pxToEmu(40),
          spPrInner: `<a:solidFill><a:srgbClr val="0000FF"/></a:solidFill><![CDATA[ <a:foo/> <a:noFill/> ]]>`,
        })}${spPrShapeXml({
          id: "4",
          name: "pi",
          offY: pxToEmu(80),
          spPrInner: `<a:solidFill><a:srgbClr val="00AA00"/></a:solidFill><?ignored <a:foo/> <a:noFill/> ?>`,
        })}`,
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const fills = loaded.deck.pages[0].elements
        .filter((el) => el.type === "shape")
        .map((el) => el.fill)
        .sort();
      assert.deepEqual(fills, ["#0000FF", "#00AA00", "#FF0000"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("emits a filled shape behind contained text with unique ids", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-shape-text-"));
    try {
      const pptxPath = join(work, "shape-text.pptx");
      const xml = slideXmlWithBody(
        spPrShapeXml({
          id: "2",
          name: "label",
          spPrInner: `<a:solidFill><a:srgbClr val="2563EB"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="F59E0B"/></a:solidFill></a:ln>`,
          text: "LABEL",
        }),
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      validateDeck(loaded.deck, {
        projectRoot: loaded.projectRoot,
        checkMedia: true,
      });
      const els = loaded.deck.pages[0].elements;
      assert.equal(els.length, 2);
      assert.equal(els[0].type, "shape");
      assert.equal(els[0].fill, "#2563EB");
      assert.equal(els[1].type, "text");
      assert.equal(els[1].text, "LABEL");
      assert.deepEqual(els[0].bounds, els[1].bounds);
      assert.notEqual(els[0].id, els[1].id);
      assert.equal(
        els.some((el) => el.fill === "#F59E0B" || el.color === "#F59E0B"),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("keeps transparent and text-only shapes as text-only", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-text-only-"));
    try {
      const pptxPath = join(work, "text-only.pptx");
      const xml = slideXmlWithBody(
        `${spPrShapeXml({
          id: "2",
          name: "ghost",
          spPrInner: `<a:noFill/><a:ln w="25400"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln>`,
          text: "GHOST",
        })}${spPrShapeXml({
          id: "3",
          name: "plain",
          offY: pxToEmu(40),
          text: "PLAIN",
        })}`,
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const els = loaded.deck.pages[0].elements;
      assert.deepEqual(
        els.map((el) => el.type),
        ["text", "text"],
      );
      assert.deepEqual(
        els.map((el) => el.text),
        ["GHOST", "PLAIN"],
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("maps paragraph algn ctr/l/r as full tokens and drops unsupported values", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-algn-"));
    try {
      const pptxPath = join(work, "algn.pptx");
      const box = (id, y, algn, text, extraPPr = "") => `<p:sp>
        <p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="${y}"/><a:ext cx="${pxToEmu(200)}" cy="${pxToEmu(30)}"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:pPr algn="${algn}"${extraPPr}/><a:r><a:t>${text}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>`;
      const xml = slideXmlWithBody(
        `${box("2", 0, "ctr", "CENTER")}${box("3", pxToEmu(40), "l", "LEFT")}${box("4", pxToEmu(80), "r", "RIGHT")}${box("5", pxToEmu(120), "just", "JUST")}`,
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const texts = loaded.deck.pages[0].elements.filter((el) => el.type === "text");
      assert.equal(texts.length, 4);
      assert.equal(texts[0].text, "CENTER");
      assert.equal(texts[0].align, "center");
      assert.equal(texts[1].text, "LEFT");
      assert.equal(texts[1].align, "left");
      assert.equal(texts[2].text, "RIGHT");
      assert.equal(texts[2].align, "right");
      assert.equal(texts[3].text, "JUST");
      assert.equal(texts[3].align, "left");
      assert.ok(imp.warnings.some((w) => /unsupported paragraph align 'just'/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("reads off/ext and group chOff/chExt regardless of attribute order", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-geom-"));
    try {
      const pptxPath = join(work, "geom.pptx");
      const xml = slideXmlWithBody(`<p:grpSp>
      <p:nvGrpSpPr><p:cNvPr id="8" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm>
        <a:off y="${pxToEmu(10)}" x="${pxToEmu(10)}"/>
        <a:ext cy="${pxToEmu(20)}" cx="${pxToEmu(20)}"/>
        <a:chOff y='0' x='0'/>
        <a:chExt cy='${pxToEmu(10)}' cx='${pxToEmu(10)}'/>
      </a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="9" name="inner"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off y="${pxToEmu(1)}" x="${pxToEmu(1)}"/>
            <a:ext cy="${pxToEmu(2)}" cx="${pxToEmu(4)}"/>
          </a:xfrm>
          <a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
        </p:spPr>
      </p:sp>
    </p:grpSp>`);
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(shapes.length, 1);
      assert.deepEqual(shapes[0].bounds, [12, 12, 8, 4]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("resolves pic embeds by actual relationship Id, not rIdN naming", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-pic-rid-"));
    try {
      const pptxPath = join(work, "pic.pptx");
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const xml = slideXmlWithBody(
        picXml({
          offX: 0,
          offY: 0,
          cx: pxToEmu(10),
          cy: pxToEmu(10),
          embed: "picRel",
        }),
      );
      const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="../media/image1.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Id="picRel"/>
</Relationships>`;
      await writeMinimalPptx(pptxPath, {
        slides: [{ xml, rels }],
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

  it("selects slides by relationship type and ZIP membership, not slideN names", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-slide-rel-"));
    try {
      const pptxPath = join(work, "slides.pptx");
      const notesType =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
      const slideType =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
      await writeMinimalPptx(pptxPath, {
        slides: [
          { path: "ppt/slides/slide1.xml", xml: slideXmlWithText("NOTES_TARGET") },
          { path: "ppt/slides/home.xml", xml: slideXmlWithText("HOME") },
          { path: "ppt/slides/slide9.xml", xml: slideXmlWithText("GHOST") },
        ],
        presentationRels: [
          { id: "rId2", target: "slides/slide1.xml", type: notesType },
          { id: "rId3", target: "slides/home.xml", type: slideType },
          { id: "rId4", target: "slides/missing.xml", type: slideType },
        ],
        sldIdLst: [
          { id: "256", rId: "rId2" },
          { id: "257", rId: "rId3" },
          { id: "258", rId: "rId4" },
        ],
      });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const texts = loaded.deck.pages.map((page) =>
        page.elements.map((el) => el.text).join(""),
      );
      assert.deepEqual(texts, ["HOME"]);
      assert.ok(
        imp.warnings.some((w) =>
          /sldIdLst/.test(w) && /rId2/.test(w) && /unresolved/i.test(w),
        ),
        "notes relationship selected from sldIdLst must warn",
      );
      assert.ok(
        imp.warnings.some((w) =>
          /sldIdLst/.test(w) && /rId4/.test(w) && /missing/i.test(w),
        ),
        "missing slide part selected from sldIdLst must warn",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("falls back to slide relationships when sldIdLst is empty", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-sldid-fallback-"));
    try {
      const pptxPath = join(work, "fallback.pptx");
      await writeMinimalPptx(pptxPath, {
        slides: [
          { path: "ppt/slides/slide1.xml", xml: slideXmlWithText("FILE_FIRST") },
          { path: "ppt/slides/b.xml", xml: slideXmlWithText("REL_FIRST") },
        ],
        presentationRels: [
          { id: "rId2", target: "slides/b.xml" },
          { id: "rId3", target: "slides/slide1.xml" },
        ],
        sldIdLst: [],
      });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const texts = loaded.deck.pages.map((page) =>
        page.elements.map((el) => el.text).join(""),
      );
      assert.deepEqual(texts, ["REL_FIRST", "FILE_FIRST"]);
      assert.ok(imp.warnings.some((w) => /falling back to slide relationships/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("derives a slide part rels path from the part name, not ppt/slides", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-rels-path-"));
    try {
      const pptxPath = join(work, "custom.pptx");
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const xml = slideXmlWithBody(
        picXml({
          offX: 0,
          offY: 0,
          cx: pxToEmu(10),
          cy: pxToEmu(10),
          embed: "rId9",
        }),
      );
      const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../../media/image1.png"/>
</Relationships>`;
      await writeMinimalPptx(pptxPath, {
        slides: [{ path: "ppt/deck/pages/home.xml", xml }],
        presentationRels: [
          {
            id: "rId2",
            target: "deck/pages/home.xml",
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
          },
        ],
        sldIdLst: [{ id: "256", rId: "rId2" }],
        extraFiles: {
          "ppt/deck/pages/_rels/home.xml.rels": rels,
          "ppt/media/image1.png": png,
        },
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

  it("substitutes AlternateContent Fallback with literal replacement semantics", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-ac-literal-"));
    try {
      const pptxPath = join(work, "ac.pptx");
      const expected = "KEEP$&END$'TAIL$`HEAD$$DOLLAR";
      const xmlText = expected.replaceAll("&", "&amp;");
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
            <p:txBody><a:bodyPr/><a:p><a:r><a:t>${xmlText}</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </mc:Fallback>
      </mc:AlternateContent>`;
      await writeMinimalPptx(pptxPath, {
        slides: [{ xml: slideXmlWithText("BASE", extra) }],
      });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const blob = JSON.stringify(loaded.deck);
      assert.match(blob, /BASE/);
      assert.doesNotMatch(blob, /CHOICE_TEXT/);
      const texts = loaded.deck.pages[0].elements
        .filter((el) => el.type === "text")
        .map((el) => el.text);
      assert.equal(texts.includes(expected), true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("warns and drops unsupported direct shape fills", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-grad-"));
    try {
      const pptxPath = join(work, "grad.pptx");
      const xml = slideXmlWithBody(
        `${spPrShapeXml({
          id: "2",
          name: "grad",
          spPrInner: `<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst></a:gradFill>`,
        })}${spPrShapeXml({
          id: "3",
          name: "ok",
          offY: pxToEmu(40),
          spPrInner: `<a:solidFill><a:srgbClr val="0000FF"/></a:solidFill>`,
        })}`,
      );
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(shapes.length, 1);
      assert.equal(shapes[0].fill, "#0000FF");
      assert.ok(imp.warnings.some((w) => /dropped unsupported shape fill a:gradFill/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("skips connectors with a targeted loss warning", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-cxn-"));
    try {
      const pptxPath = join(work, "cxn.pptx");
      const xml = slideXmlWithBody(`<p:cxnSp>
        <p:nvCxnSpPr><p:cNvPr id="2" name="connector"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="${pxToEmu(40)}" cy="${pxToEmu(20)}"/></a:xfrm>
          <a:prstGeom prst="line"><a:avLst/></a:prstGeom>
          <a:ln w="25400"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:ln>
        </p:spPr>
      </p:cxnSp>${spPrShapeXml({
        id: "3",
        name: "keep",
        offY: pxToEmu(40),
        spPrInner: `<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>`,
      })}`);
      await writeMinimalPptx(pptxPath, { slides: [{ xml }] });
      const imp = await importPptx(pptxPath, join(work, "out"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      const shapes = loaded.deck.pages[0].elements.filter((el) => el.type === "shape");
      assert.equal(shapes.length, 1);
      assert.equal(shapes[0].fill, "#FF0000");
      assert.ok(imp.warnings.some((w) => /skipped connector \(p:cxnSp\)/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("warns when a picture is missing transform, embed, or media", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-b1-pic-drop-"));
    try {
      const pptxPath = join(work, "pic-drop.pptx");
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const xml = slideXmlWithBody(`<p:pic>
        <p:nvPicPr><p:cNvPr id="2" name="no-xfrm"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId9"/></p:blipFill>
        <p:spPr/>
      </p:pic><p:pic>
        <p:nvPicPr><p:cNvPr id="3" name="no-embed"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${pxToEmu(10)}" cy="${pxToEmu(10)}"/></a:xfrm></p:spPr>
      </p:pic><p:pic>
        <p:nvPicPr><p:cNvPr id="4" name="no-media"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="missingRel"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="${pxToEmu(20)}" y="0"/><a:ext cx="${pxToEmu(10)}" cy="${pxToEmu(10)}"/></a:xfrm></p:spPr>
      </p:pic>`);
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
      assert.equal(images.length, 0);
      assert.ok(imp.warnings.some((w) => /skipped picture.*missing transform/i.test(w)));
      assert.ok(imp.warnings.some((w) => /skipped picture.*missing embed/i.test(w)));
      assert.ok(imp.warnings.some((w) => /skipped picture.*missing media/i.test(w)));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
