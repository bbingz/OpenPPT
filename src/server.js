/**
 * OpenPPT Studio — local web workbench server (Bun.serve, no new deps).
 *
 * Serves the static UI in web/ plus a JSON API over project folders that stay
 * fully CLI-compatible: each project is a directory with deck.json + media/.
 * Binds 127.0.0.1 only; every path segment is allowlisted and containment-checked.
 */

import {
  cpSync,
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
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { OpenPptError, ErrorCodes } from "./errors.js";
import { loadDeck } from "./load.js";
import { validateDeck, sniffImageBytes } from "./validate.js";
import { compileToBuffer } from "./compile.js";
import { findSofficeAsync, convertPptxToPdfAsync } from "./render-pdf.js";
import { MEDIA_EXTENSIONS, extToSniff, contentTypeFor } from "./internal/media-types.js";
import { renderPreviewHtml } from "./preview.js";
import { qaDeck } from "./qa.js";
import { initProject } from "./init.js";
import { projectFromOutline } from "./from-outline.js";
import { importPptx } from "./import-pptx.js";
import { writeDeckFileAtomic } from "./project-write.js";
import { RESOURCE_LIMITS } from "./resource-limits.js";
import {
  AuthoringPatchError,
  applyAuthoringPatch,
  cloneJson,
  deckHasExternalPageRefs,
  parsePatchBody,
  serializeAuthoringDeck,
} from "./internal/authoring-patch.js";
import {
  ProjectEventError,
  SSE_LIMITS,
  createProjectEventHub,
  formatSseEvent,
} from "./internal/project-events.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MEDIA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const THEMES = ["default", "dark", "magazine", "report"];
const DECK_FILES = ["deck.json", "deck.yaml", "deck.yml"];
const DECK_SOURCE_MAX_BYTES = RESOURCE_LIMITS.totalStringBytes; // 8 MiB

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/authoring-source.js", {
    file: "authoring-source.js",
    type: "text/javascript; charset=utf-8",
    root: join(rootDir, "src/internal"),
  }],
  ["/workbench-lifecycle.js", {
    file: "workbench-lifecycle.js",
    type: "text/javascript; charset=utf-8",
    root: join(rootDir, "src/internal"),
  }],
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
  "frame-ancestors 'none'",
].join("; ");
const PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Exact Host authority for the bound loopback listener (host:port, IPv6 bracketed). */
function hostAuthority(hostname, port) {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `${host}:${port}`;
}

function assertAllowedHost(req, hostname, port, publicOrigin) {
  const expected = publicOrigin ? new URL(publicOrigin).host : hostAuthority(hostname, port).toLowerCase();
  const actual = (req.headers.get("host") || "").trim().toLowerCase();
  if (actual !== expected) {
    throw new HttpError(
      403,
      "FORBIDDEN_HOST",
      "Host header must match the Studio endpoint",
    );
  }
}

function assertAllowedOrigin(req, hostname, port, publicOrigin) {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return;
  const origin = req.headers.get("origin");
  if (origin == null || origin === "") return; // originless local CLI
  if (origin === "null") {
    throw new HttpError(403, "FORBIDDEN_ORIGIN", "null Origin is not allowed on mutations");
  }
  const allowed = publicOrigin || `http://${hostAuthority(hostname, port)}`;
  if (origin !== allowed) {
    throw new HttpError(
      403,
      "FORBIDDEN_ORIGIN",
      "Origin must match the Studio endpoint",
    );
  }
}

/** SSE is GET; still reject foreign/null Origin and cross-site fetch metadata. */
function assertAllowedSseAudience(req, hostname, port, publicOrigin) {
  const site = (req.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (site === "cross-site") {
    throw new HttpError(
      403,
      "FORBIDDEN_FETCH_SITE",
      "cross-site EventSource is not allowed",
    );
  }
  const origin = req.headers.get("origin");
  if (origin == null || origin === "") return;
  if (origin === "null") {
    throw new HttpError(403, "FORBIDDEN_ORIGIN", "null Origin is not allowed on SSE");
  }
  const allowed = publicOrigin || `http://${hostAuthority(hostname, port)}`;
  if (origin !== allowed) {
    throw new HttpError(
      403,
      "FORBIDDEN_ORIGIN",
      "Origin must match the Studio endpoint",
    );
  }
}

/** Strong validator for exact source bytes: quoted SHA-256 hex, never weak. */
function strongEtag(bytes) {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

function parseIfMatch(header) {
  if (header == null || !String(header).trim()) {
    throw new HttpError(
      428,
      "PRECONDITION_REQUIRED",
      "If-Match with a strong validator is required to save",
    );
  }
  const value = String(header).trim();
  if (value === "*" || /^W\//i.test(value)) {
    throw new HttpError(
      412,
      "PRECONDITION_FAILED",
      "If-Match must be a strong validator matching the current source",
    );
  }
  return value;
}

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
  if (err instanceof AuthoringPatchError) {
    return new HttpError(err.status, err.code, err.message, err.details || {});
  }
  if (err instanceof ProjectEventError) {
    return new HttpError(err.status, err.code, err.message, err.details || {});
  }
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
  if (!MEDIA_EXTENSIONS.has(ext)) {
    throw new HttpError(
      422,
      ErrorCodes.MEDIA_TYPE,
      `Unsupported media extension: ${name} (allowed: ${[...MEDIA_EXTENSIONS].join(", ")})`,
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
 * @param {{ port?: number, hostname?: string, publicOrigin?: string, dataDir?: string, soffice?: string | null }} [options]
 * @returns {{ server: object, url: string, port: number, hostname: string, dataDir: string, stop: () => void }}
 */
export function startWebServer(options = {}) {
  const publicOrigin = options.publicOrigin;
  if (publicOrigin !== undefined) {
    const parsed = new URL(publicOrigin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== publicOrigin) {
      throw new Error("publicOrigin must be an exact HTTP(S) origin without credentials, path, query or fragment");
    }
  }
  const hostname = options.hostname || "127.0.0.1";
  const port = options.port ?? 7357;
  const dataDir = resolve(options.dataDir || join(homedir(), ".openppt", "projects"));
  mkdirSync(dataDir, { recursive: true });
  const webDir = join(rootDir, "web");
  // Do not call sync findSoffice() here: PATH --version uses spawnSync and
  // would block start/health. Discovery is async on meta/export.pdf.
  const sofficeOverride = options.soffice;
  let pdfBusy = false;
  const eventHub = createProjectEventHub({ dataDir });

  async function handleApi(req, url, httpServer) {
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
        pdfAvailable: Boolean(
          sofficeOverride !== undefined ? sofficeOverride : await findSofficeAsync(),
        ),
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
          const sourceBytes = readFileSync(join(dir, deckFile));
          const source = sourceBytes.toString("utf8");
          const mediaDir = join(dir, "media");
          const media = [];
          if (existsSync(mediaDir)) {
            for (const entry of readdirSync(mediaDir, { withFileTypes: true })) {
              if (!entry.isFile() || entry.name.startsWith(".")) continue;
              if (!MEDIA_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
              media.push({
                name: entry.name,
                size: statSync(join(mediaDir, entry.name)).size,
              });
            }
          }
          return jsonResponse(
            {
              ...projectSummary(dataDir, id),
              source,
              media,
            },
            200,
            { ETag: strongEtag(Buffer.from(source, "utf8")) },
          );
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

      // GET /api/projects/:id/events — project-scoped filesystem SSE
      if (parts.length === 4 && sub === "events" && method === "GET") {
        assertAllowedSseAudience(req, hostname, server.port, publicOrigin);
        if (!existsSync(dir)) {
          throw new HttpError(404, "NOT_FOUND", `Project not found: ${id}`);
        }
        httpServer.timeout(req, 0);
        const encoder = new TextEncoder();
        const early = [];
        let sink = (name, data) => {
          early.push([name, data]);
        };
        const unsub = eventHub.subscribe(id, dir, (name, data) => sink(name, data));
        const maxFrames = SSE_LIMITS.maxBufferedEvents;
        const maxBytes = SSE_LIMITS.maxBufferedBytes;
        /** @type {Uint8Array[]} */
        const pending = [];
        let pendingBytes = 0;
        let closed = false;
        let heartbeat = null;
        /** @type {((this: AbortSignal, ev: Event) => void) | null} */
        let abortHandler = null;
        /** @type {ReadableStreamDefaultController | null} */
        let ctrl = null;
        let cleanup = () => {};

        const drain = (force = false) => {
          if (!ctrl || closed) return;
          while (pending.length) {
            if (!force && (ctrl.desiredSize === null || ctrl.desiredSize <= 0)) break;
            const frame = pending.shift();
            pendingBytes -= frame.byteLength;
            try {
              ctrl.enqueue(frame);
            } catch {
              cleanup();
              return;
            }
          }
        };

        const pushFrame = (bytes) => {
          if (closed) return false;
          if (pending.length >= maxFrames || pendingBytes + bytes.byteLength > maxBytes) {
            return false;
          }
          pending.push(bytes);
          pendingBytes += bytes.byteLength;
          drain(false);
          return true;
        };

        cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          if (abortHandler) {
            req.signal.removeEventListener("abort", abortHandler);
            abortHandler = null;
          }
          pending.length = 0;
          pendingBytes = 0;
          early.length = 0;
          unsub();
          try {
            ctrl?.close();
          } catch {
            // already closed
          }
        };

        const stream = new ReadableStream({
          start(controller) {
            ctrl = controller;
            sink = (name, data) => {
              if (closed) return;
              const frame = encoder.encode(formatSseEvent(name, data));
              if (!pushFrame(frame)) {
                cleanup();
                return;
              }
              if (name === "deleted" || name === "error") {
                drain(true);
                cleanup();
              }
            };
            for (const item of early) sink(item[0], item[1]);
            early.length = 0;
            if (closed) return;
            abortHandler = () => cleanup();
            req.signal.addEventListener("abort", abortHandler);
            heartbeat = setInterval(() => {
              if (closed) return;
              const beat = encoder.encode(": \n\n");
              if (!pushFrame(beat)) cleanup();
            }, SSE_LIMITS.heartbeatMs);
            drain(false);
          },
          pull() {
            drain(false);
          },
          cancel() {
            cleanup();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      // POST /api/projects/:id/duplicate — fork the whole project folder
      if (parts.length === 4 && sub === "duplicate" && method === "POST") {
        if (!findDeckFile(dir)) {
          throw new HttpError(404, "NOT_FOUND", `Project not found: ${id}`);
        }
        const raw = (await readBodyWithCap(req, 64 * 1024, "duplicate request")).toString("utf8");
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
        }
        const summary = projectSummary(dataDir, id);
        const title =
          (typeof body.title === "string" && body.title.trim()) ||
          `${summary?.title || id} copy`;
        const newId = requireProjectId(slugFromTitle(title));
        const newDir = join(dataDir, newId);
        assertInside(dataDir, newDir, "project");
        cpSync(dir, newDir, { recursive: true, errorOnExist: true, force: false });
        if (findDeckFile(newDir) === "deck.json") {
          try {
            const deck = JSON.parse(readFileSync(join(newDir, "deck.json"), "utf8"));
            deck.title = title;
            writeDeckFileAtomic(join(newDir, "deck.json"), `${JSON.stringify(deck, null, 2)}\n`, { force: true });
          } catch {
            // keep the copied deck as-is when it is not editable JSON
          }
        }
        return jsonResponse({ project: projectSummary(dataDir, newId) }, 201);
      }

      // PUT /api/projects/:id/deck — save deck source (must parse as JSON)
      if (parts.length === 4 && sub === "deck" && method === "PUT") {
        const deckFile = findDeckFile(dir);
        if (!deckFile) throw new HttpError(404, "NOT_FOUND", `Project not found: ${id}`);
        if (deckFile !== "deck.json") {
          throw new HttpError(400, "BAD_REQUEST", "Web editing supports deck.json projects only");
        }
        const claimed = parseIfMatch(req.headers.get("if-match"));
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
        const deckPath = join(dir, "deck.json");
        // Re-read current bytes after awaits, then write synchronously so two
        // cooperating PUTs from one version cannot both succeed. An external
        // CLI writer that replaces deck.json between this read and the atomic
        // rename remains a TOCTOU race outside the If-Match protocol.
        const currentBytes = readFileSync(deckPath);
        const currentTag = strongEtag(currentBytes);
        if (claimed !== currentTag) {
          throw new HttpError(
            412,
            "PRECONDITION_FAILED",
            "If-Match does not match the current source",
          );
        }
        writeDeckFileAtomic(deckPath, normalized, { force: true });
        const savedTag = strongEtag(Buffer.from(normalized, "utf8"));
        return jsonResponse(
          { ok: true, savedAt: new Date().toISOString() },
          200,
          { ETag: savedTag },
        );
      }

      // PATCH /api/projects/:id/deck — bounded authoring mutations
      if (parts.length === 4 && sub === "deck" && method === "PATCH") {
        const deckFile = findDeckFile(dir);
        if (!deckFile) throw new HttpError(404, "NOT_FOUND", `Project not found: ${id}`);
        if (deckFile !== "deck.json") {
          throw new HttpError(
            422,
            "UNSUPPORTED_EDIT",
            "PATCH cannot edit YAML decks; inline deck.json pages only. Use the CLI or convert to a single JSON file.",
            { deckFile },
          );
        }
        const contentType = (req.headers.get("content-type") || "").trim();
        const mediaType = contentType.split(";")[0].trim().toLowerCase();
        if (/\byaml\b|\byml\b/.test(contentType.toLowerCase())) {
          throw new HttpError(
            422,
            "UNSUPPORTED_EDIT",
            "PATCH accepts application/json only; YAML request bodies are not edited through this API.",
          );
        }
        if (mediaType !== "application/json") {
          throw new HttpError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "PATCH requires Content-Type application/json",
          );
        }
        const claimed = parseIfMatch(req.headers.get("if-match"));
        const buf = await readBodyWithCap(req, DECK_SOURCE_MAX_BYTES, "deck source");
        let requestBody;
        try {
          requestBody = JSON.parse(buf.toString("utf8"));
        } catch (err) {
          throw new HttpError(400, "BAD_REQUEST", `Request body must be JSON: ${err.message}`);
        }
        const operations = parsePatchBody(requestBody);
        const deckPath = join(dir, "deck.json");
        // Re-read after awaits so two cooperating PATCHes from one version
        // cannot both succeed. External CLI replacement between this read and
        // the atomic rename remains a TOCTOU race outside If-Match.
        const currentBytes = readFileSync(deckPath);
        const currentTag = strongEtag(currentBytes);
        if (claimed !== currentTag) {
          throw new HttpError(
            412,
            "PRECONDITION_FAILED",
            "If-Match does not match the current source",
          );
        }
        let authoring;
        try {
          authoring = JSON.parse(currentBytes.toString("utf8"));
        } catch (err) {
          throw new HttpError(422, ErrorCodes.SCHEMA, `deck.json is not valid JSON: ${err.message}`);
        }
        if (!authoring || typeof authoring !== "object" || Array.isArray(authoring)) {
          throw new HttpError(422, ErrorCodes.SCHEMA, "deck.json must be a JSON object");
        }
        if (deckHasExternalPageRefs(authoring)) {
          const pageIndex = authoring.pages.findIndex((page) => typeof page === "string");
          throw new HttpError(
            422,
            "UNSUPPORTED_EDIT",
            `PATCH cannot edit decks with external page files (pages[${pageIndex}]=${authoring.pages[pageIndex]}). Inline page objects in deck.json; multifile viewing and CLI still work.`,
            { pageIndex, pagePath: authoring.pages[pageIndex] },
          );
        }
        const next = applyAuthoringPatch(authoring, operations);
        validateDeck(cloneJson(next), { projectRoot: dir, checkMedia: true });
        const savedSource = serializeAuthoringDeck(next);
        const latestBytes = readFileSync(deckPath);
        if (claimed !== strongEtag(latestBytes)) {
          throw new HttpError(
            412,
            "PRECONDITION_FAILED",
            "If-Match does not match the current source",
          );
        }
        writeDeckFileAtomic(deckPath, savedSource, { force: true });
        const savedTag = strongEtag(Buffer.from(savedSource, "utf8"));
        return jsonResponse({ ok: true, source: savedSource }, 200, { ETag: savedTag });
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
        if (pdfBusy) {
          throw new HttpError(
            429,
            "PDF_BUSY",
            "A PDF conversion is already in progress on this server",
          );
        }
        pdfBusy = true;
        try {
          // Bun.serve default idleTimeout is 10s and counts silent in-flight
          // handlers; PDF conversion may run up to CONVERT_TIMEOUT_MS (120s).
          httpServer.timeout(req, 180);
          const work = mkdtempSync(join(tmpdir(), "openppt-studio-pdf-"));
          try {
            const sofficePath =
              sofficeOverride !== undefined ? sofficeOverride : await findSofficeAsync();
            if (!sofficePath) {
              throw new HttpError(
                501,
                "PDF_UNAVAILABLE",
                "LibreOffice (soffice) not found on this machine — install it or set SOFFICE to enable PDF export",
              );
            }
            const { deck, projectRoot } = loadProjectDeck(dataDir, id);
            const buffer = await compileToBuffer(deck, { projectRoot });
            const pptxPath = join(work, "deck.pptx");
            writeFileSync(pptxPath, buffer);
            const pdfPath = await convertPptxToPdfAsync(pptxPath, join(work, "deck.pdf"), {
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
        } finally {
          pdfBusy = false;
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
          if (!sniffed || sniffed !== extToSniff(ext)) {
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
                "Content-Type": contentTypeFor(ext) || "application/octet-stream",
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
    const base = entry.root || webDir;
    const filePath = join(base, entry.file);
    assertInside(base, filePath, "static");
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
    async fetch(req, httpServer) {
      const url = new URL(req.url);
      try {
        assertAllowedHost(req, hostname, server.port, publicOrigin);
        assertAllowedOrigin(req, hostname, server.port, publicOrigin);
        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          return await handleApi(req, url, httpServer);
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
    url: publicOrigin ? `${publicOrigin}/` : `http://${hostname}:${boundPort}/`,
    stop: () => {
      eventHub.close();
      server.stop(true);
    },
  };
}
