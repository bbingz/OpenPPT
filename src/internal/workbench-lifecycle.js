/**
 * Pure workbench lifecycle decisions: route generation, delayed load/save
 * completions, and SSE reconcile. Shared by Studio and tests.
 */

export function isHomeRoute(hash) {
  const h = hash || "#/";
  return h === "#" || h === "#/" || h === "";
}

export function isWorkbenchRoute(hash, id) {
  return (hash || "") === `#/p/${id}`;
}

export function effectIsCurrent(generation, currentGeneration) {
  return generation === currentGeneration;
}

export function effectIsLive({
  generation,
  currentGeneration,
  disposed = false,
  terminal = false,
}) {
  return !disposed && !terminal && generation === currentGeneration;
}

export function mutationInFlight({ saveGate = null, patchGate = null, loadGate = null } = {}) {
  return Boolean(saveGate || patchGate || loadGate);
}

/** Frozen Studio PUT writes source with a trailing newline. */
export function putPersistedSource(submitted) {
  return submitted.endsWith("\n") ? submitted : `${submitted}\n`;
}

/**
 * After a successful PUT: adopt the persisted (newline-normalized) bytes as
 * saved/base. A still-matching editor reloads those bytes; newer input is kept.
 */
export function applyPutSuccess({ submitted, current, persistedSource, persistedEtag }) {
  if (current === submitted) {
    return {
      saved: persistedSource,
      baseEtag: persistedEtag,
      editor: persistedSource,
      dirty: false,
    };
  }
  return {
    saved: persistedSource,
    baseEtag: persistedEtag,
    editor: current,
    dirty: true,
  };
}

/**
 * Explicit load-disk GET settled. Input typed after the fetch began keeps
 * the exact newer draft and the original base ETag.
 */
export function applyLoadDiskResult({
  submitted,
  current,
  fetchedSource,
  fetchedEtag,
  originalEtag,
}) {
  if (current !== submitted) {
    return {
      apply: false,
      source: current,
      baseEtag: originalEtag,
      conflict: true,
    };
  }
  return {
    apply: true,
    source: fetchedSource,
    baseEtag: fetchedEtag,
    conflict: false,
  };
}

export function parseSsePayload(data) {
  if (data == null || data === "") return {};
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // native EventSource error has no JSON payload
  }
  return {};
}

function inactive({ generation, currentGeneration, disposed = false, terminal = false }) {
  return !effectIsLive({ generation, currentGeneration, disposed, terminal });
}

/**
 * Named SSE events vs the native EventSource connection error (reconnect).
 * Typed watcher failures and deletion are terminal; empty error is ignored.
 * busy = PUT/PATCH/load in flight; fetching = one authoritative GET in flight.
 */
export function decideSseDispatch({
  generation,
  currentGeneration,
  eventName,
  busy = false,
  fetching = false,
  errorCode = null,
  disposed = false,
  terminal = false,
}) {
  if (inactive({ generation, currentGeneration, disposed, terminal })) return { action: "ignore" };
  if (eventName === "deleted") return { action: "deleted" };
  if (eventName === "error") {
    if (errorCode) return { action: "error" };
    return { action: "ignore" };
  }
  if (eventName !== "ready" && eventName !== "changed" && eventName !== "refresh") {
    return { action: "ignore" };
  }
  if (busy || fetching) return { action: "queue" };
  return { action: "fetch" };
}

function diskMoved({ fetchedSource, saved, fetchedEtag, currentEtag }) {
  if (fetchedEtag != null && currentEtag != null) return fetchedEtag !== currentEtag;
  return fetchedSource !== saved;
}

/**
 * After an authoritative GET: reload only a clean editor whose disk snapshot
 * moved. Same ETag is the same authority even if local saved lacks PUT's
 * trailing newline. Dirty/conflicted/invalid keep exact text + original ETag.
 * Unchanged source (media/page-only or own write) only refreshes preview.
 * Terminal/disposed workbenches ignore late GET/validate completions.
 */
export function decideReconcile({
  generation,
  currentGeneration,
  busy = false,
  disposed = false,
  terminal = false,
  editorChangedDuringFetch = false,
  editorValue,
  saved,
  conflicted = false,
  invalid = false,
  fetchedSource,
  fetchedEtag,
  currentEtag,
}) {
  if (inactive({ generation, currentGeneration, disposed, terminal })) return { action: "ignore" };
  if (busy) return { action: "queue" };
  const moved = diskMoved({ fetchedSource, saved, fetchedEtag, currentEtag });
  if (editorChangedDuringFetch) {
    return { action: moved ? "keep-conflict" : "keep" };
  }
  const dirty = editorValue !== saved || conflicted || invalid;
  if (!moved) return { action: "preview-only" };
  if (!dirty) return { action: "reload", source: fetchedSource, etag: fetchedEtag };
  return { action: "keep-conflict" };
}
