#!/usr/bin/env node

/**
 * OpenPPT CLI — validate IR and export editable PPTX (open stack only).
 *
 * Usage:
 *   openppt validate <deck.json|yaml>
 *   openppt export <deck.json|yaml> -o <out.pptx> [--force]
 *   openppt --version | --help
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

function printHelp() {
  console.log(`OpenPPT v${pkg.version} — open IR → editable PPTX

Usage:
  openppt validate <deck.json|deck.yaml>
  openppt export <deck.json|deck.yaml> -o <out.pptx> [--force]
  openppt -h | --help
  openppt -V | --version

Notes:
  - IR schema: schema/openppt-ir.schema.json
  - Export uses pptxgenjs only (no Kimi/neo-ppt WASM)
  - Missing local media and out-of-bounds elements fail closed
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
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-V" || a === "--version") opts.version = true;
    else if (a === "--force") opts.force = true;
    else if (a === "-o" || a === "--output") {
      opts.output = args.shift() || null;
    } else if (!opts.command && (a === "validate" || a === "export")) {
      opts.command = a;
    } else if (!opts.deck) {
      opts.deck = a;
    } else {
      throw new Error(`Unexpected argument: ${a}`);
    }
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

// Allow importing without running when tested
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain || process.argv[1]?.endsWith("openppt.js")) {
  main();
}
