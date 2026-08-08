import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin/openppt.js");
const node = process.execPath;

describe("openppt CLI (shipped entry)", () => {
  it("prints version", () => {
    const out = execFileSync(node, [cli, "--version"], { encoding: "utf8" }).trim();
    assert.equal(out, "1.0.0");
  });

  it("validates golden fixture", () => {
    const out = execFileSync(
      node,
      [cli, "validate", join(root, "fixtures/golden/deck.json")],
      { encoding: "utf8" },
    );
    assert.match(out, /OK/);
    assert.match(out, /pages=2/);
  });

  it("validate fails for missing media with non-zero exit", () => {
    let code = 0;
    let errOut = "";
    try {
      execFileSync(
        node,
        [cli, "validate", join(root, "fixtures/negative-missing-media/deck.json")],
        { encoding: "utf8" },
      );
    } catch (e) {
      code = e.status;
      errOut = String(e.stderr || e.stdout || "");
    }
    assert.notEqual(code, 0);
    assert.match(errOut, /MEDIA_MISSING/);
  });

  it("exports golden fixture via CLI", () => {
    const outDir = join(root, "fixtures/golden/out");
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, "cli-deck.pptx");
    const log = execFileSync(
      node,
      [cli, "export", join(root, "fixtures/golden/deck.json"), "-o", out, "--force"],
      { encoding: "utf8" },
    );
    assert.match(log, /Wrote/);
    assert.ok(existsSync(out));
    assert.ok(statSync(out).size > 0);
  });
});
