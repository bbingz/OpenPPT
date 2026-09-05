import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeck } from "../src/load.js";
import {
  validateDeck,
  getSchemaValidator,
  safeProjectPath,
  resolveColor,
  imageSizeFromBytes,
  sniffImageBytes,
} from "../src/validate.js";
import { OpenPptError, ErrorCodes } from "../src/errors.js";
import { pngIhdrHeader } from "./helpers/pptx.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("validateDeck (shipped)", () => {
  it("accepts golden multi-page fixture", () => {
    const { deck, projectRoot } = loadDeck(join(root, "fixtures/golden/deck.json"));
    const result = validateDeck(deck, { projectRoot, checkMedia: true });
    assert.equal(result.ok, true);
    assert.equal(deck.pages.length, 2);
    assert.ok(result.colors.primary);
  });

  it("fails closed on missing local media", () => {
    const { deck, projectRoot } = loadDeck(
      join(root, "fixtures/negative-missing-media/deck.json"),
    );
    assert.throws(
      () => validateDeck(deck, { projectRoot, checkMedia: true }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.MEDIA_MISSING);
        return true;
      },
    );
  });

  it("fails closed on out-of-bounds elements", () => {
    const { deck, projectRoot } = loadDeck(join(root, "fixtures/negative-oob/deck.json"));
    assert.throws(
      () => validateDeck(deck, { projectRoot, checkMedia: true }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.BOUNDS);
        return true;
      },
    );
  });

  it("rejects schema-invalid deck", () => {
    const { deck, projectRoot } = loadDeck(join(root, "fixtures/invalid-schema/deck.json"));
    assert.throws(
      () => validateDeck(deck, { projectRoot, checkMedia: false }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        return true;
      },
    );
  });

  it("fails closed on non-finite bounds from YAML (.nan / .inf)", () => {
    const { deck, projectRoot } = loadDeck(
      join(root, "fixtures/negative-nonfinite/deck.yaml"),
    );
    assert.throws(
      () => validateDeck(deck, { projectRoot, checkMedia: true }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.BOUNDS);
        return true;
      },
    );
  });

  it("fails closed on non-finite font and line sizes", () => {
    const elements = [
      {
        id: "text",
        type: "text",
        bounds: [0, 0, 100, 40],
        text: "x",
        fontSize: Infinity,
      },
      {
        id: "shape",
        type: "shape",
        bounds: [0, 0, 100, 40],
        shape: "rect",
        lineWidth: Infinity,
      },
    ];

    for (const element of elements) {
      assert.throws(
        () =>
          validateDeck(
            {
              version: "openppt-1",
              size: [960, 540],
              pages: [{ id: "p1", elements: [element] }],
            },
            { checkMedia: false },
          ),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.SCHEMA);
          return true;
        },
      );
    }
  });

  it("fails closed on an unresolved theme token", () => {
    assert.throws(
      () =>
        validateDeck(
          {
            version: "openppt-1",
            size: [960, 540],
            pages: [
              {
                id: "p1",
                elements: [
                  {
                    id: "t1",
                    type: "text",
                    bounds: [0, 0, 100, 40],
                    text: "x",
                    color: "$nope",
                  },
                ],
              },
            ],
          },
          { checkMedia: false },
        ),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.THEME_COLOR);
        return true;
      },
    );
  });

  it("path jail accepts a media/ path", () => {
    const abs = safeProjectPath(join(root, "fixtures/golden"), "media/accent.png");
    assert.ok(existsSync(abs));
  });

  it("rejects image src outside media/", () => {
    assert.throws(
      () =>
        validateDeck(
          {
            version: "openppt-1",
            size: [960, 540],
            pages: [
              {
                id: "p1",
                elements: [
                  {
                    id: "img1",
                    type: "image",
                    bounds: [0, 0, 100, 100],
                    src: "secrets/note.png",
                  },
                ],
              },
            ],
          },
          { projectRoot: join(root, "fixtures/golden"), checkMedia: true },
        ),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        // schema pattern or runtime subtree — either is fail-closed
        assert.ok(
          err.code === ErrorCodes.MEDIA_MISSING || err.code === ErrorCodes.SCHEMA,
        );
        return true;
      },
    );
  });

  it("rejects non-image bytes under media/", () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-media-"));
    try {
      mkdirSync(join(dir, "media"), { recursive: true });
      writeFileSync(join(dir, "media/fake.png"), "not-a-real-png");
      assert.throws(
        () =>
          validateDeck(
            {
              version: "openppt-1",
              size: [960, 540],
              pages: [
                {
                  id: "p1",
                  elements: [
                    {
                      id: "img1",
                      type: "image",
                      bounds: [0, 0, 100, 100],
                      src: "media/fake.png",
                    },
                  ],
                },
              ],
            },
            { projectRoot: dir, checkMedia: true },
          ),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.MEDIA_TYPE);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("path jail rejects a symlink pointing outside the project root", () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-jail-"));
    try {
      const outside = join(dir, "outside.png");
      const projectRoot = join(dir, "proj");
      mkdirSync(join(projectRoot, "media"), { recursive: true });
      writeFileSync(outside, "stand-in for a file outside the deck project");
      symlinkSync(outside, join(projectRoot, "media/leak.png"));
      assert.throws(
        () => safeProjectPath(projectRoot, "media/leak.png"),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.MEDIA_MISSING);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on a duplicate page id", () => {
    assert.throws(
      () =>
        validateDeck(
          {
            version: "openppt-1",
            size: [960, 540],
            pages: [
              { id: "dup", elements: [] },
              { id: "dup", elements: [] },
            ],
          },
          { checkMedia: false },
        ),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        assert.match(err.message, /Duplicate page id/);
        return true;
      },
    );
  });

  it("element ids must be unique deck-wide, not just per page", () => {
    assert.throws(
      () =>
        validateDeck(
          {
            version: "openppt-1",
            size: [960, 540],
            pages: [
              {
                id: "p1",
                elements: [
                  { id: "title", type: "text", bounds: [0, 0, 100, 40], text: "a" },
                ],
              },
              {
                id: "p2",
                elements: [
                  { id: "title", type: "text", bounds: [0, 0, 100, 40], text: "b" },
                ],
              },
            ],
          },
          { checkMedia: false },
        ),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        assert.match(err.message, /Duplicate element id/);
        return true;
      },
    );
  });

  it("rejects finite but unbounded fontSize (1e308)", () => {
    assert.throws(
      () =>
        validateDeck(
          {
            version: "openppt-1",
            size: [960, 540],
            pages: [
              {
                id: "p1",
                elements: [
                  {
                    id: "t1",
                    type: "text",
                    bounds: [0, 0, 100, 40],
                    text: "x",
                    fontSize: 1e308,
                  },
                ],
              },
            ],
          },
          { checkMedia: false },
        ),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        return true;
      },
    );
  });

  it("rejects prototype-chain theme tokens", () => {
    for (const token of [
      "$constructor",
      "$toString",
      "$hasOwnProperty",
      "$valueOf",
      "$isPrototypeOf",
      "$propertyIsEnumerable",
    ]) {
      assert.throws(
        () =>
          validateDeck(
            {
              version: "openppt-1",
              size: [960, 540],
              pages: [
                {
                  id: "p1",
                  elements: [
                    {
                      id: "t1",
                      type: "text",
                      bounds: [0, 0, 100, 40],
                      text: "x",
                      color: token,
                    },
                  ],
                },
              ],
            },
            { checkMedia: false },
          ),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.THEME_COLOR);
          return true;
        },
        token,
      );
    }
  });

  it("resolveColor rejects prototype keys and non-hex exits", () => {
    const colors = { primary: "#2563EB" };
    assert.throws(
      () => resolveColor("$constructor", colors, "test"),
      (err) => err instanceof OpenPptError && err.code === ErrorCodes.THEME_COLOR,
    );
    assert.throws(
      () => resolveColor("not-a-color", colors, "test"),
      (err) => err instanceof OpenPptError && err.code === ErrorCodes.THEME_COLOR,
    );
    assert.equal(resolveColor("$primary", colors, "test"), "#2563EB");
    assert.equal(resolveColor("#11223344", colors, "test"), "#11223344");
  });

  it("rejects PNG natural sizes that overflow ST_Coordinate", () => {
    const huge = pngIhdrHeader(4294967295, 1);
    assert.deepEqual(imageSizeFromBytes(huge), {
      width: 4294967295,
      height: 1,
    });

    const dir = mkdtempSync(join(tmpdir(), "openppt-huge-png-"));
    try {
      mkdirSync(join(dir, "media"), { recursive: true });
      writeFileSync(join(dir, "media/huge.png"), huge);
      assert.throws(
        () =>
          validateDeck(
            {
              version: "openppt-1",
              size: [960, 540],
              pages: [
                {
                  id: "p1",
                  elements: [
                    {
                      id: "img1",
                      type: "image",
                      bounds: [0, 0, 100, 100],
                      src: "media/huge.png",
                    },
                  ],
                },
              ],
            },
            { projectRoot: dir, checkMedia: true },
          ),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.MEDIA_TYPE);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps EISDIR from loadDeck as IO_ERROR", () => {
    assert.throws(
      () => loadDeck(root),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.IO);
        assert.equal(err instanceof TypeError && !(err instanceof OpenPptError), false);
        return true;
      },
    );
  });

  it("wraps function values as SCHEMA_INVALID instead of DataCloneError", () => {
    const deck = {
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p1",
          elements: [
            { id: "t1", type: "text", bounds: [0, 0, 100, 40], text: "x" },
          ],
        },
      ],
    };
    deck.pages[0].poison = function nope() {};
    assert.throws(
      () => validateDeck(deck, { checkMedia: false }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        return true;
      },
    );
  });

  it("wraps deeply nested IR as SCHEMA_INVALID instead of RangeError", () => {
    let poison = { leaf: 1 };
    for (let i = 0; i < 50000; i += 1) poison = { n: poison };
    const deck = {
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p1",
          elements: [
            { id: "t1", type: "text", bounds: [0, 0, 100, 40], text: "x" },
          ],
        },
      ],
    };
    deck.pages[0].poison = poison;
    assert.throws(
      () => validateDeck(deck, { checkMedia: false }),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        return true;
      },
    );
  });

  it("rejects SVG without natural size unless fit is fill", () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-svg-fit-"));
    try {
      mkdirSync(join(dir, "media"), { recursive: true });
      writeFileSync(
        join(dir, "media/bare.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>`,
      );
      const deck = (fit) => ({
        version: "openppt-1",
        size: [200, 200],
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "img",
                type: "image",
                bounds: [0, 0, 100, 100],
                src: "media/bare.svg",
                fit,
              },
            ],
          },
        ],
      });
      assert.throws(
        () => validateDeck(deck("cover"), { projectRoot: dir, checkMedia: true }),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.MEDIA_TYPE,
      );
      assert.equal(
        validateDeck(deck("fill"), { projectRoot: dir, checkMedia: true }).ok,
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sniffs GIF, JPEG, and WEBP dimensions from minimal buffers", () => {
    const gif = Buffer.alloc(24);
    gif.write("GIF89a", 0);
    gif.writeUInt16LE(7, 6);
    gif.writeUInt16LE(9, 8);
    assert.equal(sniffImageBytes(gif), "gif");
    assert.deepEqual(imageSizeFromBytes(gif), { width: 7, height: 9 });

    const jpeg = Buffer.alloc(24, 0);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    jpeg[2] = 0xff;
    jpeg[3] = 0xc0;
    jpeg.writeUInt16BE(11, 4);
    jpeg[6] = 8;
    jpeg.writeUInt16BE(11, 7);
    jpeg.writeUInt16BE(13, 9);
    assert.equal(sniffImageBytes(jpeg), "jpeg");
    assert.deepEqual(imageSizeFromBytes(jpeg), { width: 13, height: 11 });

    const vp8 = Buffer.alloc(30);
    vp8.write("RIFF", 0);
    vp8.write("WEBP", 8);
    vp8.write("VP8 ", 12);
    vp8.writeUInt16LE(17, 26);
    vp8.writeUInt16LE(19, 28);
    assert.equal(sniffImageBytes(vp8), "webp");
    assert.deepEqual(imageSizeFromBytes(vp8), { width: 17, height: 19 });

    const vp8l = Buffer.alloc(30);
    vp8l.write("RIFF", 0);
    vp8l.write("WEBP", 8);
    vp8l.write("VP8L", 12);
    vp8l.writeUInt32LE((21 - 1) | ((23 - 1) << 14), 21);
    assert.deepEqual(imageSizeFromBytes(vp8l), { width: 21, height: 23 });

    const vp8x = Buffer.alloc(30);
    vp8x.write("RIFF", 0);
    vp8x.write("WEBP", 8);
    vp8x.write("VP8X", 12);
    const wMinus = 31 - 1;
    const hMinus = 41 - 1;
    vp8x[24] = wMinus & 0xff;
    vp8x[25] = (wMinus >> 8) & 0xff;
    vp8x[26] = (wMinus >> 16) & 0xff;
    vp8x[27] = hMinus & 0xff;
    vp8x[28] = (hMinus >> 8) & 0xff;
    vp8x[29] = (hMinus >> 16) & 0xff;
    assert.deepEqual(imageSizeFromBytes(vp8x), { width: 31, height: 41 });
  });

  it("rejects an SVG polyglot that starts with a PNG header", () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-polyglot-"));
    try {
      mkdirSync(join(dir, "media"), { recursive: true });
      writeFileSync(
        join(dir, "media/poly.svg"),
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from("<html><svg xmlns='http://www.w3.org/2000/svg'></svg></html>"),
        ]),
      );
      assert.throws(
        () =>
          validateDeck(
            {
              version: "openppt-1",
              size: [200, 200],
              pages: [
                {
                  id: "p1",
                  elements: [
                    {
                      id: "img",
                      type: "image",
                      bounds: [0, 0, 100, 100],
                      src: "media/poly.svg",
                      fit: "fill",
                    },
                  ],
                },
              ],
            },
            { projectRoot: dir, checkMedia: true },
          ),
        (err) => err instanceof OpenPptError && err.code === ErrorCodes.MEDIA_TYPE,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schema validator is the real ajv function from getSchemaValidator", () => {
    const v = getSchemaValidator();
    assert.equal(typeof v, "function");
    const ok = v({
      version: "openppt-1",
      size: [100, 100],
      pages: [
        {
          id: "p1",
          elements: [
            {
              id: "t1",
              type: "text",
              bounds: [0, 0, 50, 20],
              text: "hi",
            },
          ],
        },
      ],
    });
    assert.equal(ok, true);
  });

  function textDeck(fontFamily, runFamily) {
    return {
      version: "openppt-1",
      size: [960, 540],
      pages: [
        {
          id: "p1",
          elements: [
            {
              id: "t1",
              type: "text",
              bounds: [0, 0, 200, 40],
              text: runFamily
                ? [{ text: "Hi", fontFamily: runFamily }]
                : "Hi",
              ...(fontFamily ? { fontFamily } : {}),
            },
          ],
        },
      ],
    };
  }

  it("accepts ordinary Latin and CJK fontFamily names", () => {
    for (const name of [
      "Arial",
      "Times New Roman",
      "PingFang SC",
      "微软雅黑",
      "Noto Sans CJK SC",
      "Rock'n'Roll One",
    ]) {
      const result = validateDeck(textDeck(name), { checkMedia: false });
      assert.equal(result.ok, true, name);
    }
    const run = validateDeck(textDeck(undefined, "Hiragino Sans GB"), {
      checkMedia: false,
    });
    assert.equal(run.ok, true);
  });

  it("rejects multi-series pie and doughnut charts", () => {
    for (const chartType of ["pie", "doughnut"]) {
      assert.throws(
        () =>
          validateDeck(
            {
              version: "openppt-1",
              size: [960, 540],
              pages: [
                {
                  id: "p1",
                  elements: [
                    {
                      id: "ch",
                      type: "chart",
                      bounds: [0, 0, 400, 300],
                      chartType,
                      series: [
                        { name: "A", values: [1, 2], labels: ["x", "y"] },
                        { name: "B", values: [3, 4], labels: ["x", "y"] },
                      ],
                    },
                  ],
                },
              ],
            },
            { checkMedia: false },
          ),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.SCHEMA);
          assert.match(err.message, /multi-series/i);
          return true;
        },
        chartType,
      );
    }
  });

  it("rejects mixed explicit and omitted chart categories", () => {
    assert.throws(
      () =>
        validateDeck(
          {
            version: "openppt-1",
            size: [960, 540],
            pages: [
              {
                id: "p1",
                elements: [
                  {
                    id: "ch",
                    type: "chart",
                    bounds: [0, 0, 400, 300],
                    chartType: "bar",
                    series: [
                      { name: "A", values: [1, 2], labels: ["Q1", "Q2"] },
                      { name: "B", values: [3, 4] },
                    ],
                  },
                ],
              },
            ],
          },
          { checkMedia: false },
        ),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        assert.match(err.message, /categor/i);
        return true;
      },
    );
  });

  it("accepts omitted chart labels that match the default 1-based categories", () => {
    const result = validateDeck(
      {
        version: "openppt-1",
        size: [960, 540],
        pages: [
          {
            id: "p1",
            elements: [
              {
                id: "ch",
                type: "chart",
                bounds: [0, 0, 400, 300],
                chartType: "bar",
                series: [
                  { name: "A", values: [1, 2] },
                  { name: "B", labels: ["1", "2"], values: [3, 4] },
                ],
              },
            ],
          },
        ],
      },
      { checkMedia: false },
    );
    assert.equal(result.ok, true);
  });

  it("rejects chart series with mismatched categories", () => {
    assert.throws(
      () =>
        validateDeck(
          {
            version: "openppt-1",
            size: [960, 540],
            pages: [
              {
                id: "p1",
                elements: [
                  {
                    id: "ch",
                    type: "chart",
                    bounds: [0, 0, 400, 300],
                    chartType: "bar",
                    series: [
                      { name: "A", values: [1, 2], labels: ["x", "y"] },
                      { name: "B", values: [3, 4], labels: ["y", "z"] },
                    ],
                  },
                ],
              },
            ],
          },
          { checkMedia: false },
        ),
      (err) => {
        assert.ok(err instanceof OpenPptError);
        assert.equal(err.code, ErrorCodes.SCHEMA);
        assert.match(err.message, /categor/i);
        return true;
      },
    );
  });

  it("rejects unsafe fontFamily values with SCHEMA_INVALID", () => {
    for (const name of [
      `Arial"/><a:latin typeface="Wingdings`,
      "Arial;color:red",
      "/usr/share/fonts/Arial.ttf",
      "Arial\nComic Sans",
      "<script>",
      "Arial\uFFFF",
      "Arial\uFFFE",
      "Arial\uD800",
      "Arial\u0001",
      "Arial\u007F",
    ]) {
      assert.throws(
        () => validateDeck(textDeck(name), { checkMedia: false }),
        (err) => {
          assert.ok(err instanceof OpenPptError);
          assert.equal(err.code, ErrorCodes.SCHEMA);
          assert.match(err.message, /fontFamily/i);
          return true;
        },
        JSON.stringify(name),
      );
    }
  });
});
