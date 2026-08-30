#!/usr/bin/env bun

/**
 * OpenPPT CLI — validate / export / import / qa / preview / init (Bun).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const COMMANDS = new Set([
  "validate",
  "export",
  "import",
  "qa",
  "preview",
  "init",
  "from-outline",
  "serve",
  "pdf",
]);

function printHelp() {
  console.log(`OpenPPT v${pkg.version} — open IR → editable PPTX

Usage:
  bun bin/openppt.js init         <project-dir> [--theme default|dark|magazine|report]
                                               [--title "..."] [--skeleton] [--force]
  bun bin/openppt.js from-outline <outline.md> -o <project-dir> [--theme ...] [--force]
  bun bin/openppt.js validate     <deck.json|yaml>
  bun bin/openppt.js export       <deck.json|yaml> -o <out.pptx> [--force]
  bun bin/openppt.js import       <file.pptx> -o <project-dir> [--force]
  bun bin/openppt.js qa           <deck.json|yaml> [--fail-on low|med|high|critical]
  bun bin/openppt.js preview      <deck.json|yaml> -o <out.html> [--force]
  bun bin/openppt.js serve        [--port 7357] [--data-dir <dir>] [--open]
  bun bin/openppt.js pdf          <deck.json|yaml> -o <out.pdf> [--force]
  bun bin/openppt.js -h | --help
  bun bin/openppt.js -V | --version

Notes:
  - Schema: normalized leaf IR — schema/openppt-ir.schema.json
  - Agents: docs/AGENT.md
  - Leaf elements: text · shape · image · chart · table
  - group(stack|row|grid|layer): authoring-only; use loadDeck / validateDeck before raw Ajv
  - from-outline: # title / ## section / - bullets → deck with layout groups
  - Export uses pptxgenjs only (no Kimi/neo-ppt WASM)
  - import is lossy (text/shapes/images/tables + best-effort charts)
  - qa --fail-on default: high
  - serve: local web workbench (OpenPPT Studio) on 127.0.0.1; projects live in
    --data-dir (default ~/.openppt/projects), each one a CLI-compatible folder
  - pdf: renders via headless LibreOffice when installed (or set SOFFICE);
    PPTX export itself never needs LibreOffice
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
    failOn: null,
    theme: null,
    title: null,
    skeleton: false,
    port: null,
    dataDir: null,
    open: false,
    help: false,
    version: false,
    warnings: [],
  };
  const seen = new Set();

  function noteFlag(name) {
    if (seen.has(name)) {
      opts.warnings.push(`duplicate option ${name}`);
    }
    seen.add(name);
  }

  function takeValue(flag) {
    const value = args.shift();
    if (!value || value.startsWith("-")) {
      throw new Error(`${flag} requires a path argument (got ${value ?? "nothing"})`);
    }
    return value;
  }

  function addPositional(token) {
    if (!opts.command && COMMANDS.has(token)) {
      opts.command = token;
      return;
    }
    if (!opts.input) {
      opts.input = token;
      return;
    }
    throw new Error(`Unexpected argument: ${token}`);
  }

  while (args.length) {
    const a = args.shift();
    if (a === "--") {
      while (args.length) addPositional(args.shift());
      break;
    }
    if (a === "-h" || a === "--help") {
      noteFlag("--help");
      opts.help = true;
      continue;
    }
    if (a === "-V" || a === "--version") {
      noteFlag("--version");
      opts.version = true;
      continue;
    }
    if (a === "--force") {
      noteFlag("--force");
      opts.force = true;
      continue;
    }
    if (a === "--skeleton") {
      noteFlag("--skeleton");
      opts.skeleton = true;
      continue;
    }
    if (a === "--fail-on") {
      noteFlag("--fail-on");
      const value = args.shift();
      if (!value || value.startsWith("-")) {
        throw new Error(
          `--fail-on requires low|med|high|critical (got ${value ?? "nothing"})`,
        );
      }
      if (!["low", "med", "high", "critical"].includes(value)) {
        throw new Error(
          `--fail-on must be low|med|high|critical (got ${value})`,
        );
      }
      opts.failOn = value;
      continue;
    }
    if (a === "--theme") {
      noteFlag("--theme");
      const value = args.shift();
      if (!value || value.startsWith("-")) {
        throw new Error(`--theme requires a name (got ${value ?? "nothing"})`);
      }
      opts.theme = value;
      continue;
    }
    if (a === "--title") {
      noteFlag("--title");
      const value = args.shift();
      if (!value || value.startsWith("-")) {
        throw new Error(`--title requires a string (got ${value ?? "nothing"})`);
      }
      opts.title = value;
      continue;
    }
    if (a === "-o" || a === "--output") {
      noteFlag("-o/--output");
      opts.output = takeValue(a);
      continue;
    }
    if (a === "--port") {
      noteFlag("--port");
      const value = args.shift();
      if (value === undefined || !/^\d{1,5}$/.test(value) || Number(value) > 65535) {
        throw new Error(`--port requires 0-65535 (got ${value ?? "nothing"})`);
      }
      opts.port = Number(value);
      continue;
    }
    if (a === "--data-dir") {
      noteFlag("--data-dir");
      opts.dataDir = takeValue(a);
      continue;
    }
    if (a === "--open") {
      noteFlag("--open");
      opts.open = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}`);
    }
    addPositional(a);
  }
  return opts;
}

function assertCommandOptions(opts) {
  const allowed = {
    init: new Set(["force", "theme", "title", "skeleton"]),
    "from-outline": new Set(["output", "force", "theme"]),
    validate: new Set(),
    export: new Set(["output", "force"]),
    import: new Set(["output", "force"]),
    qa: new Set(["failOn"]),
    preview: new Set(["output", "force"]),
    serve: new Set(["port", "dataDir", "open"]),
    pdf: new Set(["output", "force"]),
  };
  const labels = {
    output: "-o/--output",
    force: "--force",
    failOn: "--fail-on",
    theme: "--theme",
    title: "--title",
    skeleton: "--skeleton",
    dataDir: "--data-dir",
    open: "--open",
  };
  for (const [key, label] of Object.entries(labels)) {
    if (opts[key] && !allowed[opts.command].has(key)) {
      throw new Error(`${opts.command} does not accept ${label}`);
    }
  }
  if (opts.port !== null && !allowed[opts.command].has("port")) {
    throw new Error(`${opts.command} does not accept --port`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  for (const warning of opts.warnings) {
    console.error(`Warning: ${warning}`);
  }

  if (opts.version) {
    console.log(pkg.version);
    return;
  }
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (!opts.command) {
    console.error("Missing command");
    console.error("Try --help for usage");
    process.exit(2);
  }

  try {
    assertCommandOptions(opts);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (!opts.input && opts.command !== "serve") {
    console.error("Missing input path");
    printHelp();
    process.exit(2);
  }
  if (opts.command === "serve" && opts.input) {
    console.error(`serve does not take a positional argument (got ${opts.input})`);
    process.exit(2);
  }

  const { OpenPptError } = await import("../src/errors.js");

  try {
    if (opts.command === "serve") {
      const { startWebServer } = await import("../src/server.js");
      const started = startWebServer({
        port: opts.port ?? 7357,
        dataDir: opts.dataDir || undefined,
      });
      console.log(`OpenPPT Studio  ${started.url}`);
      console.log(`projects        ${started.dataDir}`);
      console.log("Press Ctrl+C to stop.");
      if (opts.open && process.platform === "darwin") {
        try {
          Bun.spawn(["open", started.url]);
        } catch {
          // browser open is best-effort
        }
      }
      return;
    }

    if (opts.command === "init") {
      const { initProject } = await import("../src/init.js");
      const result = initProject(opts.input, {
        force: opts.force,
        theme: opts.theme || "default",
        title: opts.title || "Untitled deck",
        skeleton: opts.skeleton,
      });
      console.log(`Wrote ${result.deckPath}`);
      console.log(`theme=${result.theme}`);
      return;
    }

    if (opts.command === "from-outline") {
      if (!opts.output) {
        console.error("from-outline requires -o <project-dir>");
        process.exit(2);
      }
      const { projectFromOutline } = await import("../src/from-outline.js");
      const result = projectFromOutline(opts.input, opts.output, {
        force: opts.force,
        theme: opts.theme || "default",
      });
      console.log(`Wrote ${result.deckPath}`);
      console.log(`pages=${result.pageCount} title=${result.title}`);
      return;
    }

    if (opts.command === "pdf") {
      if (!opts.output) {
        console.error("pdf requires -o <out.pdf>");
        process.exit(2);
      }
      const { exportDeckPdf } = await import("../src/render-pdf.js");
      const result = await exportDeckPdf(opts.input, opts.output, {
        force: opts.force,
      });
      console.log(`Wrote ${result.outputPath}`);
      console.log(`pages=${result.pageCount}`);
      return;
    }

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
      validateDeck(deck, { projectRoot, checkMedia: true });
      console.log(`OK  ${sourcePath}`);
      console.log(
        `    pages=${deck.pages.length} size=${JSON.stringify(deck.size)}`,
      );
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
      const result = qaDeck(deck, {
        projectRoot,
        checkMedia: true,
        failOn: opts.failOn || "high",
      });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    }

    if (opts.command === "preview") {
      if (!opts.output) {
        console.error("preview requires -o <out.html>");
        process.exit(2);
      }
      const { writePreviewHtml } = await import("../src/preview.js");
      const out = writePreviewHtml(deck, projectRoot, opts.output, {
        force: opts.force,
        sourcePath,
      });
      console.log(`Wrote ${out}`);
      return;
    }
  } catch (err) {
    if (err instanceof OpenPptError) {
      console.error(`[${err.code}] ${err.message}`);
      process.exit(1);
    }
    console.error(
      err instanceof Error ? err.stack || err.message : String(err),
    );
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
