import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startWebServer } from "../src/server.js";

let ctx;

function origin() {
  return ctx.url.replace(/\/$/, "");
}

function deck() {
  return {
    version: "openppt-1",
    size: [960, 540],
    pages: [
      {
        id: "p",
        elements: [{ id: "t", type: "text", bounds: [40, 40, 800, 100], text: "Version one" }],
      },
    ],
  };
}

async function seedProject(title = "Sse seed") {
  const created = await fetch(`${origin()}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "blank", title }),
  });
  expect(created.status).toBe(201);
  const body = await created.json();
  const id = body.project.id;
  const dir = join(ctx.dataDir, id);
  writeFileSync(join(dir, "deck.json"), `${JSON.stringify(deck(), null, 2)}\n`);
  mkdirSync(join(dir, "media"), { recursive: true });
  return { id, dir };
}

function parseSseBlock(block) {
  if (!block.trim() || block.startsWith(":")) return null;
  const name = block.match(/^event: ?(.+)$/m)?.[1];
  const raw = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return { name, data: raw ? JSON.parse(raw) : null };
}

/** One reader per response. until() never cancels; close() is final cleanup. */
function openSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = "";
  let leftover = null;
  let closed = false;

  async function until(predicate, label, ms = 6000) {
    const end = Date.now() + ms;
    if (predicate(events)) return events;
    while (Date.now() < end) {
      if (!leftover) leftover = reader.read();
      const remain = Math.max(20, end - Date.now());
      const raced = await Promise.race([
        leftover.then((chunk) => ({ chunk })),
        new Promise((resolve) => setTimeout(() => resolve({ tick: true }), Math.min(remain, 100))),
      ]);
      if (raced.tick) continue;
      leftover = null;
      if (raced.chunk.done) break;
      buf += decoder.decode(raced.chunk.value, { stream: true });
      let boundary;
      while ((boundary = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, boundary);
        buf = buf.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed) events.push(parsed);
      }
      if (predicate(events)) return events;
    }
    if (predicate(events)) return events;
    throw new Error(`${label}: ${JSON.stringify(events)}`);
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }

  return { events, until, close };
}

beforeAll(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "openppt-sse-api-"));
  ctx = startWebServer({ port: 0, dataDir });
});

afterAll(() => {
  ctx.stop();
  rmSync(ctx.dataDir, { recursive: true, force: true });
});

describe("GET /api/projects/:id/events", () => {
  test("emits initial ready on an originless stream", async () => {
    const { id } = await seedProject("Sse ready");
    const res = await fetch(`${origin()}/api/projects/${id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const sse = openSse(res);
    try {
      const events = await sse.until((list) => list.some((e) => e.name === "ready"), "initial ready");
      expect(events.some((e) => e.name === "ready")).toBe(true);
      expect(JSON.stringify(events)).not.toContain(ctx.dataDir);
    } finally {
      await sse.close();
    }
  }, 10000);

  test("rejects foreign and null Origin while allowing same-origin EventSource", async () => {
    const { id } = await seedProject("Sse origin");
    const url = `${origin()}/api/projects/${id}/events`;

    const foreign = await fetch(url, { headers: { Origin: "http://foreign.invalid" } });
    expect(foreign.status).toBe(403);
    const foreignBody = await foreign.json();
    expect(foreignBody.error.code).toBe("FORBIDDEN_ORIGIN");

    const nulled = await fetch(url, { headers: { Origin: "null" } });
    expect(nulled.status).toBe(403);

    const cross = await fetch(url, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(cross.status).toBe(403);

    const same = await fetch(url, { headers: { Origin: origin() } });
    expect(same.status).toBe(200);
    expect(same.headers.get("content-type")).toMatch(/text\/event-stream/);
    await same.body.cancel();
  }, 10000);

  test("notifies atomic deck.json replacement with a relative path and etag", async () => {
    const { id, dir } = await seedProject("Sse atomic");
    const res = await fetch(`${origin()}/api/projects/${id}/events`);
    expect(res.status).toBe(200);
    const sse = openSse(res);
    try {
      await sse.until((list) => list.some((e) => e.name === "ready"), "ready before atomic");

      const next = deck();
      next.pages[0].elements[0].text = "Atomic source edit";
      writeFileSync(join(dir, "next.json"), JSON.stringify(next));
      renameSync(join(dir, "next.json"), join(dir, "deck.json"));

      const events = await sse.until(
        (list) => list.some((e) => e.name === "changed" && JSON.stringify(e.data).includes("deck.json")),
        "atomic source notification",
      );
      const changed = [...events].reverse().find((e) => e.name === "changed");
      expect(JSON.stringify(changed.data)).toMatch(/"etag"/i);
      expect(JSON.stringify(events)).not.toContain(ctx.dataDir);
      expect(JSON.stringify(events)).not.toContain(dir);
    } finally {
      await sse.close();
    }
  }, 10000);

  test("missing project is 404", async () => {
    const res = await fetch(`${origin()}/api/projects/no-such-project/events`);
    expect(res.status).toBe(404);
  });

  test("notifies nested media paths and project deletion; fifth subscriber is 429", async () => {
    const { id, dir } = await seedProject("Sse nested");
    const url = `${origin()}/api/projects/${id}/events`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    const sse = openSse(first);
    const extra = [];
    try {
      await sse.until((list) => list.some((e) => e.name === "ready"), "ready before nested");
      mkdirSync(join(dir, "media", "nested"));
      await Bun.sleep(250);
      const beforeNested = sse.events.length;
      writeFileSync(join(dir, "media", "nested", "item.txt"), "nested content");
      await sse.until(
        (list) =>
          list
            .slice(beforeNested)
            .some((e) => e.name === "changed" && JSON.stringify(e.data).includes("media/nested")),
        "new nested directory/file notification",
      );

      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(url);
        expect(res.status).toBe(200);
        extra.push(res);
      }
      const excess = await fetch(url);
      expect(excess.status).toBe(429);
      const excessBody = await excess.json();
      expect(typeof excessBody.error.code).toBe("string");

      const beforeDelete = sse.events.length;
      rmSync(dir, { recursive: true, force: true });
      await sse.until(
        (list) => list.slice(beforeDelete).some((e) => e.name === "deleted"),
        "project deletion notification",
      );
    } finally {
      await sse.close();
      for (const res of extra) {
        try {
          await res.body.cancel();
        } catch {
          // already closed
        }
      }
    }
  }, 15000);

  test("keeps delivering changes to an actively reading client past 40 events", async () => {
    const { id, dir } = await seedProject("Sse consume");
    const res = await fetch(`${origin()}/api/projects/${id}/events`);
    expect(res.status).toBe(200);
    const sse = openSse(res);
    try {
      await sse.until((list) => list.some((e) => e.name === "ready"), "ready before burst");
      for (let i = 0; i < 40; i += 1) {
        const before = sse.events.length;
        writeFileSync(join(dir, "one.txt"), `change ${i}`);
        await sse.until(
          (list) => list.slice(before).some((e) => e.name === "changed"),
          `consuming client lost change ${i}`,
        );
      }
      expect(sse.events.filter((e) => e.name === "changed").length).toBeGreaterThanOrEqual(40);
    } finally {
      await sse.close();
    }
  }, 20000);

  test("watches descendants after a populated subtree is renamed into the project", async () => {
    const { id, dir } = await seedProject("Sse subtree");
    const res = await fetch(`${origin()}/api/projects/${id}/events`);
    expect(res.status).toBe(200);
    const sse = openSse(res);
    try {
      await sse.until((list) => list.some((e) => e.name === "ready"), "ready before subtree");
      const staging = join(ctx.dataDir, `staging-${id}`);
      mkdirSync(join(staging, "deep"), { recursive: true });
      writeFileSync(join(staging, "deep", "one.txt"), "initial");
      rmSync(join(dir, "media"), { recursive: true, force: true });
      renameSync(staging, join(dir, "media"));
      await Bun.sleep(350);
      const before = sse.events.length;
      writeFileSync(join(dir, "media", "deep", "one.txt"), "future deep update");
      await sse.until(
        (list) =>
          list
            .slice(before)
            .some((e) => e.name === "changed" && JSON.stringify(e.data).includes("media/deep/one.txt")),
        "new subtree descendants are not watched",
      );
    } finally {
      await sse.close();
    }
  }, 15000);

  test("symlink escape is visible without leaking absolute paths", async () => {
    const { id, dir } = await seedProject("Sse symlink");
    const outside = mkdtempSync(join(tmpdir(), "openppt-sse-out-"));
    try {
      symlinkSync(outside, join(dir, "media", "escape"));
      const res = await fetch(`${origin()}/api/projects/${id}/events`);
      expect(res.status).toBe(200);
      const sse = openSse(res);
      try {
        const events = await sse.until(
          (list) => list.some((e) => e.name === "error"),
          "symlink error",
        );
        const dump = JSON.stringify(events);
        expect(dump).not.toContain(outside);
        expect(dump).not.toContain(dir);
        expect(dump).not.toContain(ctx.dataDir);
        expect(events.some((e) => e.name === "error" && e.data?.code === "WATCH_SYMLINK")).toBe(true);
      } finally {
        await sse.close();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10000);

  test("early SSE error does not leak heartbeat timers after close and stop", async () => {
    const interval = globalThis.setInterval;
    const clear = globalThis.clearInterval;
    const active = new Set();
    let created = 0;
    let cleared = 0;
    globalThis.setInterval = (...args) => {
      const id = interval(...args);
      active.add(id);
      created += 1;
      return id;
    };
    globalThis.clearInterval = (id) => {
      if (active.delete(id)) cleared += 1;
      return clear(id);
    };
    const dataDir = mkdtempSync(join(tmpdir(), "openppt-sse-cleanup-"));
    const outside = mkdtempSync(join(tmpdir(), "openppt-sse-out-"));
    let local;
    try {
      const dir = join(dataDir, "demo");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "deck.json"),
        `${JSON.stringify({ version: "openppt-1", size: [960, 540], pages: [{ id: "p", elements: [] }] })}\n`,
      );
      symlinkSync(outside, join(dir, "escape"));
      local = startWebServer({ port: 0, dataDir });
      const ctl = new AbortController();
      const res = await fetch(`${local.url.replace(/\/$/, "")}/api/projects/demo/events`, {
        signal: ctl.signal,
      });
      const body = await res.text();
      expect(res.status === 200 || (res.status >= 400 && res.status < 500)).toBe(true);
      expect(body.includes("WATCH_SYMLINK") || res.status >= 400).toBe(true);
      ctl.abort();
      await Bun.sleep(50);
      local.stop();
      local = null;
      await Bun.sleep(50);
      expect(active.size).toBe(0);
      expect(cleared).toBe(created);
    } finally {
      try {
        local?.stop();
      } catch {
        // already stopped
      }
      globalThis.setInterval = interval;
      globalThis.clearInterval = clear;
      for (const id of active) clear(id);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10000);
});
