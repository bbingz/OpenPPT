#!/usr/bin/env bun

/**
 * OpenPPT dogfood battery — automated *real* generation tasks.
 *
 * Runs 12 realistic end-to-end scenarios (authoring, layout, charts, tables,
 * rich text, media formats, outline, multi-file, YAML, PPTX import round-trip,
 * Studio HTTP API, and a stress deck), then inspects the actual artifacts:
 * unzipped slide XML sanity, relationship integrity, preview escaping, sizes.
 *
 * Usage:
 *   bun scripts/dogfood.js [--out <dir>]
 *
 * Exit code 0 only when every scenario passes. Artifacts are kept in the
 * output directory for manual inspection; a machine-readable report.json is
 * written next to them.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";

import {
  loadDeck,
  validateDeck,
  qaDeck,
  exportDeckFile,
  compileToPptx,
  renderPreviewHtml,
  writePreviewHtml,
  initProject,
  projectFromOutline,
  importPptx,
  startWebServer,
} from "../src/index.js";

/* ---------------- tiny check framework ---------------- */

class Scenario {
  constructor(name, outDir) {
    this.name = name;
    this.outDir = outDir;
    this.checks = [];
  }

  check(label, ok, info = "") {
    this.checks.push({ label, ok: Boolean(ok), info: String(info) });
    return ok;
  }

  eq(label, actual, expected) {
    return this.check(
      label,
      actual === expected,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }

  ge(label, actual, min) {
    return this.check(label, actual >= min, `expected >= ${min}, got ${actual}`);
  }

  contains(label, haystack, needle) {
    return this.check(
      label,
      String(haystack).includes(needle),
      `missing ${JSON.stringify(needle)}`,
    );
  }

  lacks(label, haystack, needle) {
    return this.check(
      label,
      !String(haystack).includes(needle),
      `unexpectedly found ${JSON.stringify(needle)}`,
    );
  }

  get failed() {
    return this.checks.filter((c) => !c.ok);
  }
}

/* ---------------- artifact inspectors ---------------- */

async function unzip(path) {
  return JSZip.loadAsync(readFileSync(path));
}

async function slideXmls(zip) {
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const out = [];
  for (const name of names) out.push({ name, xml: await zip.file(name).async("string") });
  return out;
}

/** Attribute-level hygiene: numbers that overflowed or ids that never resolved. */
function xmlSane(s, name, xml) {
  s.lacks(`${name}: no Infinity`, xml, "Infinity");
  s.lacks(`${name}: no NaN attr`, xml, '="NaN"');
  s.lacks(`${name}: no rIdundefined`, xml, "rIdundefined");
  s.lacks(`${name}: no [object Object]`, xml, "[object Object]");
}

/** Every r:embed / r:id used in a slide must exist in its rels part. */
async function relsResolve(s, zip, slideName) {
  const xml = await zip.file(slideName).async("string");
  const relsName = slideName.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
  const relsFile = zip.file(relsName);
  const ids = [...xml.matchAll(/r:(?:id|embed)="([^"]+)"/g)].map((m) => m[1]);
  if (!ids.length) {
    s.check(`${slideName}: no rels needed`, true);
    return;
  }
  if (!relsFile) {
    s.check(`${slideName}: rels part exists`, false, `missing ${relsName}`);
    return;
  }
  const rels = await relsFile.async("string");
  const defined = new Set([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
  const missing = ids.filter((id) => !defined.has(id));
  s.check(`${slideName}: all ${ids.length} r:ids resolve`, missing.length === 0, missing.join(","));
}

/* ---------------- shared fixtures ---------------- */

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
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48"><rect width="120" height="48" rx="8" fill="#2563EB"/></svg>`,
  "utf8",
);

const THEME = {
  colors: {
    primary: "#2563EB",
    accent: "#7C3AED",
    text: "#111827",
    muted: "#6B7280",
    background: "#FFFFFF",
    surface: "#F3F4F6",
  },
};

function baseDeck(title, pages) {
  return { version: "openppt-1", title, size: [960, 540], theme: THEME, pages };
}

function writeProject(dir, deck, media = {}) {
  mkdirSync(join(dir, "media"), { recursive: true });
  writeFileSync(join(dir, "deck.json"), `${JSON.stringify(deck, null, 2)}\n`, "utf8");
  for (const [name, bytes] of Object.entries(media)) {
    writeFileSync(join(dir, "media", name), bytes);
  }
  return join(dir, "deck.json");
}

/* ---------------- scenarios ---------------- */

const SCENARIOS = [];
function scenario(name, fn) {
  SCENARIOS.push({ name, fn });
}

/* S1 中文产品发布会:skeleton 模板真实成稿 */
scenario("pitch-zh", async (s) => {
  const dir = join(s.outDir, "pitch-zh");
  initProject(dir, { title: "岚图智能座舱 · 发布会", theme: "magazine", skeleton: true });
  const deckPath = join(dir, "deck.json");
  const deck = JSON.parse(readFileSync(deckPath, "utf8"));
  const replacements = {
    "{{SUBTITLE}}": "把每一次通勤,变成一段旅程",
    "{{FOOTER}}": "岚图汽车 · 2026 秋季发布",
    "{{TOC_1}}": "行业趋势与用户洞察",
    "{{TOC_2}}": "座舱系统架构",
    "{{TOC_3}}": "生态与合作伙伴",
    "{{TOC_4}}": "定价与上市节奏",
    "{{SECTION_TITLE}}": "座舱系统架构",
    "{{BODY}}": "三屏联动 + 语音全场景免唤醒;算力平台支持 OTA 三年演进,开放 SDK 接入第三方应用。",
    "{{CALLOUT}}": "▶ 现场演示:一句话规划周末露营行程",
    "{{CLOSING}}": "谢谢 · 一起出发",
    "{{CTA}}": "预售通道今晚 20:00 开启",
    "{{CONTACT}}": "media@voyah.example · 400-000-0000",
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      if (typeof node.text === "string" && replacements[node.text]) {
        node.text = replacements[node.text];
      }
      Object.values(node).forEach(walk);
    }
  };
  walk(deck);
  writeFileSync(deckPath, `${JSON.stringify(deck, null, 2)}\n`, "utf8");

  const loaded = loadDeck(deckPath);
  validateDeck(loaded.deck, { projectRoot: loaded.projectRoot, checkMedia: true });
  const qa = qaDeck(loaded.deck, { projectRoot: loaded.projectRoot, failOn: "high" });
  s.check("qa passes at fail-on high", qa.ok, JSON.stringify(qa.issues.slice(0, 3)));

  const pptxPath = join(dir, "out.pptx");
  await compileToPptx(loaded.deck, pptxPath, { projectRoot: loaded.projectRoot, force: true });
  writePreviewHtml(loaded.deck, loaded.projectRoot, join(dir, "preview.html"), { force: true });

  const zip = await unzip(pptxPath);
  const slides = await slideXmls(zip);
  s.eq("4 slides", slides.length, 4);
  for (const { name, xml } of slides) xmlSane(s, name, xml);
  s.contains("cover title survives", slides[0].xml, "岚图智能座舱");
  s.contains("body copy survives", slides[2].xml, "三屏联动");
});

/* S2 图表全家桶:5 种图表 + 单系列饼图标签 */
scenario("charts-all", async (s) => {
  const dir = join(s.outDir, "charts-all");
  const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];
  const mkChart = (id, chartType, x, y, series) => ({
    id, type: "chart", chartType, bounds: [x, y, 430, 230],
    title: `${chartType} demo`,
    series,
  });
  const multi = [
    { name: "华东", labels: QUARTERS, values: [42, 58, 63, 71] },
    { name: "华南", labels: QUARTERS, values: [35, 41, 55, 60] },
  ];
  const single = [{ name: "份额", labels: ["直营", "经销", "线上", "其他"], values: [45, 30, 15, 10] }];
  const deck = baseDeck("图表全家桶", [
    { id: "c1", background: { type: "solid", color: "$background" }, elements: [
      mkChart("bar1", "bar", 30, 30, multi), mkChart("line1", "line", 500, 30, multi),
      mkChart("area1", "area", 30, 285, multi), mkChart("pie1", "pie", 500, 285, single),
    ]},
    { id: "c2", background: { type: "solid", color: "$surface" }, elements: [
      mkChart("dough1", "doughnut", 30, 30, single),
    ]},
  ]);
  const deckPath = writeProject(dir, deck);
  const pptxPath = join(dir, "out.pptx");
  await exportDeckFile(deckPath, pptxPath, { force: true });

  const zip = await unzip(pptxPath);
  const chartParts = Object.keys(zip.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  s.eq("5 chart parts", chartParts.length, 5);
  let pieXml = "";
  let catHits = 0;
  for (const name of chartParts) {
    const xml = await zip.file(name).async("string");
    xmlSane(s, name, xml);
    if (xml.includes("pieChart")) pieXml = xml;
    if (xml.includes(">Q1<") || xml.includes(">直营<")) catHits += 1;
  }
  s.eq("authored category labels reach every chart", catHits, chartParts.length);
  s.check("single-series pie has legend or data labels",
    pieXml.includes("<c:legend>") || pieXml.includes("<c:dLbls>"), "pie chart lacks both");
  s.contains("pie categories use authored labels", pieXml, "直营");
  for (const { name } of await slideXmls(zip)) await relsResolve(s, zip, name);
});

/* S3 表格深水区:50 行 + 不齐行 + colW 权重 + RGBA */
scenario("tables-real", async (s) => {
  const dir = join(s.outDir, "tables-real");
  const rows = [[
    { text: "套餐", bold: true, color: "#FFFFFF", fill: "#0D9488" },
    { text: "月费", bold: true, color: "#FFFFFF", fill: "#0D9488" },
    { text: "流量", bold: true, color: "#FFFFFF", fill: "#0D9488" },
    { text: "备注", bold: true, color: "#FFFFFF", fill: "#0D9488" },
  ]];
  for (let i = 1; i <= 50; i += 1) {
    rows.push([
      `Plan-${i}`,
      { text: `¥${(i * 9.9).toFixed(1)}`, align: "right" },
      `${i * 5}GB`,
      i % 7 === 0 ? { text: "限时", color: "#DC2626", bold: true } : "",
    ]);
  }
  rows.push(["合计", "—", "—"]); // ragged row on purpose
  const deck = baseDeck("资费表", [
    { id: "t1", background: { type: "solid", color: "$background" }, elements: [
      { id: "price-table", type: "table", bounds: [40, 40, 880, 460], header: true,
        fontSize: 11, colW: [2, 1, 1, 1.5],
        borderColor: "#E5E7EB", borderWidth: 1, rows },
    ]},
  ]);
  const deckPath = writeProject(dir, deck);
  const pptxPath = join(dir, "out.pptx");
  await exportDeckFile(deckPath, pptxPath, { force: true });
  const zip = await unzip(pptxPath);
  const [{ name, xml }] = await slideXmls(zip);
  xmlSane(s, name, xml);
  const gridCols = (xml.match(/<a:gridCol /g) || []).length;
  s.eq("4 grid columns", gridCols, 4);
  const rowCount = (xml.match(/<a:tr /g) || []).length;
  s.eq("52 table rows", rowCount, 52);
  s.contains("ragged row padded", xml, "合计");
  s.contains("rich header cell fill applied", xml, "0D9488");
  s.contains("rich cell color applied", xml, "DC2626");
});

/* S4 富文本与链接:run 覆盖、href、特殊字符 */
scenario("richtext-links", async (s) => {
  const dir = join(s.outDir, "richtext-links");
  const deck = baseDeck("富文本 & 链接 <测试> \"引号\" '单引' 🚀", [
    { id: "r1", background: { type: "solid", color: "$background" }, elements: [
      { id: "rich", type: "text", bounds: [60, 60, 840, 120], fontSize: 20, bold: true, color: "$text",
        text: [
          { text: "粗体基线," },
          { text: "这段取消粗体,", bold: false },
          { text: "这段换色", color: "#DC2626" },
          { text: "这段放大", fontSize: 28 },
          { text: " & <html> \"quotes\" 🚀" },
        ]},
      { id: "link", type: "text", bounds: [60, 220, 840, 60], fontSize: 18, color: "$primary",
        text: "查看完整文档", href: "https://github.com/bbingz/OpenPPT" },
      { id: "rgba", type: "text", bounds: [60, 320, 840, 60], fontSize: 16, color: "#11182780",
        text: "半透明脚注文字" },
    ]},
  ]);
  const deckPath = writeProject(dir, deck);
  const pptxPath = join(dir, "out.pptx");
  await exportDeckFile(deckPath, pptxPath, { force: true });
  const zip = await unzip(pptxPath);
  const [{ name, xml }] = await slideXmls(zip);
  xmlSane(s, name, xml);
  s.contains("hlinkClick present", xml, "hlinkClick");
  await relsResolve(s, zip, name);
  const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
  s.contains("hyperlink target in rels", rels, "https://github.com/bbingz/OpenPPT");
  // bold:false run must NOT inherit the element-level b="1" (absent b == not bold
  // in OOXML when no defRPr overrides; this deck has no bold defRPr)
  const cancelRun = xml.match(/<a:r><a:rPr[^>]*>(?:(?!<\/a:r>).)*?这段取消粗体/s)?.[0] || "";
  s.check('bold-off run drops b="1"', cancelRun && !cancelRun.includes('b="1"'), cancelRun.slice(0, 120));
  s.lacks("no bold defRPr override", xml, 'defRPr b="1"');
  s.contains("escaped ampersand", xml, "&amp;");

  const loaded = loadDeck(deckPath);
  const html = renderPreviewHtml(loaded.deck, loaded.projectRoot);
  s.contains("preview escapes <html>", html, "&lt;html&gt;");
  s.lacks("preview has no raw <html> payload", html, ' <html> ');
});

/* S5 布局嵌套:stack>row>grid>layer + flex + justify/align */
scenario("layout-nested", async (s) => {
  const dir = join(s.outDir, "layout-nested");
  const card = (id) => ({
    id, type: "group", layout: "layer", children: [
      { id: `${id}-bg`, type: "shape", shape: "roundRect", fill: "$surface", lineColor: "$primary", lineWidth: 1 },
      { id: `${id}-label`, type: "text", text: id, fontSize: 12, color: "$text", align: "center", valign: "middle" },
    ],
  });
  const deck = baseDeck("嵌套布局", [
    { id: "l1", background: { type: "solid", color: "$background" }, elements: [
      { id: "root", type: "group", layout: "stack", bounds: [40, 40, 880, 460], gap: 16, children: [
        { id: "hero", type: "text", height: 48, text: "Nested layout torture", fontSize: 26, bold: true, color: "$primary" },
        { id: "row", type: "group", layout: "row", flex: 1, gap: 16, justify: "space-between", align: "center", children: [
          { id: "left", type: "group", layout: "grid", flex: 2, columns: 2, gap: 12,
            children: [card("g1"), card("g2"), card("g3"), card("g4")] },
          { id: "right", type: "group", layout: "stack", flex: 1, gap: 12, justify: "end",
            children: [{ ...card("s1"), height: 120 }, { ...card("s2"), height: 120 }] },
        ]},
      ]},
    ]},
  ]);
  const deckPath = writeProject(dir, deck);
  const loaded = loadDeck(deckPath);
  const { deck: leaf } = validateDeck(loaded.deck, { projectRoot: loaded.projectRoot });
  const [cw, ch] = leaf.size;
  let inBounds = true;
  for (const el of leaf.pages[0].elements) {
    const [x, y, w, h] = el.bounds;
    if (x < 0 || y < 0 || x + w > cw + 0.01 || y + h > ch + 0.01) inBounds = false;
  }
  s.check("all expanded bounds inside canvas", inBounds);
  s.ge("groups expanded to leaves", leaf.pages[0].elements.length, 13);
  const pptxPath = join(dir, "out.pptx");
  await compileToPptx(loaded.deck, pptxPath, { projectRoot: loaded.projectRoot, force: true });
  const zip = await unzip(pptxPath);
  for (const { name, xml } of await slideXmls(zip)) xmlSane(s, name, xml);
});

/* S6 30 节长大纲 → from-outline */
scenario("outline-long", async (s) => {
  const dir = join(s.outDir, "outline-long");
  mkdirSync(dir, { recursive: true });
  let md = "# 全国渠道年度复盘\n";
  for (let i = 1; i <= 30; i += 1) {
    md += `## ${String(i).padStart(2, "0")} 区域 ${i} 复盘\n- 营收同比 +${i}%\n- 重点客户 ${i * 3} 家\n- 明年目标:渗透率 ${20 + i}%\n`;
  }
  const mdPath = join(dir, "outline.md");
  writeFileSync(mdPath, md, "utf8");
  const result = projectFromOutline(mdPath, join(dir, "project"), { theme: "report" });
  s.ge("cover + toc + 30 sections", result.pageCount, 32);
  const pptxPath = join(dir, "out.pptx");
  await exportDeckFile(result.deckPath, pptxPath, { force: true });
  const zip = await unzip(pptxPath);
  const slides = await slideXmls(zip);
  s.eq("slide count matches pages", slides.length, result.pageCount);
  s.contains("last section survives", slides[slides.length - 1].xml, "区域 30");
});

/* S7 多文件 deck */
scenario("multifile", async (s) => {
  const dir = join(s.outDir, "multifile");
  mkdirSync(join(dir, "pages"), { recursive: true });
  const page = (id, text) => ({
    id, background: { type: "solid", color: "$background" },
    elements: [{ id: `${id}-t`, type: "text", bounds: [60, 220, 840, 80], text, fontSize: 28, color: "$text", align: "center" }],
  });
  writeFileSync(join(dir, "pages/one.json"), JSON.stringify(page("pg-one", "第一章")), "utf8");
  writeFileSync(join(dir, "pages/two.json"), JSON.stringify(page("pg-two", "第二章")), "utf8");
  const deck = { ...baseDeck("多文件", []), pages: ["pages/one.json", "pages/two.json", page("pg-three", "第三章")] };
  writeFileSync(join(dir, "deck.json"), JSON.stringify(deck, null, 2), "utf8");
  const pptxPath = join(dir, "out.pptx");
  await exportDeckFile(join(dir, "deck.json"), pptxPath, { force: true });
  const zip = await unzip(pptxPath);
  const slides = await slideXmls(zip);
  s.eq("3 slides from mixed sources", slides.length, 3);
  s.contains("external page content", slides[0].xml, "第一章");
  s.contains("inline page content", slides[2].xml, "第三章");
});

/* S8 媒体矩阵:5 种格式 + fit 模式 */
scenario("media-matrix", async (s) => {
  const dir = join(s.outDir, "media-matrix");
  const deck = baseDeck("媒体矩阵", [
    { id: "m1", background: { type: "solid", color: "$background" }, elements: [
      { id: "png-cover", type: "image", bounds: [30, 30, 280, 200], src: "media/dot.png", fit: "cover" },
      { id: "jpg-contain", type: "image", bounds: [340, 30, 280, 200], src: "media/photo.jpg", fit: "contain" },
      { id: "gif-fill", type: "image", bounds: [650, 30, 280, 200], src: "media/anim.gif", fit: "fill" },
      { id: "webp-cover", type: "image", bounds: [30, 280, 280, 200], src: "media/modern.webp", fit: "cover" },
      { id: "svg-fill", type: "image", bounds: [340, 280, 280, 200], src: "media/badge.svg", fit: "fill" },
    ]},
  ]);
  const deckPath = writeProject(dir, deck, {
    "dot.png": PNG_1X1,
    "photo.jpg": minimalJpeg(640, 480),
    "anim.gif": minimalGif(320, 240),
    "modern.webp": minimalWebp(256, 128),
    "badge.svg": SVG_BADGE,
  });
  const loaded = loadDeck(deckPath);
  validateDeck(loaded.deck, { projectRoot: loaded.projectRoot, checkMedia: true });
  const pptxPath = join(dir, "out.pptx");
  await compileToPptx(loaded.deck, pptxPath, { projectRoot: loaded.projectRoot, force: true });
  const zip = await unzip(pptxPath);
  const mediaEntries = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/"));
  s.ge("5 media parts embedded", mediaEntries.length, 5);
  const html = renderPreviewHtml(loaded.deck, loaded.projectRoot);
  const imgSrcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  s.eq("5 preview images", imgSrcs.length, 5);
  s.check("all preview images are data URIs", imgSrcs.every((u) => u.startsWith("data:")));
});

/* S9 导入回环:S1 的 PPTX → import → re-export */
scenario("roundtrip-import", async (s) => {
  const srcPptx = join(s.outDir, "pitch-zh", "out.pptx");
  const dir = join(s.outDir, "roundtrip-import");
  const result = await importPptx(srcPptx, join(dir, "recovered"), { force: false });
  s.eq("recovered 4 pages", result.pageCount, 4);
  const loaded = loadDeck(result.deckPath);
  validateDeck(loaded.deck, { projectRoot: loaded.projectRoot, checkMedia: true });
  const flat = JSON.stringify(loaded.deck);
  s.contains("title text recovered", flat, "岚图智能座舱");
  s.contains("body text recovered", flat, "三屏联动");
  const rePptx = join(dir, "re-export.pptx");
  await compileToPptx(loaded.deck, rePptx, { projectRoot: loaded.projectRoot, force: true });
  const zip = await unzip(rePptx);
  const slides = await slideXmls(zip);
  s.eq("re-export keeps 4 slides", slides.length, 4);
  for (const { name, xml } of slides) xmlSane(s, name, xml);
});

/* S10 Studio HTTP 全链路 */
scenario("studio-api", async (s) => {
  const dataDir = join(s.outDir, "studio-data");
  mkdirSync(dataDir, { recursive: true });
  const studio = startWebServer({ port: 0, dataDir });
  const base = studio.url.replace(/\/$/, "");
  try {
    const post = (path, body) => fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const blank = await (await post("/api/projects", { mode: "blank", title: "API Blank", theme: "default" })).json();
    const skel = await (await post("/api/projects", { mode: "skeleton", title: "API Skeleton", theme: "dark" })).json();
    const outline = await (await post("/api/projects", {
      mode: "outline", title: "API Outline", theme: "report",
      outline: "# API Outline\n## 一\n- a\n## 二\n- b\n",
    })).json();
    s.check("blank/skeleton/outline created",
      blank.project?.id && skel.project?.id && outline.project?.id);

    const form = new FormData();
    form.append("file", new File([readFileSync(join(s.outDir, "pitch-zh", "out.pptx"))], "pitch.pptx"));
    const imported = await (await fetch(`${base}/api/import`, { method: "POST", body: form })).json();
    s.eq("import via HTTP → 4 pages", imported.pageCount, 4);

    const id = blank.project.id;
    const detailRes = await fetch(`${base}/api/projects/${id}`);
    const detail = await detailRes.json();
    const deck = JSON.parse(detail.source);
    deck.title = "API Blank · edited";
    const put = await fetch(`${base}/api/projects/${id}/deck`, {
      method: "PUT",
      headers: { "If-Match": detailRes.headers.get("etag") },
      body: JSON.stringify(deck, null, 2),
    });
    s.eq("save edited deck", put.status, 200);
    const check = await (await fetch(`${base}/api/projects/${id}/validate`, { method: "POST" })).json();
    s.check("edited deck validates", check.ok, JSON.stringify(check.error || {}));

    const up = new FormData();
    up.append("file", new File([PNG_1X1], "logo.png"));
    const uploaded = await (await fetch(`${base}/api/projects/${id}/media`, { method: "POST", body: up })).json();
    s.eq("media upload via HTTP", uploaded.src, "media/logo.png");

    const qa = await (await fetch(`${base}/api/projects/${id}/qa`)).json();
    s.check("qa endpoint returns issues[]", Array.isArray(qa.issues));

    const exported = await fetch(`${base}/api/projects/${id}/export`);
    const bytes = Buffer.from(await exported.arrayBuffer());
    s.eq("export via HTTP is a ZIP", bytes.subarray(0, 2).toString("latin1"), "PK");
    writeFileSync(join(s.outDir, "studio-api-export.pptx"), bytes);

    const del = await fetch(`${base}/api/projects/${outline.project.id}`, { method: "DELETE" });
    s.eq("delete project", del.status, 200);
  } finally {
    studio.stop();
  }
});

/* S11 YAML deck */
scenario("yaml-deck", async (s) => {
  const dir = join(s.outDir, "yaml-deck");
  mkdirSync(dir, { recursive: true });
  const yaml = `version: openppt-1
title: YAML 作者路径
size: [960, 540]
theme:
  colors:
    primary: "#0EA5E9"
    text: "#0F172A"
    background: "#FFFFFF"
pages:
  - id: y1
    background: { type: solid, color: "$background" }
    elements:
      - id: y1-title
        type: text
        bounds: [60, 200, 840, 80]
        text: "YAML 也是一等公民"
        fontSize: 30
        bold: true
        color: "$primary"
        align: center
`;
  writeFileSync(join(dir, "deck.yaml"), yaml, "utf8");
  const pptxPath = join(dir, "out.pptx");
  await exportDeckFile(join(dir, "deck.yaml"), pptxPath, { force: true });
  const zip = await unzip(pptxPath);
  const slides = await slideXmls(zip);
  s.eq("1 slide from YAML", slides.length, 1);
  s.contains("YAML text survives", slides[0].xml, "一等公民");
});

/* S12 压力:64 页生成型 deck */
scenario("stress-64", async (s) => {
  const dir = join(s.outDir, "stress-64");
  const pages = [];
  for (let p = 1; p <= 64; p += 1) {
    const cells = [];
    for (let i = 0; i < 12; i += 1) {
      cells.push({
        id: `p${p}-cell${i}`, type: "group", layout: "layer", children: [
          { id: `p${p}-c${i}-bg`, type: "shape", shape: i % 2 ? "roundRect" : "rect",
            fill: i % 3 ? "$surface" : "$primary" },
          { id: `p${p}-c${i}-t`, type: "text", text: `P${p}·${i}`, fontSize: 11,
            color: i % 3 ? "$text" : "#FFFFFF", align: "center", valign: "middle" },
        ],
      });
    }
    pages.push({
      id: `stress-${p}`, background: { type: "solid", color: "$background" },
      elements: [
        { id: `p${p}-head`, type: "text", bounds: [30, 16, 900, 34], text: `压力页 ${p} / 64`, fontSize: 20, bold: true, color: "$primary" },
        { id: `p${p}-grid`, type: "group", layout: "grid", bounds: [30, 66, 900, 444], columns: 4, gap: 10, children: cells },
      ],
    });
  }
  const deckPath = writeProject(dir, baseDeck("压力测试 64 页", pages));
  const started = performance.now();
  const pptxPath = join(dir, "out.pptx");
  await exportDeckFile(deckPath, pptxPath, { force: true });
  const seconds = (performance.now() - started) / 1000;
  s.check(`export under 30s (took ${seconds.toFixed(1)}s)`, seconds < 30);
  const zip = await unzip(pptxPath);
  const slides = await slideXmls(zip);
  s.eq("64 slides", slides.length, 64);
  s.ge("pptx size sane", statSync(pptxPath).size, 50_000);
});

/* ---------------- runner ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  let outDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") outDir = argv[i + 1];
  }
  outDir = outDir ? outDir : mkdtempSync(join(tmpdir(), "openppt-dogfood-"));
  mkdirSync(outDir, { recursive: true });

  const report = { startedAt: new Date().toISOString(), outDir, scenarios: [] };
  let failed = 0;

  console.log(`OpenPPT dogfood battery → ${outDir}\n`);
  for (const { name, fn } of SCENARIOS) {
    const s = new Scenario(name, outDir);
    const started = performance.now();
    let crash = null;
    try {
      await fn(s);
    } catch (err) {
      crash = err;
    }
    const ms = Math.round(performance.now() - started);
    const bad = s.failed;
    const ok = !crash && bad.length === 0;
    if (!ok) failed += 1;
    const flag = ok ? "PASS" : "FAIL";
    console.log(`[${flag}] ${name}  (${s.checks.length} checks, ${ms}ms)`);
    if (crash) {
      console.log(`       crash: ${crash.code ? `[${crash.code}] ` : ""}${crash.message}`);
    }
    for (const c of bad) console.log(`       ✗ ${c.label} — ${c.info}`);
    report.scenarios.push({
      name, ok, ms,
      crash: crash ? { code: crash.code || null, message: crash.message } : null,
      checks: s.checks,
    });
  }

  report.finishedAt = new Date().toISOString();
  report.ok = failed === 0;
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const total = SCENARIOS.length;
  console.log(`\n${total - failed}/${total} scenarios passed · report: ${join(outDir, "report.json")}`);
  if (failed > 0) process.exit(1);
}

main();
