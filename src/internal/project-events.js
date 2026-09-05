/**
 * Project-scoped fs.watch hub for Studio SSE.
 * Watchers are shared across subscribers of one project and closed when the
 * last client disconnects. Parent-dir watch is filtered to the project name
 * (deletion). No process-wide scanner.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { RESOURCE_LIMITS } from "../resource-limits.js";

export const SSE_LIMITS = Object.freeze({
  subscribersPerProject: 4,
  subscribersPerServer: 32,
  watchedDirsPerProject: 128,
  debounceMs: 80,
  heartbeatMs: 5000,
  maxBufferedEvents: 32,
  maxBufferedBytes: 64 * 1024,
  maxPendingPaths: 64,
  maxEventBytes: 16 * 1024,
});

const DECK_FILES = Object.freeze(["deck.json", "deck.yaml", "deck.yml"]);

export class ProjectEventError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "ProjectEventError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function formatSseEvent(name, data) {
  const payload = JSON.stringify(data ?? {});
  return `event: ${name}\ndata: ${payload}\n\n`;
}

function posixRel(from, to) {
  return relative(from, to).split(sep).join("/");
}

export function contained(root, candidate) {
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    rootReal = resolve(root);
  }
  let cand;
  try {
    cand = realpathSync(candidate);
  } catch {
    cand = resolve(candidate);
  }
  const rel = relative(rootReal, cand);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(`..${sep}`));
}

function isHiddenRel(rel) {
  return rel.split("/").some((part) => part.startsWith("."));
}

export function sourceEtag(projectDir, capBytes = RESOURCE_LIMITS.totalStringBytes) {
  const root = resolve(projectDir);
  for (const name of DECK_FILES) {
    const abs = join(root, name);
    if (!contained(root, abs)) continue;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > capBytes) continue;
      const bytes = readFileSync(abs);
      if (bytes.length > capBytes) continue;
      return `"${createHash("sha256").update(bytes).digest("hex")}"`;
    } catch {
      // try next allowlisted deck filename
    }
  }
  return null;
}

export function createProjectEventHub(options) {
  const dataDir = resolve(options.dataDir);
  const limits = { ...SSE_LIMITS, ...(options.limits || {}) };
  /** @type {Map<string, ProjectWatch>} */
  const projects = new Map();
  let serverSubscribers = 0;

  function subscribe(projectId, projectDir, listener) {
    const abs = resolve(projectDir);
    if (!existsSync(abs) || !contained(dataDir, abs)) {
      throw new ProjectEventError(404, "NOT_FOUND", `Project not found: ${projectId}`);
    }
    if (serverSubscribers >= limits.subscribersPerServer) {
      throw new ProjectEventError(
        429,
        "SUBSCRIBER_LIMIT",
        "SSE subscriber cap reached for this server",
        { limit: limits.subscribersPerServer },
      );
    }
    let bucket = projects.get(projectId);
    if (!bucket || bucket.dead) {
      bucket = new ProjectWatch(projectId, abs, dataDir, limits);
      projects.set(projectId, bucket);
    }
    if (bucket.subscribers.size >= limits.subscribersPerProject) {
      throw new ProjectEventError(
        429,
        "SUBSCRIBER_LIMIT",
        "SSE subscriber cap reached for this project",
        { limit: limits.subscribersPerProject, projectId },
      );
    }
    serverSubscribers += 1;
    const sub = { listener };
    bucket.subscribers.add(sub);
    let active = true;
    const started = bucket.ensureWatching();
    if (started) {
      const etag = sourceEtag(abs, limits.sourceBytesCap || RESOURCE_LIMITS.totalStringBytes);
      listener("ready", etag ? { etag } : {});
    }

    return () => {
      if (!active) return;
      active = false;
      serverSubscribers = Math.max(0, serverSubscribers - 1);
      bucket.subscribers.delete(sub);
      if (bucket.subscribers.size === 0 || bucket.dead) {
        if (!bucket.dead) bucket.destroy();
        if (projects.get(projectId) === bucket) projects.delete(projectId);
      }
    };
  }

  function close() {
    for (const bucket of projects.values()) bucket.destroy();
    projects.clear();
    serverSubscribers = 0;
  }

  return {
    subscribe,
    close,
    limits,
    subscriberCount() {
      return serverSubscribers;
    },
  };
}

class ProjectWatch {
  /**
   * @param {string} projectId
   * @param {string} projectDir
   * @param {string} dataDir
   * @param {typeof SSE_LIMITS} limits
   */
  constructor(projectId, projectDir, dataDir, limits) {
    this.projectId = projectId;
    this.projectDir = projectDir;
    this.dataDir = dataDir;
    this.limits = limits;
    this.projectName = basename(projectDir);
    this.parentDir = dirname(projectDir);
    /** @type {Set<{listener: (name: string, data: object) => void}>} */
    this.subscribers = new Set();
    /** @type {Map<string, import("node:fs").FSWatcher>} */
    this.watchers = new Map();
    this.parentWatcher = null;
    /** @type {Set<string>} */
    this.pending = new Set();
    this.refresh = false;
    this.timer = null;
    this.dead = false;
    this.failed = false;
    this.lastError = null;
  }

  emit(name, data) {
    for (const sub of [...this.subscribers]) {
      try {
        sub.listener(name, data);
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  fail(code, message) {
    if (this.failed || this.dead) return;
    this.failed = true;
    this.lastError = { code, message };
    this.emit("error", this.lastError);
    this.destroy();
  }

  relOf(abs) {
    const rel = posixRel(this.projectDir, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel === "" ? "." : rel;
  }

  emitDeleted() {
    if (this.dead) return;
    this.emit("deleted", {});
    this.destroy();
  }

  ensureWatching() {
    if (this.dead) return false;
    this.watchParent();
    if (this.failed || this.dead) return false;
    if (!this.watchDir(this.projectDir)) return false;
    this.walk(this.projectDir, new Set());
    if (this.failed || this.dead) return false;
    return true;
  }

  watchParent() {
    if (this.parentWatcher) return;
    const parent = this.parentDir;
    if (!contained(this.dataDir, parent) && resolve(parent) !== resolve(this.dataDir)) {
      return;
    }
    try {
      this.parentWatcher = watch(parent, (_eventType, filename) => {
        if (this.dead) return;
        const hit = !filename || String(filename) === this.projectName;
        if (!hit) return;
        if (!existsSync(this.projectDir)) this.emitDeleted();
      });
      this.parentWatcher.on("error", () => {
        if (this.dead) return;
        if (!existsSync(this.projectDir)) {
          this.emitDeleted();
          return;
        }
        this.fail("WATCH_ERROR", "Filesystem watch failed");
      });
    } catch {
      this.fail("WATCH_ERROR", "Filesystem watch failed");
    }
  }

  walk(dir, visited) {
    if (this.dead || this.failed) return;
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      real = resolve(dir);
    }
    if (visited.has(real)) return;
    visited.add(real);
    if (!contained(this.projectDir, dir) && resolve(dir) !== resolve(this.projectDir)) {
      this.fail("WATCH_SYMLINK", "Symlink escape rejected");
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (this.dead || this.failed) return;
      if (ent.name.startsWith(".")) continue;
      const child = join(dir, ent.name);
      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        if (!contained(this.projectDir, child)) {
          this.fail("WATCH_SYMLINK", "Symlink escape rejected");
          return;
        }
        try {
          isDir = statSync(child).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;
      if (!this.watchDir(child)) return;
      this.walk(child, visited);
    }
  }

  watchDir(abs) {
    if (this.dead || this.failed) return false;
    if (!contained(this.projectDir, abs) && resolve(abs) !== resolve(this.projectDir)) {
      this.fail("WATCH_SYMLINK", "Symlink escape rejected");
      return false;
    }
    const rel = this.relOf(abs);
    if (rel == null) {
      this.fail("WATCH_SYMLINK", "Symlink escape rejected");
      return false;
    }
    if (this.watchers.has(rel)) return true;
    if (this.watchers.size >= this.limits.watchedDirsPerProject) {
      this.fail("WATCHER_LIMIT", "Watched directory cap exceeded");
      return false;
    }
    try {
      const watcher = watch(abs, (_eventType, filename) => {
        this.onFs(abs, filename);
      });
      watcher.on("error", () => this.onWatchError());
      this.watchers.set(rel, watcher);
      return true;
    } catch {
      this.fail("WATCH_ERROR", "Filesystem watch failed");
      return false;
    }
  }

  closeWatchersUnder(rel) {
    const prefix = rel === "." ? null : `${rel}/`;
    for (const key of [...this.watchers.keys()]) {
      if (key === rel || (prefix && key.startsWith(prefix))) {
        try {
          this.watchers.get(key).close();
        } catch {
          // already closed
        }
        this.watchers.delete(key);
      }
    }
  }

  attachTree(abs) {
    if (this.dead || this.failed) return;
    const rel = this.relOf(abs);
    if (rel == null) {
      this.fail("WATCH_SYMLINK", "Symlink escape rejected");
      return;
    }
    this.closeWatchersUnder(rel);
    if (!this.watchDir(abs)) return;
    this.walk(abs, new Set());
  }

  onWatchError() {
    if (this.dead) return;
    if (!existsSync(this.projectDir)) {
      this.emitDeleted();
      return;
    }
    this.fail("WATCH_ERROR", "Filesystem watch failed");
  }

  onFs(watchedAbs, filename) {
    if (this.dead || this.failed) return;
    if (!existsSync(this.projectDir)) {
      this.emitDeleted();
      return;
    }
    const unknown = filename == null || filename === "";
    if (unknown) {
      this.refresh = true;
      try {
        const st = lstatSync(watchedAbs);
        const isDir =
          st.isDirectory() || (st.isSymbolicLink() && statSync(watchedAbs).isDirectory());
        if (isDir && contained(this.projectDir, watchedAbs)) this.attachTree(watchedAbs);
      } catch {
        const watchedRel = this.relOf(watchedAbs);
        if (watchedRel && this.watchers.has(watchedRel)) this.closeWatchersUnder(watchedRel);
      }
      this.scheduleFlush();
      return;
    }
    const abs = join(watchedAbs, String(filename));
    const rel = this.relOf(abs);
    if (rel == null) {
      this.fail("WATCH_SYMLINK", "Symlink escape rejected");
      return;
    }
    if (rel === ".") {
      this.refresh = true;
    } else if (!isHiddenRel(rel)) {
      if (this.pending.size < this.limits.maxPendingPaths) this.pending.add(rel);
      else this.refresh = true;
    }
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink() && !contained(this.projectDir, abs)) {
        this.fail("WATCH_SYMLINK", "Symlink escape rejected");
        return;
      }
      const isDir =
        st.isDirectory() || (st.isSymbolicLink() && statSync(abs).isDirectory());
      if (isDir && contained(this.projectDir, abs)) {
        this.attachTree(abs);
      }
    } catch {
      if (rel && this.watchers.has(rel)) this.closeWatchersUnder(rel);
    }
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.dead || this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.limits.debounceMs);
  }

  flush() {
    this.timer = null;
    if (this.dead) return;
    if (!existsSync(this.projectDir)) {
      this.emitDeleted();
      return;
    }
    let paths = [...this.pending].filter((p) => p && p !== ".");
    this.pending.clear();
    let refresh = this.refresh;
    this.refresh = false;
    const etag = sourceEtag(
      this.projectDir,
      this.limits.sourceBytesCap || RESOURCE_LIMITS.totalStringBytes,
    );
    if (paths.length === 0 && !refresh) return;
    /** @type {{ paths: string[], etag?: string, refresh?: boolean }} */
    let payload = { paths };
    if (etag) payload.etag = etag;
    if (refresh) payload.refresh = true;
    while (paths.length > 1 && Buffer.byteLength(JSON.stringify(payload), "utf8") > this.limits.maxEventBytes) {
      paths = paths.slice(0, Math.max(1, paths.length - 1));
      refresh = true;
      payload = { paths, refresh: true };
      if (etag) payload.etag = etag;
    }
    this.emit("changed", payload);
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    this.watchers.clear();
    if (this.parentWatcher) {
      try {
        this.parentWatcher.close();
      } catch {
        // already closed
      }
      this.parentWatcher = null;
    }
    this.subscribers.clear();
    this.pending.clear();
    this.refresh = false;
  }
}
