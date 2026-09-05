import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realOrResolve } from "../src/internal/paths.js";
import {
  MEDIA_EXTENSIONS,
  contentTypeFor,
  extToSniff,
} from "../src/internal/media-types.js";
import {
  EMU_PER_INCH,
  EMU_PER_PX,
  PT_PER_INCH,
  PX_PER_INCH,
  PX_PER_PT,
  TEXT_INSET_X_PX,
  TEXT_INSET_Y_PX,
  emuToPx,
  ptToPx,
  pxToInch,
} from "../src/internal/units.js";
import { THEME_IDS, loadThemeColors } from "../src/internal/theme-io.js";
import { ErrorCodes, OpenPptError } from "../src/errors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("internal paths", () => {
  it("returns realpath for an existing path and resolve() when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-real-"));
    try {
      const file = join(dir, "exists.txt");
      writeFileSync(file, "ok");
      assert.equal(realOrResolve(file), realpathSync(file));
      const missing = join(dir, "no-such.txt");
      assert.equal(realOrResolve(missing), resolve(missing));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("internal media types", () => {
  it("keeps the three views consistent", () => {
    assert.deepEqual(
      [...MEDIA_EXTENSIONS],
      [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
    );
    for (const ext of MEDIA_EXTENSIONS) {
      assert.equal(typeof extToSniff(ext), "string");
      assert.equal(typeof contentTypeFor(ext), "string");
    }
    // canonical token matches sniffImageBytes output ("jpeg", not "jpg")
    assert.equal(extToSniff(".jpeg"), "jpeg");
    assert.equal(extToSniff(".jpg"), "jpeg");
    assert.equal(contentTypeFor(".svg"), "image/svg+xml");
    assert.equal(contentTypeFor(".jpg"), "image/jpeg");
    assert.equal(extToSniff(".tiff"), undefined);
    assert.equal(contentTypeFor(".tiff"), undefined);
  });
});

describe("internal units", () => {
  it("round-trips px through EMU at 96 dpi", () => {
    assert.equal(PX_PER_INCH, 96);
    assert.equal(EMU_PER_INCH, 914400);
    assert.equal(EMU_PER_PX, EMU_PER_INCH / PX_PER_INCH);
    assert.equal(EMU_PER_PX, 9525);
    assert.equal(pxToInch(96), 1);
    assert.equal(emuToPx(EMU_PER_PX), 1);
    assert.equal(emuToPx(0), 0);
    assert.equal(emuToPx(10 * EMU_PER_PX), 10);
    assert.equal(emuToPx(-EMU_PER_PX), -1);
    assert.equal(PT_PER_INCH, 72);
    assert.equal(PX_PER_PT, 96 / 72);
    assert.equal(ptToPx(24), 32);
    assert.equal(ptToPx(18), 24);
    assert.equal(ptToPx(15), 20);
    assert.equal(ptToPx(1.5), 2);
    assert.equal(TEXT_INSET_X_PX, 9.6);
    assert.equal(TEXT_INSET_Y_PX, 4.8);
  });
});

describe("internal theme-io", () => {
  it("loads known theme colors and rejects unknown ids with the existing message", () => {
    const expected = JSON.parse(
      readFileSync(join(root, "themes/default.json"), "utf8"),
    ).colors;
    assert.deepEqual(loadThemeColors("default"), expected);
    assert.equal(THEME_IDS.has("magazine"), true);
    assert.throws(
      () => loadThemeColors("nope"),
      (err) =>
        err instanceof OpenPptError &&
        err.code === ErrorCodes.IO &&
        err.message ===
          'Unknown theme "nope" (available: default, dark, magazine, report)',
    );
  });
});
