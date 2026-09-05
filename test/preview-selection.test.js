import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { locateAuthoringIdToken } from "../src/internal/authoring-source.js";
import { renderPreviewHtml } from "../src/preview.js";
import { startWebServer } from "../src/server.js";

const goldenRoot = join(import.meta.dir, "..", "fixtures", "golden");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapedId(n) {
  return `leaf"\\#[]<${n}>`;
}

function fiveLeafDeck() {
  return {
    version: "openppt-1",
    title: "Preview leaf ids",
    size: [960, 540],
    theme: { colors: { primary: "#2563EB", background: "#FFFFFF", text: "#111827" } },
    pages: [
      {
        id: "page-0",
        elements: [
          {
            id: escapedId(1),
            type: "text",
            bounds: [20, 20, 300, 40],
            text: "hello",
            fontSize: 18,
          },
          {
            id: escapedId(2),
            type: "shape",
            shape: "rect",
            bounds: [20, 80, 80, 80],
            fill: "#2563EB",
          },
          {
            id: escapedId(3),
            type: "image",
            bounds: [120, 80, 80, 80],
            src: "media/accent.png",
          },
        ],
      },
      {
        id: "page-1",
        elements: [
          {
            id: escapedId(4),
            type: "chart",
            chartType: "bar",
            bounds: [20, 20, 400, 200],
            series: [{ name: "s", labels: ["A", "B"], values: [1, 2] }],
          },
        ],
      },
      {
        id: "page-2",
        elements: [
          {
            id: escapedId(5),
            type: "table",
            bounds: [20, 20, 400, 120],
            rows: [["a", "b"]],
          },
        ],
      },
    ],
  };
}

function expectedLeaves(deck) {
  const out = [];
  for (const page of deck.pages) {
    for (const el of page.elements) {
      out.push({ page: page.id, id: el.id, type: el.type });
    }
  }
  return out;
}

/** Direct `.page > .el` leaves: type class plus escaped data-el-id. */
function previewLeaves(html) {
  const pages = [...html.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)];
  const leaves = [];
  for (const match of pages) {
    const pageId = /data-page="([^"]*)"/.exec(match[1])?.[1];
    const body = match[2];
    const tagRe = /<(div|img)\b([^>]*)>/gi;
    let tag;
    while ((tag = tagRe.exec(body))) {
      const attrs = tag[2];
      const className = /(?:^|\s)class="([^"]*)"/.exec(attrs)?.[1] || "";
      const classes = className.split(/\s+/).filter(Boolean);
      if (!classes.includes("el")) continue;
      leaves.push({
        page: pageId,
        id: /(?:^|\s)data-el-id="([^"]*)"/.exec(attrs)?.[1],
        type: classes.find((c) => c !== "el"),
      });
    }
  }
  return leaves;
}

describe("preview leaf selection ids", () => {
  test("escaped data-el-id on text, shape, image, chart, and table leaves", () => {
    const deck = fiveLeafDeck();
    const html = renderPreviewHtml(deck, goldenRoot);
    const expected = expectedLeaves(deck).map((leaf) => ({
      page: escapeHtml(leaf.page),
      id: escapeHtml(leaf.id),
      type: leaf.type,
    }));

    expect(html).not.toMatch(/<script[\s>]/i);
    expect(previewLeaves(html)).toEqual(expected);
    for (const leaf of expectedLeaves(deck)) {
      expect(html).toContain(`data-page="${escapeHtml(leaf.page)}"`);
      expect(html).toContain(`class="el ${leaf.type}"`);
    }
  });

  test("nested group child keeps escaped data-el-id after flatten", () => {
    const id = 'child"\\#[]<x>';
    const html = renderPreviewHtml(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              {
                id: "g",
                type: "group",
                layout: "stack",
                bounds: [40, 40, 800, 400],
                children: [{ id, type: "text", height: 80, text: "n", fontSize: 18 }],
              },
            ],
          },
        ],
      },
      goldenRoot,
    );
    expect(html).toContain(`data-el-id="${escapeHtml(id)}"`);
    expect(html).not.toMatch(/<script[\s>]/i);
  });

  test("selected outline does not raise stacking order above later siblings", () => {
    const html = renderPreviewHtml(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p",
            elements: [
              {
                id: "card",
                type: "shape",
                shape: "rect",
                bounds: [40, 40, 800, 300],
                fill: "#FFFFFF",
              },
              {
                id: "copy",
                type: "text",
                bounds: [70, 80, 700, 100],
                text: "Foreground content stays visible",
                fontSize: 24,
              },
            ],
          },
        ],
      },
      goldenRoot,
    );
    const rule = html.match(/\.el\.selected\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toMatch(/outline\s*:/);
    expect(rule[0]).not.toMatch(/z-index\s*:/);
    expect(html.indexOf('data-el-id="card"')).toBeLessThan(html.indexOf('data-el-id="copy"'));
  });

  test("studio iframe sandbox is allow-same-origin only", () => {
    const src = readFileSync(join(import.meta.dir, "../web/app.js"), "utf8");
    expect(src).toMatch(/sandbox:\s*"allow-same-origin"/);
    expect(src).not.toMatch(/allow-scripts/);
  });

  test("studio imports the shared authoring-source helper", () => {
    const src = readFileSync(join(import.meta.dir, "../web/app.js"), "utf8");
    expect(src).toMatch(/from ["']\/authoring-source\.js["']/);
    expect(src).not.toMatch(/function locateAuthoringIdToken/);
    expect(src).not.toMatch(/function locateJsonPath/);
  });

  test("GET /authoring-source.js serves src/internal/authoring-source.js", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openppt-c4c1-static-"));
    const ctx = startWebServer({ port: 0, dataDir });
    try {
      const res = await fetch(`${ctx.url}authoring-source.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") || "").toMatch(/javascript/);
      const body = await res.text();
      expect(body).toBe(
        readFileSync(join(import.meta.dir, "../src/internal/authoring-source.js"), "utf8"),
      );
    } finally {
      ctx.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("authoring source location", () => {
  const selectedId = 'selected"\\#[]<id>';
  const pageId = 'page"\\#[]<p>';

  function selectionDeck() {
    return {
      version: "openppt-1",
      title: "Selection source location",
      size: [960, 540],
      pages: [
        {
          id: "decoy-page",
          elements: [
            {
              id: "other-leaf",
              type: "text",
              bounds: [40, 40, 800, 100],
              text: selectedId,
              fontSize: 24,
            },
          ],
        },
        {
          id: pageId,
          elements: [
            {
              id: "decoy",
              type: "text",
              bounds: [40, 20, 800, 80],
              text: selectedId,
              fontSize: 20,
            },
            {
              id: "container",
              type: "group",
              layout: "stack",
              bounds: [40, 140, 800, 240],
              children: [
                {
                  id: selectedId,
                  type: "text",
                  height: 160,
                  text: "Actual nested child 内容",
                  fontSize: 24,
                },
              ],
            },
          ],
        },
      ],
    };
  }

  test("locates nested escaped id, not body-text decoy", () => {
    const source = `${JSON.stringify(selectionDeck(), null, 2)}\n`;
    const key = `"id": ${JSON.stringify(selectedId)}`;
    const pageAnchor = source.indexOf(`"id": ${JSON.stringify(pageId)}`);
    const expectedStart = source.indexOf(key, pageAnchor);
    expect(expectedStart).toBeGreaterThan(source.indexOf(JSON.stringify(selectedId)));
    const located = locateAuthoringIdToken(source, pageId, selectedId);
    expect(located).toEqual({
      kind: "ok",
      start: expectedStart,
      end: expectedStart + key.length,
    });
    expect(source.slice(located.start, located.end)).toBe(key);
  });

  test("locates compact JSON without relying on pretty-printed spacing", () => {
    const source = JSON.stringify(selectionDeck());
    const located = locateAuthoringIdToken(source, pageId, selectedId);
    expect(located.kind).toBe("ok");
    expect(source.slice(located.start, located.end)).toBe(`"id":${JSON.stringify(selectedId)}`);
  });

  test("external page files are not a false manifest offset", () => {
    const source = `${JSON.stringify({
      version: "openppt-1",
      size: [960, 540],
      pages: ["pages/cover.json", "pages/body.json"],
    }, null, 2)}\n`;
    const located = locateAuthoringIdToken(source, "cover", "t");
    expect(located.kind).toBe("external");
    expect(located.paths).toEqual(["pages/cover.json", "pages/body.json"]);
  });

  test("invalid JSON is not rewritten by lookup", () => {
    const source = `${JSON.stringify(selectionDeck(), null, 2)}\n INVALID`;
    const snapshot = source;
    const located = locateAuthoringIdToken(source, pageId, selectedId);
    expect(located.kind).toBe("invalid");
    expect(source).toBe(snapshot);
  });
});
