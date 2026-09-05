import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { validateDeck } from "../src/validate.js";
import { compileToBuffer, compileToPptx } from "../src/compile.js";
import { renderPreviewHtml } from "../src/preview.js";
import { analyzeLayout, qaDeck } from "../src/qa.js";
import { OpenPptError, ErrorCodes } from "../src/errors.js";
import { RESOURCE_LIMITS } from "../src/resource-limits.js";
import { openPptx, readPptxEntry } from "./helpers/pptx.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let outDir;

function probeDeck() {
  return {
    version: "openppt-1",
    size: [960, 540],
    theme: {
      fonts: { latin: "Arial", ea: "Noto Sans CJK SC" },
      textStyles: {
        body: {
          fontSize: 20,
          bold: true,
          lineHeight: 1.5,
          spaceBefore: 12,
          spaceAfter: 6,
          charSpacing: 1,
        },
      },
    },
    pages: [
      {
        id: "p",
        elements: [
          {
            id: "paragraphs",
            type: "text",
            style: "$body",
            bounds: [48, 40, 864, 460],
            paragraphs: [
              {
                text: [
                  { text: "中文第一行\nSecond line", bold: false },
                  { text: " + inline tail", italic: true, charSpacing: 0 },
                ],
                bullet: { type: "number", start: 3 },
                spaceBefore: 0,
              },
              { text: "Next numbered item", bullet: { type: "number" } },
              { text: "", bullet: false, spaceBefore: 0, spaceAfter: 0 },
              { text: "Unordered final / 无序要点", bullet: true },
            ],
          },
        ],
      },
    ],
  };
}

describe("C2 paragraphs vs legacy text", () => {
  before(() => {
    outDir = mkdtempSync(join(tmpdir(), "openppt-c2-"));
  });
  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("rejects both text and paragraphs, and neither", () => {
    const both = probeDeck();
    both.pages[0].elements[0].text = "also text";
    assert.throws(
      () => validateDeck(both, { checkMedia: false }),
      (err) => err instanceof OpenPptError && err.code === ErrorCodes.SCHEMA,
    );
    const neither = probeDeck();
    delete neither.pages[0].elements[0].paragraphs;
    assert.throws(
      () => validateDeck(neither, { checkMedia: false }),
      (err) => err instanceof OpenPptError && err.code === ErrorCodes.SCHEMA,
    );
  });

  it("resolves paragraph styles with explicit false/zero and stays detached/idempotent", () => {
    const deck = probeDeck();
    const before = JSON.stringify(deck);
    const result = validateDeck(deck, { checkMedia: false });
    assert.equal(JSON.stringify(deck), before);
    const el = result.deck.pages[0].elements[0];
    assert.equal(el.fontSize, 20);
    assert.equal(el.bold, true);
    assert.equal(el.lineHeight, 1.5);
    assert.equal(el.paragraphs[0].spaceBefore, 0);
    assert.equal(el.paragraphs[0].text[0].bold, false);
    assert.equal(el.paragraphs[0].text[1].charSpacing, 0);
    assert.deepEqual(
      validateDeck(result.deck, { checkMedia: false }).deck,
      result.deck,
    );
  });

  it("emits one paragraph per entry, soft a:br, and native numbered counters", async () => {
    const deck = probeDeck();
    const buffer = await compileToBuffer(deck, { projectRoot: root });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("ppt/slides/slide1.xml").async("string");
    assert.equal([...xml.matchAll(/<a:p>/g)].length, 4);
    assert.equal([...xml.matchAll(/<a:br\s*\/>/g)].length, 1);
    assert.equal([...xml.matchAll(/<a:buAutoNum\b/g)].length, 2);
    assert.equal([...xml.matchAll(/<a:buChar\b/g)].length, 1);
    assert.match(xml, /startAt="3"/);
    assert.match(xml, /startAt="4"/);
    assert.match(xml, /<a:spcPct val="150000"/);
    const inline = [...xml.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)]
      .map((m) => m[1])
      .find((s) => s.includes(" + inline tail"));
    assert.ok(inline);
    const spacing = inline.match(/\bspc="([^"]+)"/);
    assert.ok(!spacing || Number(spacing[1]) === 0, "run zero spacing was overwritten");

    const filePath = join(outDir, "c2-paragraphs.pptx");
    await compileToPptx(deck, filePath, { projectRoot: root, force: true });
    const fileXml = await readPptxEntry(await openPptx(filePath), "ppt/slides/slide1.xml");
    assert.equal(fileXml, xml);
  });

  it("keeps legacy A/BC newline paragraphs and does not treat them as a:br", async () => {
    const xml = await compileToBuffer(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "nl",
                type: "text",
                bounds: [20, 20, 500, 120],
                text: [
                  { text: "A\nB", bold: true },
                  { text: "C", color: "#DC2626" },
                ],
              },
            ],
          },
        ],
      },
      { projectRoot: root },
    ).then(async (buf) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file("ppt/slides/slide1.xml").async("string");
    });
    const paras = [...xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)].map((m) =>
      [...m[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join(""),
    );
    assert.deepEqual(paras, ["A", "BC"]);
    assert.equal([...xml.matchAll(/<a:br\s*\/>/g)].length, 0);
  });

  it("emits marL=0 for explicit bullet indent 0 instead of the 27pt default", async () => {
    const xml = await compileToBuffer(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              {
                id: "z",
                type: "text",
                bounds: [40, 40, 800, 200],
                paragraphs: [
                  { text: "zero indent", bullet: { type: "bullet", indent: 0 } },
                  { text: "default indent", bullet: true },
                ],
              },
            ],
          },
        ],
      },
      { projectRoot: root },
    ).then(async (buf) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file("ppt/slides/slide1.xml").async("string");
    });
    const pPrs = [...xml.matchAll(/<a:pPr\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(pPrs.some((p) => /marL="0"/.test(p) && /indent="-0"/.test(p)));
    assert.ok(!pPrs.some((p) => /marL="342900"/.test(p) && /zero indent/.test(xml)));
    assert.match(xml, /marL="228600"/);
  });

  it("restarts nested numbered levels and clears deeper counters", async () => {
    const xml = await compileToBuffer(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              {
                id: "n",
                type: "text",
                bounds: [40, 40, 800, 400],
                paragraphs: [
                  { text: "A1", bullet: { type: "number" } },
                  { text: "A1a", bullet: { type: "number", level: 1 } },
                  { text: "A1b", bullet: { type: "number", level: 1 } },
                  { text: "A2", bullet: { type: "number" } },
                  { text: "A2a", bullet: { type: "number", level: 1, start: 9 } },
                  { text: "plain", bullet: false },
                  { text: "B1", bullet: { type: "number" } },
                ],
              },
            ],
          },
        ],
      },
      { projectRoot: root },
    ).then(async (buf) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file("ppt/slides/slide1.xml").async("string");
    });
    const starts = [...xml.matchAll(/startAt="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(starts, ["1", "1", "2", "2", "9", "1"]);
    assert.equal([...xml.matchAll(/<a:p>/g)].length, 7);
  });

  it("rejects start 32767 plus implicit continuation, keeps single 32767 and explicit reset", () => {
    const single = {
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "n",
              type: "text",
              bounds: [40, 40, 800, 200],
              paragraphs: [
                { text: "last", bullet: { type: "number", start: 32767 } },
              ],
            },
          ],
        },
      ],
    };
    assert.equal(validateDeck(single, { checkMedia: false }).ok, true);

    const reset = structuredClone(single);
    reset.pages[0].elements[0].paragraphs.push({
      text: "again",
      bullet: { type: "number", start: 1 },
    });
    assert.equal(validateDeck(reset, { checkMedia: false }).ok, true);

    const overflow = structuredClone(single);
    overflow.pages[0].elements[0].paragraphs.push({
      text: "too far",
      bullet: { type: "number" },
    });
    assert.throws(
      () => validateDeck(overflow, { checkMedia: false }),
      (err) =>
        err instanceof OpenPptError &&
        err.code === ErrorCodes.SCHEMA &&
        /32767/.test(err.message),
    );
  });

  it("rejects unused invalid typography, start on unordered, and both text+paragraphs", () => {
    for (const mutate of [
      (d) => {
        d.pages[0].elements[0].paragraphs[0].lineHeight = 0;
      },
      (d) => {
        d.pages[0].elements[0].paragraphs[0].charSpacing = Infinity;
      },
      (d) => {
        d.pages[0].elements[0].paragraphs[0].bullet = { type: "bullet", start: 2 };
      },
      (d) => {
        d.theme.textStyles.unused = { lineHeight: Infinity };
      },
    ]) {
      const deck = probeDeck();
      mutate(deck);
      assert.throws(
        () => validateDeck(deck, { checkMedia: false }),
        (err) => err instanceof OpenPptError,
      );
    }
  });

  it("preview shows computed counters, soft break, and italic continuation", () => {
    const html = renderPreviewHtml(probeDeck(), root);
    assert.match(html, /data-marker="3\."/);
    assert.match(html, /data-marker="4\."/);
    assert.match(html, /data-marker="•"/);
    assert.match(html, /class="para-line"/);
    assert.match(html, /font-style:italic/);
    assert.match(html, /letter-spacing:0px/);
  });

  it("QA flags a stack of empty paragraphs in a tiny box", () => {
    const deck = probeDeck();
    deck.pages[0].elements[0].bounds = [48, 40, 864, 40];
    deck.pages[0].elements[0].paragraphs = Array.from({ length: 10 }, () => ({
      text: "",
    }));
    const qa = analyzeLayout(deck);
    assert.ok(
      qa.issues.some((issue) => /OVERFLOW|DENSE|CAPACITY/.test(issue.code)),
      JSON.stringify(qa.issues),
    );
    const viaQa = qaDeck(deck, { checkMedia: false });
    assert.ok(viaQa.issues.some((issue) => issue.code === "TEXT_OVERFLOW_RISK"));
  });

  it("enforces the per-element paragraph ceiling", () => {
    const paragraphs = Array.from(
      { length: RESOURCE_LIMITS.paragraphsPerElement },
      (_, i) => ({ text: `p${i}` }),
    );
    const deck = {
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "t",
              type: "text",
              bounds: [0, 0, 400, 400],
              paragraphs,
            },
          ],
        },
      ],
    };
    assert.equal(validateDeck(deck, { checkMedia: false }).ok, true);
    paragraphs.push({ text: "extra" });
    assert.throws(
      () => validateDeck(deck, { checkMedia: false }),
      (err) =>
        err instanceof OpenPptError &&
        err.code === ErrorCodes.RESOURCE_LIMIT &&
        err.details.limit === "paragraphsPerElement",
    );
  });

  it("QA overflow accounts for wrapping, run fontSize, and charSpacing", () => {
    const cases = [
      {
        name: "long wrapped paragraph",
        paragraphs: [{ text: "汉".repeat(400) }],
        fontSize: 20,
      },
      {
        name: "large inline run",
        paragraphs: [{ text: [{ text: "Visible", fontSize: 120 }] }],
        fontSize: 18,
      },
      {
        name: "character spacing",
        paragraphs: [{ text: "ABCDEFGHIJKLMNO", charSpacing: 100 }],
        fontSize: 18,
      },
    ];
    for (const c of cases) {
      const { name, ...rest } = c;
      const deck = {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              { type: "text", id: "t", bounds: [40, 40, 200, 80], ...rest },
            ],
          },
        ],
      };
      const q = qaDeck(deck, { checkMedia: false, failOn: "med" });
      assert.ok(
        q.issues.some((issue) => issue.code === "TEXT_OVERFLOW_RISK"),
        name,
      );
    }
  });

  it("fails the run ceiling before walking extra paragraph runs", () => {
    const runs = Array.from(
      { length: RESOURCE_LIMITS.richTextRunsPerElement + 1 },
      () => ({ text: "x" }),
    );
    assert.throws(
      () =>
        validateDeck(
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
                    bounds: [0, 0, 400, 400],
                    paragraphs: [{ text: runs }],
                  },
                ],
              },
            ],
          },
          { checkMedia: false },
        ),
      (err) =>
        err instanceof OpenPptError &&
        err.code === ErrorCodes.RESOURCE_LIMIT &&
        err.details.limit === "richTextRunsPerElement",
    );
  });

  it("preview keeps paragraph valign via justify-content and empty-line font metrics", () => {
    const html = renderPreviewHtml(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              {
                id: "mid",
                type: "text",
                bounds: [40, 40, 400, 200],
                valign: "middle",
                paragraphs: [{ text: "Hello" }, { text: "" }],
              },
            ],
          },
        ],
      },
      root,
    );
    assert.match(html, /flex-direction:column;justify-content:center/);
    assert.match(html, /class="para-line"/);
    assert.match(html, /min-height:/);
  });

  it("applies authored typography to legacy string and run arrays without changing newline grouping", async () => {
    const deck = {
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "legacy-string",
              type: "text",
              text: "One\nTwo",
              bounds: [40, 40, 400, 220],
              fontSize: 20,
              lineHeight: 2,
              charSpacing: 4,
              spaceBefore: 10,
              spaceAfter: 6,
            },
            {
              id: "legacy-runs",
              type: "text",
              text: [{ text: "Three\nFour" }, { text: " tail", charSpacing: 0 }],
              bounds: [480, 40, 440, 220],
              fontSize: 20,
              lineHeight: 2,
              charSpacing: 4,
              spaceBefore: 10,
              spaceAfter: 6,
            },
          ],
        },
      ],
    };
    const xml = await compileToBuffer(deck, { projectRoot: root }).then(async (buf) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file("ppt/slides/slide1.xml").async("string");
    });
    assert.equal([...xml.matchAll(/<a:spcPct val="200000"/g)].length, 4);
    assert.match(xml, /spc="400"/);
    const tail = [...xml.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)]
      .map((m) => m[1])
      .find((s) => s.includes(" tail"));
    assert.ok(tail);
    const spacing = tail.match(/\bspc="([^"]+)"/);
    assert.ok(!spacing || Number(spacing[1]) === 0);
    const paras = [...xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)].map((m) =>
      [...m[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join(""),
    );
    assert.deepEqual(paras, ["One", "Two", "Three", "Four tail"]);
    assert.equal([...xml.matchAll(/<a:br\s*\/>/g)].length, 0);

    const html = renderPreviewHtml(deck, root);
    assert.match(html, /line-height:2/);
    assert.match(html, /letter-spacing:5\.3/);
    assert.match(html, /letter-spacing:0px/);

    const spaced = qaDeck(
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
                bounds: [40, 40, 200, 80],
                fontSize: 18,
                charSpacing: 100,
                text: "ABCDEFGHIJKLMNO",
              },
            ],
          },
        ],
      },
      { checkMedia: false, failOn: "med" },
    );
    assert.ok(spaced.issues.some((issue) => issue.code === "TEXT_OVERFLOW_RISK"));
  });

  it("renders legacy A\\nB with per-native-paragraph spaceAfter, preserving A/BC", () => {
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
                text: "A\nB",
                fontSize: 20,
                lineHeight: 1,
                spaceAfter: 30,
                bounds: [40, 40, 800, 400],
              },
            ],
          },
        ],
      },
      root,
    );
    assert.equal((html.match(/class="para"/g) || []).length, 2);
    assert.match(html, /margin-bottom:40px/);
    assert.doesNotMatch(html, /padding-bottom:40px/);
    const abc = renderPreviewHtml(
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
                text: [{ text: "A\nB" }, { text: "C", italic: true }],
                fontSize: 20,
                spaceAfter: 30,
                bounds: [40, 40, 800, 400],
              },
            ],
          },
        ],
      },
      root,
    );
    const bodies = [...abc.matchAll(/<div class="para-body">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    assert.equal(bodies.length, 2);
    assert.match(bodies[0], />A</);
    assert.match(bodies[1], />B</);
    assert.match(bodies[1], />C</);
    const plain = renderPreviewHtml(
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
                text: "A\nB",
                fontSize: 20,
                bounds: [40, 40, 800, 400],
              },
            ],
          },
        ],
      },
      root,
    );
    assert.equal((plain.match(/class="para"/g) || []).length, 0);
    assert.match(plain, /A\nB/);
  });

  it("QA flags zero usable width and a glyph wider than the box", () => {
    const tiny = qaDeck(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              {
                type: "text",
                id: "t",
                paragraphs: [{ text: "A" }],
                bounds: [40, 40, 1, 400],
              },
            ],
          },
        ],
      },
      { checkMedia: false, failOn: "med" },
    );
    const tinyHit = tiny.issues.find((issue) => issue.code === "TEXT_OVERFLOW_RISK");
    assert.ok(tinyHit, JSON.stringify(tiny.issues));
    assert.equal(tinyHit.details.horizontalOverflow, true);
    const walk = (value) => {
      if (typeof value === "number") {
        assert.equal(Number.isFinite(value), true);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(walk);
      }
    };
    walk(tinyHit.details);

    const wide = qaDeck(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              {
                type: "text",
                id: "t",
                fontSize: 120,
                paragraphs: [{ text: "W" }],
                bounds: [40, 40, 40, 400],
              },
            ],
          },
        ],
      },
      { checkMedia: false, failOn: "med" },
    );
    assert.ok(wide.issues.some((issue) => issue.code === "TEXT_OVERFLOW_RISK"));
    assert.match(tinyHit.message, /px/);
    assert.doesNotMatch(tinyHit.message, /chars vs/);
  });

  it("applies paragraph base size/bold/color to the marker and container", () => {
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
                bounds: [40, 40, 800, 400],
                fontSize: 18,
                bold: true,
                color: "#111827",
                paragraphs: [
                  {
                    text: "Paragraph font",
                    fontSize: 36,
                    bold: false,
                    italic: true,
                    fontFamily: "Georgia",
                    color: "#2563EB",
                    bullet: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      root,
    );
    const marker = html.match(/<span class="para-marker" style="([^"]*)"/);
    assert.ok(marker);
    assert.match(marker[1], /font-size:48px/);
    assert.match(marker[1], /font-weight:400/);
    assert.match(marker[1], /font-style:italic/);
    assert.match(marker[1], /Georgia/);
    assert.match(marker[1], /color:#2563EB/);
    assert.match(html, /class="para"[^>]*font-size:48px/);
    assert.match(html, /class="para"[^>]*font-weight:400/);
  });

  it("preview keeps numbered markers on one line without overlapping the body", () => {
    const html = renderPreviewHtml(
      {
        version: "openppt-1",
        size: [960, 540],
        theme: { fonts: { latin: "Georgia" } },
        pages: [
          {
            id: "p",
            elements: [
              {
                id: "t",
                type: "text",
                bounds: [40, 40, 800, 400],
                fontSize: 18,
                fontFamily: "Georgia",
                paragraphs: [
                  { text: "Third", bullet: { type: "number", start: 3 } },
                  { text: "Fourth", bullet: { type: "number" } },
                  { text: "Bullet", bullet: true },
                ],
              },
            ],
          },
        ],
      },
      root,
    );
    const markerRule = html.match(/\.para-marker \{[^}]+\}/)?.[0] || "";
    assert.match(markerRule, /white-space:\s*nowrap/);
    assert.match(markerRule, /overflow-wrap:\s*normal/);
    assert.match(html, /\.para-body \{[^}]*overflow-wrap:anywhere/);
    assert.match(html, /\.text \{[^}]*overflow-wrap:anywhere/);
    assert.match(html, /class="para-gutter"[^>]*min-width:/);
    assert.match(html, /class="para-gutter"[^>]*width:max-content/);
    assert.match(html, /data-marker="3\."/);
    assert.match(html, /data-marker="4\."/);
  });

  it("preserves exact leading/trailing/consecutive CRLF/CR/LF soft breaks across runs", async () => {
    const xml = await compileToBuffer(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              {
                id: "breaks",
                type: "text",
                bounds: [40, 40, 800, 460],
                paragraphs: [
                  { text: "\nA\n\n", bullet: true },
                  {
                    text: [
                      { text: "\r\nA\r", bold: true },
                      { text: "B\n\n", bold: false },
                    ],
                    bullet: { type: "number" },
                  },
                  { text: "", fontSize: 36 },
                ],
              },
            ],
          },
        ],
      },
      { projectRoot: root },
    ).then(async (buf) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file("ppt/slides/slide1.xml").async("string");
    });
    const ps = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => m[1]);
    assert.equal(ps.length, 3);
    const values = ps.map((p) =>
      [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g)]
        .map((m) => (m[1] === undefined ? "\n" : m[1]))
        .join(""),
    );
    assert.deepEqual(values, ["\nA\n\n", "\nA\nB\n\n", ""]);
    for (const p of ps) assert.equal([...p.matchAll(/<a:pPr\b/g)].length, 1);
  });

  it("does not switch legacy preview layout for pre-C2 run.fontSize alone", () => {
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
                bounds: [40, 40, 400, 200],
                text: [
                  { text: "A\nB", fontSize: 24 },
                  { text: "C", fontSize: 12 },
                ],
              },
            ],
          },
        ],
      },
      root,
    );
    assert.equal((html.match(/class="para"/g) || []).length, 0);
    assert.match(html, /\.text \{ white-space:pre-wrap; line-height:1\.25;/);
    assert.doesNotMatch(html, /class="el text"[^>]*line-height:1\.2/);
  });

  it("rejects derived bullet marL over 51206400 EMU and spaceAfter over 1584pt", async () => {
    const base = {
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "t",
              type: "text",
              bounds: [40, 40, 800, 400],
              paragraphs: [{ text: "x", bullet: { type: "bullet", level: 0, indent: 1584 } }],
            },
          ],
        },
      ],
    };
    assert.equal(validateDeck(base, { checkMedia: false }).ok, true);
    const xml1584 = await compileToBuffer(base, { projectRoot: root }).then(async (buf) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file("ppt/slides/slide1.xml").async("string");
    });
    assert.match(xml1584, /marL="20116800"/);

    const lvl8 = structuredClone(base);
    lvl8.pages[0].elements[0].paragraphs[0].bullet = {
      type: "bullet",
      level: 8,
      indent: 448,
    };
    assert.equal(validateDeck(lvl8, { checkMedia: false }).ok, true);
    const xml448 = await compileToBuffer(lvl8, { projectRoot: root }).then(async (buf) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file("ppt/slides/slide1.xml").async("string");
    });
    assert.match(xml448, /marL="51206400"/);

    const over = structuredClone(base);
    over.pages[0].elements[0].paragraphs[0].bullet = {
      type: "bullet",
      level: 8,
      indent: 1584,
    };
    assert.throws(
      () => validateDeck(over, { checkMedia: false }),
      (err) =>
        err instanceof OpenPptError &&
        err.code === ErrorCodes.SCHEMA &&
        /51206400/.test(err.message),
    );

    const spaceOk = structuredClone(base);
    spaceOk.pages[0].elements[0].paragraphs[0].spaceBefore = 1584;
    spaceOk.pages[0].elements[0].paragraphs[0].spaceAfter = 1584;
    spaceOk.pages[0].elements[0].paragraphs[0].bullet = true;
    assert.equal(validateDeck(spaceOk, { checkMedia: false }).ok, true);
    const spaceXml = await compileToBuffer(spaceOk, { projectRoot: root }).then(
      async (buf) => {
        const zip = await JSZip.loadAsync(buf);
        return zip.file("ppt/slides/slide1.xml").async("string");
      },
    );
    assert.match(spaceXml, /<a:spcBef><a:spcPts val="158400"/);
    assert.match(spaceXml, /<a:spcAft><a:spcPts val="158400"/);
    const spaceOver = structuredClone(spaceOk);
    spaceOver.pages[0].elements[0].paragraphs[0].spaceAfter = 1584.1;
    assert.throws(
      () => validateDeck(spaceOver, { checkMedia: false }),
      (err) => err instanceof OpenPptError && err.code === ErrorCodes.SCHEMA,
    );
    const unused = structuredClone(spaceOk);
    unused.theme = { textStyles: { body: { spaceAfter: 4000 } } };
    unused.pages[0].elements[0].style = "$body";
    assert.throws(
      () => validateDeck(unused, { checkMedia: false }),
      (err) => err instanceof OpenPptError && err.code === ErrorCodes.SCHEMA,
    );
    const elementOver = {
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p",
          elements: [
            {
              id: "t",
              type: "text",
              bounds: [40, 40, 400, 200],
              text: "x",
              spaceBefore: 4000,
            },
          ],
        },
      ],
    };
    assert.throws(
      () => validateDeck(elementOver, { checkMedia: false }),
      (err) => err instanceof OpenPptError && err.code === ErrorCodes.SCHEMA,
    );
  });
});
