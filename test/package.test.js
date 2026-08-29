import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bunBin = process.env.BUN_BIN || "bun";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function runBun(args, cwd) {
  const result = spawnSync(bunBin, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    [`bun ${args.join(" ")} failed`, result.stdout, result.stderr].join("\n"),
  );
  return result.stdout.trim();
}

describe("package contract", () => {
  it("packs, installs, and invokes the shipped bin", { timeout: 45_000 }, () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-package-"));
    try {
      const archiveDir = join(work, "archive");
      const consumerDir = join(work, "consumer");
      const archive = join(archiveDir, `${pkg.name}-${pkg.version}.tgz`);
      mkdirSync(archiveDir, { recursive: true });
      mkdirSync(consumerDir, { recursive: true });

      runBun(
        [
          "pm",
          "pack",
          "--destination",
          archiveDir,
          "--ignore-scripts",
          "--quiet",
        ],
        root,
      );
      assert.ok(existsSync(archive));
      assert.ok(statSync(archive).size > 1000);

      writeFileSync(join(consumerDir, "package.json"), '{"private":true}\n');
      runBun(["add", archive, "--ignore-scripts"], consumerDir);
      const version = runBun(["run", "--silent", "openppt", "--version"], consumerDir);
      assert.equal(version, pkg.version);

      const packedRoot = join(consumerDir, "node_modules", "openppt");
      runBun(
        [
          "run",
          "--silent",
          "openppt",
          "validate",
          join(packedRoot, "fixtures/golden/deck.json"),
        ],
        consumerDir,
      );
      const skeletonDir = join(consumerDir, "skel");
      runBun(
        ["run", "--silent", "openppt", "init", skeletonDir, "--skeleton"],
        consumerDir,
      );
      assert.ok(existsSync(join(skeletonDir, "deck.json")));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
