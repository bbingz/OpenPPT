import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeck } from "../src/load.js";
import { validateDeck, getSchemaValidator } from "../src/validate.js";
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
