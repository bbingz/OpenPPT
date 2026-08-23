import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDeck } from "../src/validate.js";
import { compileToPptx } from "../src/compile.js";
import { ErrorCodes, OpenPptError } from "../src/errors.js";
import { initProject } from "../src/init.js";
import { expandPageLayouts } from "../src/layout.js";
import { RESOURCE_LIMITS } from "../src/resource-limits.js";

function textElement(id, text = "x") {
  return { id, type: "text", bounds: [0, 0, 10, 10], text };
}

function deckWithPages(pages) {
  return { version: "openppt-1", size: [960, 540], pages };
}

function onePage(elements) {
  return deckWithPages([{ id: "p1", elements }]);
}

function expectResourceLimit(fn, limit) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof OpenPptError);
    assert.equal(err.code, ErrorCodes.RESOURCE_LIMIT);
    assert.equal(err.details.limit, limit);
    return true;
  });
}

function validateStructure(deck) {
  return validateDeck(deck, { checkMedia: false });
}

function deckWithElementCount(count) {
  const pages = [];
  let created = 0;
  while (created < count) {
    const pageIndex = pages.length;
    const pageCount = Math.min(
      RESOURCE_LIMITS.elementsPerPage,
      count - created,
    );
    const elements = Array.from({ length: pageCount }, (_, index) =>
      textElement(`e-${created + index}`),
    );
    pages.push({ id: `p-${pageIndex}`, elements });
    created += pageCount;
  }
  return deckWithPages(pages);
}

function chartElement(id, pointCount, seriesCount = 1) {
  return {
    id,
    type: "chart",
    bounds: [0, 0, 100, 100],
    chartType: "line",
    series: Array.from({ length: seriesCount }, (_, seriesIndex) => ({
      name: `s-${seriesIndex}`,
      values: Array.from({ length: pointCount }, (_, index) => index),
    })),
  };
}

function tableElement(id, cellCount) {
  const rows = [];
  let remaining = cellCount;
  while (remaining > 0) {
    const width = Math.min(RESOURCE_LIMITS.tableColumnsPerRow, remaining);
    rows.push(Array.from({ length: width }, () => "x"));
    remaining -= width;
  }
  return {
    id,
    type: "table",
    bounds: [0, 0, 100, 100],
    rows,
  };
}

function nestedLayerGroup(depth, prefix = "nested") {
  let child = { id: `${prefix}-leaf`, type: "text", text: "x" };
  for (let index = depth; index > 0; index -= 1) {
    child = {
      id: `${prefix}-group-${index}`,
      type: "group",
      layout: "layer",
      bounds: [0, 0, 100, 100],
      children: [child],
    };
  }
  return child;
}

function pageAtAuthoringNodeLimit(pageIndex) {
  const nodesPerChain = RESOURCE_LIMITS.groupDepth;
  const chainCount = RESOURCE_LIMITS.authoringNodesPerPage / nodesPerChain;
  return {
    id: `authoring-page-${pageIndex}`,
    elements: Array.from({ length: chainCount }, (_, chainIndex) =>
      nestedLayerGroup(
        nodesPerChain - 1,
        `authoring-${pageIndex}-${chainIndex}`,
      ),
    ),
  };
}

function writePngSized(path, bytes) {
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  truncateSync(path, bytes);
}

function mediaDeck(names) {
  return onePage(
    names.map((name, index) => ({
      id: `image-${index}`,
      type: "image",
      bounds: [0, 0, 10, 10],
      src: `media/${name}`,
    })),
  );
}

describe("resource ceilings", () => {
  it("accepts the page boundary and rejects one extra page", () => {
    const pages = Array.from({ length: RESOURCE_LIMITS.pagesPerDeck }, (_, index) => ({
      id: `p-${index}`,
      elements: [],
    }));
    assert.equal(validateStructure(deckWithPages(pages)).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          deckWithPages([...pages, { id: "too-many", elements: [] }]),
        ),
      "pagesPerDeck",
    );
  });

  it("accepts per-page and per-deck element boundaries and rejects limit + 1", () => {
    const pageElements = Array.from(
      { length: RESOURCE_LIMITS.elementsPerPage },
      (_, index) => textElement(`page-${index}`),
    );
    assert.equal(validateStructure(onePage(pageElements)).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([...pageElements, textElement("page-too-many")]),
        ),
      "elementsPerPage",
    );

    assert.equal(
      validateStructure(deckWithElementCount(RESOURCE_LIMITS.elementsPerDeck)).ok,
      true,
    );
    expectResourceLimit(
      () =>
        validateStructure(
          deckWithElementCount(RESOURCE_LIMITS.elementsPerDeck + 1),
        ),
      "elementsPerDeck",
    );
  });

  it("bounds authoring group depth and direct children before layout expansion", () => {
    assert.equal(
      validateStructure(onePage([nestedLayerGroup(RESOURCE_LIMITS.groupDepth)])).ok,
      true,
    );
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([nestedLayerGroup(RESOURCE_LIMITS.groupDepth + 1)]),
        ),
      "groupDepth",
    );

    const children = Array.from(
      { length: RESOURCE_LIMITS.groupChildren },
      (_, index) => ({ id: `child-${index}`, type: "text", text: "x" }),
    );
    const group = {
      id: "group",
      type: "group",
      layout: "layer",
      bounds: [0, 0, 100, 100],
      children,
    };
    assert.equal(validateStructure(onePage([group])).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([
            {
              ...group,
              children: [...children, { id: "child-too-many", type: "text", text: "x" }],
            },
          ]),
        ),
      "groupChildren",
    );

    expectResourceLimit(
      () => expandPageLayouts({ id: "p1", elements: [nestedLayerGroup(
        RESOURCE_LIMITS.groupDepth + 1,
      )] }),
      "groupDepth",
    );
  });

  it("accepts authoring-node boundaries and rejects page or deck overflow", () => {
    const pageBoundary = pageAtAuthoringNodeLimit(0);
    assert.equal(validateStructure(deckWithPages([pageBoundary])).ok, true);

    const pageOverflow = {
      id: "authoring-page-overflow",
      elements: [
        ...pageBoundary.elements.slice(1),
        nestedLayerGroup(
          RESOURCE_LIMITS.groupDepth,
          "authoring-page-overflow-chain",
        ),
      ],
    };
    expectResourceLimit(
      () => validateStructure(deckWithPages([pageOverflow])),
      "authoringNodesPerPage",
    );

    const pageCountAtDeckLimit =
      RESOURCE_LIMITS.authoringNodesPerDeck /
      RESOURCE_LIMITS.authoringNodesPerPage;
    const deckBoundary = deckWithPages(
      Array.from({ length: pageCountAtDeckLimit }, (_, pageIndex) =>
        pageAtAuthoringNodeLimit(pageIndex),
      ),
    );
    assert.equal(validateStructure(deckBoundary).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          deckWithPages([
            ...Array.from({ length: pageCountAtDeckLimit }, (_, pageIndex) =>
              pageAtAuthoringNodeLimit(pageIndex),
            ),
            { id: "authoring-deck-overflow", elements: [textElement("extra")] },
          ]),
        ),
      "authoringNodesPerDeck",
    );
  });

  it("accepts string boundaries and rejects per-string or aggregate overflow", () => {
    const boundary = "x".repeat(RESOURCE_LIMITS.stringBytes);
    assert.equal(validateStructure(onePage([textElement("boundary", boundary)])).ok, true);
    expectResourceLimit(
      () => validateStructure(onePage([textElement("too-long", `${boundary}x`)])),
      "stringBytes",
    );

    const pageId = "p1";
    const elementId = "aggregate";
    const overhead = Buffer.byteLength(pageId) + Buffer.byteLength(elementId);
    const runCount = RESOURCE_LIMITS.totalStringBytes / RESOURCE_LIMITS.stringBytes;
    const runs = Array.from({ length: runCount }, () => ({ text: boundary }));
    runs.at(-1).text = "x".repeat(RESOURCE_LIMITS.stringBytes - overhead);
    const aggregateDeck = deckWithPages([
      { id: pageId, elements: [{ ...textElement(elementId), text: runs }] },
    ]);
    assert.equal(validateStructure(aggregateDeck).ok, true);
    runs.at(-1).text += "x";
    expectResourceLimit(
      () => validateStructure(aggregateDeck),
      "totalStringBytes",
    );
  });

  it("accepts the rich-text run boundary and rejects one extra run", () => {
    const runs = Array.from(
      { length: RESOURCE_LIMITS.richTextRunsPerElement },
      () => ({ text: "" }),
    );
    const element = { ...textElement("rich"), text: runs };
    assert.equal(validateStructure(onePage([element])).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([{ ...element, text: [...runs, { text: "" }] }]),
        ),
      "richTextRunsPerElement",
    );
  });

  it("applies the per-string ceiling to rich text, chart labels, and table cells", () => {
    const tooLong = "x".repeat(RESOURCE_LIMITS.stringBytes + 1);
    const elements = [
      { ...textElement("rich-string"), text: [{ text: tooLong }] },
      {
        ...chartElement("chart-label", 1),
        series: [{ name: "series", labels: [tooLong], values: [1] }],
      },
      { ...tableElement("table-cell", 1), rows: [[tooLong]] },
      textElement(tooLong),
    ];
    for (const element of elements) {
      expectResourceLimit(
        () => validateStructure(onePage([element])),
        "stringBytes",
      );
    }
  });

  it("accepts chart series/point boundaries and rejects limit + 1", () => {
    assert.equal(
      validateStructure(
        onePage([
          chartElement(
            "series-boundary",
            1,
            RESOURCE_LIMITS.chartSeriesPerElement,
          ),
        ]),
      ).ok,
      true,
    );
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([
            chartElement(
              "series-overflow",
              1,
              RESOURCE_LIMITS.chartSeriesPerElement + 1,
            ),
          ]),
        ),
      "chartSeriesPerElement",
    );

    assert.equal(
      validateStructure(
        onePage([
          chartElement("points-boundary", RESOURCE_LIMITS.chartPointsPerSeries),
        ]),
      ).ok,
      true,
    );
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([
            chartElement(
              "points-overflow",
              RESOURCE_LIMITS.chartPointsPerSeries + 1,
            ),
          ]),
        ),
      "chartPointsPerSeries",
    );

    const labels = Array.from(
      { length: RESOURCE_LIMITS.chartPointsPerSeries },
      () => "",
    );
    const labelsBoundary = {
      ...chartElement("labels-boundary", 1),
      series: [{
        name: "series",
        labels,
        values: Array.from({ length: labels.length }, (_, index) => index),
      }],
    };
    assert.equal(validateStructure(onePage([labelsBoundary])).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([
            {
              ...labelsBoundary,
              series: [{ ...labelsBoundary.series[0], labels: [...labels, ""] }],
            },
          ]),
        ),
      "chartPointsPerSeries",
    );

    const perElementSeries = Array.from({ length: 4 }, (_, index) => ({
      name: `series-${index}`,
      values: Array.from(
        { length: RESOURCE_LIMITS.chartPointsPerSeries },
        (_, point) => point,
      ),
    }));
    const perElementBoundary = {
      ...chartElement("element-points", 1),
      series: perElementSeries,
    };
    assert.equal(validateStructure(onePage([perElementBoundary])).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([
            {
              ...perElementBoundary,
              series: [
                ...perElementSeries,
                { name: "overflow", values: [1] },
              ],
            },
          ]),
        ),
      "chartPointsPerElement",
    );
  });

  it("accepts aggregate chart points and rejects one extra point", () => {
    const chartCount =
      RESOURCE_LIMITS.chartPointsPerDeck /
      RESOURCE_LIMITS.chartPointsPerSeries;
    const charts = Array.from({ length: chartCount }, (_, index) =>
      chartElement(`chart-${index}`, RESOURCE_LIMITS.chartPointsPerSeries),
    );
    assert.equal(validateStructure(onePage(charts)).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([...charts, chartElement("chart-too-many", 1)]),
        ),
      "chartPointsPerDeck",
    );
  });

  it("accepts table collection boundaries and rejects row/column/cell overflow", () => {
    const rows = Array.from({ length: RESOURCE_LIMITS.tableRowsPerElement }, () => [
      "x",
    ]);
    const rowBoundary = {
      ...tableElement("rows", 1),
      rows,
    };
    assert.equal(validateStructure(onePage([rowBoundary])).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([{ ...rowBoundary, rows: [...rows, ["x"]] }]),
        ),
      "tableRowsPerElement",
    );

    const columns = Array.from(
      { length: RESOURCE_LIMITS.tableColumnsPerRow },
      () => "x",
    );
    const columnBoundary = { ...tableElement("columns", 1), rows: [columns] };
    assert.equal(validateStructure(onePage([columnBoundary])).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([{ ...columnBoundary, rows: [[...columns, "x"]] }]),
        ),
      "tableColumnsPerRow",
    );

    const colWBoundary = {
      ...tableElement("column-widths", 1),
      colW: Array.from(
        { length: RESOURCE_LIMITS.tableColumnsPerRow },
        () => 1,
      ),
    };
    assert.equal(validateStructure(onePage([colWBoundary])).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([{ ...colWBoundary, colW: [...colWBoundary.colW, 1] }]),
        ),
      "tableColumnsPerRow",
    );

    assert.equal(
      validateStructure(
        onePage([
          tableElement("cells-boundary", RESOURCE_LIMITS.tableCellsPerElement),
        ]),
      ).ok,
      true,
    );
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([
            tableElement(
              "cells-overflow",
              RESOURCE_LIMITS.tableCellsPerElement + 1,
            ),
          ]),
        ),
      "tableCellsPerElement",
    );
  });

  it("accepts aggregate table cells and rejects one extra cell", () => {
    const tableCount =
      RESOURCE_LIMITS.tableCellsPerDeck /
      RESOURCE_LIMITS.tableCellsPerElement;
    const tables = Array.from({ length: tableCount }, (_, index) =>
      tableElement(`table-${index}`, RESOURCE_LIMITS.tableCellsPerElement),
    );
    assert.equal(validateStructure(onePage(tables)).ok, true);
    expectResourceLimit(
      () =>
        validateStructure(
          onePage([...tables, tableElement("table-too-many", 1)]),
        ),
      "tableCellsPerDeck",
    );
  });

  it("accepts the per-file media boundary and rejects one extra byte", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-media-limit-"));
    try {
      mkdirSync(join(work, "media"));
      const path = join(work, "media/boundary.png");
      writePngSized(path, RESOURCE_LIMITS.mediaBytesPerFile);
      const deck = mediaDeck(["boundary.png"]);
      assert.equal(validateDeck(deck, { projectRoot: work, checkMedia: true }).ok, true);

      truncateSync(path, RESOURCE_LIMITS.mediaBytesPerFile + 1);
      expectResourceLimit(
        () => validateDeck(deck, { projectRoot: work, checkMedia: true }),
        "mediaBytesPerFile",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("counts each resolved media path once and enforces aggregate bytes", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-media-total-"));
    try {
      const mediaDir = join(work, "media");
      mkdirSync(mediaDir);
      const base = join(mediaDir, "image-0.png");
      writePngSized(base, RESOURCE_LIMITS.mediaBytesPerFile);
      const fileCount =
        RESOURCE_LIMITS.mediaBytesPerDeck /
        RESOURCE_LIMITS.mediaBytesPerFile;
      const names = ["image-0.png"];
      for (let index = 1; index < fileCount; index += 1) {
        const name = `image-${index}.png`;
        linkSync(base, join(mediaDir, name));
        names.push(name);
      }

      assert.equal(
        validateDeck(mediaDeck(names), { projectRoot: work, checkMedia: true }).ok,
        true,
      );
      assert.equal(
        validateDeck(mediaDeck(Array(fileCount).fill(names[0])), {
          projectRoot: work,
          checkMedia: true,
        }).ok,
        true,
      );

      writePngSized(join(mediaDir, "extra.png"), 4);
      expectResourceLimit(
        () =>
          validateDeck(mediaDeck([...names, "extra.png"]), {
            projectRoot: work,
            checkMedia: true,
          }),
        "mediaBytesPerDeck",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("rejects an over-limit public export before creating output", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-resource-export-"));
    try {
      const output = join(work, "should-not-exist.pptx");
      const deck = onePage([
        textElement("too-long", "x".repeat(RESOURCE_LIMITS.stringBytes + 1)),
      ]);
      await assert.rejects(
        () => compileToPptx(deck, output, { projectRoot: work, force: true }),
        (err) =>
          err instanceof OpenPptError &&
          err.code === ErrorCodes.RESOURCE_LIMIT,
      );
      assert.equal(existsSync(output), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("rejects an over-limit init title before creating project files", () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-resource-init-"));
    try {
      const project = join(work, "project");
      expectResourceLimit(
        () =>
          initProject(project, {
            title: "x".repeat(RESOURCE_LIMITS.stringBytes + 1),
          }),
        "stringBytes",
      );
      assert.equal(existsSync(project), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
