import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyLoadDiskResult,
  applyPutSuccess,
  decideReconcile,
  decideSseDispatch,
  effectIsCurrent,
  effectIsLive,
  isHomeRoute,
  isWorkbenchRoute,
  mutationInFlight,
  parseSsePayload,
  putPersistedSource,
} from "../src/internal/workbench-lifecycle.js";
import { startWebServer } from "../src/server.js";

describe("route generation", () => {
  test("late workbench init is ignored after navigating home", () => {
    expect(isWorkbenchRoute("#/p/demo", "demo")).toBe(true);
    expect(isHomeRoute("#/")).toBe(true);
    expect(isHomeRoute("#/p/demo")).toBe(false);
    expect(effectIsCurrent(1, 2)).toBe(false);
    expect(effectIsCurrent(2, 2)).toBe(true);
    expect(effectIsLive({ generation: 1, currentGeneration: 2 })).toBe(false);
  });
});

describe("explicit load-disk race", () => {
  test("delayed GET must not overwrite input typed after the fetch began", () => {
    const originalEtag = '"etag-old"';
    const decision = applyLoadDiskResult({
      submitted: '{"title":"Draft before conflict"}',
      current: '{"title":"Typed after load began"}',
      fetchedSource: '{"title":"External disk version"}',
      fetchedEtag: '"etag-new"',
      originalEtag,
    });
    expect(decision.apply).toBe(false);
    expect(decision.source).toBe('{"title":"Typed after load began"}');
    expect(decision.baseEtag).toBe(originalEtag);
    expect(decision.conflict).toBe(true);
  });

  test("unchanged editor applies fetched disk source and ETag", () => {
    const submitted = '{"title":"Draft before conflict"}';
    const fetched = '{"title":"External disk version"}';
    const decision = applyLoadDiskResult({
      submitted,
      current: submitted,
      fetchedSource: fetched,
      fetchedEtag: '"etag-new"',
      originalEtag: '"etag-old"',
    });
    expect(decision.apply).toBe(true);
    expect(decision.source).toBe(fetched);
    expect(decision.baseEtag).toBe('"etag-new"');
  });
});

describe("PUT newline normalization", () => {
  test("persisted PUT source always ends with a newline", () => {
    expect(putPersistedSource('{"title":"x"}')).toBe('{"title":"x"}\n');
    expect(putPersistedSource('{"title":"x"}\n')).toBe('{"title":"x"}\n');
  });

  test("clean PUT adopts authoritative disk bytes including the newline", () => {
    const submitted = '{"title":"Own save without final newline"}';
    const persisted = putPersistedSource(submitted);
    const applied = applyPutSuccess({
      submitted,
      current: submitted,
      persistedSource: persisted,
      persistedEtag: '"etag-put"',
    });
    expect(applied.dirty).toBe(false);
    expect(applied.saved).toBe(persisted);
    expect(applied.editor).toBe(persisted);
    expect(applied.baseEtag).toBe('"etag-put"');
  });

  test("newer input during PUT keeps exact draft and uses persisted bytes as saved/base", () => {
    const submitted = '{"title":"Own save without final newline"}';
    const newer = '{"title":"Draft typed during own PUT"}';
    const persisted = putPersistedSource(submitted);
    const applied = applyPutSuccess({
      submitted,
      current: newer,
      persistedSource: persisted,
      persistedEtag: '"etag-put"',
    });
    expect(applied.dirty).toBe(true);
    expect(applied.editor).toBe(newer);
    expect(applied.saved).toBe(persisted);
    expect(applied.baseEtag).toBe('"etag-put"');
  });

  test("queued GET with the same ETag is not an external conflict", () => {
    const submitted = '{"title":"Own save without final newline"}';
    const persisted = putPersistedSource(submitted);
    const newer = '{"title":"Draft typed during own PUT"}';
    expect(
      decideReconcile({
        generation: 1,
        currentGeneration: 1,
        editorValue: newer,
        saved: persisted,
        fetchedSource: persisted,
        fetchedEtag: '"etag-put"',
        currentEtag: '"etag-put"',
      }).action,
    ).toBe("preview-only");
    expect(
      decideReconcile({
        generation: 1,
        currentGeneration: 1,
        editorChangedDuringFetch: true,
        editorValue: newer,
        saved: submitted,
        fetchedSource: persisted,
        fetchedEtag: '"etag-put"',
        currentEtag: '"etag-put"',
      }).action,
    ).toBe("keep");
  });
});

describe("SSE dispatch and reconcile", () => {
  test("native EventSource error without code is ignored so reconnect can fetch", () => {
    expect(parseSsePayload("")).toEqual({});
    expect(
      decideSseDispatch({
        generation: 1,
        currentGeneration: 1,
        eventName: "error",
      }).action,
    ).toBe("ignore");
    expect(
      decideSseDispatch({
        generation: 1,
        currentGeneration: 1,
        eventName: "ready",
      }).action,
    ).toBe("fetch");
  });

  test("typed watcher error and deletion are terminal", () => {
    expect(
      decideSseDispatch({
        generation: 1,
        currentGeneration: 1,
        eventName: "error",
        errorCode: "WATCH_SYMLINK",
      }).action,
    ).toBe("error");
    expect(
      decideSseDispatch({
        generation: 1,
        currentGeneration: 1,
        eventName: "deleted",
      }).action,
    ).toBe("deleted");
  });

  test("in-flight mutation, load, or GET queues a single pending reconcile", () => {
    expect(
      decideSseDispatch({
        generation: 1,
        currentGeneration: 1,
        eventName: "changed",
        busy: true,
      }).action,
    ).toBe("queue");
    expect(
      decideSseDispatch({
        generation: 1,
        currentGeneration: 1,
        eventName: "ready",
        fetching: true,
      }).action,
    ).toBe("queue");
  });

  test("stale generation ignores SSE and GET results", () => {
    expect(
      decideSseDispatch({
        generation: 1,
        currentGeneration: 2,
        eventName: "ready",
      }).action,
    ).toBe("ignore");
    expect(
      decideReconcile({
        generation: 1,
        currentGeneration: 2,
        editorValue: "a",
        saved: "a",
        fetchedSource: "b",
        fetchedEtag: '"2"',
        currentEtag: '"1"',
      }).action,
    ).toBe("ignore");
  });

  test("clean editor reloads moved disk; dirty keeps exact text", () => {
    expect(
      decideReconcile({
        generation: 1,
        currentGeneration: 1,
        editorValue: "old",
        saved: "old",
        fetchedSource: "external",
        fetchedEtag: '"2"',
        currentEtag: '"1"',
      }),
    ).toEqual({ action: "reload", source: "external", etag: '"2"' });

    expect(
      decideReconcile({
        generation: 1,
        currentGeneration: 1,
        editorValue: "dirty",
        saved: "old",
        fetchedSource: "external",
        fetchedEtag: '"2"',
        currentEtag: '"1"',
      }).action,
    ).toBe("keep-conflict");

    expect(
      decideReconcile({
        generation: 1,
        currentGeneration: 1,
        editorValue: "dirty",
        saved: "old",
        fetchedSource: "old",
        fetchedEtag: '"1"',
        currentEtag: '"1"',
      }).action,
    ).toBe("preview-only");
  });

  test("input during authoritative GET keeps the newer draft", () => {
    expect(
      decideReconcile({
        generation: 1,
        currentGeneration: 1,
        editorChangedDuringFetch: true,
        editorValue: "typed-after",
        saved: "old",
        fetchedSource: "external",
        fetchedEtag: '"2"',
        currentEtag: '"1"',
      }).action,
    ).toBe("keep-conflict");
  });

  test("pagehide and terminal invalidate late GET/validate completions", () => {
    expect(effectIsLive({ generation: 1, currentGeneration: 1, disposed: true })).toBe(false);
    expect(effectIsLive({ generation: 1, currentGeneration: 1, terminal: true })).toBe(false);
    expect(
      decideReconcile({
        generation: 1,
        currentGeneration: 1,
        terminal: true,
        editorValue: "old",
        saved: "old",
        fetchedSource: "external",
        fetchedEtag: '"2"',
        currentEtag: '"1"',
      }).action,
    ).toBe("ignore");
    expect(
      decideSseDispatch({
        generation: 1,
        currentGeneration: 1,
        eventName: "changed",
        disposed: true,
      }).action,
    ).toBe("ignore");
  });

  test("load, save, and PATCH are exclusive via mutationInFlight", () => {
    expect(mutationInFlight({})).toBe(false);
    expect(mutationInFlight({ saveGate: Promise.resolve() })).toBe(true);
    expect(mutationInFlight({ patchGate: Promise.resolve() })).toBe(true);
    expect(mutationInFlight({ loadGate: Promise.resolve() })).toBe(true);
    expect(mutationInFlight({ saveGate: Promise.resolve(), loadGate: Promise.resolve() })).toBe(true);
  });
});

describe("studio wiring", () => {
  test("app.js imports the shared helper and does not duplicate it", () => {
    const src = readFileSync(join(import.meta.dir, "../web/app.js"), "utf8");
    expect(src).toMatch(/from ["']\/workbench-lifecycle\.js["']/);
    expect(src).toMatch(/new EventSource\(`\/api\/projects\/\$\{id\}\/events`\)/);
    expect(src).toMatch(/pagehide/);
    expect(src).toMatch(/applyLoadDiskResult/);
    expect(src).toMatch(/applyPutSuccess/);
    expect(src).toMatch(/putPersistedSource/);
    expect(src).toMatch(/decideReconcile/);
    expect(src).toMatch(/decideSseDispatch/);
    expect(src).toMatch(/parseSsePayload/);
    expect(src).toMatch(/effectIsLive/);
    expect(src).toMatch(/mutationInFlight/);
    expect(src).toMatch(/pendingReconcile/);
    expect(src).toMatch(/downloadExport\(id, format, stillHere\)/);
    expect(src).toMatch(/const ok = await doValidate\(\{ silent: true \}\);\s*if \(!stillHere\(\)\) return true;/s);
    expect(src).toMatch(/if \(saveGate \|\| patchGate\) return;/);
    expect(src).toMatch(/if \(patchGate \|\| loadGate\) return false;/);
    expect(src).not.toMatch(/function applyLoadDiskResult/);
    expect(src).not.toMatch(/function mutationInFlight/);
    expect(src).not.toMatch(/function applyPutSuccess/);
    expect(src).not.toMatch(/function decideReconcile/);
    expect(src).not.toMatch(/function decideSseDispatch/);
    expect(src).not.toMatch(/function parseSsePayload/);
    expect(src).not.toMatch(/function putPersistedSource/);
    expect(src).not.toMatch(/function effectIsLive/);
  });

  test("GET /workbench-lifecycle.js serves src/internal/workbench-lifecycle.js", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openppt-c4c3-static-"));
    const ctx = startWebServer({ port: 0, dataDir });
    try {
      const res = await fetch(`${ctx.url}workbench-lifecycle.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") || "").toMatch(/javascript/);
      expect(await res.text()).toBe(
        readFileSync(join(import.meta.dir, "../src/internal/workbench-lifecycle.js"), "utf8"),
      );
    } finally {
      ctx.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
