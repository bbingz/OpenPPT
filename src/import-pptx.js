/**
 * Lossy PPTX → OpenPPT IR importer.
 * Extracts text + simple shapes + images. Charts/tables/groups are skipped or approximated.
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve, basename, extname } from "node:path";
import JSZip from "jszip";
import { OpenPptError, ErrorCodes } from "./errors.js";

/** EMUs per CSS px at 96dpi (914400 EMU/in ÷ 96). */
const EMU_PER_PX = 9525;

/**
 * @param {number} emu
 */
function emuToPx(emu) {
  return Math.round(Number(emu) / EMU_PER_PX);
}

/**
 * @param {string} xml
 * @param {RegExp} re
 */
function matchAll(xml, re) {
  return [...xml.matchAll(re)];
}

/**
 * @param {string} xml
 * @param {string} attr
 */
function attr(xml, attr) {
  const m = xml.match(new RegExp(`${attr}="([^"]*)"`));
  return m ? m[1] : null;
}

/**
 * Lossy parse of a single chart XML into IR chart fields.
 * @param {string} chartXml
 * @returns {{ chartType: string, title?: string, series: object[] } | null}
 */
function parseChartXml(chartXml) {
  /** @type {string} */
  let chartType = "bar";
  if (/<c:lineChart[\s>]/.test(chartXml)) chartType = "line";
  else if (/<c:pieChart[\s>]/.test(chartXml)) chartType = "pie";
  else if (/<c:doughnutChart[\s>]/.test(chartXml)) chartType = "doughnut";
  else if (/<c:areaChart[\s>]/.test(chartXml)) chartType = "area";
  else if (/<c:barChart[\s>]/.test(chartXml)) chartType = "bar";
  else return null;

  const title = chartXml.match(
    /<c:title[\s\S]*?<a:t>([^<]*)<\/a:t>/,
  )?.[1];

  /** @type {object[]} */
  const series = [];
  const serBlocks = matchAll(chartXml, /<c:ser\b[\s\S]*?<\/c:ser>/g);
  /** @type {string[] | undefined} */
  let sharedLabels;
  for (let si = 0; si < serBlocks.length; si += 1) {
    const ser = serBlocks[si][0];
    const name =
      ser.match(/<c:tx>[\s\S]*?<c:v>([^<]*)<\/c:v>/)?.[1] ||
      `Series ${si + 1}`;
    const valBlock = ser.match(
      /<c:val>[\s\S]*?<c:numCache>([\s\S]*?)<\/c:numCache>/,
    );
    const values = valBlock
      ? matchAll(valBlock[1], /<c:v>([^<]*)<\/c:v>/g)
          .map((m) => Number(m[1]))
          .filter((n) => Number.isFinite(n))
      : [];
    const catStr = ser.match(
      /<c:cat>[\s\S]*?<c:strCache>([\s\S]*?)<\/c:strCache>/,
    );
    const catNum = ser.match(
      /<c:cat>[\s\S]*?<c:numCache>([\s\S]*?)<\/c:numCache>/,
    );
    const catBlock = catStr || catNum;
    if (catBlock) {
      const labels = matchAll(catBlock[1], /<c:v>([^<]*)<\/c:v>/g).map(
        (m) => m[1],
      );
      if (labels.length) sharedLabels = labels;
    }
    if (values.length === 0) continue;
    /** @type {{ name: string, values: number[], labels?: string[] }} */
    const entry = { name, values };
    if (sharedLabels && sharedLabels.length === values.length) {
      entry.labels = sharedLabels;
    }
    series.push(entry);
  }
  if (series.length === 0) return null;
  /** @type {{ chartType: string, title?: string, series: object[] }} */
  const out = { chartType, series };
  if (title) out.title = title;
  return out;
}

/**
 * Parse one slide XML into IR elements (lossy).
 * @param {string} slideXml
 * @param {Map<string, string>} relIdToMediaPath  rId → media/foo.png relative path
 * @param {Map<string, string>} relIdToChartXml  rId → chart XML string
 * @param {number} pageIndex
 */
function parseSlide(slideXml, relIdToMediaPath, relIdToChartXml, pageIndex) {
  /** @type {object[]} */
  const elements = [];
  let ei = 0;

  // Background solid
  let background;
  const bg = slideXml.match(
    /<p:bg[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"[\s\S]*?<\/p:bg>/,
  );
  if (bg) {
    background = { type: "solid", color: `#${bg[1]}` };
  }

  // Shapes and text boxes are <p:sp>...</p:sp>
  const shapes = matchAll(slideXml, /<p:sp\b[\s\S]*?<\/p:sp>/g);
  for (const m of shapes) {
    const sp = m[0];
    const off = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"/);
    const ext = sp.match(/<a:ext cx="(-?\d+)" cy="(-?\d+)"/);
    if (!off || !ext) continue;
    const x = emuToPx(off[1]);
    const y = emuToPx(off[2]);
    const w = Math.max(1, emuToPx(ext[1]));
    const h = Math.max(1, emuToPx(ext[2]));
    const bounds = [x, y, w, h];

    const texts = matchAll(sp, /<a:t>([^<]*)<\/a:t>/g).map((t) =>
      t[1]
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"'),
    );
    const joined = texts.join("").trim();

    const fillM = sp.match(
      /<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/,
    );
    const prst = attr(sp, "prst") || "rect";
    const hasText = joined.length > 0;
    // Text boxes from pptxgenjs often have noFill
    const noFill = /<a:noFill\/>/.test(sp);

    if (hasText) {
      const sz = sp.match(/sz="(\d+)"/);
      const fontSize = sz ? Math.max(1, Math.round(Number(sz[1]) / 100)) : 18;
      const colorM = sp.match(
        /<a:rPr[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/,
      );
      const bold = /b="1"/.test(sp);
      const algn = sp.match(/algn="([lctr])"/);
      const alignMap = { l: "left", c: "center", r: "right", t: "left" };
      elements.push({
        id: `p${pageIndex}-t${ei++}`,
        type: "text",
        bounds,
        text: joined,
        fontSize,
        bold,
        color: colorM ? `#${colorM[1]}` : "#111827",
        align: algn ? alignMap[algn[1]] || "left" : "left",
      });
    } else if (fillM && !noFill) {
      const shapeMap = {
        rect: "rect",
        roundRect: "roundRect",
        ellipse: "ellipse",
        circle: "ellipse",
      };
      elements.push({
        id: `p${pageIndex}-s${ei++}`,
        type: "shape",
        bounds,
        shape: shapeMap[prst] || "rect",
        fill: `#${fillM[1]}`,
      });
    }
  }

  // Pictures <p:pic>
  const pics = matchAll(slideXml, /<p:pic\b[\s\S]*?<\/p:pic>/g);
  for (const m of pics) {
    const pic = m[0];
    const off = pic.match(/<a:off x="(-?\d+)" y="(-?\d+)"/);
    const ext = pic.match(/<a:ext cx="(-?\d+)" cy="(-?\d+)"/);
    const embed = pic.match(/r:embed="(rId\d+)"/);
    if (!off || !ext || !embed) continue;
    const mediaPath = relIdToMediaPath.get(embed[1]);
    if (!mediaPath) continue;
    elements.push({
      id: `p${pageIndex}-i${ei++}`,
      type: "image",
      bounds: [
        emuToPx(off[1]),
        emuToPx(off[2]),
        Math.max(1, emuToPx(ext[1])),
        Math.max(1, emuToPx(ext[2])),
      ],
      src: mediaPath,
    });
  }

  // graphicFrame: tables and charts
  const frames = matchAll(slideXml, /<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g);
  for (const m of frames) {
    const frame = m[0];
    const off = frame.match(/<a:off x="(-?\d+)" y="(-?\d+)"/);
    const ext = frame.match(/<a:ext cx="(-?\d+)" cy="(-?\d+)"/);
    if (!off || !ext) continue;
    const bounds = [
      emuToPx(off[1]),
      emuToPx(off[2]),
      Math.max(1, emuToPx(ext[1])),
      Math.max(1, emuToPx(ext[2])),
    ];

    if (/<a:tbl[\s>]/.test(frame)) {
      const rowXmls = matchAll(frame, /<a:tr\b[\s\S]*?<\/a:tr>/g).map((r) => r[0]);
      if (rowXmls.length === 0) continue;
      /** @type {string[][]} */
      const rows = [];
      for (const rowXml of rowXmls) {
        const cells = matchAll(rowXml, /<a:tc\b[\s\S]*?<\/a:tc>/g).map((c) => {
          const texts = matchAll(c[0], /<a:t>([^<]*)<\/a:t>/g).map((t) =>
            t[1]
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&amp;/g, "&")
              .replace(/&quot;/g, '"'),
          );
          return texts.join("").trim();
        });
        if (cells.length) rows.push(cells);
      }
      if (rows.length === 0) continue;
      elements.push({
        id: `p${pageIndex}-tbl${ei++}`,
        type: "table",
        bounds,
        header: true,
        rows,
      });
      continue;
    }

    const chartEmbed = frame.match(
      /<c:chart[^>]*r:id="(rId\d+)"|r:id="(rId\d+)"[^>]*\/?>/,
    );
    const chartRid = chartEmbed?.[1] || chartEmbed?.[2];
    if (chartRid && relIdToChartXml.has(chartRid)) {
      const parsed = parseChartXml(relIdToChartXml.get(chartRid) || "");
      if (parsed) {
        elements.push({
          id: `p${pageIndex}-ch${ei++}`,
          type: "chart",
          bounds,
          chartType: parsed.chartType,
          ...(parsed.title ? { title: parsed.title } : {}),
          series: parsed.series,
        });
      }
    }
  }

  return { background, elements };
}

/**
 * @param {import('jszip')} zip
 * @param {string} path
 */
async function readZipText(zip, path) {
  const f = zip.file(path);
  if (!f) return null;
  return f.async("string");
}

/**
 * Import a .pptx file into an OpenPPT project directory (lossy).
 * @param {string} pptxPath
 * @param {string} outDir
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ deckPath: string, pageCount: number, warnings: string[] }>}
 */
export async function importPptx(pptxPath, outDir, options = {}) {
  const { force = false } = options;
  const absPptx = resolve(pptxPath);
  if (!existsSync(absPptx)) {
    throw new OpenPptError(ErrorCodes.IO, `PPTX not found: ${absPptx}`);
  }
  const dest = resolve(outDir);
  if (existsSync(join(dest, "deck.json")) && !force) {
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `deck.json already exists in ${dest} (pass force=true)`,
    );
  }
  mkdirSync(join(dest, "media"), { recursive: true });

  const buf = readFileSync(absPptx);
  const zip = await JSZip.loadAsync(buf);
  const warnings = [
    "import is lossy: masters/animations/fonts not reconstructed; charts/tables are best-effort",
  ];

  // Slide size from presentation.xml sldSz
  let size = [960, 540];
  const presXml = await readZipText(zip, "ppt/presentation.xml");
  if (presXml) {
    const sldSz = presXml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    if (sldSz) {
      size = [emuToPx(sldSz[1]), emuToPx(sldSz[2])];
    }
  }

  // Enumerate slides
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/i)?.[1] || 0);
      const nb = Number(b.match(/slide(\d+)/i)?.[1] || 0);
      return na - nb;
    });

  if (slidePaths.length === 0) {
    throw new OpenPptError(ErrorCodes.IO, "No slides found in PPTX");
  }

  /** @type {object[]} */
  const pages = [];
  let mediaIndex = 0;

  for (let si = 0; si < slidePaths.length; si += 1) {
    const slidePath = slidePaths[si];
    const slideXml = await readZipText(zip, slidePath);
    if (!slideXml) continue;

    // Relationships for images + charts
    const relPath = slidePath
      .replace("ppt/slides/", "ppt/slides/_rels/")
      .replace(/\.xml$/, ".xml.rels");
    const relXml = (await readZipText(zip, relPath)) || "";
    /** @type {Map<string, string>} */
    const relIdToMedia = new Map();
    /** @type {Map<string, string>} */
    const relIdToChartXml = new Map();
    for (const rm of matchAll(
      relXml,
      /Id="(rId\d+)"[^>]*Target="([^"]+)"/g,
    )) {
      const rId = rm[1];
      let target = rm[2].replace(/\\/g, "/");
      // Target may be package-absolute (/ppt/...), relative ../media/, or sibling
      if (target.startsWith("/")) {
        target = target.replace(/^\/+/, "");
      } else if (target.startsWith("../")) {
        target = `ppt/${target.replace(/^\.\.\//, "")}`;
      } else if (!target.startsWith("ppt/")) {
        target = `ppt/slides/${target}`;
      }
      if (/charts\/chart\d+\.xml$/i.test(target)) {
        const chartXml = await readZipText(zip, target);
        if (chartXml) relIdToChartXml.set(rId, chartXml);
        continue;
      }
      const mediaFile = zip.file(target);
      if (!mediaFile) continue;
      const ext = extname(target).toLowerCase() || ".png";
      const allowed = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
      if (!allowed.has(ext)) {
        // not an image relationship (could be notes, etc.)
        continue;
      }
      const localName = `img-${++mediaIndex}${ext}`;
      const relMedia = `media/${localName}`;
      const bytes = await mediaFile.async("nodebuffer");
      writeFileSync(join(dest, relMedia), bytes);
      relIdToMedia.set(rId, relMedia);
    }

    const { background, elements } = parseSlide(
      slideXml,
      relIdToMedia,
      relIdToChartXml,
      si + 1,
    );
    pages.push({
      id: `page-${si + 1}`,
      ...(background ? { background } : {}),
      elements,
    });
  }

  const title =
    (await readZipText(zip, "docProps/core.xml"))?.match(
      /<dc:title>([^<]*)<\/dc:title>/,
    )?.[1] || basename(absPptx, ".pptx");

  const deck = {
    version: "openppt-1",
    title,
    size,
    theme: {
      colors: {
        primary: "#2563EB",
        text: "#111827",
        muted: "#6B7280",
        background: "#FFFFFF",
        surface: "#F8FAFC",
        accent: "#F59E0B",
      },
    },
    pages,
  };

  const deckPath = join(dest, "deck.json");
  writeFileSync(deckPath, `${JSON.stringify(deck, null, 2)}\n`, "utf8");
  return { deckPath, pageCount: pages.length, warnings };
}
