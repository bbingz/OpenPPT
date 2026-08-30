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
import { openPptx, readPptxEntry } from "./helpers/pptx.js";

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

  it("explains authoring groups versus the normalized leaf schema in help", () => {
    const out = execFileSync(bunBin, [cli, "--help"], { encoding: "utf8" });
    assert.match(out, /normalized leaf IR/i);
    assert.match(out, /group.*authoring-only.*loadDeck.*validateDeck/i);
  });

  it("pdf subcommand requires -o and rejects stray options", () => {
    const missing = spawnSync(bunBin, [cli, "pdf", "deck.json"], { encoding: "utf8" });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /pdf requires -o/);

    const stray = spawnSync(
      bunBin,
      [cli, "pdf", "deck.json", "-o", "out.pdf", "--skeleton"],
      { encoding: "utf8" },
    );
    assert.equal(stray.status, 2);
    assert.match(stray.stderr, /pdf does not accept --skeleton/);
  });

  it(
    "runs directly through the shipped Bun shebang",
    { skip: process.platform === "win32" },
    () => {
      const out = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
      assert.equal(out, pkg.version);
    },
  );

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

  it("accepts -- as an options terminator", () => {
    const out = execFileSync(
      bunBin,
      [cli, "validate", "--", join(root, "fixtures/golden/deck.json")],
      { encoding: "utf8" },
    );
    assert.match(out, /OK/);
  });

  it("warns on duplicate flags and keeps help on stdout", () => {
    const outDir = mkdtempSync(join(tmpdir(), "openppt-cli-dup-"));
    try {
      const dup = spawnSync(
        bunBin,
        [
          cli,
          "export",
          join(root, "fixtures/golden/deck.json"),
          "-o",
          join(outDir, "dup.pptx"),
          "--force",
          "--force",
        ],
        { encoding: "utf8" },
      );
      assert.equal(dup.status, 0, dup.stderr);
      assert.match(dup.stderr, /duplicate option --force/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }

    const help = spawnSync(bunBin, [cli, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);
    assert.equal(help.stderr.trim(), "");
  });

  it("prints a missing-command error on stderr", () => {
    const r = spawnSync(bunBin, [cli], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Missing command/);
    assert.doesNotMatch(r.stdout, /Usage:/);
  });

  it("import and preview require -o and exit 2 when it is missing", () => {
    const imp = spawnSync(bunBin, [cli, "import", "deck.pptx"], {
      encoding: "utf8",
    });
    assert.equal(imp.status, 2);
    assert.match(imp.stderr, /import requires -o/);

    const prev = spawnSync(bunBin, [cli, "preview", join(root, "fixtures/golden/deck.json")], {
      encoding: "utf8",
    });
    assert.equal(prev.status, 2);
    assert.match(prev.stderr, /preview requires -o/);
  });

  it("exports golden fixture via CLI", async () => {
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
      const pptx = await openPptx(out);
      const xml = await readPptxEntry(pptx, "ppt/slides/slide1.xml");
      assert.match(xml, /<p:sld[\s>]|<p:cSld/);
      assert.match(xml, /a:t/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("runs import and preview subcommands end to end", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-cli-e2e-"));
    try {
      const pptx = join(work, "in.pptx");
      execFileSync(
        bunBin,
        [cli, "export", join(root, "fixtures/golden/deck.json"), "-o", pptx, "--force"],
        { encoding: "utf8" },
      );
      const imported = join(work, "imported");
      const imp = execFileSync(
        bunBin,
        [cli, "import", pptx, "-o", imported, "--force"],
        { encoding: "utf8" },
      );
      assert.match(imp, /Wrote/);
      assert.ok(existsSync(join(imported, "deck.json")));

      const html = join(work, "preview.html");
      const prev = execFileSync(
        bunBin,
        [cli, "preview", join(imported, "deck.json"), "-o", html, "--force"],
        { encoding: "utf8" },
      );
      assert.match(prev, /Wrote/);
      assert.match(readFileSync(html, "utf8"), /class="page"/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
