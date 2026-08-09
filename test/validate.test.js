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
import { validateDeck, getSchemaValidator, safeProjectPath } from "../src/validate.js";
import { OpenPptError, ErrorCodes } from "../src/errors.js";

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
});
