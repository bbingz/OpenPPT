import { describe, test, expect } from "bun:test";

import { renderPreviewHtml } from "../src/index.js";

function chartDeck(chart) {
  return {
    version: "openppt-1",
    title: "chart preview",
    size: [960, 540],
    theme: { colors: { primary: "#2563EB", background: "#FFFFFF", text: "#111827" } },
    pages: [
      {
        id: "p1",
        background: { type: "solid", color: "$background" },
        elements: [{ id: "c1", bounds: [40, 40, 400, 240], ...chart }],
      },
    ],
  };
}

describe("preview mini-charts", () => {
  test("bar chart renders sampled rects with escaped labels and legend", () => {
    const html = renderPreviewHtml(
      chartDeck({
        type: "chart",
        chartType: "bar",
        title: "营收 <b>粗体注入</b>",
        series: [
          { name: "华东<script>", labels: ["Q1", "Q2", "Q3", "Q4"], values: [10, 20, 30, 40] },
          { name: "华南", values: [5, 15, 25, 35] },
        ],
      }),
      process.cwd(),
    );
    expect(html).toContain("<svg");
    const rects = html.match(/<rect /g) || [];
    // 8 data bars + 2 legend swatches
    expect(rects.length).toBe(10);
    expect(html).toContain("华东&lt;script&gt;");
    expect(html).toContain("营收 &lt;b&gt;粗体注入&lt;/b&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain(">Q1<");
  });

  test("long line series is sampled and stays finite", () => {
    const values = Array.from({ length: 2000 }, (_, i) => Math.sin(i / 40) * 100);
    const html = renderPreviewHtml(
      chartDeck({ type: "chart", chartType: "line", series: [{ name: "s", values }] }),
      process.cwd(),
    );
    const polyline = html.match(/<polyline points="([^"]+)"/);
    expect(polyline).not.toBeNull();
    const points = polyline[1].split(" ");
    expect(points.length).toBeLessThanOrEqual(256);
    expect(polyline[1]).not.toContain("NaN");
    expect(polyline[1]).not.toContain("Infinity");
  });

  test("area chart draws a filled polygon plus its line", () => {
    const html = renderPreviewHtml(
      chartDeck({ type: "chart", chartType: "area", series: [{ name: "a", values: [3, 9, 6] }] }),
      process.cwd(),
    );
    expect(html).toContain("<polygon");
    expect(html).toContain("<polyline");
  });

  test("pie ignores negatives, doughnut cuts a hole, full-circle slice works", () => {
    const pie = renderPreviewHtml(
      chartDeck({
        type: "chart",
        chartType: "pie",
        series: [{ name: "份额", labels: ["直营", "经销"], values: [60, -5] }],
      }),
      process.cwd(),
    );
    // negative slice contributes nothing → the only positive slice is a full circle
    expect(pie).toContain("<circle");
    expect(pie).not.toContain("NaN");
    expect(pie).toContain("直营");

    const doughnut = renderPreviewHtml(
      chartDeck({
        type: "chart",
        chartType: "doughnut",
        series: [{ name: "d", values: [30, 70] }],
      }),
      process.cwd(),
    );
    const circles = doughnut.match(/<circle /g) || [];
    expect(circles.length).toBeGreaterThanOrEqual(1); // hole
    expect(doughnut).toContain("<path");
  });

  test("all-zero pie falls back to a no-data note instead of NaN math", () => {
    const html = renderPreviewHtml(
      chartDeck({ type: "chart", chartType: "pie", series: [{ name: "z", values: [0, 0] }] }),
      process.cwd(),
    );
    expect(html).toContain("no data");
    expect(html).not.toContain("NaN");
  });
});
