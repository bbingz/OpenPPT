/**
 * OpenPPT Studio — local web workbench server (Bun.serve, no new deps).
 *
 * Serves the static UI in web/ plus a JSON API over project folders that stay
 * fully CLI-compatible: each project is a directory with deck.json + media/.
 * Binds 127.0.0.1 only; every path segment is allowlisted and containment-checked.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { OpenPptError, ErrorCodes } from "./errors.js";
import { loadDeck } from "./load.js";
import { validateDeck, sniffImageBytes } from "./validate.js";
import { compileToBuffer } from "./compile.js";
import { findSoffice, convertPptxToPdf } from "./render-pdf.js";
import { renderPreviewHtml } from "./preview.js";
import { qaDeck } from "./qa.js";
import { initProject } from "./init.js";
import { projectFromOutline } from "./from-outline.js";
import { importPptx } from "./import-pptx.js";
import { writeDeckFileAtomic } from "./project-write.js";
import { RESOURCE_LIMITS } from "./resource-limits.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MEDIA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MEDIA_EXT_TO_SNIFF = new Map([
  [".png", "png"],
  [".jpg", "jpg"],
  [".jpeg", "jpg"],
  [".gif", "gif"],
  [".webp", "webp"],
  [".svg", "svg"],
]);
const MEDIA_CONTENT_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);
const THEMES = ["default", "dark", "magazine", "report"];
const DECK_FILES = ["deck.json", "deck.yaml", "deck.yml"];
const DECK_SOURCE_MAX_BYTES = RESOURCE_LIMITS.totalStringBytes; // 8 MiB

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/favicon.svg", { file: "favicon.svg", type: "image/svg+xml" }],
]);

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");
const PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ERROR_STATUS = new Map([
  [ErrorCodes.SCHEMA, 422],
  [ErrorCodes.BOUNDS, 422],
  [ErrorCodes.MEDIA_MISSING, 422],
  [ErrorCodes.MEDIA_TYPE, 422],
  [ErrorCodes.THEME_COLOR, 422],
  [ErrorCodes.RESOURCE_LIMIT, 422],
  [ErrorCodes.LAYOUT, 422],
  [ErrorCodes.ALREADY_EXISTS, 409],
  [ErrorCodes.IO, 404],
  [ErrorCodes.EXPORT, 500],
]);

function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof OpenPptError) {
    return new HttpError(
      ERROR_STATUS.get(err.code) || 500,
      err.code,
      err.message,
      err.details || {},
    );
  }
  return new HttpError(
    500,
    "INTERNAL",
    err instanceof Error ? err.message : String(err),
  );
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function errorResponse(err) {
  const httpErr = toHttpError(err);
  return jsonResponse(
    {
      error: {
        code: httpErr.code,
        message: httpErr.message,
        details: httpErr.details,
      },
    },
    httpErr.status,
  );
}

/** Reject any resolved path that escapes the base directory. */
function assertInside(baseDir, candidate, label) {
  const rel = relative(resolve(baseDir), resolve(candidate));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes(`..${sep}`)) {
    throw new HttpError(400, "BAD_PATH", `Unsafe ${label} path`);
  }
}

function slugFromTitle(title) {
  const base = String(title || "deck")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stem = base && /^[a-z0-9]/.test(base) ? base : "deck";
  return `${stem}-${randomBytes(3).toString("hex")}`;
}

function requireProjectId(id) {
  if (typeof id !== "string" || !PROJECT_ID_RE.test(id)) {
    throw new HttpError(400, "BAD_PROJECT_ID", `Invalid project id: ${id}`);
  }
  return id;
}

function requireMediaName(name) {
  if (typeof name !== "string" || !MEDIA_NAME_RE.test(name) || name.includes("..")) {
    throw new HttpError(400, "BAD_MEDIA_NAME", `Invalid media name: ${name}`);
  }
  const ext = extname(name).toLowerCase();
  if (!MEDIA_EXT_TO_SNIFF.has(ext)) {
    throw new HttpError(
      422,
      ErrorCodes.MEDIA_TYPE,
      `Unsupported media extension: ${name} (allowed: ${[...MEDIA_EXT_TO_SNIFF.keys()].join(", ")})`,
    );
  }
  return { name: basename(name), ext };
}

async function readBodyWithCap(req, capBytes, label) {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > capBytes) {
    throw new HttpError(
      413,
      ErrorCodes.RESOURCE_LIMIT,
      `${label} exceeds ${capBytes} bytes`,
    );
  }
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > capBytes) {
    throw new HttpError(
      413,
      ErrorCodes.RESOURCE_LIMIT,
      `${label} exceeds ${capBytes} bytes`,
    );
  }
  return buf;
}

async function readUploadFile(req, capBytes, label) {
  const declared = Number(req.headers.get("content-length") || 0);
  // multipart framing adds overhead; allow a small envelope margin
  if (declared > capBytes + 64 * 1024) {
    throw new HttpError(
      413,
      ErrorCodes.RESOURCE_LIMIT,
      `${label} exceeds ${capBytes} bytes`,
    );
  }
  let form;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "BAD_UPLOAD", "Expected multipart/form-data with a file field");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    throw new HttpError(400, "BAD_UPLOAD", "Missing file field");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > capBytes) {
    throw new HttpError(
      413,
      ErrorCodes.RESOURCE_LIMIT,
      `${label} exceeds ${capBytes} bytes`,
    );
  }
  return { fileName: file.name || "", bytes, form };
}

function findDeckFile(projectDir) {
  for (const name of DECK_FILES) {
    if (existsSync(join(projectDir, name))) return name;
  }
  return null;
}

function projectSummary(dataDir, id) {
  const dir = join(dataDir, id);
  const deckFile = findDeckFile(dir);
  if (!deckFile) return null;
  const deckPath = join(dir, deckFile);
  let title = id;
  let pages = null;
  if (deckFile === "deck.json") {
    try {
      const deck = JSON.parse(readFileSync(deckPath, "utf8"));
      if (typeof deck?.title === "string" && deck.title.trim()) title = deck.title;
      if (Array.isArray(deck?.pages)) pages = deck.pages.length;
    } catch {
      // draft with broken JSON still lists; workbench will surface the error
    }
  }
  let updatedAt = null;
  try {
    updatedAt = statSync(deckPath).mtime.toISOString();
  } catch {
    // stat raced with delete; keep null
  }
  return { id, title, pages, deckFile, updatedAt };
}

function loadProjectDeck(dataDir, id) {
  const dir = join(dataDir, id);
  assertInside(dataDir, dir, "project");
  const deckFile = findDeckFile(dir);
  if (!deckFile) {
    throw new HttpError(404, "NOT_FOUND", `Project not found: ${id}`);
  }
  return { dir, deckFile, ...loadDeck(join(dir, deckFile)) };
}

function uniqueMediaPath(mediaDir, name, ext) {
  let candidate = name;
  let n = 1;
  const stem = name.slice(0, name.length - ext.length);
  while (existsSync(join(mediaDir, candidate))) {
    n += 1;
    candidate = `${stem}-${n}${ext}`;
    if (n > 9999) throw new HttpError(409, ErrorCodes.ALREADY_EXISTS, "Too many name collisions");
  }
  return { path: join(mediaDir, candidate), name: candidate };
}

/**
 * Start the local OpenPPT Studio server.
 * @param {{ port?: number, hostname?: string, dataDir?: string }} [options]
 * @returns {{ server: object, url: string, port: number, hostname: string, dataDir: string, stop: () => void }}
 */
export function startWebServer(options = {}) {
  const hostname = options.hostname || "127.0.0.1";
  const port = options.port ?? 7357;
  const dataDir = resolve(options.dataDir || join(homedir(), ".openppt", "projects"));
  mkdirSync(dataDir, { recursive: true });
  const webDir = join(rootDir, "web");
  const sofficePath = findSoffice();

  async function handleApi(req, url) {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    const method = req.method.toUpperCase();

    // GET /api/health · /api/meta
    if (parts.length === 2 && method === "GET" && parts[1] === "health") {
      return jsonResponse({ ok: true, version: pkg.version });
    }
    if (parts.length === 2 && method === "GET" && parts[1] === "meta") {
      return jsonResponse({
        version: pkg.version,
        themes: THEMES,
        dataDir,
        pdfAvailable: Boolean(sofficePath),
        limits: {
          mediaBytesPerFile: RESOURCE_LIMITS.mediaBytesPerFile,
          mediaBytesPerDeck: RESOURCE_LIMITS.mediaBytesPerDeck,
          pptxArchiveBytes: RESOURCE_LIMITS.pptxArchiveBytes,
          deckSourceBytes: DECK_SOURCE_MAX_BYTES,
        },
      });
    }

    // /api/projects
    if (parts[1] === "projects" && parts.length === 2) {
      if (method === "GET") {
        const items = [];
        for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || !PROJECT_ID_RE.test(entry.name)) continue;
          const summary = projectSummary(dataDir, entry.name);
          if (summary) items.push(summary);
        }
        items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        return jsonResponse({ projects: items });
      }
      if (method === "POST") {
        const raw = (await readBodyWithCap(req, 1024 * 1024, "create request")).toString("utf8");
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
        }
        const mode = body.mode || "blank";
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Untitled deck";
        const theme = THEMES.includes(body.theme) ? body.theme : "default";
        const id = requireProjectId(slugFromTitle(title));
        const dir = join(dataDir, id);
        assertInside(dataDir, dir, "project");
        if (mode === "blank" || mode === "skeleton") {
          initProject(dir, { title, theme, skeleton: mode === "skeleton" });
        } else if (mode === "outline") {
          if (typeof body.outline !== "string" || !body.outline.trim()) {
            throw new HttpError(400, "BAD_REQUEST", "outline mode requires outline markdown text");
          }
          const tmp = mkdtempSync(join(tmpdir(), "openppt-outline-"));
          try {
            const mdPath = join(tmp, "outline.md");
            writeFileSync(mdPath, body.outline, "utf8");
            projectFromOutline(mdPath, dir, { theme });
          } finally {
            rmSync(tmp, { recursive: true, force: true });
          }
        } else {
          throw new HttpError(400, "BAD_REQUEST", `Unknown mode: ${mode}`);
        }
        return jsonResponse({ project: projectSummary(dataDir, id) }, 201);
      }
    }

    // POST /api/import — upload a PPTX, lossy-import into a new project
    if (parts.length === 2 && parts[1] === "import" && method === "POST") {
      const { fileName, bytes, form } = await readUploadFile(
        req,
        RESOURCE_LIMITS.pptxArchiveBytes,
        "PPTX upload",
      );
      const titleField = form.get("title");
      const baseTitle =
        (typeof titleField === "string" && titleField.trim()) ||
        basename(fileName || "imported", extname(fileName || "")) ||
        "imported";
      const id = requireProjectId(slugFromTitle(baseTitle));
      const dir = join(dataDir, id);
      assertInside(dataDir, dir, "project");
      const tmp = mkdtempSync(join(tmpdir(), "openppt-upload-"));
      try {
        const pptxPath = join(tmp, "upload.pptx");
        writeFileSync(pptxPath, bytes);
        const result = await importPptx(pptxPath, dir, { force: false });
        return jsonResponse(
          {
            project: projectSummary(dataDir, id),
            pageCount: result.pageCount,
            warnings: result.warnings,
          },
          201,
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    // /api/projects/:id[/...]
    if (parts[1] === "projects" && parts.length >= 3) {
      const id = requireProjectId(parts[2]);
      const dir = join(dataDir, id);
      assertInside(dataDir, dir, "project");

      if (parts.length === 3) {
        if (method === "GET") {
          const deckFile = findDeckFile(dir);
          if (!deckFile) throw new HttpError(404, "NOT_FOUND", `Project not found: ${id}`);
          const source = readFileSync(join(dir, deckFile), "utf8");
          const mediaDir = join(dir, "media");
          const media = [];
          if (existsSync(mediaDir)) {
            for (const entry of readdirSync(mediaDir, { withFileTypes: true })) {
              if (!entry.isFile() || entry.name.startsWith(".")) continue;
              if (!MEDIA_EXT_TO_SNIFF.has(extname(entry.name).toLowerCase())) continue;
              media.push({
                name: entry.name,
                size: statSync(join(mediaDir, entry.name)).size,
              });
            }
          }
          return jsonResponse({
            ...projectSummary(dataDir, id),
            source,
            media,
          });
        }
        if (method === "DELETE") {
          if (!findDeckFile(dir)) {
            throw new HttpError(404, "NOT_FOUND", `Project not found: ${id}`);
          }
          rmSync(dir, { recursive: true, force: true });
          return jsonResponse({ ok: true });
        }
      }

      const sub = parts[3];

      // PUT /api/projects/:id/deck — save deck source (must parse as JSON)
      if (parts.length === 4 && sub === "deck" && method === "PUT") {
        const deckFile = findDeckFile(dir);
        if (!deckFile) throw new HttpError(404, "NOT_FOUND", `Project not found: ${id}`);
        if (deckFile !== "deck.json") {
          throw new HttpError(400, "BAD_REQUEST", "Web editing supports deck.json projects only");
        }
        const buf = await readBodyWithCap(req, DECK_SOURCE_MAX_BYTES, "deck source");
        const source = buf.toString("utf8");
        let parsed;
        try {
          parsed = JSON.parse(source);
        } catch (err) {
          throw new HttpError(422, ErrorCodes.SCHEMA, `deck.json is not valid JSON: ${err.message}`);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new HttpError(422, ErrorCodes.SCHEMA, "deck.json must be a JSON object");
        }
        const normalized = source.endsWith("\n") ? source : `${source}\n`;
        writeDeckFileAtomic(join(dir, "deck.json"), normalized, { force: true });
        return jsonResponse({ ok: true, savedAt: new Date().toISOString() });
      }

      // POST /api/projects/:id/validate
      if (parts.length === 4 && sub === "validate" && method === "POST") {
        try {
          const { dir: projDir, deck, projectRoot } = loadProjectDeck(dataDir, id);
          void projDir;
          const { deck: validated } = validateDeck(deck, { projectRoot, checkMedia: true });
          return jsonResponse({
            ok: true,
            pages: validated.pages.length,
            size: validated.size,
          });
        } catch (err) {
          const httpErr = toHttpError(err);
          if (httpErr.status >= 500 || httpErr.status === 404) throw err;
          return jsonResponse(
            { ok: false, error: { code: httpErr.code, message: httpErr.message, details: httpErr.details } },
            200,
          );
        }
      }

      // GET /api/projects/:id/preview
      if (parts.length === 4 && sub === "preview" && method === "GET") {
        const { deck, projectRoot } = loadProjectDeck(dataDir, id);
        const html = renderPreviewHtml(deck, projectRoot);
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": PREVIEW_CSP,
          },
        });
      }

      // GET /api/projects/:id/qa[?failOn=...]
      if (parts.length === 4 && sub === "qa" && method === "GET") {
        const failOn = url.searchParams.get("failOn") || "high";
        if (!["low", "med", "high", "critical"].includes(failOn)) {
          throw new HttpError(400, "BAD_REQUEST", "failOn must be low|med|high|critical");
        }
        const { deck, projectRoot } = loadProjectDeck(dataDir, id);
        const result = qaDeck(deck, { projectRoot, checkMedia: true, failOn });
        return jsonResponse(result);
      }

      // GET /api/projects/:id/export
      if (parts.length === 4 && sub === "export" && method === "GET") {
        const { deck, projectRoot } = loadProjectDeck(dataDir, id);
        const buffer = await compileToBuffer(deck, { projectRoot });
        return new Response(buffer, {
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "Content-Disposition": `attachment; filename="${id}.pptx"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      // GET /api/projects/:id/export.pdf — optional LibreOffice rendering
      if (parts.length === 4 && sub === "export.pdf" && method === "GET") {
        if (!sofficePath) {
          throw new HttpError(
            501,
            "PDF_UNAVAILABLE",
            "LibreOffice (soffice) not found on this machine — install it or set SOFFICE to enable PDF export",
          );
        }
        const { deck, projectRoot } = loadProjectDeck(dataDir, id);
        const buffer = await compileToBuffer(deck, { projectRoot });
        const work = mkdtempSync(join(tmpdir(), "openppt-studio-pdf-"));
        try {
          const pptxPath = join(work, "deck.pptx");
          writeFileSync(pptxPath, buffer);
          const pdfPath = convertPptxToPdf(pptxPath, join(work, "deck.pdf"), {
            force: true,
            soffice: sofficePath,
          });
          return new Response(readFileSync(pdfPath), {
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="${id}.pdf"`,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      }

      // /api/projects/:id/media[/:name]
      if (sub === "media") {
        const mediaDir = join(dir, "media");
        if (parts.length === 4 && method === "POST") {
          if (!findDeckFile(dir)) {
            throw new HttpError(404, "NOT_FOUND", `Project not found: ${id}`);
          }
          const { fileName, bytes } = await readUploadFile(
            req,
            RESOURCE_LIMITS.mediaBytesPerFile,
            "media upload",
          );
          const { name, ext } = requireMediaName(basename(fileName || ""));
          const sniffed = sniffImageBytes(bytes);
          if (!sniffed || sniffed !== MEDIA_EXT_TO_SNIFF.get(ext)) {
            throw new HttpError(
              422,
              ErrorCodes.MEDIA_TYPE,
              `File content does not match ${ext} (sniffed: ${sniffed || "unknown"})`,
            );
          }
          mkdirSync(mediaDir, { recursive: true });
          const target = uniqueMediaPath(mediaDir, name, ext);
          assertInside(mediaDir, target.path, "media");
          writeFileSync(target.path, bytes, { flag: "wx" });
          return jsonResponse(
            { name: target.name, size: bytes.length, src: `media/${target.name}` },
            201,
          );
        }
        if (parts.length === 5) {
          const { name } = requireMediaName(parts[4]);
          const filePath = join(mediaDir, name);
          assertInside(mediaDir, filePath, "media");
          if (method === "GET") {
            if (!existsSync(filePath)) throw new HttpError(404, "NOT_FOUND", `No media: ${name}`);
            const ext = extname(name).toLowerCase();
            return new Response(readFileSync(filePath), {
              headers: {
                "Content-Type": MEDIA_CONTENT_TYPES.get(ext) || "application/octet-stream",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'",
              },
            });
          }
          if (method === "DELETE") {
            if (!existsSync(filePath)) throw new HttpError(404, "NOT_FOUND", `No media: ${name}`);
            unlinkSync(filePath);
            return jsonResponse({ ok: true });
          }
        }
      }
    }

    throw new HttpError(404, "NOT_FOUND", `No route: ${method} ${url.pathname}`);
  }

  function handleStatic(url) {
    const entry = STATIC_FILES.get(url.pathname);
    if (!entry) return null;
    const filePath = join(webDir, entry.file);
    assertInside(webDir, filePath, "static");
    if (!existsSync(filePath)) return null;
    const headers = {
      "Content-Type": entry.type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (entry.type.startsWith("text/html")) {
      headers["Content-Security-Policy"] = APP_CSP;
    }
    return new Response(readFileSync(filePath), { headers });
  }

  const server = Bun.serve({
    hostname,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          return await handleApi(req, url);
        }
        const staticResponse = handleStatic(url);
        if (staticResponse) return staticResponse;
        throw new HttpError(404, "NOT_FOUND", `No route: ${url.pathname}`);
      } catch (err) {
        return errorResponse(err);
      }
    },
  });

  const boundPort = server.port;
  return {
    server,
    hostname,
    port: boundPort,
    dataDir,
    url: `http://${hostname}:${boundPort}/`,
    stop: () => server.stop(true),
  };
}
