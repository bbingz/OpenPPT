#!/usr/bin/env bun

/**
 * Render-check: conversion smoke via headless LibreOffice plus pdfinfo page count.
 *
 * Converts every *.pptx found under the given paths to PDF and requires
 * pdfinfo to report a positive page count that matches the PPTX slide count.
 * Zero, unknown, or mismatched counts never PASS. This is not a full Office,
 * glyph, or editorial validation.
 *
 * Usage:
 *   bun scripts/render-check.js [--require] [--limit N] <file-or-dir> [...]
 *
 * Without --require the script exits 0 with a SKIP notice when LibreOffice
 * is not installed (local convenience); CI passes --require.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

import { findSoffice } from "../src/render-pdf.js";
import { libreOfficeChildEnv } from "../src/internal/libreoffice-env.js";

function collectPptx(paths, limit) {
  const found = [];
  const walk = (p) => {
    const stat = statSync(p);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(p)) walk(join(p, entry));
    } else if (p.toLowerCase().endsWith(".pptx")) {
      found.push(p);
    }
  };
  for (const p of paths) walk(resolve(p));
  found.sort();
  return limit ? found.slice(0, limit) : found;
}

async function slideCount(pptxPath) {
  const zip = await JSZip.loadAsync(readFileSync(pptxPath));
  return Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
}

/**
 * Reliable page count from pdfinfo. Never guess via PDF regex.
 * @param {string} pdfPath
 * @returns {{ ok: true, pages: number } | { ok: false, detail: string }}
 */
function inspectPdfPages(pdfPath) {
  let probe;
  try {
    probe = spawnSync(process.env.PDFINFO || "pdfinfo", [pdfPath], {
      encoding: "utf8",
      timeout: 15000,
    });
  } catch (err) {
    return {
      ok: false,
      detail: `pdfinfo error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (probe.error?.code === "ENOENT") {
    return {
      ok: false,
      detail: "pdfinfo not found — cannot verify page count (install poppler-utils)",
    };
  }
  if (probe.status !== 0) {
    const err = String(probe.stderr || probe.stdout || "pdfinfo failed").split("\n")[0];
    return { ok: false, detail: `pdfinfo failed: ${err}` };
  }
  const match = String(probe.stdout || "").match(/^Pages:\s+(\d+)\s*$/m);
  if (!match) {
    return { ok: false, detail: "pdfinfo did not report a page count" };
  }
  const pages = Number(match[1]);
  if (!Number.isInteger(pages) || pages <= 0) {
    return { ok: false, detail: `pdfinfo page count is ${pages}` };
  }
  return { ok: true, pages };
}

async function main() {
  const argv = process.argv.slice(2);
  const paths = [];
  let required = false;
  let limit = 0;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--require") required = true;
    else if (argv[i] === "--limit") { limit = Number(argv[i + 1]); i += 1; }
    else paths.push(argv[i]);
  }
  if (!paths.length) {
    console.error("usage: bun scripts/render-check.js [--require] [--limit N] <file-or-dir> [...]");
    process.exit(2);
  }

  const soffice = findSoffice();
  if (!soffice) {
    if (required) {
      console.error("LibreOffice (soffice) not found and --require was set");
      process.exit(1);
    }
    console.log("SKIP: LibreOffice (soffice) not installed — render check not run");
    return;
  }

  const files = collectPptx(paths, limit);
  if (!files.length) {
    console.error("no .pptx files found under given paths");
    process.exit(required ? 1 : 0);
  }

  const work = mkdtempSync(join(tmpdir(), "openppt-render-"));
  const profile = pathToFileURL(join(work, "lo-profile")).href;
  let failures = 0;

  console.log(`render-check via ${soffice} · ${files.length} file(s)\n`);
  for (const file of files) {
    const started = performance.now();
    let problem = null;
    try {
      execFileSync(
        soffice,
        [
          `-env:UserInstallation=${profile}`,
          "--headless", "--norestore", "--convert-to", "pdf",
          "--outdir", work,
          file,
        ],
        { stdio: "pipe", timeout: 120000, env: libreOfficeChildEnv() },
      );
      const pdfPath = join(work, `${basename(file, ".pptx")}.pdf`);
      if (!existsSync(pdfPath)) {
        problem = "no PDF produced";
      } else {
        const pdf = readFileSync(pdfPath);
        if (pdf.length < 1024) problem = `suspiciously small PDF (${pdf.length} B)`;
        else {
          const expected = await slideCount(file);
          const inspected = inspectPdfPages(pdfPath);
          if (!inspected.ok) {
            problem = inspected.detail;
          } else if (inspected.pages !== expected) {
            problem = `pdfinfo pages ${inspected.pages} != PPTX slides ${expected}`;
          }
        }
        rmSync(pdfPath, { force: true });
      }
    } catch (err) {
      problem = `conversion failed: ${err.message.split("\n")[0]}`;
    }
    const ms = Math.round(performance.now() - started);
    if (problem) {
      failures += 1;
      console.log(`[FAIL] ${file} — ${problem} (${ms}ms)`);
    } else {
      console.log(`[PASS] ${basename(file)} (${ms}ms)`);
    }
  }

  rmSync(work, { recursive: true, force: true });
  console.log(
    `\n${files.length - failures}/${files.length} files produced a PDF whose pdfinfo page count matched the PPTX slide count`,
  );
  console.log("Conversion smoke only — not full Office, glyph, or editorial validation.");
  if (failures > 0) process.exit(1);
}

main();
