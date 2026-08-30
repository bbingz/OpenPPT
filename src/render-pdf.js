/**
 * Optional PDF rendering via headless LibreOffice.
 *
 * OpenPPT's default export is PPTX-only with zero external tools. When a
 * LibreOffice installation is present (env SOFFICE, PATH soffice/libreoffice,
 * or the macOS app bundle), decks can additionally be rendered to PDF through
 * the same engine the nightly render check uses. Everything here fails closed
 * with typed errors and never becomes a hard dependency.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { OpenPptError, ErrorCodes } from "./errors.js";

const CONVERT_TIMEOUT_MS = 120000;
let cachedSoffice; // undefined = not probed yet; null = probed, absent

/**
 * Locate a usable LibreOffice binary, or return null.
 * Probe order: $SOFFICE, PATH (soffice, libreoffice), macOS app bundle.
 * @param {{ fresh?: boolean }} [options]
 * @returns {string | null}
 */
export function findSoffice(options = {}) {
  if (!options.fresh && cachedSoffice !== undefined) return cachedSoffice;
  cachedSoffice = probeSoffice();
  return cachedSoffice;
}

function probeSoffice() {
  const fromEnv = process.env.SOFFICE;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  for (const name of ["soffice", "libreoffice"]) {
    const probe = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 20000 });
    if (probe.status === 0) return name;
  }
  const macPath = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  if (existsSync(macPath)) return macPath;
  return null;
}

/**
 * Convert one PPTX to PDF with an isolated LibreOffice profile.
 * @param {string} pptxPath
 * @param {string} outputPath
 * @param {{ force?: boolean, soffice?: string }} [options]
 * @returns {string} resolved output path
 */
export function convertPptxToPdf(pptxPath, outputPath, options = {}) {
  const soffice = options.soffice || findSoffice();
  if (!soffice) {
    throw new OpenPptError(
      ErrorCodes.IO,
      "LibreOffice (soffice) not found — install LibreOffice or set SOFFICE to enable PDF export",
    );
  }
  const src = resolve(pptxPath);
  if (!existsSync(src)) {
    throw new OpenPptError(ErrorCodes.IO, `PPTX not found: ${src}`);
  }
  const out = resolve(outputPath);
  if (existsSync(out) && !options.force) {
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `Output already exists (pass force=true to overwrite): ${out}`,
    );
  }

  const work = mkdtempSync(join(tmpdir(), "openppt-pdf-"));
  try {
    const profile = pathToFileURL(join(work, "profile")).href;
    try {
      execFileSync(
        soffice,
        [
          `-env:UserInstallation=${profile}`,
          "--headless", "--norestore", "--convert-to", "pdf",
          "--outdir", work,
          src,
        ],
        { stdio: "pipe", timeout: CONVERT_TIMEOUT_MS },
      );
    } catch (err) {
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        `LibreOffice PDF conversion failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        { cause: err },
      );
    }
    const produced = join(work, `${basename(src, ".pptx")}.pdf`);
    if (!existsSync(produced)) {
      throw new OpenPptError(ErrorCodes.EXPORT, "LibreOffice produced no PDF output");
    }
    mkdirSync(dirname(out), { recursive: true });
    if (existsSync(out) && !options.force) {
      // re-check after the slow conversion; force semantics stay strict
      throw new OpenPptError(ErrorCodes.EXPORT, `Output already exists: ${out}`);
    }
    try {
      renameSync(produced, out);
    } catch (err) {
      if (err?.code !== "EXDEV") throw err;
      copyFileSync(produced, out);
    }
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * High-level: load deck file → validate → PPTX buffer → PDF.
 * @param {string} deckPath
 * @param {string} outputPath
 * @param {{ force?: boolean, soffice?: string }} [options]
 * @returns {Promise<{ outputPath: string, pageCount: number }>}
 */
export async function exportDeckPdf(deckPath, outputPath, options = {}) {
  const { loadDeck } = await import("./load.js");
  const { compileToBuffer } = await import("./compile.js");
  const out = resolve(outputPath);
  if (existsSync(out) && !options.force) {
    throw new OpenPptError(
      ErrorCodes.EXPORT,
      `Output already exists (pass force=true to overwrite): ${out}`,
    );
  }
  const { deck, projectRoot } = loadDeck(deckPath);
  const buffer = await compileToBuffer(deck, { projectRoot });
  const work = mkdtempSync(join(tmpdir(), "openppt-pdf-src-"));
  try {
    const pptxPath = join(work, "deck.pptx");
    writeFileSync(pptxPath, buffer);
    convertPptxToPdf(pptxPath, out, options);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { outputPath: out, pageCount: deck.pages.length };
}
