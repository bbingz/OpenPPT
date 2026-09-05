import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import JSZip from "jszip";

import { startWebServer } from "../src/index.js";
import { exportDeckFile } from "../src/index.js";

const posix = process.platform !== "win32";

/** Minimal valid 1x1 PNG (transparent). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Real 1x1 JFIF JPEG (SOI/APP0/DQT/SOF0/DHT/SOS/EOI); `file` and sips accept it. */
const JPEG_1X1 = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb00430001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101ffc0000b080001000101011100ffc40014100000000000000000000000000000000000ffda00080001000100003f007fffd9",
  "hex",
);

let ctx;

function api(path, options) {
  return fetch(`${ctx.url.replace(/\/$/, "")}${path}`, options);
}

async function apiJson(path, options) {
  const res = await api(path, options);
  const body = await res.json();
  return { res, body };
}

async function etagOf(id) {
  const res = await api(`/api/projects/${id}`);
  const etag = res.headers.get("etag");
  await res.json();
  return etag;
}

async function putDeck(id, body, headers = {}) {
  const etag = headers["If-Match"] === undefined ? await etagOf(id) : headers["If-Match"];
  const nextHeaders = { ...headers };
  if (etag) nextHeaders["If-Match"] = etag;
  else delete nextHeaders["If-Match"];
  return apiJson(`/api/projects/${id}/deck`, {
    method: "PUT",
    headers: nextHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validDeck(title = "Server test deck") {
  return {
    version: "openppt-1",
    title,
    size: [960, 540],
    theme: { colors: { primary: "#2563EB", background: "#FFFFFF" } },
    pages: [
      {
        id: "p1",
        background: { type: "solid", color: "$background" },
        elements: [
          {
            id: "t1",
            type: "text",
            bounds: [60, 200, 840, 60],
            text: "Hello Studio",
            fontSize: 32,
            color: "$primary",
            align: "center",
          },
        ],
      },
    ],
  };
}

beforeAll(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "openppt-server-data-"));
  ctx = startWebServer({ port: 0, dataDir });
});

afterAll(() => {
  ctx.stop();
  rmSync(ctx.dataDir, { recursive: true, force: true });
});

describe("web server", () => {
  test("binds loopback only and serves health/meta", async () => {
    expect(ctx.hostname).toBe("127.0.0.1");
    const { res, body } = await apiJson("/api/health");
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const meta = await apiJson("/api/meta");
    expect(meta.body.themes).toContain("magazine");
    expect(meta.body.limits.mediaBytesPerFile).toBeGreaterThan(0);
  });

  test("serves the static app shell with CSP and rejects unknown paths", async () => {
    const res = await api("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toContain("OpenPPT Studio");

    const miss = await api("/does-not-exist.js");
    expect(miss.status).toBe(404);
    const traversal = await api("/..%2Fpackage.json");
    expect(traversal.status).toBe(404);
  });

  test("rejects foreign Host on every request and foreign/null Origin on mutations", async () => {
    const origin = ctx.url.replace(/\/$/, "");
    const allowedHost = `${ctx.hostname}:${ctx.port}`;
    const wrongPort = ctx.port === 65000 ? 65001 : 65000;

    for (const Host of [
      `foreign.invalid:${ctx.port}`,
      `127.0.0.1:${wrongPort}`,
      `127.0.0.1.evil.invalid:${ctx.port}`,
    ]) {
      const res = await api("/api/health", { headers: { Host } });
      expect(`${Host}:${res.status}`).toBe(`${Host}:403`);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN_HOST");
    }

    const healthy = await api("/api/health", { headers: { Host: allowedHost } });
    expect(healthy.status).toBe(200);

    for (const Origin of ["https://foreign.invalid", "null", `${origin}.evil.invalid`]) {
      const res = await api("/api/projects", {
        method: "POST",
        headers: { Origin, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "blank", title: "Rejected source" }),
      });
      expect(`${Origin}:${res.status}`).toBe(`${Origin}:403`);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN_ORIGIN");
    }

    const sameOrigin = await apiJson("/api/projects", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "blank", title: "Same origin allowed" }),
    });
    expect(sameOrigin.res.status).toBe(201);
    expect(sameOrigin.body.project.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);

    const originless = await apiJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "blank", title: "CLI originless allowed" }),
    });
    expect(originless.res.status).toBe(201);

    const cors = sameOrigin.res.headers.get("access-control-allow-origin");
    expect(cors === null || cors === origin).toBe(true);
    expect(cors).not.toBe("*");
  });

  test("app CSP forbids framing while preview allows same-origin iframe ancestors", async () => {
    const shell = await api("/");
    expect(shell.headers.get("content-security-policy")).toMatch(/frame-ancestors\s+'none'/);

    const created = await apiJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "blank", title: "CSP preview", theme: "default" }),
    });
    expect(created.res.status).toBe(201);
    const preview = await api(`/api/projects/${created.body.project.id}/preview`);
    expect(preview.status).toBe(200);
    const csp = preview.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/frame-ancestors\s+'self'/);
    expect(csp).not.toMatch(/frame-ancestors\s+'none'/);
    expect(csp).not.toMatch(/frame-ancestors\s+\*/);
  });

  test("GET source ETag is a strong content hash and PUT requires matching If-Match", async () => {
    const origin = ctx.url.replace(/\/$/, "");
    const created = await apiJson("/api/projects", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "blank", title: "ETag project" }),
    });
    expect(created.res.status).toBe(201);
    const id = created.body.project.id;
    const deckPath = join(ctx.dataDir, id, "deck.json");

    const detail = await api(`/api/projects/${id}`);
    expect(detail.status).toBe(200);
    const etag = detail.headers.get("etag");
    const body = await detail.json();
    const onDisk = readFileSync(deckPath);
    expect(body.source).toBe(onDisk.toString("utf8"));
    expect(etag).toBeTruthy();
    expect(etag.startsWith("W/")).toBe(false);
    const expected = `"${createHash("sha256").update(Buffer.from(body.source)).digest("hex")}"`;
    expect(etag).toBe(expected);

    const initial = JSON.parse(body.source);
    const put = (value, tag, extra = {}) =>
      api(`/api/projects/${id}/deck`, {
        method: "PUT",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(tag ? { "If-Match": tag } : {}),
          ...extra,
        },
        body: JSON.stringify(value),
      });

    expect((await put(initial)).status).toBe(428);
    expect((await put(initial, "*")).status).toBe(412);
    expect((await put(initial, `W/${etag}`)).status).toBe(412);
    expect(readFileSync(deckPath, "utf8")).toBe(body.source);

    const pairs = await Promise.all([
      put({ ...initial, title: "Winner A" }, etag),
      put({ ...initial, title: "Winner B" }, etag),
    ]);
    expect(pairs.map((r) => r.status).sort()).toEqual([200, 412]);
    const winner = pairs.find((r) => r.status === 200);
    const nextTag = winner.headers.get("etag");
    expect(nextTag).toBeTruthy();
    expect(nextTag).not.toBe(etag);
    const winnerBody = await winner.json();
    expect(winnerBody.ok).toBe(true);

    const reread = await api(`/api/projects/${id}`);
    expect(reread.headers.get("etag")).toBe(nextTag);
    const afterWin = await reread.json();
    const diskAfter = readFileSync(deckPath);
    expect(afterWin.source).toBe(diskAfter.toString("utf8"));
    expect(nextTag).toBe(
      `"${createHash("sha256").update(Buffer.from(afterWin.source)).digest("hex")}"`,
    );

    writeFileSync(deckPath, `${diskAfter.toString("utf8")}\n`);
    const formatting = await api(`/api/projects/${id}`);
    const formatTag = formatting.headers.get("etag");
    expect(formatTag).not.toBe(nextTag);
    await formatting.json();

    const stale = await put(initial, nextTag);
    expect(stale.status).toBe(412);
    expect(readFileSync(deckPath, "utf8")).toBe(`${diskAfter.toString("utf8")}\n`);
  });

  let projectId;

  test("creates a blank project and lists it", async () => {
    const { res, body } = await apiJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "blank", title: "Server Test", theme: "default" }),
    });
    expect(res.status).toBe(201);
    projectId = body.project.id;
    expect(projectId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(existsSync(join(ctx.dataDir, projectId, "deck.json"))).toBe(true);

    const list = await apiJson("/api/projects");
    expect(list.body.projects.map((p) => p.id)).toContain(projectId);

    const detail = await apiJson(`/api/projects/${projectId}`);
    expect(detail.res.status).toBe(200);
    expect(() => JSON.parse(detail.body.source)).not.toThrow();
  });

  test("creates a project from a markdown outline", async () => {
    const { res, body } = await apiJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "outline",
        title: "Outline Flow",
        theme: "report",
        outline: "# Outline Flow\n## First\n- a\n- b\n## Second\n- c\n",
      }),
    });
    expect(res.status).toBe(201);
    expect(body.project.pages).toBeGreaterThanOrEqual(2);
  });

  test("rejects invalid project ids and traversal media names", async () => {
    // literal ../ is normalized away by URL parsing before routing (safe: 404)
    const normalized = await api("/api/projects/../../etc");
    expect(normalized.status).toBe(404);
    // percent-encoded traversal reaches the router as one segment → 400
    const bad = await apiJson("/api/projects/%2e%2e%2fetc");
    expect(bad.res.status).toBe(400);
    const badCase = await apiJson("/api/projects/Not-A-Slug");
    expect(badCase.res.status).toBe(400);
    const badMedia = await api(`/api/projects/${projectId}/media/..%2Fdeck.json`);
    expect(badMedia.status).toBe(400);
    const dotted = await api(`/api/projects/${projectId}/media/.hidden.png`);
    expect(dotted.status).toBe(400);
  });

  test("PUT deck rejects broken JSON without touching the file", async () => {
    const before = readFileSync(join(ctx.dataDir, projectId, "deck.json"), "utf8");
    const { res, body } = await putDeck(projectId, "{ not json");
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("SCHEMA_INVALID");
    const after = readFileSync(join(ctx.dataDir, projectId, "deck.json"), "utf8");
    expect(after).toBe(before);
  });

  test("PUT deck saves and validate endpoint reports fail-closed errors", async () => {
    const good = validDeck();
    let put = await putDeck(projectId, JSON.stringify(good, null, 2));
    expect(put.res.status).toBe(200);
    expect(put.res.headers.get("etag")).toBeTruthy();

    let check = await apiJson(`/api/projects/${projectId}/validate`, { method: "POST" });
    expect(check.body.ok).toBe(true);
    expect(check.body.pages).toBe(1);

    const broken = validDeck();
    broken.pages[0].elements[0].fontSize = 1e308; // round-five H1 regression via HTTP
    put = await putDeck(projectId, JSON.stringify(broken));
    expect(put.res.status).toBe(200);
    check = await apiJson(`/api/projects/${projectId}/validate`, { method: "POST" });
    expect(check.res.status).toBe(200);
    expect(check.body.ok).toBe(false);
    expect(check.body.error.code).toBe("SCHEMA_INVALID");

    // restore a valid deck for the following tests
    put = await putDeck(projectId, JSON.stringify(good, null, 2));
    expect(put.res.status).toBe(200);
  });

  test("preview escapes user text and ships a strict CSP", async () => {
    const deck = validDeck('XSS <script>alert(1)</script> "quoted"');
    deck.pages[0].elements[0].text = '</div><script>alert(2)</script>';
    const put = await putDeck(projectId, JSON.stringify(deck));
    expect(put.res.status).toBe(200);

    const res = await api(`/api/projects/${projectId}/preview`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  test("qa endpoint returns issues payload", async () => {
    const { res, body } = await apiJson(`/api/projects/${projectId}/qa?failOn=high`);
    expect(res.status).toBe(200);
    expect(typeof body.ok).toBe("boolean");
    expect(Array.isArray(body.issues)).toBe(true);
    const bad = await api(`/api/projects/${projectId}/qa?failOn=nope`);
    expect(bad.status).toBe(400);
  });

  test("export returns a real PPTX with slide XML", async () => {
    const res = await api(`/api/projects/${projectId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("presentationml");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    const zip = await JSZip.loadAsync(bytes);
    const slide = await zip.file("ppt/slides/slide1.xml").async("string");
    expect(slide).toContain("<a:t>");
  });

  test("media upload enforces magic bytes and serves the file back", async () => {
    const okForm = new FormData();
    okForm.append("file", new File([PNG_1X1], "logo.png", { type: "image/png" }));
    const ok = await apiJson(`/api/projects/${projectId}/media`, { method: "POST", body: okForm });
    expect(ok.res.status).toBe(201);
    expect(ok.body.src).toBe("media/logo.png");

    const served = await api(`/api/projects/${projectId}/media/logo.png`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG_1X1)).toBe(true);

    // duplicate upload auto-renames instead of clobbering
    const dupForm = new FormData();
    dupForm.append("file", new File([PNG_1X1], "logo.png", { type: "image/png" }));
    const dup = await apiJson(`/api/projects/${projectId}/media`, { method: "POST", body: dupForm });
    expect(dup.res.status).toBe(201);
    expect(dup.body.name).toBe("logo-2.png");

    // real JPEG/GIF/WEBP uploads must be accepted (regression: the old
    // server-local sniff map used "jpg" while sniffImageBytes says "jpeg",
    // silently rejecting every real JPEG upload)
    const gif = Buffer.alloc(24);
    gif.write("GIF89a", 0); gif.writeUInt16LE(7, 6); gif.writeUInt16LE(9, 8);
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0); webp.write("WEBP", 8); webp.write("VP8 ", 12);
    webp.writeUInt16LE(17, 26); webp.writeUInt16LE(19, 28);
    for (const [name, bytes] of [
      ["photo.jpg", JPEG_1X1],
      ["photo.jpeg", JPEG_1X1],
      ["anim.gif", gif],
      ["modern.webp", webp],
    ]) {
      const form = new FormData();
      form.append("file", new File([bytes], name));
      const up = await apiJson(`/api/projects/${projectId}/media`, { method: "POST", body: form });
      expect(`${name}:${up.res.status}`).toBe(`${name}:201`);
    }

    // PNG bytes with .jpg name must be rejected (polyglot guard)
    const liarForm = new FormData();
    liarForm.append("file", new File([PNG_1X1], "liar.jpg", { type: "image/jpeg" }));
    const liar = await apiJson(`/api/projects/${projectId}/media`, { method: "POST", body: liarForm });
    expect(liar.res.status).toBe(422);
    expect(liar.body.error.code).toBe("MEDIA_TYPE_INVALID");

    const gone = await apiJson(`/api/projects/${projectId}/media/logo-2.png`, { method: "DELETE" });
    expect(gone.res.status).toBe(200);
    const miss = await api(`/api/projects/${projectId}/media/logo-2.png`);
    expect(miss.status).toBe(404);
  });

  test("pdf export endpoint matches advertised LibreOffice availability", async () => {
    const meta = await apiJson("/api/meta");
    expect(typeof meta.body.pdfAvailable).toBe("boolean");

    const created = await apiJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "blank", title: "PDF Probe", theme: "default" }),
    });
    const pid = created.body.project.id;
    try {
      const res = await api(`/api/projects/${pid}/export.pdf`);
      if (meta.body.pdfAvailable) {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/pdf");
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
      } else {
        expect(res.status).toBe(501);
        const body = await res.json();
        expect(body.error.code).toBe("PDF_UNAVAILABLE");
      }
    } finally {
      await api(`/api/projects/${pid}`, { method: "DELETE" });
    }
  }, 30000);

  test("import endpoint turns an uploaded PPTX into a project", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-server-import-"));
    try {
      const deckPath = join(work, "deck.json");
      writeFileSync(deckPath, JSON.stringify(validDeck("Roundtrip Import")), "utf8");
      const pptxPath = join(work, "roundtrip.pptx");
      await exportDeckFile(deckPath, pptxPath, { force: true });

      const form = new FormData();
      form.append(
        "file",
        new File([readFileSync(pptxPath)], "roundtrip.pptx", {
          type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
      );
      const { res, body } = await apiJson("/api/import", { method: "POST", body: form });
      expect(res.status).toBe(201);
      expect(body.pageCount).toBe(1);
      expect(existsSync(join(ctx.dataDir, body.project.id, "deck.json"))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("duplicate forks the whole project folder with a fresh id and title", async () => {
    const created = await apiJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "blank", title: "Dup Source", theme: "default" }),
    });
    const src = created.body.project.id;
    try {
      const dup = await apiJson(`/api/projects/${src}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Dup Fork" }),
      });
      expect(dup.res.status).toBe(201);
      const forkId = dup.body.project.id;
      expect(forkId).not.toBe(src);
      expect(dup.body.project.title).toBe("Dup Fork");

      const srcDeck = JSON.parse((await apiJson(`/api/projects/${src}`)).body.source);
      const forkDeck = JSON.parse((await apiJson(`/api/projects/${forkId}`)).body.source);
      expect(forkDeck.pages).toEqual(srcDeck.pages);
      expect(forkDeck.title).toBe("Dup Fork");

      await api(`/api/projects/${forkId}`, { method: "DELETE" });
    } finally {
      await api(`/api/projects/${src}`, { method: "DELETE" });
    }
  });

  test("delete project removes it and later requests 404", async () => {
    const { res } = await apiJson(`/api/projects/${projectId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(existsSync(join(ctx.dataDir, projectId))).toBe(false);
    const gone = await api(`/api/projects/${projectId}`);
    expect(gone.status).toBe(404);
    const del = await api(`/api/projects/${projectId}`, { method: "DELETE" });
    expect(del.status).toBe(404);
  });
});

describe("studio PDF slot", () => {
  test.skipIf(!posix)("health stays responsive during conversion and a second job is 429", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-pdf-slot-"));
    const marker = join(dir, "started");
    const soffice = join(dir, "fake-soffice");
    writeFileSync(
      soffice,
      `#!${process.execPath}
import { writeFileSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Fake'); process.exit(0); }
writeFileSync(${JSON.stringify(marker)}, 'started');
await Bun.sleep(800);
const out = args[args.indexOf('--outdir') + 1];
writeFileSync(join(out, basename(args.at(-1), '.pptx') + '.pdf'), '%PDF-1.4\\n%%EOF\\n');
`,
    );
    chmodSync(soffice, 0o755);
    const dataDir = join(dir, "data");
    const local = startWebServer({ port: 0, dataDir, soffice });
    try {
      const origin = local.url.replace(/\/$/, "");
      const created = await fetch(`${origin}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "blank", title: "PDF slot" }),
      });
      const id = (await created.json()).project.id;
      const pending = fetch(`${origin}/api/projects/${id}/export.pdf`);
      const deadline = Date.now() + 5000;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
      const started = performance.now();
      const health = await fetch(`${origin}/api/health`);
      const healthMs = performance.now() - started;
      const busy = await fetch(`${origin}/api/projects/${id}/export.pdf`);
      const pdfRes = await pending;
      expect(health.status).toBe(200);
      expect(healthMs).toBeLessThan(350);
      expect(busy.status).toBe(429);
      const busyBody = await busy.json();
      expect(busyBody.error.code).toBe("PDF_BUSY");
      expect(pdfRes.status).toBe(200);
      const bytes = Buffer.from(await pdfRes.arrayBuffer());
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    } finally {
      local.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)(
    "accepted PDF job returns 200 after a 22s converter instead of a retried 429",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "openppt-pdf-idle-"));
      const marker = join(dir, "started");
      const starts = join(dir, "starts");
      const soffice = join(dir, "fake-soffice");
      writeFileSync(
        soffice,
        `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Fake'); process.exit(0); }
appendFileSync(${JSON.stringify(starts)}, '1');
writeFileSync(${JSON.stringify(marker)}, 'started');
await Bun.sleep(22000);
const out = args[args.indexOf('--outdir') + 1];
writeFileSync(join(out, basename(args.at(-1), '.pptx') + '.pdf'), '%PDF-1.4\\n%%EOF\\n');
`,
      );
      chmodSync(soffice, 0o755);
      const dataDir = join(dir, "data");
      const local = startWebServer({ port: 0, dataDir, soffice });
      try {
        const origin = local.url.replace(/\/$/, "");
        const created = await fetch(`${origin}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "blank", title: "PDF idle" }),
        });
        const id = (await created.json()).project.id;
        const pendingStarted = performance.now();
        const pending = fetch(`${origin}/api/projects/${id}/export.pdf`);
        const readyDeadline = Date.now() + 5000;
        while (!existsSync(marker) && Date.now() < readyDeadline) await Bun.sleep(20);
        expect(existsSync(marker)).toBe(true);
        const healthStarted = performance.now();
        const health = await fetch(`${origin}/api/health`);
        const healthMs = performance.now() - healthStarted;
        const busy = await fetch(`${origin}/api/projects/${id}/export.pdf`);
        const pdfRes = await pending;
        const pendingMs = performance.now() - pendingStarted;
        expect(health.status).toBe(200);
        expect(healthMs).toBeLessThan(350);
        expect(busy.status).toBe(429);
        const busyBody = await busy.json();
        expect(busyBody.error.code).toBe("PDF_BUSY");
        expect(pendingMs).toBeGreaterThan(20000);
        expect(pdfRes.status).toBe(200);
        expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
        const bytes = Buffer.from(await pdfRes.arrayBuffer());
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        expect(readFileSync(starts, "utf8")).toBe("1");
      } finally {
        local.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    40000,
  );
});
