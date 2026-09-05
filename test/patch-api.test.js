import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { startWebServer } from "../src/server.js";

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

function groupDeck() {
  return {
    version: "openppt-1",
    title: "Patch groups",
    size: [960, 540],
    theme: {
      colors: { primary: "#2563EB", background: "#FFFFFF" },
      textStyles: { body: { fontSize: 20 } },
    },
    pages: [
      {
        id: "p",
        elements: [
          {
            id: "stack",
            type: "group",
            layout: "stack",
            bounds: [40, 40, 800, 400],
            children: [
              {
                id: "t",
                type: "text",
                height: 100,
                style: "$body",
                text: "Original constructor __proto__",
              },
            ],
          },
        ],
      },
    ],
  };
}

async function seedDeck(deck, title = "Patch seed") {
  const created = await apiJson("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "blank", title }),
  });
  expect(created.res.status).toBe(201);
  const id = created.body.project.id;
  const deckPath = join(ctx.dataDir, id, "deck.json");
  const got = await api(`/api/projects/${id}`);
  const etag = got.headers.get("etag");
  await got.json();
  const put = await api(`/api/projects/${id}/deck`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": etag },
    body: `${JSON.stringify(deck, null, 2)}\n`,
  });
  expect(put.status).toBe(200);
  const nextTag = put.headers.get("etag");
  await put.json();
  return { id, deckPath, etag: nextTag };
}

async function patchDeck(id, operations, etag, extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (etag !== undefined && etag !== null) headers["If-Match"] = etag;
  return apiJson(`/api/projects/${id}/deck`, {
    method: "PATCH",
    headers,
    body: typeof operations === "string" ? operations : JSON.stringify({ operations }),
  });
}

beforeAll(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "openppt-patch-api-"));
  ctx = startWebServer({ port: 0, dataDir });
});

afterAll(() => {
  ctx.stop();
  rmSync(ctx.dataDir, { recursive: true, force: true });
});

describe("PATCH /api/projects/:id/deck", () => {
  test("updates raw groups and style refs, keeps false/zero, returns exact source", async () => {
    const { id, deckPath, etag } = await seedDeck(groupDeck(), "Patch preserve");
    const before = readFileSync(deckPath, "utf8");

    const { res, body } = await patchDeck(id, [
      {
        op: "update",
        pageId: "p",
        elementId: "t",
        changes: { text: "Updated constructor __proto__", bold: false, charSpacing: 0 },
      },
    ], etag);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.source).toBe("string");
    expect(body.source).toBe(readFileSync(deckPath, "utf8"));
    expect(body.source).not.toBe(before);

    const saved = JSON.parse(body.source);
    expect(saved.pages[0].elements[0].type).toBe("group");
    expect(saved.pages[0].elements[0].children[0].style).toBe("$body");
    expect(saved.pages[0].elements[0].children[0].bold).toBe(false);
    expect(saved.pages[0].elements[0].children[0].charSpacing).toBe(0);
    expect(saved.pages[0].elements[0].children[0].text).toBe("Updated constructor __proto__");

    const nextTag = res.headers.get("etag");
    expect(nextTag).toBeTruthy();
    expect(nextTag.startsWith("W/")).toBe(false);
    expect(nextTag).not.toBe(etag);
    expect(nextTag).toBe(
      `"${createHash("sha256").update(Buffer.from(body.source, "utf8")).digest("hex")}"`,
    );
  });

  test("requires a strong If-Match and rejects stale or weak validators", async () => {
    const { id, deckPath, etag } = await seedDeck(groupDeck(), "Patch ifmatch");
    const before = readFileSync(deckPath, "utf8");

    const missing = await patchDeck(
      id,
      [{ op: "update", pageId: "p", elementId: "t", changes: { text: "no etag" } }],
      null,
    );
    expect(missing.res.status).toBe(428);
    expect(missing.body.error.code).toBe("PRECONDITION_REQUIRED");
    expect(readFileSync(deckPath, "utf8")).toBe(before);

    const weak = await patchDeck(
      id,
      [{ op: "update", pageId: "p", elementId: "t", changes: { text: "weak" } }],
      `W/${etag}`,
    );
    expect(weak.res.status).toBe(412);
    expect(weak.body.error.code).toBe("PRECONDITION_FAILED");

    const star = await patchDeck(
      id,
      [{ op: "update", pageId: "p", elementId: "t", changes: { text: "star" } }],
      "*",
    );
    expect(star.res.status).toBe(412);

    const stale = await patchDeck(
      id,
      [{ op: "remove", pageId: "p", elementId: "t" }],
      `"${"0".repeat(64)}"`,
    );
    expect(stale.res.status).toBe(412);
    expect(readFileSync(deckPath, "utf8")).toBe(before);
  });

  test("rolls back the whole batch when a later operation fails", async () => {
    const { id, deckPath, etag } = await seedDeck(groupDeck(), "Patch rollback");
    const before = readFileSync(deckPath, "utf8");

    const { res, body } = await patchDeck(id, [
      { op: "update", pageId: "p", elementId: "t", changes: { text: "must roll back" } },
      { op: "remove", pageId: "p", elementId: "missing" },
    ], etag);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(404);
    expect(body.error?.code).not.toBe("NOT_FOUND");
    expect(body.ok).not.toBe(true);
    expect(readFileSync(deckPath, "utf8")).toBe(before);
    expect(JSON.parse(before).pages[0].elements[0].children[0].text).toBe(
      "Original constructor __proto__",
    );
  });

  test("two same-version writers cannot both succeed", async () => {
    const { id, etag } = await seedDeck(groupDeck(), "Patch cas");
    const pair = await Promise.all([
      patchDeck(id, [{ op: "update", pageId: "p", elementId: "t", changes: { text: "race A" } }], etag),
      patchDeck(id, [{ op: "update", pageId: "p", elementId: "t", changes: { text: "race B" } }], etag),
    ]);
    expect(pair.map((x) => x.res.status).sort()).toEqual([200, 412]);
    const winner = pair.find((x) => x.res.status === 200);
    expect(["race A", "race B"]).toContain(JSON.parse(winner.body.source).pages[0].elements[0].children[0].text);
  });

  test("rejects unknown fields, empty/overlong batches, and non-integer index", async () => {
    const { id, deckPath, etag } = await seedDeck(groupDeck(), "Patch shapes");
    const before = readFileSync(deckPath, "utf8");

    const extraOp = await patchDeck(id, [
      { op: "update", pageId: "p", elementId: "t", changes: { text: "x" }, extra: 1 },
    ], etag);
    expect(extraOp.res.status).toBe(400);
    expect(extraOp.body.error.code).toBe("PATCH_INVALID");

    const extraBody = await apiJson(`/api/projects/${id}/deck`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify({ operations: [{ op: "remove", pageId: "p", elementId: "t" }], debug: true }),
    });
    expect(extraBody.res.status).toBe(400);
    expect(extraBody.body.error.code).toBe("PATCH_INVALID");

    const empty = await apiJson(`/api/projects/${id}/deck`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify({ operations: [] }),
    });
    expect(empty.res.status).toBe(400);

    const tooMany = await patchDeck(
      id,
      Array.from({ length: 65 }, () => ({
        op: "update",
        pageId: "p",
        elementId: "t",
        changes: { text: "n" },
      })),
      etag,
    );
    expect(tooMany.res.status).toBe(400);

    const badIndex = await patchDeck(id, [
      {
        op: "add",
        pageId: "p",
        index: 1.5,
        element: { id: "n", type: "text", bounds: [40, 40, 100, 40], text: "nope" },
      },
    ], etag);
    expect(badIndex.res.status).toBe(400);
    expect(readFileSync(deckPath, "utf8")).toBe(before);
  });

  test("rejects prototype-sensitive keys but allows those words in text", async () => {
    const { id, deckPath, etag } = await seedDeck(groupDeck(), "Patch proto");
    const before = readFileSync(deckPath, "utf8");

    const proto = await apiJson(`/api/projects/${id}/deck`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: `{"operations":[{"op":"update","pageId":"p","elementId":"t","changes":{"__proto__":{"polluted":true}}}]}`,
    });
    expect(proto.res.status).toBe(400);
    expect(proto.body.error.code).toBe("PATCH_INVALID");
    expect(Object.prototype.polluted).toBeUndefined();

    const ctor = await patchDeck(id, [
      { op: "update", pageId: "p", elementId: "t", changes: { constructor: { name: "evil" } } },
    ], etag);
    expect(ctor.res.status).toBe(400);
    expect(ctor.body.error.code).toBe("PATCH_INVALID");

    const ok = await patchDeck(id, [
      { op: "update", pageId: "p", elementId: "t", changes: { text: "constructor __proto__ prototype" } },
    ], etag);
    expect(ok.res.status).toBe(200);
    expect(JSON.parse(ok.body.source).pages[0].elements[0].children[0].text).toBe(
      "constructor __proto__ prototype",
    );
    expect(readFileSync(deckPath, "utf8")).not.toBe(before);
  });

  test("cannot change or unset id/type; duplicate and conflicting unset keys fail", async () => {
    const { id, deckPath, etag } = await seedDeck(groupDeck(), "Patch unset");
    const before = readFileSync(deckPath, "utf8");

    const changeId = await patchDeck(id, [
      { op: "update", pageId: "p", elementId: "t", changes: { id: "other" } },
    ], etag);
    expect(changeId.res.status).toBe(400);

    const unsetId = await patchDeck(id, [
      { op: "update", pageId: "p", elementId: "t", changes: {}, unset: ["id"] },
    ], etag);
    expect(unsetId.res.status).toBe(400);

    const dupUnset = await patchDeck(id, [
      { op: "update", pageId: "p", elementId: "t", changes: {}, unset: ["bold", "bold"] },
    ], etag);
    expect(dupUnset.res.status).toBe(400);

    const conflict = await patchDeck(id, [
      { op: "update", pageId: "p", elementId: "t", changes: { bold: false }, unset: ["bold"] },
    ], etag);
    expect(conflict.res.status).toBe(400);
    expect(readFileSync(deckPath, "utf8")).toBe(before);

    const tagged = await patchDeck(id, [
      { op: "update", pageId: "p", elementId: "t", changes: { bold: true, italic: true } },
    ], etag);
    expect(tagged.res.status).toBe(200);
    const cleared = await patchDeck(
      id,
      [{ op: "update", pageId: "p", elementId: "t", changes: {}, unset: ["italic"] }],
      tagged.res.headers.get("etag"),
    );
    expect(cleared.res.status).toBe(200);
    const el = JSON.parse(cleared.body.source).pages[0].elements[0].children[0];
    expect(el.bold).toBe(true);
    expect(el).not.toHaveProperty("italic");
    expect(el.id).toBe("t");
    expect(el.type).toBe("text");
  });

  test("add/update/remove keep groups; index is not clamped; parent must be a group", async () => {
    const { id, etag } = await seedDeck(groupDeck(), "Patch add");

    const over = await patchDeck(id, [
      {
        op: "add",
        pageId: "p",
        index: 4,
        element: { id: "ghost", type: "text", bounds: [40, 40, 120, 40], text: "nope" },
      },
    ], etag);
    expect(over.res.status).toBe(400);
    expect(over.body.error.details.index).toBe(4);

    const notGroup = await patchDeck(id, [
      {
        op: "add",
        pageId: "p",
        parentId: "t",
        element: { id: "inner", type: "text", height: 40, text: "nope" },
      },
    ], etag);
    expect(notGroup.res.status).toBe(422);
    expect(notGroup.body.error.code).toBe("PATCH_TARGET");

    const added = await patchDeck(id, [
      {
        op: "add",
        pageId: "p",
        parentId: "stack",
        index: 0,
        element: { id: "kicker", type: "text", height: 40, text: "Kicker", fontSize: 18 },
      },
    ], etag);
    expect(added.res.status).toBe(200);
    const afterAdd = JSON.parse(added.body.source);
    expect(afterAdd.pages[0].elements[0].type).toBe("group");
    expect(afterAdd.pages[0].elements[0].children.map((el) => el.id)).toEqual(["kicker", "t"]);

    const sibling = await patchDeck(
      id,
      [
        {
          op: "add",
          pageId: "p",
          index: 1,
          element: {
            id: "card",
            type: "group",
            layout: "stack",
            bounds: [40, 40, 200, 200],
            children: [{ id: "card-t", type: "text", height: 40, text: "Card" }],
          },
        },
      ],
      added.res.headers.get("etag"),
    );
    expect(sibling.res.status).toBe(200);
    expect(JSON.parse(sibling.body.source).pages[0].elements.map((el) => el.id)).toEqual(["stack", "card"]);

    const removed = await patchDeck(
      id,
      [{ op: "remove", pageId: "p", elementId: "card" }],
      sibling.res.headers.get("etag"),
    );
    expect(removed.res.status).toBe(200);
    const afterRemove = JSON.parse(removed.body.source);
    expect(afterRemove.pages[0].elements.map((el) => el.id)).toEqual(["stack"]);
    expect(JSON.stringify(afterRemove)).not.toContain("card-t");
  });

  test("unknown and duplicate targets abort without writing", async () => {
    const { id, etag } = await seedDeck(groupDeck(), "Patch targets");
    const missingPage = await patchDeck(id, [
      { op: "update", pageId: "nope", elementId: "t", changes: { text: "x" } },
    ], etag);
    expect(missingPage.res.status).toBe(422);
    expect(missingPage.body.error.code).toBe("PATCH_TARGET");

    const dup = structuredClone(groupDeck());
    dup.pages[0].elements.push({
      id: "t",
      type: "text",
      bounds: [40, 450, 200, 40],
      text: "dup",
    });
    const seeded = await seedDeck(dup, "Patch dup ids");
    const beforeDup = readFileSync(seeded.deckPath, "utf8");
    const ambiguous = await patchDeck(seeded.id, [
      { op: "update", pageId: "p", elementId: "t", changes: { text: "which" } },
    ], seeded.etag);
    expect(ambiguous.res.status).toBe(409);
    expect(ambiguous.body.error.code).toBe("PATCH_TARGET");
    expect(readFileSync(seeded.deckPath, "utf8")).toBe(beforeDup);
  });

  test("rejects missing media, out-of-bounds geometry, and resource overruns", async () => {
    const { id, deckPath, etag } = await seedDeck(groupDeck(), "Patch unsafe");
    const before = readFileSync(deckPath, "utf8");

    const media = await patchDeck(id, [
      {
        op: "add",
        pageId: "p",
        element: {
          id: "img",
          type: "image",
          bounds: [40, 40, 80, 80],
          src: "media/missing.png",
        },
      },
    ], etag);
    expect(media.res.status).toBe(422);
    expect(media.body.error.code).toBe("MEDIA_MISSING");

    const bounds = await patchDeck(id, [
      { op: "update", pageId: "p", elementId: "stack", changes: { bounds: [0, 0, 9999, 9999] } },
    ], etag);
    expect(bounds.res.status).toBe(422);
    expect(bounds.body.error.code).toBe("BOUNDS_OUT_OF_RANGE");

    const children = Array.from({ length: 257 }, (_, i) => ({
      id: `c${i}`,
      type: "text",
      height: 1,
      text: "x",
    }));
    const resource = await patchDeck(id, [
      {
        op: "add",
        pageId: "p",
        element: {
          id: "too-many",
          type: "group",
          layout: "stack",
          bounds: [40, 40, 200, 400],
          children,
        },
      },
    ], etag);
    expect(resource.res.status).toBe(422);
    expect(resource.body.error.code).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(readFileSync(deckPath, "utf8")).toBe(before);

    const form = new FormData();
    form.append("file", new File([PNG_1X1], "mark.png", { type: "image/png" }));
    const up = await apiJson(`/api/projects/${id}/media`, { method: "POST", body: form });
    expect(up.res.status).toBe(201);
    const okImg = await patchDeck(id, [
      {
        op: "add",
        pageId: "p",
        element: {
          id: "mark",
          type: "image",
          bounds: [700, 40, 80, 80],
          src: "media/mark.png",
        },
      },
    ], etag);
    expect(okImg.res.status).toBe(200);
    expect(JSON.parse(okImg.body.source).pages[0].elements.some((el) => el.id === "mark")).toBe(true);
  });

  test("YAML decks and external page files return actionable UNSUPPORTED_EDIT", async () => {
    const yamlCreated = await apiJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "blank", title: "Patch yaml" }),
    });
    const yamlId = yamlCreated.body.project.id;
    const yamlDir = join(ctx.dataDir, yamlId);
    const jsonPath = join(yamlDir, "deck.json");
    const yamlBody = readFileSync(jsonPath, "utf8");
    unlinkSync(jsonPath);
    writeFileSync(join(yamlDir, "deck.yaml"), yamlBody);
    const yamlPatch = await patchDeck(yamlId, [
      { op: "update", pageId: "p", elementId: "t", changes: { text: "nope" } },
    ], `"${"a".repeat(64)}"`);
    expect(yamlPatch.res.status).toBe(422);
    expect(yamlPatch.body.error.code).toBe("UNSUPPORTED_EDIT");
    expect(yamlPatch.body.error.message).toMatch(/YAML/i);
    expect(readFileSync(join(yamlDir, "deck.yaml"), "utf8")).toBe(yamlBody);

    const { id, deckPath, etag } = await seedDeck(groupDeck(), "Patch multifile");
    const pagesDir = join(ctx.dataDir, id, "pages");
    mkdirSync(pagesDir);
    const cover = {
      id: "cover",
      elements: [{ id: "c1", type: "text", bounds: [40, 40, 400, 40], text: "Cover" }],
    };
    writeFileSync(join(pagesDir, "cover.json"), `${JSON.stringify(cover, null, 2)}\n`);
    const manifest = {
      version: "openppt-1",
      title: "External pages",
      size: [960, 540],
      pages: ["pages/cover.json"],
    };
    writeFileSync(deckPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const got = await api(`/api/projects/${id}`);
    const fileTag = got.headers.get("etag");
    await got.json();
    expect(fileTag).not.toBe(etag);
    const ext = await patchDeck(id, [
      { op: "update", pageId: "cover", elementId: "c1", changes: { text: "inlined?" } },
    ], fileTag);
    expect(ext.res.status).toBe(422);
    expect(ext.body.error.code).toBe("UNSUPPORTED_EDIT");
    expect(ext.body.error.message).toMatch(/external page/i);
    const after = JSON.parse(readFileSync(deckPath, "utf8"));
    expect(after.pages).toEqual(["pages/cover.json"]);
    expect(JSON.parse(readFileSync(join(pagesDir, "cover.json"), "utf8")).elements[0].text).toBe("Cover");
  });

  test("rejects text/plain and missing Content-Type without writing; allows charset", async () => {
    const { id, deckPath, etag } = await seedDeck(groupDeck(), "Patch content-type");
    const before = readFileSync(deckPath, "utf8");
    const payload = JSON.stringify({
      operations: [{ op: "update", pageId: "p", elementId: "t", changes: { text: "Must not be saved" } }],
    });
    const bytes = new TextEncoder().encode(payload);

    const plain = await apiJson(`/api/projects/${id}/deck`, {
      method: "PATCH",
      headers: { "Content-Type": "text/plain", "If-Match": etag },
      body: bytes,
    });
    expect(plain.res.status).toBe(415);
    expect(plain.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(readFileSync(deckPath, "utf8")).toBe(before);

    const missing = await apiJson(`/api/projects/${id}/deck`, {
      method: "PATCH",
      headers: { "If-Match": etag },
      body: bytes,
    });
    expect(missing.res.status).toBe(415);
    expect(missing.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(readFileSync(deckPath, "utf8")).toBe(before);

    const yamlType = await apiJson(`/api/projects/${id}/deck`, {
      method: "PATCH",
      headers: { "Content-Type": "application/yaml", "If-Match": etag },
      body: bytes,
    });
    expect(yamlType.res.status).toBe(422);
    expect(yamlType.body.error.code).toBe("UNSUPPORTED_EDIT");
    expect(yamlType.body.error.message).toMatch(/application\/json/i);
    expect(readFileSync(deckPath, "utf8")).toBe(before);

    const charset = await patchDeck(
      id,
      [{ op: "update", pageId: "p", elementId: "t", changes: { text: "charset ok" } }],
      etag,
      { "Content-Type": "application/json; charset=utf-8" },
    );
    expect(charset.res.status).toBe(200);
    expect(JSON.parse(charset.body.source).pages[0].elements[0].children[0].text).toBe("charset ok");
    expect(charset.body.source).toBe(readFileSync(deckPath, "utf8"));
  });
});
