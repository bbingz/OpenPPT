#!/usr/bin/env bun

/**
 * OpenPPT CLI — validate / export / import / qa / preview (Bun).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const COMMANDS = new Set(["validate", "export", "import", "qa", "preview"]);

function printHelp() {
  console.log(`OpenPPT v${pkg.version} — open IR → editable PPTX

Usage:
  bun bin/openppt.js validate <deck.json|yaml>
  bun bin/openppt.js export   <deck.json|yaml> -o <out.pptx> [--force]
  bun bin/openppt.js import   <file.pptx> -o <project-dir> [--force]
  bun bin/openppt.js qa       <deck.json|yaml>
  bun bin/openppt.js preview  <deck.json|yaml> -o <out.html>
  bun bin/openppt.js -h | --help
  bun bin/openppt.js -V | --version

Notes:
  - Schema: schema/openppt-ir.schema.json
  - Agents: docs/AGENT.md
  - Export uses pptxgenjs only (no Kimi/neo-ppt WASM)
  - import is lossy (text/shapes/images)
  - Runtime: Bun
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const opts = {
    command: null,
    input: null,
    output: null,
    force: false,
    help: false,
    version: false,
  };

  while (args.length) {
    const a = args.shift();
    if (a === "-h" || a === "--help") {
      opts.help = true;
      continue;
    }
    if (a === "-V" || a === "--version") {
      opts.version = true;
      continue;
    }
    if (a === "--force") {
      opts.force = true;
      continue;
    }
    if (a === "-o" || a === "--output") {
      const value = args.shift();
      if (!value || value.startsWith("-")) {
        throw new Error(`${a} requires a path argument (got ${value ?? "nothing"})`);
      }
      opts.output = value;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}`);
    }
    if (!opts.command && COMMANDS.has(a)) {
      opts.command = a;
      continue;
    }
    if (!opts.input) {
      opts.input = a;
      continue;
    }
    throw new Error(`Unexpected argument: ${a}`);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (opts.version) {
    console.log(pkg.version);
    return;
  }
  if (opts.help || !opts.command) {
    printHelp();
    process.exit(opts.help ? 0 : 2);
  }

  if (!opts.input) {
    console.error("Missing input path");
    printHelp();
    process.exit(2);
  }

  const { OpenPptError } = await import("../src/errors.js");

  try {
    if (opts.command === "import") {
      if (!opts.output) {
        console.error("import requires -o <project-dir>");
        process.exit(2);
      }
      const { importPptx } = await import("../src/import-pptx.js");
      const result = await importPptx(opts.input, opts.output, {
        force: opts.force,
      });
      console.log(`Wrote ${result.deckPath}`);
      console.log(`pages=${result.pageCount}`);
      for (const w of result.warnings) console.log(`warn: ${w}`);
      return;
    }

    const { loadDeck } = await import("../src/load.js");
    const { validateDeck } = await import("../src/validate.js");
    const { deck, projectRoot, sourcePath } = loadDeck(opts.input);

    if (opts.command === "validate") {
      if (opts.output) {
        console.error("validate does not accept -o/--output");
        process.exit(2);
      }
      validateDeck(deck, { projectRoot, checkMedia: true });
      console.log(`OK  ${sourcePath}`);
      console.log(`    pages=${deck.pages.length} size=${JSON.stringify(deck.size)}`);
      return;
    }

    if (opts.command === "export") {
      if (!opts.output) {
        console.error("export requires -o <out.pptx>");
        process.exit(2);
      }
      const { compileToPptx } = await import("../src/compile.js");
      const result = await compileToPptx(deck, opts.output, {
        projectRoot,
        force: opts.force,
        sourcePath,
      });
      console.log(`Wrote ${result.outputPath}`);
      console.log(`pages=${result.pageCount}`);
      return;
    }

    if (opts.command === "qa") {
      const { qaDeck } = await import("../src/qa.js");
      const result = qaDeck(deck, { projectRoot, checkMedia: true });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    }

    if (opts.command === "preview") {
      if (!opts.output) {
        console.error("preview requires -o <out.html>");
        process.exit(2);
      }
      validateDeck(deck, { projectRoot, checkMedia: true });
      const { writePreviewHtml } = await import("../src/preview.js");
      const out = writePreviewHtml(deck, projectRoot, opts.output);
      console.log(`Wrote ${out}`);
      return;
    }
  } catch (err) {
    if (err instanceof OpenPptError) {
      console.error(`[${err.code}] ${err.message}`);
      process.exit(1);
    }
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(resolve(process.argv[1])) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main();
}
