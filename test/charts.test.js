import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeck } from "../src/load.js";
import { validateDeck } from "../src/validate.js";
import JSZip from "jszip";
import { compileToPptx, compileToBuffer } from "../src/compile.js";
import { OpenPptError, ErrorCodes } from "../src/errors.js";
import { openPptx, readPptxEntry } from "./helpers/pptx.js";
import { parseChartXml } from "../src/import-pptx.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("charts (shipped)", () => {
  it("validates and exports chart-demo fixture with slide XML", async () => {
    const deckPath = join(root, "fixtures/chart-demo/deck.json");
    const { deck, projectRoot } = loadDeck(deckPath);
    validateDeck(deck, { projectRoot, checkMedia: true });
    assert.equal(deck.pages[0].elements.some((e) => e.type === "chart"), true);

    const outDir = mkdtempSync(join(tmpdir(), "openppt-chart-"));
    try {
      const out = join(outDir, "chart.pptx");
      const result = await compileToPptx(deck, out, {
        projectRoot,
        force: true,
        sourcePath: deckPath,
      });
      assert.ok(existsSync(result.outputPath));
      assert.ok(statSync(result.outputPath).size > 1000);

      const pptx = await openPptx(result.outputPath);
      assert.ok(pptx.file("ppt/slides/slide1.xml"));
      // pptxgenjs emits chart parts for chart slides
      assert.ok(Object.keys(pptx.files).some((name) => name.startsWith("ppt/charts/")));

      const xml = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
      assert.match(xml, /Quarterly results|a:t/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("parses line, pie, doughnut, and area chart XML fragments", () => {
    function fragment(kind, title = "T") {
      return `<c:chartSpace>
        <c:title><a:t>${title}</a:t></c:title>
        <c:${kind}Chart>
          <c:ser>
            <c:tx><c:v>Series 1</c:v></c:tx>
            <c:val><c:numCache><c:v>1</c:v><c:v>3</c:v></c:numCache></c:val>
            <c:cat><c:strCache><c:v>A</c:v><c:v>B</c:v></c:strCache></c:cat>
          </c:ser>
        </c:${kind}Chart>
      </c:chartSpace>`;
    }
    for (const kind of ["line", "pie", "doughnut", "area"]) {
      const parsed = parseChartXml(fragment(kind));
      assert.equal(parsed.chartType, kind);
      assert.equal(parsed.title, "T");
      assert.equal(parsed.series.length, 1);
      assert.deepEqual(parsed.series[0].values, [1, 3]);
      assert.deepEqual(parsed.series[0].labels, ["A", "B"]);
    }
  });

  it("keeps compatible multi-series values, categories, and workbook cache", async () => {
    const deck = {
      version: "openppt-1",
      size: [960, 540],
      theme: {
        colors: {
          primary: "#2563EB",
          accent: "#F59E0B",
          text: "#111827",
        },
      },
      pages: [
        {
          id: "p1",
          elements: [
            {
              id: "ch",
              type: "chart",
              bounds: [40, 40, 800, 400],
              chartType: "bar",
              title: "Sales",
              series: [
                { name: "Revenue", labels: ["Q1", "Q2", "Q3"], values: [12, 18, 15] },
                { name: "Cost", labels: ["Q1", "Q2", "Q3"], values: [8, 9, 10] },
              ],
            },
          ],
        },
      ],
    };
    const buf = await compileToBuffer(deck, { projectRoot: root });
    const zip = await JSZip.loadAsync(buf);
    const chartName = Object.keys(zip.files).find((name) =>
      /^ppt\/charts\/chart\d+\.xml$/i.test(name),
    );
    assert.ok(chartName);
    const chartXml = await zip.file(chartName).async("string");
    const seriesBlocks = [...chartXml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map(
      (m) => m[0],
    );
    assert.equal(seriesBlocks.length, 2);
    assert.match(seriesBlocks[0], /Revenue/);
    assert.match(seriesBlocks[1], /Cost/);
    assert.match(seriesBlocks[0], /<c:v>12<\/c:v>/);
    assert.match(seriesBlocks[1], /<c:v>10<\/c:v>/);
    assert.match(chartXml, /<c:v>Q1<\/c:v>/);
    assert.match(chartXml, /val="2563EB"/);
    assert.match(chartXml, /val="F59E0B"|val="111827"/);

    const embedName = Object.keys(zip.files).find((name) =>
      /ppt\/embeddings\/.*\.xlsx$/i.test(name),
    );
    assert.ok(embedName, "expected an embedded workbook");
    const xlsx = await JSZip.loadAsync(await zip.file(embedName).async("nodebuffer"));
    const sheet = await xlsx.file("xl/worksheets/sheet1.xml").async("string");
    const shared = await xlsx.file("xl/sharedStrings.xml").async("string");
    assert.match(shared, /Revenue/);
    assert.match(shared, /Cost/);
    assert.match(shared, /Q1/);
    assert.match(shared, /Q3/);
    assert.match(sheet, /<v>12<\/v>/);
    assert.match(sheet, /<v>10<\/v>/);
  });

  it("does not export unsupported multi-series pie charts", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-pie-reject-"));
    const out = join(work, "should-not-write-pie.pptx");
    try {
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
                      id: "pie",
                      type: "chart",
                      bounds: [40, 40, 400, 300],
                      chartType: "pie",
                      series: [
                        { name: "A", values: [1, 2], labels: ["x", "y"] },
                        { name: "B", values: [3, 4], labels: ["x", "y"] },
                      ],
                    },
                  ],
                },
              ],
            },
            out,
            { projectRoot: work, force: true },
          ),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.SCHEMA,
      );
      assert.equal(existsSync(out), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("uses theme text color for dark-theme pie data labels", async () => {
    const buf = await compileToBuffer(
      {
        version: "openppt-1",
        size: [960, 540],
        theme: {
          colors: {
            background: "#111827",
            text: "#F9FAFB",
            primary: "#60A5FA",
          },
        },
        pages: [
          {
            id: "p1",
            background: { type: "solid", color: "$background" },
            elements: [
              {
                id: "pie",
                type: "chart",
                bounds: [40, 40, 400, 300],
                chartType: "pie",
                title: "Share",
                series: [{ name: "Share", values: [40, 60], labels: ["A", "B"] }],
              },
            ],
          },
        ],
      },
      { projectRoot: root },
    );
    const zip = await JSZip.loadAsync(buf);
    const chartName = Object.keys(zip.files).find((name) =>
      /^ppt\/charts\/chart\d+\.xml$/i.test(name),
    );
    assert.ok(chartName);
    const chartXml = await zip.file(chartName).async("string");
    const pointLabels = [...chartXml.matchAll(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g)].map(
      (match) => match[0],
    );
    assert.ok(pointLabels.length >= 1, "expected pie slice data labels");
    for (const point of pointLabels) {
      assert.match(point, /val="F9FAFB"/);
      assert.doesNotMatch(point, /val="000000"/);
    }
  });

  it("chart-demo series fills use primary then fallback, never surface", async () => {
    const { deck, projectRoot } = loadDeck(join(root, "fixtures/chart-demo/deck.json"));
    const buf = await compileToBuffer(deck, { projectRoot });
    const zip = await JSZip.loadAsync(buf);
    const chartName = Object.keys(zip.files).find((name) =>
      /^ppt\/charts\/chart\d+\.xml$/i.test(name),
    );
    assert.ok(chartName);
    const chartXml = await zip.file(chartName).async("string");
    const seriesBlocks = [...chartXml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map(
      (match) => match[0],
    );
    assert.equal(seriesBlocks.length, 2);
    const fills = seriesBlocks.map((block) => {
      const match = block.match(
        /<c:spPr>\s*<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/,
      );
      assert.ok(match, "expected a series solid fill");
      return match[1].toUpperCase();
    });
    assert.deepEqual(fills, ["2563EB", "7C3AED"]);
    assert.notEqual(fills[1], "F8FAFC");
    assert.ok(!fills.includes("FFFFFF"));
  });

  it("preserves dark-theme primary and accent as the first series colors", async () => {
    const buf = await compileToBuffer(
      {
        version: "openppt-1",
        size: [960, 540],
        theme: {
          colors: {
            primary: "#60A5FA",
            accent: "#FBBF24",
            text: "#F8FAFC",
            muted: "#94A3B8",
            background: "#0F172A",
            surface: "#1E293B",
          },
        },
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "ch",
                type: "chart",
                bounds: [40, 40, 800, 400],
                chartType: "bar",
                series: [
                  { name: "A", labels: ["Q1", "Q2"], values: [1, 2] },
                  { name: "B", labels: ["Q1", "Q2"], values: [3, 4] },
                ],
              },
            ],
          },
        ],
      },
      { projectRoot: root },
    );
    const zip = await JSZip.loadAsync(buf);
    const chartName = Object.keys(zip.files).find((name) =>
      /^ppt\/charts\/chart\d+\.xml$/i.test(name),
    );
    const chartXml = await zip.file(chartName).async("string");
    const fills = [...chartXml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map((match) => {
      const fill = match[0].match(
        /<c:spPr>\s*<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/,
      );
      return fill[1].toUpperCase();
    });
    assert.deepEqual(fills, ["60A5FA", "FBBF24"]);
    assert.ok(!fills.includes("1E293B"));
    assert.ok(!fills.includes("0F172A"));
    assert.ok(!fills.includes("F8FAFC"));
  });

  it("aligns pie slice fills with the shared palette", async () => {
    const buf = await compileToBuffer(
      {
        version: "openppt-1",
        size: [960, 540],
        theme: {
          colors: {
            primary: "#2563EB",
            text: "#111827",
            background: "#FFFFFF",
            surface: "#F8FAFC",
          },
        },
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "pie",
                type: "chart",
                bounds: [40, 40, 400, 300],
                chartType: "pie",
                series: [{ name: "Share", labels: ["A", "B"], values: [40, 60] }],
              },
            ],
          },
        ],
      },
      { projectRoot: root },
    );
    const zip = await JSZip.loadAsync(buf);
    const chartName = Object.keys(zip.files).find((name) =>
      /^ppt\/charts\/chart\d+\.xml$/i.test(name),
    );
    const chartXml = await zip.file(chartName).async("string");
    const points = [...chartXml.matchAll(/<c:dPt>[\s\S]*?<\/c:dPt>/g)].map(
      (match) => match[0],
    );
    assert.equal(points.length, 2);
    const sliceFills = points.map((point) => {
      const fill = point.match(
        /<c:spPr>\s*<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/,
      );
      assert.ok(fill, "expected a c:dPt solid fill");
      return fill[1].toUpperCase();
    });
    assert.deepEqual(sliceFills, ["2563EB", "7C3AED"]);
    assert.ok(!sliceFills.includes("F8FAFC"));
  });
});
