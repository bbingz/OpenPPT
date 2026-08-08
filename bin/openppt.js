#!/usr/bin/env bun

/**
 * OpenPPT CLI — validate IR and export editable PPTX (open stack only).
 * Runtime: Bun (preferred). Node may work but is not the supported path.
 *
 * Usage:
 *   bun bin/openppt.js validate <deck.json|yaml>
 *   bun bin/openppt.js export <deck.json|yaml> -o <out.pptx> [--force]
 *   openppt --version | --help
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function printHelp() {
  console.log(`OpenPPT v${pkg.version} — open IR → editable PPTX

Usage:
  bun bin/openppt.js validate <deck.json|deck.yaml>
  bun bin/openppt.js export <deck.json|deck.yaml> -o <out.pptx> [--force]
  openppt -h | --help
  openppt -V | --version

Notes:
  - IR schema: schema/openppt-ir.schema.json
  - Export uses pptxgenjs only (no Kimi/neo-ppt WASM)
  - Missing local media and out-of-bounds elements fail closed
  - Runtime: Bun
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const opts = {
    command: null,
    deck: null,
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
    if (!opts.command && (a === "validate" || a === "export")) {
      opts.command = a;
      continue;
    }
    if (!opts.deck) {
      opts.deck = a;
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

  if (!opts.deck) {
    console.error("Missing deck path");
    printHelp();
    process.exit(2);
  }

  const { loadDeck } = await import("../src/load.js");
  const { validateDeck } = await import("../src/validate.js");
  const { compileToPptx } = await import("../src/compile.js");
  const { OpenPptError } = await import("../src/errors.js");

  try {
    const { deck, projectRoot, sourcePath } = loadDeck(opts.deck);

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
      const result = await compileToPptx(deck, opts.output, {
        projectRoot,
        force: opts.force,
        sourcePath,
      });
      console.log(`Wrote ${result.outputPath}`);
      console.log(`pages=${result.pageCount}`);
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

/**
 * True when this file is the process entry point. Compares *real* paths: an
 * installed `bin` is a symlink (npm/bun link) and a repo can sit under a
 * symlinked parent, in both of which cases argv[1] and import.meta.url spell
 * the same file differently and a naive comparison silently skips main().
 * @returns {boolean}
 */
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
