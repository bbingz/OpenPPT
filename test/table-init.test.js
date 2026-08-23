import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { loadDeck } from "../src/load.js";
import { validateDeck } from "../src/validate.js";
import { compileToPptx } from "../src/compile.js";
import { importPptx } from "../src/import-pptx.js";
import { initProject } from "../src/init.js";
import { analyzeLayout } from "../src/qa.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bunBin = process.env.BUN_BIN || "bun";
const cli = join(root, "bin/openppt.js");

describe("tables + init", () => {
  it("validates and exports table-demo fixture", async () => {
    const { deck, projectRoot, sourcePath } = loadDeck(
      join(root, "fixtures/table-demo/deck.json"),
    );
    validateDeck(deck, { projectRoot, checkMedia: false });
    const outDir = mkdtempSync(join(tmpdir(), "openppt-table-"));
    try {
      const out = join(outDir, "table.pptx");
      const result = await compileToPptx(deck, out, {
        projectRoot,
        force: true,
        sourcePath,
      });
      assert.ok(statSync(result.outputPath).size > 1000);
      const listing = execFileSync("unzip", ["-l", out], { encoding: "utf8" });
      assert.match(listing, /slide1\.xml/);
      // OOXML table marker
      const xml = execFileSync("unzip", ["-p", out, "ppt/slides/slide1.xml"], {
        encoding: "utf8",
      });
      assert.match(xml, /a:tbl|a:tc/);
      assert.match(xml, /OpenPPT tables|Feature|Charts/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("round-trips table through export → import", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-tbl-"));
    try {
      const { deck, projectRoot, sourcePath } = loadDeck(
        join(root, "fixtures/table-demo/deck.json"),
      );
      const pptx = join(work, "t.pptx");
      await compileToPptx(deck, pptx, { projectRoot, force: true, sourcePath });
      const impDir = join(work, "imp");
      const imp = await importPptx(pptx, impDir, { force: true });
      const loaded = loadDeck(imp.deckPath);
      validateDeck(loaded.deck, {
        projectRoot: loaded.projectRoot,
        checkMedia: true,
      });
      const tables = loaded.deck.pages.flatMap((p) =>
        (p.elements || []).filter((e) => e.type === "table"),
      );
      assert.ok(tables.length >= 1, "expected imported table");
      assert.ok(tables[0].rows.length >= 2);
      assert.match(JSON.stringify(tables[0].rows), /Feature|Charts|Tables/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("init scaffolds a valid project that exports", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-init-"));
    try {
      const dest = join(work, "proj");
      const { deckPath, theme } = initProject(dest, {
        theme: "magazine",
        title: "Init Test",
      });
      assert.equal(theme, "magazine");
      assert.ok(existsSync(deckPath));
      const { deck, projectRoot, sourcePath } = loadDeck(deckPath);
      validateDeck(deck, { projectRoot, checkMedia: true });
      assert.equal(deck.title, "Init Test");
      assert.ok(deck.theme.colors.primary);
      const hasTable = deck.pages.some((p) =>
        (p.elements || []).some((e) => e.type === "table"),
      );
      assert.ok(hasTable);
      const out = join(work, "out.pptx");
      await compileToPptx(deck, out, { projectRoot, force: true, sourcePath });
      assert.ok(statSync(out).size > 1000);

      // CLI path
      const dest2 = join(work, "cli-proj");
      const r = spawnSync(
        bunBin,
        [cli, "init", dest2, "--theme", "report", "--title", "CLI"],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(dest2, "deck.json")));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("round-trips chart through export → import", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-ch-"));
    try {
      const { deck, projectRoot, sourcePath } = loadDeck(
        join(root, "fixtures/chart-demo/deck.json"),
      );
      const pptx = join(work, "c.pptx");
      await compileToPptx(deck, pptx, { projectRoot, force: true, sourcePath });
      const imp = await importPptx(pptx, join(work, "imp"), { force: true });
      const loaded = loadDeck(imp.deckPath);
      validateDeck(loaded.deck, {
        projectRoot: loaded.projectRoot,
        checkMedia: true,
      });
      const charts = loaded.deck.pages.flatMap((p) =>
        (p.elements || []).filter((e) => e.type === "chart"),
      );
      assert.ok(charts.length >= 1, "expected imported chart");
      assert.ok(charts[0].series?.[0]?.values?.length > 0);
      assert.match(JSON.stringify(charts[0]), /Revenue|Sales|bar/i);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("from-outline builds a multi-page deck from markdown", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-md-"));
    try {
      const r = spawnSync(
        bunBin,
        [
          cli,
          "from-outline",
          join(root, "fixtures/outline-sample.md"),
          "-o",
          join(work, "deck"),
          "--theme",
          "report",
          "--force",
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const { deck, projectRoot, sourcePath } = loadDeck(
        join(work, "deck/deck.json"),
      );
      validateDeck(deck, { projectRoot, checkMedia: true });
      assert.ok(deck.pages.length >= 4); // cover + toc + 3 sections
      assert.match(deck.title, /Product Update/);
      const out = join(work, "out.pptx");
      await compileToPptx(deck, out, { projectRoot, force: true, sourcePath });
      assert.ok(statSync(out).size > 1000);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("qa flags low contrast text", () => {
    const deck = {
      version: "openppt-1",
      size: [960, 540],
      theme: { colors: { background: "#FFFFFF", text: "#EEEEEE" } },
      pages: [
        {
          id: "p",
          background: { type: "solid", color: "$background" },
          elements: [
            {
              id: "t",
              type: "text",
              bounds: [100, 100, 400, 40],
              text: "Barely visible",
              color: "$text",
              fontSize: 18,
            },
          ],
        },
      ],
    };
    const r = analyzeLayout(deck);
    assert.ok(r.issues.some((i) => i.code === "LOW_CONTRAST"));
  });
});
