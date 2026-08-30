import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";

import { startWebServer } from "../src/index.js";
import { exportDeckFile } from "../src/index.js";

/** Minimal valid 1x1 PNG (transparent). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
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
    const { res, body } = await apiJson(`/api/projects/${projectId}/deck`, {
      method: "PUT",
      body: "{ not json",
    });
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("SCHEMA_INVALID");
    const after = readFileSync(join(ctx.dataDir, projectId, "deck.json"), "utf8");
    expect(after).toBe(before);
  });

  test("PUT deck saves and validate endpoint reports fail-closed errors", async () => {
    const good = validDeck();
    let put = await apiJson(`/api/projects/${projectId}/deck`, {
      method: "PUT",
      body: JSON.stringify(good, null, 2),
    });
    expect(put.res.status).toBe(200);

    let check = await apiJson(`/api/projects/${projectId}/validate`, { method: "POST" });
    expect(check.body.ok).toBe(true);
    expect(check.body.pages).toBe(1);

    const broken = validDeck();
    broken.pages[0].elements[0].fontSize = 1e308; // round-five H1 regression via HTTP
    put = await apiJson(`/api/projects/${projectId}/deck`, {
      method: "PUT",
      body: JSON.stringify(broken),
    });
    expect(put.res.status).toBe(200);
    check = await apiJson(`/api/projects/${projectId}/validate`, { method: "POST" });
    expect(check.res.status).toBe(200);
    expect(check.body.ok).toBe(false);
    expect(check.body.error.code).toBe("SCHEMA_INVALID");

    // restore a valid deck for the following tests
    put = await apiJson(`/api/projects/${projectId}/deck`, {
      method: "PUT",
      body: JSON.stringify(good, null, 2),
    });
    expect(put.res.status).toBe(200);
  });

  test("preview escapes user text and ships a strict CSP", async () => {
    const deck = validDeck('XSS <script>alert(1)</script> "quoted"');
    deck.pages[0].elements[0].text = '</div><script>alert(2)</script>';
    const put = await apiJson(`/api/projects/${projectId}/deck`, {
      method: "PUT",
      body: JSON.stringify(deck),
    });
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
