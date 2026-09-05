#!/usr/bin/env bun

/**
 * OpenPPT randomized generation battery (seeded, reproducible).
 *
 * Positive half: generates N random-but-valid decks across the whole IR
 * surface (rich text, shapes, images, charts, tables, nested layout groups),
 * then validates, exports, unzips, and asserts artifact hygiene.
 *
 * Negative half: applies a catalog of fail-closed mutations to a valid base
 * deck and asserts the exact error code fires and no output file is written.
 *
 * Usage:
 *   bun scripts/dogfood-random.js [--count 40] [--seed 20260830] [--out <dir>]
 *
 * Failures keep the offending deck folder and print a one-line repro command.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { stringify as yamlStringify } from "yaml";

import {
  loadDeck,
  validateDeck,
  compileToPptx,
  renderPreviewHtml,
  OpenPptError,
} from "../src/index.js";

/* ---------------- seeded PRNG ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- minimal valid media (same recipes as the fixed battery) */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function minimalGif(width = 7, height = 9) {
  const buf = Buffer.alloc(24);
  buf.write("GIF89a", 0);
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function minimalJpeg(width = 13, height = 11) {
  const buf = Buffer.alloc(24, 0);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xc0;
  buf.writeUInt16BE(11, 4);
  buf[6] = 8;
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

function minimalWebp(width = 17, height = 19) {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0);
  buf.write("WEBP", 8);
  buf.write("VP8 ", 12);
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf;
}

const SVG_BADGE = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48"><rect width="120" height="48" rx="8" fill="#334155"/></svg>`,
  "utf8",
);

const MEDIA_POOL = [
  { src: "media/a.png", bytes: PNG_1X1, raster: true },
  { src: "media/b.jpg", bytes: minimalJpeg(320, 200), raster: true },
  { src: "media/c.gif", bytes: minimalGif(64, 64), raster: true },
  { src: "media/d.webp", bytes: minimalWebp(200, 100), raster: true },
  { src: "media/e.svg", bytes: SVG_BADGE, raster: false },
];

/* ---------------- random deck generator ---------------- */

const CANVAS = [960, 540];
const TEXT_POOL = [
  "季度复盘", "Roadmap 2027", "增长引擎", "边界条件 & <edge>", "\"quoted\" 'single'",
  "🚀 发布", "多语言 · 混排 · Text", "línea três", "深圳·北京·上海", "<script>alert(1)</script>",
  "换行\n第二行", "长句:这是一段用于占位的较长中文说明文字,覆盖折行与容量估算。",
];
const SCHEMES = ["https://example.com/x", "http://intranet.local/a", "mailto:hi@example.com"];

function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

function hex(rng, alpha) {
  const chars = "0123456789ABCDEF";
  let out = "#";
  const n = alpha ? 8 : 6;
  for (let i = 0; i < n; i += 1) out += chars[rng.int(0, 15)];
  return out;
}

function buildGenerator(rng) {
  let counter = 0;
  const id = (prefix) => `${prefix}-${(counter += 1)}`;
  const tokens = ["$primary", "$text", "$muted", "$accent"];
  const color = () => (rng.chance(0.5) ? rng.pick(tokens) : hex(rng, rng.chance(0.25)));

  function textValue() {
    if (rng.chance(0.35)) {
      const runs = [];
      const n = rng.int(1, 5);
      for (let i = 0; i < n; i += 1) {
        const run = { text: rng.pick(TEXT_POOL) };
        if (rng.chance(0.4)) run.bold = rng.chance(0.5);
        if (rng.chance(0.4)) run.color = color();
        if (rng.chance(0.3)) run.fontSize = rng.int(9, 40);
        runs.push(run);
      }
      return runs;
    }
    return rng.pick(TEXT_POOL);
  }

  function leafText(sized) {
    const el = { id: id("t"), type: "text", text: textValue(), fontSize: rng.int(9, 54), color: color() };
    if (rng.chance(0.5)) el.align = rng.pick(["left", "center", "right"]);
    if (rng.chance(0.4)) el.valign = rng.pick(["top", "middle", "bottom"]);
    if (rng.chance(0.35)) el.bold = true;
    if (rng.chance(0.15)) el.href = rng.pick(SCHEMES);
    return sized ? el : el;
  }

  function leafShape() {
    const el = { id: id("s"), type: "shape", shape: rng.pick(["rect", "roundRect", "ellipse"]), fill: color() };
    if (rng.chance(0.5)) {
      el.lineColor = color();
      el.lineWidth = rng.int(0, 6);
    }
    return el;
  }

  function leafImage() {
    const media = rng.pick(MEDIA_POOL);
    return {
      id: id("img"), type: "image", src: media.src,
      fit: media.raster ? rng.pick(["cover", "contain", "fill"]) : "fill",
    };
  }

  function leafChart() {
    const chartType = rng.pick(["bar", "line", "pie", "doughnut", "area"]);
    const points = rng.int(2, 10);
    const n = chartType === "pie" || chartType === "doughnut" ? 1 : rng.int(1, 3);
    const labels = rng.chance(0.5)
      ? Array.from({ length: points }, (_, k) => `C${k + 1}`)
      : null;
    const series = [];
    for (let i = 0; i < n; i += 1) {
      const values = [];
      for (let p = 0; p < points; p += 1) values.push(rng.int(-50, 500) + rng.next());
      const entry = { name: `S${i + 1}`, values };
      if (labels) entry.labels = labels.slice();
      series.push(entry);
    }
    const el = {
      id: id("ch"), type: "chart",
      chartType,
      series,
    };
    if (rng.chance(0.5)) el.title = rng.pick(TEXT_POOL);
    return el;
  }

  function leafTable() {
    const cols = rng.int(2, 5);
    const rowsN = rng.int(2, 8);
    const rows = [];
    for (let r = 0; r < rowsN; r += 1) {
      const row = [];
      const short = rng.chance(0.15) && r > 0; // ragged row sometimes
      for (let c = 0; c < (short ? cols - 1 : cols); c += 1) {
        if (rng.chance(0.25)) {
          const cell = { text: rng.pick(TEXT_POOL) };
          if (rng.chance(0.5)) cell.bold = true;
          if (rng.chance(0.5)) cell.color = color();
          if (rng.chance(0.4)) cell.fill = color();
          if (rng.chance(0.3)) cell.align = rng.pick(["left", "center", "right"]);
          row.push(cell);
        } else {
          row.push(rng.chance(0.5) ? rng.pick(TEXT_POOL) : rng.int(0, 9999));
        }
      }
      rows.push(row);
    }
    const el = { id: id("tb"), type: "table", rows };
    if (rng.chance(0.5)) el.header = true;
    if (rng.chance(0.4)) el.colW = Array.from({ length: cols }, () => rng.int(1, 4));
    if (rng.chance(0.5)) el.fontSize = rng.int(8, 18);
    return el;
  }

  function anyLeaf() {
    const roll = rng.next();
    if (roll < 0.4) return leafText(true);
    if (roll < 0.65) return leafShape();
    if (roll < 0.78) return leafImage();
    if (roll < 0.9) return leafChart();
    return leafTable();
  }

  /**
   * Child of stack/row must carry the main-axis size or flex. Fixed sizes can
   * overflow a group whose extent is unknown before layout, so nested levels
   * are flex-only and depth-1 groups allow at most one small fixed child —
   * feasibility by construction (overflow rejection itself is covered by the
   * negative battery and unit tests).
   */
  function sizedChild(axisKey, depth, allowFixed) {
    const node = rng.chance(0.3) && depth < 3 ? group(depth + 1, false) : anyLeaf();
    if (allowFixed) node[axisKey] = rng.int(24, 40);
    else node.flex = rng.int(1, 3);
    return node;
  }

  function mainAxisChildren(node, axisKey, depth) {
    const n = rng.int(2, 4);
    const fixedAt = depth === 1 && rng.chance(0.5) ? rng.int(0, n - 1) : -1;
    for (let i = 0; i < n; i += 1) {
      node.children.push(sizedChild(axisKey, depth, i === fixedAt));
    }
  }

  function group(depth, topLevel) {
    const layout = rng.pick(["stack", "row", "grid", "layer"]);
    const node = { id: id("g"), type: "group", layout, children: [] };
    const n = rng.int(2, 4);
    if (layout === "stack") {
      mainAxisChildren(node, "height", depth);
      if (rng.chance(0.4)) node.justify = rng.pick(["start", "center", "end", "space-between"]);
      if (rng.chance(0.4)) node.align = rng.pick(["stretch", "start", "center", "end"]);
      // absolute gaps can exceed the tiny extents deep nesting produces, so
      // only depth 1 uses them; deeper levels stay feasible by construction
      if (depth === 1 && rng.chance(0.6)) node.gap = rng.int(4, 16);
      if (depth === 1 && rng.chance(0.4)) node.padding = rng.int(4, 16);
    } else if (layout === "row") {
      mainAxisChildren(node, "width", depth);
      if (rng.chance(0.4)) node.justify = rng.pick(["start", "center", "end", "space-between"]);
      if (rng.chance(0.4)) node.align = rng.pick(["stretch", "start", "center", "end"]);
      if (depth === 1 && rng.chance(0.6)) node.gap = rng.int(4, 16);
    } else if (layout === "grid") {
      node.columns = rng.int(2, 4);
      const cells = rng.int(2, 8);
      node.children = [];
      for (let i = 0; i < cells; i += 1) {
        node.children.push(rng.chance(0.2) && depth < 2 ? group(depth + 1, false) : anyLeaf());
      }
      if (depth === 1 && rng.chance(0.6)) node.gap = rng.int(4, 12);
    } else {
      // layer: children fill the group bounds
      for (let i = 0; i < n; i += 1) node.children.push(anyLeaf());
    }
    if (topLevel) node.bounds = randomBounds(280, 220);
    return node;
  }

  function randomBounds(minW = 20, minH = 20) {
    const [cw, ch] = CANVAS;
    const w = rng.int(minW, cw - 20);
    const h = rng.int(minH, ch - 20);
    const x = rng.int(0, cw - w);
    const y = rng.int(0, ch - h);
    return [x, y, w, h];
  }

  function page(index) {
    const elements = [];
    const n = rng.int(1, 6);
    for (let i = 0; i < n; i += 1) {
      if (rng.chance(0.3)) {
        elements.push(group(1, true));
      } else {
        const leaf = anyLeaf();
        leaf.bounds = randomBounds();
        elements.push(leaf);
      }
    }
    return {
      id: `pg-${index}-${(counter += 1)}`,
      background: rng.chance(0.7) ? { type: "solid", color: rng.chance(0.5) ? "$background" : hex(rng, false) } : undefined,
      elements,
    };
  }

  function deck(index) {
    const pages = [];
    const n = rng.int(1, 6);
    for (let i = 0; i < n; i += 1) pages.push(page(i + 1));
    return {
      version: "openppt-1",
      title: `Random deck #${index} · ${rng.pick(TEXT_POOL)}`,
      size: [...CANVAS],
      theme: {
        colors: {
          primary: hex(rng, false),
          text: hex(rng, false),
          background: "#FFFFFF",
          muted: hex(rng, false),
          accent: hex(rng, rng.chance(0.3)),
        },
      },
      pages: pages.map((p) => (p.background ? p : { id: p.id, elements: p.elements })),
    };
  }

  return { deck };
}

/* ---------------- negative catalog ---------------- */

function baseValidDeck() {
  return {
    version: "openppt-1",
    title: "negative base",
    size: [...CANVAS],
    theme: { colors: { primary: "#2563EB", text: "#111827", background: "#FFFFFF" } },
    pages: [
      {
        id: "n1",
        background: { type: "solid", color: "$background" },
        elements: [
          { id: "n1-t", type: "text", bounds: [40, 40, 400, 60], text: "ok", fontSize: 20, color: "$text" },
          { id: "n1-s", type: "shape", bounds: [40, 140, 200, 100], shape: "rect", fill: "$primary" },
        ],
      },
    ],
  };
}

const NEGATIVES = [
  ["bounds outside canvas", "BOUNDS_OUT_OF_RANGE", (d) => { d.pages[0].elements[0].bounds = [900, 40, 400, 60]; }],
  ["unknown theme token", "THEME_COLOR_UNRESOLVED", (d) => { d.pages[0].elements[0].color = "$nope"; }],
  ["prototype-chain token", "THEME_COLOR_UNRESOLVED", (d) => { d.pages[0].elements[0].color = "$constructor"; }],
  ["duplicate element id", "SCHEMA_INVALID", (d) => { d.pages[0].elements[1].id = "n1-t"; }],
  ["fontSize magnitude", "SCHEMA_INVALID", (d) => { d.pages[0].elements[0].fontSize = 1e308; }],
  ["negative lineWidth", "SCHEMA_INVALID", (d) => { d.pages[0].elements[1].lineWidth = -1; }],
  ["missing media", "MEDIA_MISSING", (d) => {
    d.pages[0].elements.push({ id: "n1-img", type: "image", bounds: [300, 300, 100, 100], src: "media/ghost.png" });
  }],
  ["javascript href", "SCHEMA_INVALID", (d) => { d.pages[0].elements[0].href = "javascript:alert(1)"; }],
  ["page ceiling", "RESOURCE_LIMIT_EXCEEDED", (d) => {
    for (let i = 0; i < 257; i += 1) {
      d.pages.push({ id: `bulk-${i}`, elements: [{ id: `bulk-${i}-t`, type: "text", bounds: [0, 0, 100, 40], text: "x" }] });
    }
  }],
  ["string ceiling", "RESOURCE_LIMIT_EXCEEDED", (d) => { d.pages[0].elements[0].text = "字".repeat(70000); }],
];

/* ---------------- runner ---------------- */

async function inspectPptx(path, expectedSlides, problems) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  if (slides.length !== expectedSlides) {
    problems.push(`slide count ${slides.length} != pages ${expectedSlides}`);
  }
  for (const name of slides.sort()) {
    const xml = await zip.file(name).async("string");
    if (xml.includes("Infinity")) problems.push(`${name}: Infinity`);
    if (xml.includes('="NaN"')) problems.push(`${name}: NaN attribute`);
    if (xml.includes("rIdundefined")) problems.push(`${name}: rIdundefined`);
    if (xml.includes("[object Object]")) problems.push(`${name}: [object Object]`);
    const ids = [...xml.matchAll(/r:(?:id|embed)="([^"]+)"/g)].map((m) => m[1]);
    if (ids.length) {
      const relsFile = zip.file(name.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels");
      if (!relsFile) {
        problems.push(`${name}: missing rels part`);
      } else {
        const rels = await relsFile.async("string");
        const defined = new Set([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
        for (const rid of ids) {
          if (!defined.has(rid)) problems.push(`${name}: dangling ${rid}`);
        }
      }
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let count = 40;
  let seed = 20260830;
  let outDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--count") count = Number(argv[i + 1]);
    if (argv[i] === "--seed") seed = Number(argv[i + 1]);
    if (argv[i] === "--out") outDir = argv[i + 1];
  }
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(seed)) {
    console.error("--count and --seed must be integers");
    process.exit(2);
  }
  outDir = outDir ? outDir : mkdtempSync(join(tmpdir(), "openppt-fuzz-"));
  mkdirSync(outDir, { recursive: true });

  console.log(`OpenPPT random battery · seed=${seed} count=${count} → ${outDir}\n`);
  const rng = makeRng(seed);
  const gen = buildGenerator(rng);
  let failures = 0;

  /* positive half — three authoring variants: plain JSON, multi-file, YAML */
  for (let i = 1; i <= count; i += 1) {
    const deck = gen.deck(i);
    const dir = join(outDir, `deck-${String(i).padStart(3, "0")}`);
    mkdirSync(join(dir, "media"), { recursive: true });
    for (const media of MEDIA_POOL) writeFileSync(join(dir, media.src), media.bytes);

    const variantRoll = rng.next();
    let deckPath;
    if (variantRoll < 0.2) {
      // YAML authoring path
      deckPath = join(dir, "deck.yaml");
      writeFileSync(deckPath, yamlStringify(deck), "utf8");
    } else if (variantRoll < 0.45) {
      // multi-file: externalize a random subset of pages (keep ≥1 inline when possible)
      mkdirSync(join(dir, "pages"), { recursive: true });
      const mixed = deck.pages.map((page, pi) => {
        if (rng.chance(0.6)) {
          const rel = `pages/pg-${pi + 1}.json`;
          writeFileSync(join(dir, rel), `${JSON.stringify(page, null, 2)}\n`, "utf8");
          return rel;
        }
        return page;
      });
      deckPath = join(dir, "deck.json");
      writeFileSync(
        deckPath,
        `${JSON.stringify({ ...deck, pages: mixed }, null, 2)}\n`,
        "utf8",
      );
    } else {
      deckPath = join(dir, "deck.json");
      writeFileSync(deckPath, `${JSON.stringify(deck, null, 2)}\n`, "utf8");
    }

    const problems = [];
    try {
      const loaded = loadDeck(deckPath);
      validateDeck(loaded.deck, { projectRoot: loaded.projectRoot, checkMedia: true });
      const pptxPath = join(dir, "out.pptx");
      await compileToPptx(loaded.deck, pptxPath, { projectRoot: loaded.projectRoot, force: true });
      await inspectPptx(pptxPath, deck.pages.length, problems);
      if (i % 5 === 0) {
        const html = renderPreviewHtml(loaded.deck, loaded.projectRoot);
        if (/<script>alert\(1\)<\/script>/.test(html)) problems.push("preview: unescaped script payload");
      }
    } catch (err) {
      problems.push(`${err instanceof OpenPptError ? `[${err.code}] ` : "crash: "}${err.message}`);
    }

    if (problems.length) {
      failures += 1;
      console.log(`[FAIL] deck-${i}  (${problems.length} problems, kept at ${dir})`);
      for (const p of problems.slice(0, 6)) console.log(`       ✗ ${p}`);
      console.log(`       repro: bun scripts/dogfood-random.js --seed ${seed} --count ${i}`);
    }
  }
  console.log(`positive: ${count - failures}/${count} random decks exported clean`);

  /* negative half */
  let negFailures = 0;
  for (const [label, expectedCode, mutate] of NEGATIVES) {
    const deck = baseValidDeck();
    mutate(deck);
    const dir = join(outDir, `neg-${label.replace(/[^a-z]+/gi, "-")}`);
    mkdirSync(join(dir, "media"), { recursive: true });
    writeFileSync(join(dir, "deck.json"), `${JSON.stringify(deck)}\n`, "utf8");
    const pptxPath = join(dir, "out.pptx");
    let outcome = "no error thrown";
    try {
      const loaded = loadDeck(join(dir, "deck.json"));
      validateDeck(loaded.deck, { projectRoot: loaded.projectRoot, checkMedia: true });
      await compileToPptx(loaded.deck, pptxPath, { projectRoot: loaded.projectRoot, force: true });
    } catch (err) {
      outcome = err instanceof OpenPptError ? err.code : `untyped: ${err.message}`;
    }
    const ok = outcome === expectedCode && !existsSync(pptxPath);
    if (!ok) {
      negFailures += 1;
      console.log(`[FAIL] negative "${label}" — expected ${expectedCode}, got ${outcome}${existsSync(pptxPath) ? " (output was written!)" : ""}`);
    }
  }
  console.log(`negative: ${NEGATIVES.length - negFailures}/${NEGATIVES.length} fail-closed mutations rejected with exact codes`);

  const ok = failures === 0 && negFailures === 0;
  writeFileSync(
    join(outDir, "report.json"),
    `${JSON.stringify({ seed, count, positiveFailures: failures, negativeFailures: negFailures, ok }, null, 2)}\n`,
    "utf8",
  );
  if (!ok) process.exit(1);
  console.log(`\nOK · seed=${seed} · artifacts kept at ${outDir}`);
}

main();
