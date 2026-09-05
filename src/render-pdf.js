/**
 * Optional PDF rendering via headless LibreOffice.
 *
 * OpenPPT's default export is PPTX-only with zero external tools. When a
 * LibreOffice installation is present (env SOFFICE, PATH soffice/libreoffice,
 * or the macOS app bundle), decks can additionally be rendered to PDF through
 * the same engine the nightly render check uses. Everything here fails closed
 * with typed errors and never becomes a hard dependency.
 */

import { execFile, execFileSync, spawnSync } from "node:child_process";
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
import { libreOfficeChildEnv } from "./internal/libreoffice-env.js";

const CONVERT_TIMEOUT_MS = 120000;
/** Historical execFileSync default; keep async conversion output bounded. */
const CONVERT_MAX_BUFFER = 1024 * 1024;
const VERSION_MAX_BUFFER = 64 * 1024;
const VERSION_TIMEOUT_MS = 8000;
let cachedSoffice; // undefined = not probed yet; null = probed, absent
/** Shared in-flight discovery so concurrent meta/export.pdf share one probe. */
let inflightDiscovery = null;

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
function sofficeArgs(profile, work, src) {
  return [
    `-env:UserInstallation=${profile}`,
    "--headless",
    "--norestore",
    "--convert-to",
    "pdf",
    "--outdir",
    work,
    src,
  ];
}

function assertConvertible(pptxPath, outputPath, options) {
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
  return { src, out };
}

function requireSoffice(soffice) {
  if (!soffice) {
    throw new OpenPptError(
      ErrorCodes.IO,
      "LibreOffice (soffice) not found — install LibreOffice or set SOFFICE to enable PDF export",
    );
  }
  return soffice;
}

function installConvertedPdf(produced, out, force) {
  if (!existsSync(produced)) {
    throw new OpenPptError(ErrorCodes.EXPORT, "LibreOffice produced no PDF output");
  }
  mkdirSync(dirname(out), { recursive: true });
  if (existsSync(out) && !force) {
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
}

/**
 * Convert one PPTX to PDF with an isolated LibreOffice profile.
 * Synchronous public contract: returns the resolved output path.
 * @param {string} pptxPath
 * @param {string} outputPath
 * @param {{ force?: boolean, soffice?: string }} [options]
 * @returns {string} resolved output path
 */
export function convertPptxToPdf(pptxPath, outputPath, options = {}) {
  const soffice = requireSoffice(options.soffice || findSoffice());
  const { src, out } = assertConvertible(pptxPath, outputPath, options);
  const work = mkdtempSync(join(tmpdir(), "openppt-pdf-"));
  try {
    const profile = pathToFileURL(join(work, "profile")).href;
    try {
      execFileSync(soffice, sofficeArgs(profile, work, src), {
        stdio: "pipe",
        timeout: CONVERT_TIMEOUT_MS,
        maxBuffer: CONVERT_MAX_BUFFER,
        killSignal: "SIGKILL",
        env: libreOfficeChildEnv(),
      });
    } catch (err) {
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        `LibreOffice PDF conversion failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        { cause: err },
      );
    }
    return installConvertedPdf(
      join(work, `${basename(src, ".pptx")}.pdf`),
      out,
      Boolean(options.force),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Bounded execFile: hard-kill on timeout, cap stdout/stderr, discard buffers.
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeoutMs: number, maxBuffer?: number, env?: NodeJS.ProcessEnv }} limits
 * @returns {Promise<{ status: number, timedOut: boolean }>}
 */
function execFileHardTimeout(file, args, { timeoutMs, maxBuffer = CONVERT_MAX_BUFFER, env }) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer,
        killSignal: "SIGKILL",
        encoding: "buffer",
        windowsHide: true,
        ...(env ? { env } : {}),
      },
      (error, stdout, stderr) => {
        void stdout;
        void stderr;
        if (!error) {
          resolve({ status: 0, timedOut: false });
          return;
        }
        const timedOut =
          Boolean(error.killed) &&
          (error.signal === "SIGKILL" ||
            error.signal === "SIGTERM" ||
            error.code === "ETIMEDOUT");
        if (timedOut) {
          resolve({ status: 1, timedOut: true });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ status: error.code, timedOut: false });
          return;
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ status: 1, timedOut: false });
          return;
        }
        reject(error);
      },
    );
  });
}

async function sofficeVersionOk(cmd) {
  try {
    const result = await execFileHardTimeout(cmd, ["--version"], {
      timeoutMs: VERSION_TIMEOUT_MS,
      maxBuffer: VERSION_MAX_BUFFER,
    });
    return !result.timedOut && result.status === 0;
  } catch {
    return false;
  }
}

async function probeSofficeAsync() {
  const fromEnv = process.env.SOFFICE;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  for (const name of ["soffice", "libreoffice"]) {
    if (await sofficeVersionOk(name)) return name;
  }
  const macPath = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  if (existsSync(macPath)) return macPath;
  return null;
}

/**
 * Async LibreOffice discovery. Does not use spawnSync, so the event loop
 * stays free for health checks during a first PATH --version probe.
 * Concurrent callers share one in-flight probe.
 * @param {{ fresh?: boolean }} [options]
 * @returns {Promise<string | null>}
 */
export function findSofficeAsync(options = {}) {
  if (!options.fresh && cachedSoffice !== undefined) return Promise.resolve(cachedSoffice);
  if (!options.fresh && inflightDiscovery) return inflightDiscovery;
  const probe = probeSofficeAsync()
    .then((value) => {
      cachedSoffice = value;
      return value;
    })
    .finally(() => {
      if (inflightDiscovery === probe) inflightDiscovery = null;
    });
  inflightDiscovery = probe;
  return probe;
}

/**
 * Async PPTX→PDF conversion for Studio / exportDeckPdf.
 * Isolated profile, cleanup on success, nonzero, timeout, and missing output.
 * @param {string} pptxPath
 * @param {string} outputPath
 * @param {{ force?: boolean, soffice?: string, timeoutMs?: number, runConverter?: Function }} [options]
 * @returns {Promise<string>}
 */
export async function convertPptxToPdfAsync(pptxPath, outputPath, options = {}) {
  const soffice = requireSoffice(options.soffice || (await findSofficeAsync()));
  const { src, out } = assertConvertible(pptxPath, outputPath, options);
  const timeoutMs = options.timeoutMs ?? CONVERT_TIMEOUT_MS;
  const work = mkdtempSync(join(tmpdir(), "openppt-pdf-"));
  try {
    const profile = pathToFileURL(join(work, "profile")).href;
    const args = sofficeArgs(profile, work, src);
    const env = libreOfficeChildEnv();
    let result;
    try {
      result = options.runConverter
        ? await options.runConverter({ soffice, args, timeoutMs, work, src, env })
        : await execFileHardTimeout(soffice, args, { timeoutMs, env });
    } catch (err) {
      if (err instanceof OpenPptError) throw err;
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        `LibreOffice PDF conversion failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        { cause: err },
      );
    }
    if (result?.timedOut) {
      throw new OpenPptError(ErrorCodes.EXPORT, "LibreOffice PDF conversion timed out");
    }
    if (result && result.status !== 0 && result.status !== undefined) {
      throw new OpenPptError(
        ErrorCodes.EXPORT,
        `LibreOffice PDF conversion failed: exit ${result.status}`,
      );
    }
    return installConvertedPdf(
      join(work, `${basename(src, ".pptx")}.pdf`),
      out,
      Boolean(options.force),
    );
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
    await convertPptxToPdfAsync(pptxPath, out, options);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { outputPath: out, pageCount: deck.pages.length };
}
