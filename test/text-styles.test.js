import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { loadDeck } from "../src/load.js";
import { validateDeck } from "../src/validate.js";
import { compileToBuffer, compileToPptx } from "../src/compile.js";
import { renderPreviewHtml } from "../src/preview.js";
import { qaDeck } from "../src/qa.js";
import { OpenPptError, ErrorCodes } from "../src/errors.js";
import { RESOURCE_LIMITS } from "../src/resource-limits.js";
import { openPptx, readPptxEntry } from "./helpers/pptx.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let outDir;

function latinFaces(xml) {
  return [...xml.matchAll(/<a:latin\b[^>]*\btypeface="([^"]*)"/g)].map((m) => m[1]);
}

function eaFaces(xml) {
  return [...xml.matchAll(/<a:ea\b[^>]*\btypeface="([^"]*)"/g)].map((m) => m[1]);
}

function styleDeck() {
  return {
    version: "openppt-1",
    title: "C1 style slice",
    size: [960, 540],
    theme: {
      colors: { text: "#111827", primary: "#2563EB", background: "#FFFFFF" },
      textStyles: {
        heading: {
          fontSize: 28,
          bold: true,
          italic: true,
          color: "$primary",
        },
        body: {
          fontSize: 20,
          bold: true,
          italic: true,
          color: "$text",
          align: "left",
        },
      },
    },
    pages: [
      {
        id: "style-page",
        elements: [
          {
            id: "heading",
            type: "text",
            bounds: [48, 32, 864, 80],
            style: "$heading",
            text: "可执行样式 · Executable styles",
            italic: false,
          },
          {
            id: "body",
            type: "text",
            bounds: [48, 145, 864, 260],
            style: "$body",
            bold: false,
            text: [
              { text: "中文正文保持可读。Latin body.\n" },
              {
                text: "Run override / 独立东亚字体",
                fontFamily: "Times New Roman",
                bold: true,
                italic: false,
                fontSize: 24,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("C1 text style resolution (validate path)", () => {
  it("resolves $heading/$body with explicit false and run override winning", () => {
    const deck = styleDeck();
    const before = JSON.stringify(deck);
    const result = validateDeck(deck, { checkMedia: false });
    assert.equal(JSON.stringify(deck), before, "caller mutation");
    const [heading, body] = result.deck.pages[0].elements;
    assert.equal(heading.fontSize, 28);
    assert.equal(heading.italic, false);
    assert.equal(heading.bold, true);
    assert.equal(heading.color, "$primary");
    assert.equal(heading.style, "$heading");
    assert.equal(body.bold, false);
    assert.equal(body.italic, true);
    assert.equal(body.fontSize, 20);
    assert.equal(body.align, "left");
    assert.equal(body.style, "$body");
    assert.equal(body.text[1].fontFamily, "Times New Roman");
    assert.equal(body.text[1].italic, false);
    assert.equal(body.text[1].bold, true);
    assert.equal(body.text[1].fontSize, 24);
    assert.deepEqual(
      validateDeck(result.deck, { checkMedia: false }).deck,
      result.deck,
      "idempotence",
    );
  });

  it("rejects unknown and prototype style names", () => {
    for (const name of ["$missing", "$toString", "$constructor"]) {
      const deck = styleDeck();
      deck.pages[0].elements[0].style = name;
      assert.throws(
        () => validateDeck(deck, { checkMedia: false }),
        (err) =>
          err instanceof OpenPptError &&
          err.code === ErrorCodes.SCHEMA &&
          /style/i.test(err.message),
      );
    }
  });

  it("rejects unused invalid style definitions before resolution", () => {
    for (const mutate of [
      (d) => {
        d.theme.textStyles.unused = { fontSize: Infinity };
      },
      (d) => {
        d.theme.textStyles.unused = { bold: "false" };
      },
    ]) {
      const deck = styleDeck();
      mutate(deck);
      assert.throws(
        () => validateDeck(deck, { checkMedia: false }),
        (err) => err instanceof OpenPptError,
      );
    }
  });
});

describe("C1 theme fonts and export artifacts", () => {
  before(() => {
    outDir = mkdtempSync(join(tmpdir(), "openppt-c1-"));
  });

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("applies theme.fonts.latin when element and style omit fontFamily", () => {
    const deck = styleDeck();
    deck.theme.fonts = { latin: "Arial", ea: "Noto Sans CJK SC" };
    const result = validateDeck(deck, { checkMedia: false });
    assert.equal(result.deck.pages[0].elements[1].fontFamily, "Arial");
    assert.equal(result.deck.pages[0].elements[1].text[1].fontFamily, "Times New Roman");
  });

  it("rejects unsafe theme.fonts.ea before export", () => {
    const deck = styleDeck();
    deck.theme.fonts = { latin: "Arial", ea: 'Bad"Font' };
    assert.throws(
      () => validateDeck(deck, { checkMedia: false }),
      (err) => err instanceof OpenPptError && err.code === ErrorCodes.SCHEMA,
    );
  });

  it("does not copy group styles; text children may reference them", () => {
    const deck = styleDeck();
    deck.pages = [
      {
        id: "g-page",
        elements: [
          {
            id: "col",
            type: "group",
            layout: "stack",
            bounds: [48, 40, 864, 400],
            gap: 16,
            children: [
              {
                id: "g-heading",
                type: "text",
                height: 64,
                style: "$heading",
                text: "Group heading",
                italic: false,
              },
              {
                id: "g-body",
                type: "text",
                flex: 1,
                style: "$body",
                bold: false,
                text: "Group body",
              },
            ],
          },
        ],
      },
    ];
    const result = validateDeck(deck, { checkMedia: false });
    assert.equal(
      result.deck.pages[0].elements.some((el) => el.type === "group"),
      false,
    );
    const heading = result.deck.pages[0].elements.find((el) => el.id === "g-heading");
    const body = result.deck.pages[0].elements.find((el) => el.id === "g-body");
    assert.equal(heading.fontSize, 28);
    assert.equal(heading.italic, false);
    assert.equal(body.bold, false);
  });

  it("resolves styles loaded from a page file", () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-c1-multi-"));
    try {
      mkdirSync(join(dir, "pages"));
      writeFileSync(
        join(dir, "deck.json"),
        JSON.stringify({
          version: "openppt-1",
          title: "multi styles",
          size: [960, 540],
          theme: {
            colors: { text: "#111827" },
            fonts: { latin: "Georgia" },
            textStyles: { body: { fontSize: 18, italic: true, color: "$text" } },
          },
          pages: ["pages/one.json"],
        }),
      );
      writeFileSync(
        join(dir, "pages/one.json"),
        JSON.stringify({
          id: "one",
          elements: [
            {
              id: "t",
              type: "text",
              bounds: [40, 40, 800, 200],
              style: "$body",
              text: "Loaded from a page file",
            },
          ],
        }),
      );
      const { deck, projectRoot } = loadDeck(join(dir, "deck.json"));
      const result = validateDeck(deck, { projectRoot, checkMedia: false });
      const el = result.deck.pages[0].elements[0];
      assert.equal(el.fontSize, 18);
      assert.equal(el.italic, true);
      assert.equal(el.fontFamily, "Georgia");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces the named text style ceiling", () => {
    const textStyles = {};
    for (let i = 0; i < RESOURCE_LIMITS.namedTextStyles; i += 1) {
      textStyles[`s${i}`] = { fontSize: 12 };
    }
    const base = {
      version: "openppt-1",
      size: [960, 540],
      theme: { textStyles },
      pages: [
        {
          id: "p1",
          elements: [
            { id: "t", type: "text", bounds: [0, 0, 40, 20], text: "x" },
          ],
        },
      ],
    };
    assert.equal(validateDeck(base, { checkMedia: false }).ok, true);
    textStyles.extra = { fontSize: 12 };
    assert.throws(
      () => validateDeck(base, { checkMedia: false }),
      (err) =>
        err instanceof OpenPptError &&
        err.code === ErrorCodes.RESOURCE_LIMIT &&
        err.details.limit === "namedTextStyles",
    );
  });

  it("emits distinct latin/ea in file and buffer XML including tables and charts", async () => {
    const deck = styleDeck();
    deck.theme.fonts = { latin: "Arial", ea: "Noto Sans CJK SC" };
    deck.pages[0].elements.push(
      {
        id: "tbl",
        type: "table",
        bounds: [48, 420, 400, 100],
        header: true,
        rows: [
          ["项", "值"],
          ["Latin", "中文"],
        ],
      },
      {
        id: "ch",
        type: "chart",
        bounds: [470, 300, 442, 200],
        chartType: "bar",
        title: "成本 Cost",
        series: [{ name: "Q", labels: ["A", "B"], values: [1, 2] }],
      },
    );

    const buffer = await compileToBuffer(deck, { projectRoot: root });
    const zip = await JSZip.loadAsync(buffer);
    const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
    assert.match(slideXml, /<a:latin typeface="Times New Roman"/);
    assert.match(slideXml, /<a:ea typeface="Noto Sans CJK SC"/);
    assert.ok(eaFaces(slideXml).every((face) => face === "Noto Sans CJK SC"));
    assert.ok(latinFaces(slideXml).includes("Arial"));
    assert.match(slideXml, / i="1"/);

    const filePath = join(outDir, "c1-styles.pptx");
    await compileToPptx(deck, filePath, { projectRoot: root, force: true });
    const fileZip = await openPptx(filePath);
    const fileSlide = await readPptxEntry(fileZip, "ppt/slides/slide1.xml");
    assert.equal(fileSlide, slideXml);

    const chartName = Object.keys(zip.files).find((name) =>
      /^ppt\/charts\/chart\d+\.xml$/i.test(name),
    );
    assert.ok(chartName);
    const chartXml = await zip.file(chartName).async("string");
    assert.ok(eaFaces(chartXml).length > 0);
    assert.ok(eaFaces(chartXml).every((face) => face === "Noto Sans CJK SC"));
    assert.ok(latinFaces(chartXml).every((face) => face === "Arial"));
  });

  it("sets theme major/minor latin only when theme.fonts.latin is authored", async () => {
    const authored = {
      version: "openppt-1",
      size: [960, 540],
      theme: {
        colors: { text: "#111827", primary: "#2563EB" },
        fonts: { latin: "Georgia", ea: "Noto Sans CJK SC" },
      },
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "t",
              type: "text",
              bounds: [40, 16, 880, 40],
              text: "Georgia body",
            },
            {
              id: "tbl",
              type: "table",
              bounds: [40, 70, 400, 120],
              rows: [["latin", "中文"]],
            },
            {
              id: "ch",
              type: "chart",
              bounds: [460, 70, 460, 200],
              chartType: "bar",
              title: "Cost",
              series: [{ name: "Q", labels: ["A", "B"], values: [1, 2] }],
            },
          ],
        },
      ],
    };
    const buf = await compileToBuffer(authored, { projectRoot: root });
    const zip = await JSZip.loadAsync(buf);
    const themeXml = await zip.file("ppt/theme/theme1.xml").async("string");
    const major = themeXml.match(/<a:majorFont>\s*<a:latin typeface="([^"]*)"/);
    const minor = themeXml.match(/<a:minorFont>\s*<a:latin typeface="([^"]*)"/);
    assert.equal(major?.[1], "Georgia");
    assert.equal(minor?.[1], "Georgia");
    assert.doesNotMatch(themeXml, /typeface="Calibri Light"/);
    assert.doesNotMatch(themeXml, /typeface="Calibri"/);
    assert.ok(eaFaces(themeXml).every((face) => face === "Noto Sans CJK SC"));

    const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
    const tableBlock = slideXml.match(/<a:tbl>[\s\S]*<\/a:tbl>/);
    assert.ok(tableBlock);
    assert.ok(latinFaces(tableBlock[0]).every((face) => face === "Georgia"));

    const chartName = Object.keys(zip.files).find((name) =>
      /^ppt\/charts\/chart\d+\.xml$/i.test(name),
    );
    assert.ok(chartName);
    const chartXml = await zip.file(chartName).async("string");
    assert.ok(latinFaces(chartXml).every((face) => face === "Georgia"));
    assert.ok(eaFaces(chartXml).every((face) => face === "Noto Sans CJK SC"));

    const legacy = await compileToBuffer(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              { id: "t", type: "text", bounds: [40, 40, 400, 80], text: "legacy" },
            ],
          },
        ],
      },
      { projectRoot: root },
    );
    const legacyZip = await JSZip.loadAsync(legacy);
    const legacyTheme = await legacyZip.file("ppt/theme/theme1.xml").async("string");
    assert.match(legacyTheme, /<a:majorFont><a:latin typeface="Calibri Light"/);
    assert.match(legacyTheme, /<a:minorFont><a:latin typeface="Calibri"/);
  });

  it("keeps legacy explicit fonts on both scripts when ea is unset", async () => {
    const buf = await compileToBuffer(
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
                bounds: [40, 40, 400, 80],
                text: "legacy",
                fontFamily: "Georgia",
              },
            ],
          },
        ],
      },
      { projectRoot: root },
    );
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("ppt/slides/slide1.xml").async("string");
    assert.ok(latinFaces(xml).includes("Georgia"));
    assert.ok(eaFaces(xml).every((face) => face === "Georgia"));
  });
});

describe("C1 preview and QA from resolved styles", () => {
  it("preview applies resolved size/italic/false and latin+ea stack", () => {
    const deck = styleDeck();
    deck.theme.fonts = { latin: "Arial", ea: "Noto Sans CJK SC" };
    const html = renderPreviewHtml(deck, root);
    assert.match(html, /font-size:37\.3/);
    assert.match(html, /font-size:26\.6/);
    assert.match(html, /font-size:32px/);
    assert.match(html, /font-style:italic/);
    assert.match(html, /font-style:normal/);
    assert.match(html, /Times New Roman/);
    assert.match(html, /Noto Sans CJK SC/);
    assert.match(html, /font-family:&quot;Arial&quot;,&quot;Noto Sans CJK SC&quot;/);
  });

  it("QA overflow and contrast use resolved style size and color", () => {
    const overflow = qaDeck(
      {
        version: "openppt-1",
        size: [960, 540],
        theme: { textStyles: { huge: { fontSize: 200 } } },
        pages: [
          {
            id: "p",
            elements: [
              {
                id: "tiny",
                type: "text",
                bounds: [40, 40, 80, 24],
                style: "$huge",
                text: "OVERFLOWCAPACITYCHECK",
              },
            ],
          },
        ],
      },
      { checkMedia: false },
    );
    assert.ok(overflow.issues.some((issue) => issue.code === "TEXT_OVERFLOW_RISK"));

    const contrast = qaDeck(
      {
        version: "openppt-1",
        size: [960, 540],
        theme: { textStyles: { ghost: { color: "#FFFFFF", fontSize: 18 } } },
        pages: [
          {
            id: "p",
            background: { type: "solid", color: "#FFFFFF" },
            elements: [
              {
                id: "ghost",
                type: "text",
                bounds: [40, 40, 400, 80],
                style: "$ghost",
                text: "hidden",
              },
            ],
          },
        ],
      },
      { checkMedia: false },
    );
    assert.ok(contrast.issues.some((issue) => issue.code === "LOW_CONTRAST"));
  });
});
