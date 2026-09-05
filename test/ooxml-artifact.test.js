import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEastAsianTypeface, repairSlideXml } from "../src/internal/ooxml-artifact.js";
import { ErrorCodes, OpenPptError } from "../src/errors.js";

function ids(xml) {
  return [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map((m) => m[1]);
}

describe("ooxml artifact repair", () => {
  it("reserves original unique cNvPr ids when repairing a duplicate", () => {
    const xml =
      '<p:sld><p:cNvPr id="1"/><p:cNvPr id="2"/><p:cNvPr id="2"/><p:cNvPr id="3"/><p:spTgt spid="3"/></p:sld>';
    const out = repairSlideXml(xml);
    assert.deepEqual(ids(out), ["1", "2", "4", "3"]);
    assert.match(out, /spid="3"/);
  });

  it("rejects a referenced duplicate drawing id", () => {
    const xml =
      '<p:sld><p:cNvPr id="1"/><p:cNvPr id="2"/><p:cNvPr id="2"/><p:spTgt spid="2"/></p:sld>';
    assert.throws(
      () => repairSlideXml(xml),
      (err) =>
        err instanceof OpenPptError &&
        err.code === ErrorCodes.EXPORT &&
        /ambiguous/i.test(err.message),
    );
  });

  it("rejects conflicting paragraph properties", () => {
    const xml =
      '<p:sld><a:p><a:pPr algn="l"/><a:r><a:t>A</a:t></a:r><a:pPr algn="r"/><a:r><a:t>B</a:t></a:r></a:p></p:sld>';
    assert.throws(
      () => repairSlideXml(xml),
      (err) =>
        err instanceof OpenPptError &&
        err.code === ErrorCodes.EXPORT &&
        /paragraph propert/i.test(err.message),
    );
  });

  it("collapses identical extra pPr into one leading pPr", () => {
    const xml =
      '<p:sld><a:p><a:pPr algn="ctr"/><a:r><a:t>A</a:t></a:r><a:pPr algn="ctr"/><a:r><a:t>B</a:t></a:r></a:p></p:sld>';
    const out = repairSlideXml(xml);
    assert.equal([...out.matchAll(/<a:pPr\b/g)].length, 1);
    assert.match(out, /<a:p><a:pPr algn="ctr"\/>/);
    assert.match(out, /<a:t>A<\/a:t>/);
    assert.match(out, /<a:t>B<\/a:t>/);
  });

  it("rejects a duplicate drawing id referenced by a connector endpoint", () => {
    const xml =
      '<p:sld><p:cNvPr id="1"/><p:cNvPr id="2"/><p:cNvPr id="2"/><a:stCxn id="2" idx="0"/></p:sld>';
    assert.throws(
      () => repairSlideXml(xml),
      (err) =>
        err instanceof OpenPptError &&
        err.code === ErrorCodes.EXPORT &&
        /ambiguous/i.test(err.message),
    );
  });

  it("rejects pPr blocks that differ only inside quoted attribute whitespace", () => {
    const xml =
      '<p:sld><a:p><a:pPr><a:buFont typeface="A  B"/></a:pPr><a:r><a:t>A</a:t></a:r><a:pPr><a:buFont typeface="A B"/></a:pPr><a:r><a:t>B</a:t></a:r></a:p></p:sld>';
    assert.throws(
      () => repairSlideXml(xml),
      (err) =>
        err instanceof OpenPptError &&
        err.code === ErrorCodes.EXPORT &&
        /paragraph propert/i.test(err.message),
    );
  });
});

describe("east asian typeface rewrite", () => {
  it("rewrites existing ea and inserts ea after latin-only runs", () => {
    const xml =
      '<a:rPr><a:latin typeface="Times New Roman" pitchFamily="34" charset="0"/><a:ea typeface="Times New Roman" pitchFamily="34" charset="-122"/><a:cs typeface="Times New Roman"/></a:rPr>' +
      '<a:defRPr><a:latin typeface="Arial"/></a:defRPr>';
    const out = applyEastAsianTypeface(xml, "Noto Sans CJK SC");
    assert.equal(
      [...out.matchAll(/<a:ea\b[^>]*\btypeface="([^"]*)"/g)].every(
        (m) => m[1] === "Noto Sans CJK SC",
      ),
      true,
    );
    assert.match(out, /<a:latin typeface="Times New Roman"/);
    assert.match(out, /<a:latin typeface="Arial"\/><a:ea typeface="Noto Sans CJK SC"\/>/);
    assert.match(out, /<a:cs typeface="Times New Roman"/);
  });
});
