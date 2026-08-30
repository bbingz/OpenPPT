import { readFileSync, writeFileSync } from "node:fs";
import JSZip from "jszip";

export async function openPptx(path) {
  return JSZip.loadAsync(readFileSync(path));
}

export async function readPptxEntry(zip, name) {
  const entry = zip.file(name);
  if (!entry) throw new Error(`Missing PPTX entry: ${name}`);
  return entry.async("string");
}

/**
 * Build a minimal PPTX (ZIP) for importer tests. Slides are raw XML strings.
 * @param {string} outputPath
 * @param {{
 *   slides?: { path?: string, xml: string, rels?: string }[],
 *   sldIdLst?: { id: string, rId: string }[],
 *   presentationRels?: { id: string, target: string, type?: string }[],
 *   extraFiles?: Record<string, string | Buffer>,
 * }} [spec]
 */
export async function writeMinimalPptx(outputPath, spec = {}) {
  const slides = spec.slides || [
    {
      path: "ppt/slides/slide1.xml",
      xml: slideXmlWithText("Hello"),
    },
  ];
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slides
    .map(
      (slide, index) =>
        `<Override PartName="/${(slide.path || `ppt/slides/slide${index + 1}.xml`).replace(/^\/+/, "")}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("\n  ")}
</Types>
`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>
`,
  );

  const presentationRels =
    spec.presentationRels ||
    slides.map((slide, index) => ({
      id: `rId${index + 2}`,
      target: (slide.path || `ppt/slides/slide${index + 1}.xml`).replace(
        /^ppt\//,
        "",
      ),
    }));
  const sldIdLst =
    spec.sldIdLst ||
    presentationRels.map((rel, index) => ({
      id: String(256 + index),
      rId: rel.id,
    }));

  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    ${sldIdLst
      .map((item) => `<p:sldId id="${item.id}" r:id="${item.rId}"/>`)
      .join("\n    ")}
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500"/>
</p:presentation>
`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${presentationRels
    .map(
      (rel) =>
        `<Relationship Id="${rel.id}" Type="${rel.type || "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"}" Target="${rel.target}"/>`,
    )
    .join("\n  ")}
</Relationships>
`,
  );

  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index];
    const path = slide.path || `ppt/slides/slide${index + 1}.xml`;
    zip.file(path, slide.xml);
    if (slide.rels) {
      zip.file(
        path.replace("ppt/slides/", "ppt/slides/_rels/").replace(/\.xml$/, ".xml.rels"),
        slide.rels,
      );
    }
  }

  for (const [name, data] of Object.entries(spec.extraFiles || {})) {
    zip.file(name, data);
  }

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  writeFileSync(outputPath, buf);
  return buf;
}

/** EMUs per CSS px at 96dpi — matches `src/import-pptx.js`. */
export const EMU_PER_PX = 9525;

export function pxToEmu(px) {
  return px * EMU_PER_PX;
}

export function slideXmlWithBody(inner) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      ${inner}
    </p:spTree>
  </p:cSld>
</p:sld>
`;
}

export function slideXmlWithText(text, extraInner = "") {
  return slideXmlWithBody(`<p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="0" y="0"/>
            <a:ext cx="1828800" cy="457200"/>
          </a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:r><a:t>${text}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      ${extraInner}`);
}

export function spRectXml({
  id = "2",
  name = "s",
  offX,
  offY,
  cx,
  cy,
  fill = "FF0000",
  txBody = "",
}) {
  return `<p:sp>
      <p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
        <a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>
      </p:spPr>
      ${txBody}
    </p:sp>`;
}

export function grpSpXml({
  id = "8",
  name = "g",
  offX = 0,
  offY = 0,
  cx = 0,
  cy = 0,
  chOffX = 0,
  chOffY = 0,
  chCx = 0,
  chCy = 0,
  children = "",
  xfrm = true,
  rot,
  flipH = false,
  flipV = false,
}) {
  const attrs = [];
  if (rot != null && rot !== "") attrs.push(`rot="${rot}"`);
  if (flipH) attrs.push(`flipH="1"`);
  if (flipV) attrs.push(`flipV="1"`);
  const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
  const xfrmXml = xfrm
    ? `<a:xfrm${attrStr}><a:off x="${offX}" y="${offY}"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="${chOffX}" y="${chOffY}"/><a:chExt cx="${chCx}" cy="${chCy}"/></a:xfrm>`
    : "";
  return `<p:grpSp>
      <p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr>${xfrmXml}</p:grpSpPr>
      ${children}
    </p:grpSp>`;
}

export function nestedGrpSpXml(depth, children, xfrm = {}) {
  let inner = children;
  for (let level = depth; level >= 1; level -= 1) {
    inner = grpSpXml({
      id: String(20 + level),
      name: `nest${level}`,
      offX: xfrm.offX ?? 0,
      offY: xfrm.offY ?? 0,
      cx: xfrm.cx ?? pxToEmu(100),
      cy: xfrm.cy ?? pxToEmu(100),
      chOffX: xfrm.chOffX ?? 0,
      chOffY: xfrm.chOffY ?? 0,
      chCx: xfrm.chCx ?? pxToEmu(100),
      chCy: xfrm.chCy ?? pxToEmu(100),
      children: inner,
    });
  }
  return inner;
}

export function picXml({
  id = "2",
  name = "pic",
  offX,
  offY,
  cx,
  cy,
  embed = "rId9",
}) {
  return `<p:pic>
      <p:nvPicPr><p:cNvPr id="${id}" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="${embed}"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr>
    </p:pic>`;
}

export function textSpXml({
  id = "2",
  name = "t",
  offX = 0,
  offY = 0,
  cx = 1828800,
  cy = 457200,
  text = "",
  rot,
  fill,
  schemeFill,
  schemeText,
}) {
  const rotAttr = rot != null ? ` rot="${rot}"` : "";
  let fillXml = "";
  if (schemeFill) {
    fillXml = `<a:solidFill><a:schemeClr val="${schemeFill}"/></a:solidFill>`;
  } else if (fill) {
    fillXml = `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`;
  }
  let txBody = "";
  if (text !== "" || schemeText) {
    const rPr = schemeText
      ? `<a:rPr sz="1800"><a:solidFill><a:schemeClr val="${schemeText}"><a:lumMod val="60000"/></a:schemeClr></a:solidFill></a:rPr>`
      : `<a:rPr/>`;
    txBody = `<p:txBody><a:bodyPr/><a:p><a:r>${rPr}<a:t>${text}</a:t></a:r></a:p></p:txBody>`;
  }
  return `<p:sp>
      <p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr ${text !== "" || schemeText ? 'txBox="1"' : ""}/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm${rotAttr}><a:off x="${offX}" y="${offY}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
        ${fillXml}
      </p:spPr>
      ${txBody}
    </p:sp>`;
}

export function theme1Xml({
  dk1 = "000000",
  lt1 = "FFFFFF",
  dk2 = "1F497D",
  lt2 = "EEECE1",
  accent1 = "CC3366",
  accent2 = "C0504D",
  accent3 = "9BBB59",
  accent4 = "8064A2",
  accent5 = "4BACC6",
  accent6 = "F79646",
  hlink = "0000FF",
  folHlink = "800080",
} = {}) {
  const sys = (name, last, sysVal) =>
    `<a:${name}><a:sysClr val="${sysVal}" lastClr="${last}"/></a:${name}>`;
  const srgb = (name, val) =>
    `<a:${name}><a:srgbClr val="${val}"/></a:${name}>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="OpenPPTTest">
  <a:themeElements>
    <a:clrScheme name="Test">
      ${sys("dk1", dk1, "windowText")}
      ${sys("lt1", lt1, "window")}
      ${srgb("dk2", dk2)}
      ${srgb("lt2", lt2)}
      ${srgb("accent1", accent1)}
      ${srgb("accent2", accent2)}
      ${srgb("accent3", accent3)}
      ${srgb("accent4", accent4)}
      ${srgb("accent5", accent5)}
      ${srgb("accent6", accent6)}
      ${srgb("hlink", hlink)}
      ${srgb("folHlink", folHlink)}
    </a:clrScheme>
  </a:themeElements>
</a:theme>
`;
}

/** 24-byte PNG signature + IHDR width/height fields (no valid image payload). */
export function pngIhdrHeader(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  buf.writeUInt32BE(width >>> 0, 16);
  buf.writeUInt32BE(height >>> 0, 20);
  return buf;
}
