import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  statSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin/openppt.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
/** Prefer Bun for all CLI invocations (project standard). */
const bunBin = process.env.BUN_BIN || "bun";

describe("openppt CLI (shipped entry)", () => {
  it("prints version", () => {
    const out = execFileSync(bunBin, [cli, "--version"], { encoding: "utf8" }).trim();
    assert.equal(out, pkg.version);
  });

  it("runs directly through the shipped Bun shebang", () => {
    const out = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
    assert.equal(out, pkg.version);
  });

  it("runs main() when invoked through a symlink (npm/bun link installs a symlinked bin)", () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-bin-"));
    try {
      const link = join(dir, "openppt.js");
      symlinkSync(cli, link);
      const out = execFileSync(bunBin, [link, "--version"], { encoding: "utf8" }).trim();
      assert.equal(out, pkg.version);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown options and a missing output value", () => {
    const unknown = spawnSync(bunBin, [cli, "validate", "--bogus"], {
      encoding: "utf8",
    });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown option: --bogus/);

    const missingOutput = spawnSync(bunBin, [cli, "export", "deck.json", "-o", "--force"], {
      encoding: "utf8",
    });
    assert.equal(missingOutput.status, 2);
    assert.match(missingOutput.stderr, /-o requires a path argument/);
  });

  it("validates golden fixture", () => {
    const out = execFileSync(
      bunBin,
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
        bunBin,
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
    const outDir = mkdtempSync(join(tmpdir(), "openppt-cli-export-"));
    try {
      const out = join(outDir, "cli-deck.pptx");
      const log = execFileSync(
        bunBin,
        [cli, "export", join(root, "fixtures/golden/deck.json"), "-o", out, "--force"],
        { encoding: "utf8" },
      );
      assert.match(log, /Wrote/);
      assert.ok(existsSync(out));
      assert.ok(statSync(out).size > 0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
