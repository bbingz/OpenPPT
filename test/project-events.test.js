import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ProjectEventError,
  createProjectEventHub,
} from "../src/internal/project-events.js";

function makeProject(root, id) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "deck.json"),
    `${JSON.stringify({ version: "openppt-1", size: [960, 540], pages: [{ id: "p", elements: [] }] })}\n`,
  );
  return dir;
}

describe("project event hub caps", () => {
  it("enforces server and per-project subscriber caps", () => {
    const root = mkdtempSync(join(tmpdir(), "openppt-sse-hub-"));
    const hub = createProjectEventHub({
      dataDir: root,
      limits: { subscribersPerServer: 3, subscribersPerProject: 2 },
    });
    try {
      const a = makeProject(root, "a");
      const b = makeProject(root, "b");
      const unsubs = [
        hub.subscribe("a", a, () => {}),
        hub.subscribe("a", a, () => {}),
      ];
      assert.throws(
        () => hub.subscribe("a", a, () => {}),
        (err) => err instanceof ProjectEventError && err.status === 429,
      );
      unsubs.push(hub.subscribe("b", b, () => {}));
      assert.throws(
        () => hub.subscribe("b", b, () => {}),
        (err) => err instanceof ProjectEventError && err.status === 429,
      );
      for (const unsub of unsubs) unsub();
      assert.equal(hub.subscriberCount(), 0);
    } finally {
      hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits WATCHER_LIMIT when watched directories exceed the cap", () => {
    const root = mkdtempSync(join(tmpdir(), "openppt-sse-dirs-"));
    const hub = createProjectEventHub({
      dataDir: root,
      limits: { watchedDirsPerProject: 3, subscribersPerProject: 4, subscribersPerServer: 8 },
    });
    try {
      const dir = makeProject(root, "wide");
      mkdirSync(join(dir, "d1"));
      mkdirSync(join(dir, "d2"));
      mkdirSync(join(dir, "d3"));
      mkdirSync(join(dir, "d4"));
      const events = [];
      const unsub = hub.subscribe("wide", dir, (name, data) => events.push({ name, data }));
      assert.ok(events.some((e) => e.name === "error" && e.data.code === "WATCHER_LIMIT"));
      assert.equal(events.some((e) => e.name === "ready"), false);
      assert.ok(!JSON.stringify(events).includes(dir));
      unsub();
      assert.equal(hub.subscriberCount(), 0);
    } finally {
      hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("signals refresh when pending paths overflow the bound", async () => {
    const root = mkdtempSync(join(tmpdir(), "openppt-sse-refresh-"));
    const hub = createProjectEventHub({
      dataDir: root,
      limits: {
        maxPendingPaths: 2,
        debounceMs: 30,
        subscribersPerProject: 4,
        subscribersPerServer: 8,
      },
    });
    try {
      const dir = makeProject(root, "burst");
      const events = [];
      const unsub = hub.subscribe("burst", dir, (name, data) => events.push({ name, data }));
      writeFileSync(join(dir, "a.txt"), "a");
      writeFileSync(join(dir, "b.txt"), "b");
      writeFileSync(join(dir, "c.txt"), "c");
      writeFileSync(join(dir, "deck.json"), `${JSON.stringify({ version: "openppt-1", size: [960, 540], pages: [{ id: "p", elements: [] }] })}\n`);
      const end = Date.now() + 1000;
      while (Date.now() < end && !events.some((e) => e.name === "changed" && e.data?.refresh)) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const changed = events.filter((e) => e.name === "changed");
      assert.ok(changed.some((e) => e.data?.refresh === true));
      unsub();
    } finally {
      hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
