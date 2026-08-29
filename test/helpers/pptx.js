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

export function slideXmlWithText(text, extraInner = "") {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
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
      ${extraInner}
    </p:spTree>
  </p:cSld>
</p:sld>
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
