/* OpenPPT Studio — vanilla ES module, no build step, offline only. */

import {
  inspectAuthoringSelection,
  inspectorAddRootText,
  inspectorPatchOperations,
  inspectorRemove,
  locateAuthoringIdToken,
  nextRootTextId,
} from "/authoring-source.js";
import {
  applyLoadDiskResult,
  applyPutSuccess,
  decideReconcile,
  decideSseDispatch,
  effectIsCurrent,
  effectIsLive,
  isHomeRoute,
  mutationInFlight,
  isWorkbenchRoute,
  parseSsePayload,
  putPersistedSource,
} from "/workbench-lifecycle.js";

const appEl = document.getElementById("app");
const toastsEl = document.getElementById("toasts");

let meta = { version: "?", themes: ["default"], dataDir: "", limits: {} };

/* ---------------- helpers ---------------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value; // trusted static chrome only
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, kind = "ok", ms = 3400) {
  const node = el("div", { class: `toast ${kind}` }, [message]);
  toastsEl.append(node);
  setTimeout(() => node.remove(), ms);
}

async function apiRaw(path, options = {}) {
  const res = await fetch(path, options);
  const type = res.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.code = body?.error?.code || String(res.status);
    err.status = res.status;
    err.details = body?.error?.details;
    err.etag = res.headers.get("etag");
    throw err;
  }
  return { body, res, etag: res.headers.get("etag") };
}

async function api(path, options = {}) {
  return (await apiRaw(path, options)).body;
}

function readStoredDraft(raw) {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.openpptDraft === 1 &&
      typeof parsed.source === "string"
    ) {
      return {
        source: parsed.source,
        baseEtag: typeof parsed.baseEtag === "string" && parsed.baseEtag ? parsed.baseEtag : null,
        versioned: true,
      };
    }
  } catch {
    // legacy plain-string (or non-JSON) draft
  }
  return { source: raw, baseEtag: null, versioned: false };
}

function writeStoredDraft(key, source, baseEtag) {
  localStorage.setItem(key, JSON.stringify({ openpptDraft: 1, source, baseEtag }));
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function lineColFromIndex(source, index) {
  const upto = source.slice(0, Math.max(0, index));
  const line = (upto.match(/\n/g) || []).length + 1;
  const col = index - upto.lastIndexOf("\n");
  return { line, col };
}

function externalPageLocationMessage(paths) {
  const listed = paths.join(", ");
  return `只读：deck.json 引用了外部页文件（${listed}）。编辑器只显示清单，定位此处会得到错误偏移。请打开对应页文件，或把页内联进 deck.json。`;
}

/* ---------------- routing ---------------- */

let routeGeneration = 0;

function route() {
  const gen = ++routeGeneration;
  const hash = location.hash || "#/";
  const match = hash.match(/^#\/p\/([a-z0-9-]+)$/);
  if (match) renderWorkbench(match[1], gen);
  else renderHome(gen);
}

window.addEventListener("hashchange", route);

/* ---------------- home ---------------- */

async function renderHome(gen = routeGeneration) {
  appEl.replaceChildren(el("div", { class: "boot", text: "加载项目列表…" }));
  let projects = [];
  try {
    const data = await api("/api/projects");
    if (!effectIsCurrent(gen, routeGeneration) || !isHomeRoute(location.hash)) return;
    projects = data.projects;
  } catch (err) {
    if (!effectIsCurrent(gen, routeGeneration) || !isHomeRoute(location.hash)) return;
    appEl.replaceChildren(el("div", { class: "boot", text: `无法连接服务:${err.message}` }));
    return;
  }
  if (!effectIsCurrent(gen, routeGeneration) || !isHomeRoute(location.hash)) return;

  const topbar = el("div", { class: "topbar" }, [
    el("div", { class: "brand" }, [
      el("img", { src: "/favicon.svg", alt: "" }),
      "OpenPPT Studio",
      el("span", { class: "ver", text: `v${meta.version}` }),
    ]),
    el("div", { class: "spacer" }),
    el("span", { class: "crumb", text: meta.dataDir }),
  ]);

  const newDefs = [
    { mode: "blank", ic: "▦", title: "空白项目", desc: "两页起步:封面 + 表格示例" },
    { mode: "skeleton", ic: "◧", title: "演示骨架", desc: "封面 · 目录 · 正文 · 结尾四页" },
    { mode: "outline", ic: "≣", title: "从大纲生成", desc: "粘贴 Markdown(# 标题 / ## 节 / - 要点)" },
    { mode: "import", ic: "⇪", title: "导入 PPTX", desc: "有损导入:文本 / 形状 / 图片 / 表格" },
  ];
  const newgrid = el("div", { class: "newgrid" },
    newDefs.map((def) =>
      el("button", { class: "newcard", onclick: () => openCreateDialog(def.mode) }, [
        el("div", { class: "ic", text: def.ic }),
        el("h3", { text: def.title }),
        el("p", { text: def.desc }),
      ]),
    ),
  );

  const grid = el("div", { class: "projectgrid" });
  for (const project of projects) {
    grid.append(
      el("div", { class: "projectcard" }, [
        el("div", { class: "title", text: project.title || project.id }),
        el("div", { class: "meta", text: `${project.id} · ${project.pages ?? "?"} 页 · ${fmtTime(project.updatedAt)}` }),
        el("div", { class: "row" }, [
          el("button", { class: "btn primary grow", text: "打开", onclick: () => { location.hash = `#/p/${project.id}`; } }),
          el("button", { class: "btn", text: "导出", onclick: () => downloadExport(project.id) }),
          el("button", {
            class: "btn", text: "复制",
            onclick: async () => {
              try {
                await api(`/api/projects/${project.id}/duplicate`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ title: `${project.title || project.id} 副本` }),
                });
                toast("已复制为新项目");
                renderHome();
              } catch (err) { toast(`复制失败:${err.message}`, "err"); }
            },
          }),
          el("button", {
            class: "btn danger", text: "删除",
            onclick: async () => {
              if (!confirm(`删除项目 “${project.title || project.id}”?文件夹将被移除,不可恢复。`)) return;
              try {
                await api(`/api/projects/${project.id}`, { method: "DELETE" });
                toast("项目已删除");
                renderHome();
              } catch (err) { toast(`删除失败:${err.message}`, "err"); }
            },
          }),
        ]),
      ]),
    );
  }

  const home = el("div", { class: "home" }, [
    el("div", { class: "hero" }, [
      el("h1", { text: "你的演示项目" }),
      el("p", {}, [
        "每个项目就是磁盘上的一个文件夹(deck.json + media/),与命令行完全互通:",
        el("code", { text: " bun bin/openppt.js export <dir>/deck.json -o out.pptx " }),
      ]),
    ]),
    newgrid,
    el("div", { class: "sectiontitle" }, [
      el("h2", { text: "项目" }),
      el("span", { class: "hint", text: `${projects.length} 个 · 存放于 ${meta.dataDir}` }),
    ]),
    projects.length ? grid : el("div", { class: "empty", text: "还没有项目 — 从上面四种方式任选其一开始。" }),
  ]);

  appEl.replaceChildren(topbar, home, el("div", { class: "footer", text: `OpenPPT Studio · 本地离线服务 · 数据目录 ${meta.dataDir}` }));
}

/* ---------------- create dialog ---------------- */

function openCreateDialog(initialMode) {
  let mode = initialMode;
  const dialog = el("dialog", { class: "modal" });

  const titleInput = el("input", { type: "text", name: "title", value: "", placeholder: "例如:Q3 产品评审" });
  const themeSelect = el("select", { name: "theme" }, meta.themes.map((t) => el("option", { value: t, text: t })));
  const outlineArea = el("textarea", { name: "outline", placeholder: "# 演示标题\n## 第一节\n- 要点一\n- 要点二\n## 第二节\n- 要点三" });
  const fileInput = el("input", { type: "file", name: "file", accept: ".pptx" });

  const outlineField = el("div", { class: "field" }, [el("label", { text: "Markdown 大纲" }), outlineArea]);
  const importField = el("div", { class: "field" }, [el("label", { text: "PPTX 文件" }), fileInput]);
  const titleField = el("div", { class: "field" }, [el("label", { text: "标题" }), titleInput]);
  const themeField = el("div", { class: "field" }, [el("label", { text: "主题" }), themeSelect]);

  const modeDefs = [
    ["blank", "空白项目", "两页起步"],
    ["skeleton", "演示骨架", "四页 pitch 结构"],
    ["outline", "从大纲", "Markdown → 多页"],
    ["import", "导入 PPTX", "有损导入现有文件"],
  ];
  const modeButtons = new Map();
  const modes = el("div", { class: "modes" },
    modeDefs.map(([value, label, sub]) => {
      const btn = el("button", {
        class: "mode", type: "button",
        onclick: () => { mode = value; sync(); },
      }, [label, el("small", { text: sub })]);
      modeButtons.set(value, btn);
      return btn;
    }),
  );

  function sync() {
    for (const [value, btn] of modeButtons) btn.classList.toggle("active", value === mode);
    outlineField.style.display = mode === "outline" ? "" : "none";
    importField.style.display = mode === "import" ? "" : "none";
    titleField.style.display = mode === "import" ? "none" : "";
    themeField.style.display = mode === "import" ? "none" : "";
  }

  const submit = el("button", { class: "btn primary", text: "创建" });
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      let created;
      if (mode === "import") {
        const file = fileInput.files?.[0];
        if (!file) throw new Error("请选择一个 .pptx 文件");
        const form = new FormData();
        form.append("file", file);
        created = await api("/api/import", { method: "POST", body: form });
        if (created.warnings?.length) toast(`导入完成,${created.warnings.length} 条警告(详见项目)`, "ok", 5000);
      } else {
        created = await api("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode,
            title: titleInput.value.trim() || "Untitled deck",
            theme: themeSelect.value,
            outline: mode === "outline" ? outlineArea.value : undefined,
          }),
        });
      }
      dialog.close();
      dialog.remove();
      toast("项目已创建");
      location.hash = `#/p/${created.project.id}`;
    } catch (err) {
      toast(`创建失败:${err.message}`, "err", 6000);
      submit.disabled = false;
    }
  });

  dialog.append(
    el("div", { class: "modalhead" }, [el("h3", { text: "新建项目" })]),
    el("div", { class: "modalbody" }, [modes, titleField, themeField, outlineField, importField]),
    el("div", { class: "modalfoot" }, [
      el("button", { class: "btn ghost", text: "取消", onclick: () => { dialog.close(); dialog.remove(); } }),
      submit,
    ]),
  );
  document.body.append(dialog);
  sync();
  dialog.showModal();
}

/* ---------------- export download ---------------- */

async function downloadExport(id, format = "pptx", live) {
  const still = typeof live === "function" ? live : () => true;
  try {
    const path = format === "pdf" ? `/api/projects/${id}/export.pdf` : `/api/projects/${id}/export`;
    const res = await fetch(path);
    if (!still()) return;
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      if (!still()) return;
      throw new Error(body?.error ? `[${body.error.code}] ${body.error.message}` : `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    if (!still()) return;
    const url = URL.createObjectURL(blob);
    const anchor = el("a", { href: url, download: `${id}.${format}` });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast(`${format.toUpperCase()} 已导出下载`);
  } catch (err) {
    if (!still()) return;
    toast(`导出失败:${err.message}`, "err", 7000);
  }
}

/* ---------------- workbench ---------------- */

async function renderWorkbench(id, gen = routeGeneration) {
  appEl.replaceChildren(el("div", { class: "boot", text: `打开项目 ${id}…` }));
  let project;
  let baseEtag;
  try {
    const loaded = await apiRaw(`/api/projects/${id}`);
    if (!effectIsCurrent(gen, routeGeneration) || !isWorkbenchRoute(location.hash, id)) return;
    project = loaded.body;
    baseEtag = loaded.etag;
  } catch (err) {
    if (!effectIsCurrent(gen, routeGeneration)) return;
    toast(`打开失败:${err.message}`, "err");
    location.hash = "#/";
    return;
  }
  if (!effectIsCurrent(gen, routeGeneration) || !isWorkbenchRoute(location.hash, id)) return;

  const draftKey = `openppt-draft-${id}`;
  let saved = project.source;
  const diskEtagAtLoad = baseEtag;
  let statusState = { kind: "ok", text: "已加载" };
  let patchGate = null;
  let saveGate = null;
  let loadGate = null;
  let reconcileGate = null;
  let pendingReconcile = false;
  let eventSource = null;
  let disposed = false;
  let terminal = false;
  let currentInspection = null;
  let selectedPageId = null;
  let selectedElementId = null;

  function stillHere() {
    return effectIsLive({
      generation: gen,
      currentGeneration: routeGeneration,
      disposed,
      terminal,
    });
  }

  function mutationBusy() {
    return mutationInFlight({ saveGate, patchGate, loadGate });
  }

  function markTerminal() {
    terminal = true;
    pendingReconcile = false;
  }

  /* --- top bar --- */
  const statusPill = el("span", { class: "statuspill ok", text: "已加载" });
  function setStatus(kind, text) {
    statusState = { kind, text };
    statusPill.className = `statuspill ${kind}`;
    statusPill.textContent = text;
  }

  const saveBtn = el("button", { class: "btn primary" }, ["保存", el("kbd", { text: "⌘S" })]);
  const validateBtn = el("button", { class: "btn", text: "校验" });
  const exportBtn = el("button", { class: "btn", text: "导出 PPTX" });
  const pdfBtn = meta.pdfAvailable
    ? el("button", { class: "btn", text: "导出 PDF", title: "经 LibreOffice 无头渲染" })
    : null;

  const topbar = el("div", { class: "topbar" }, [
    el("button", { class: "btn ghost", text: "← 项目", onclick: () => { location.hash = "#/"; } }),
    el("div", { class: "brand" }, [el("img", { src: "/favicon.svg", alt: "" }), project.title || id]),
    el("span", { class: "crumb", text: `${id}/${project.deckFile}` }),
    el("div", { class: "spacer" }),
    statusPill,
    validateBtn,
    saveBtn,
    exportBtn,
    pdfBtn,
  ]);

  /* --- editor pane --- */
  const gutter = el("div", { class: "gutter", text: "1" });
  const editor = el("textarea", { class: "editor", spellcheck: "false" });
  editor.value = saved;
  const storedDraft = readStoredDraft(localStorage.getItem(draftKey));
  if (storedDraft && storedDraft.source !== saved) {
    editor.value = storedDraft.source;
    // Never adopt the current disk ETag for a restored draft (including legacy
    // plain-string drafts that have no recorded base version).
    baseEtag = storedDraft.versioned ? storedDraft.baseEtag : null;
    writeStoredDraft(draftKey, editor.value, baseEtag);
    setStatus("dirty", storedDraft.baseEtag ? "有未保存草稿" : "有未保存草稿(无版本)");
  }

  const errMsg = el("span", { class: "msg" });
  const errJump = el("button", { class: "btn ghost", text: "定位", style: "padding:3px 10px;font-size:12px;" });
  const copyDraftBtn = el("button", {
    class: "btn ghost", text: "复制草稿",
    style: "padding:3px 10px;font-size:12px;display:none;",
  });
  const loadDiskBtn = el("button", {
    class: "btn ghost", text: "加载磁盘版本",
    style: "padding:3px 10px;font-size:12px;display:none;",
  });
  const errStrip = el("div", { class: "errstrip" }, [errMsg, errJump, copyDraftBtn, loadDiskBtn]);
  let errIndex = null;
  let conflictOpen = false;

  function hideConflictActions() {
    conflictOpen = false;
    copyDraftBtn.style.display = "none";
    loadDiskBtn.style.display = "none";
    errJump.style.display = "";
  }

  function showConflict(message) {
    conflictOpen = true;
    errIndex = null;
    errMsg.textContent = message;
    errJump.style.display = "none";
    copyDraftBtn.style.display = "";
    loadDiskBtn.style.display = "";
    errStrip.classList.add("show");
  }

  errJump.addEventListener("click", () => {
    if (errIndex == null) return;
    editor.focus();
    editor.setSelectionRange(errIndex, errIndex + 1);
  });
  copyDraftBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(editor.value);
      toast("已复制编辑器内容");
    } catch {
      toast("无法写入剪贴板,请手动全选复制", "err");
    }
  });
  loadDiskBtn.addEventListener("click", () => {
    if (saveGate || patchGate) return;
    if (loadGate) return loadGate;
    loadGate = runLoadDisk().finally(() => {
      loadGate = null;
      if (stillHere()) {
        refreshInspectorEnabled();
        flushPendingReconcile();
      }
    });
    refreshInspectorEnabled();
    return loadGate;
  });

  async function runLoadDisk() {
    if (saveGate || patchGate) return;
    const submitted = editor.value;
    const originalEtag = baseEtag;
    try {
      const fresh = await apiRaw(`/api/projects/${id}`);
      if (!stillHere()) return;
      const decision = applyLoadDiskResult({
        submitted,
        current: editor.value,
        fetchedSource: fresh.body.source,
        fetchedEtag: fresh.etag,
        originalEtag,
      });
      if (!decision.apply) {
        persistEditorDraft();
        showConflict("加载磁盘版本时编辑器已有新输入。草稿仍基于原版本。请复制草稿,或再次加载磁盘版本。");
        setStatus("bad", "保存冲突");
        return;
      }
      saved = decision.source;
      baseEtag = decision.baseEtag;
      editor.value = saved;
      localStorage.removeItem(draftKey);
      hideConflictActions();
      errStrip.classList.remove("show");
      setStatus("ok", "已加载磁盘版本");
      refreshGutter();
      checkSyntax();
      refreshInspectorEnabled();
      if (selectedPageId && selectedElementId) {
        currentInspection = inspectAuthoringSelection(editor.value, selectedPageId, selectedElementId);
        syncInspectorFields();
      }
      toast("已加载磁盘版本;先前草稿如需恢复请先点复制草稿");
    } catch (err) {
      if (!stillHere()) return;
      toast(`加载磁盘版本失败:${err.message}`, "err");
    }
  }

  if (storedDraft && storedDraft.source !== saved) {
    if (!baseEtag || baseEtag !== diskEtagAtLoad) {
      showConflict(
        baseEtag
          ? "保存冲突:磁盘版本与草稿基准不一致。编辑器与磁盘均未覆盖。请复制草稿,或加载磁盘版本后再粘贴保存。"
          : "草稿没有关联的磁盘版本。编辑器与磁盘均未覆盖。请复制草稿后加载磁盘版本,再粘贴保存。",
      );
    }
  }

  function refreshGutter() {
    const lines = editor.value.split("\n").length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
    gutter.scrollTop = editor.scrollTop;
  }

  function persistEditorDraft() {
    if (!stillHere()) return;
    if (editor.value === saved) localStorage.removeItem(draftKey);
    else writeStoredDraft(draftKey, editor.value, baseEtag);
  }

  function checkSyntax() {
    try {
      JSON.parse(editor.value);
      if (!conflictOpen) {
        errStrip.classList.remove("show");
        errIndex = null;
      }
      return true;
    } catch (err) {
      hideConflictActions();
      const match = String(err.message).match(/position (\d+)/i);
      if (match) {
        errIndex = Number(match[1]);
        const { line, col } = lineColFromIndex(editor.value, errIndex);
        errMsg.textContent = `JSON 语法错误 @ ${line}:${col} — ${err.message}`;
      } else {
        errIndex = null;
        errMsg.textContent = `JSON 语法错误 — ${err.message}`;
      }
      errStrip.classList.add("show");
      return false;
    }
  }

  let syntaxTimer = null;
  editor.addEventListener("input", () => {
    persistEditorDraft();
    if (editor.value !== saved) setStatus("dirty", "未保存");
    else if (!conflictOpen) setStatus("ok", "已加载");
    refreshGutter();
    clearTimeout(syntaxTimer);
    syntaxTimer = setTimeout(() => {
      if (!stillHere()) return;
      checkSyntax();
      refreshInspectorEnabled();
    }, 350);
    refreshInspectorEnabled();
  });
  editor.addEventListener("scroll", () => { gutter.scrollTop = editor.scrollTop; });
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      const { selectionStart: start, selectionEnd: end } = editor;
      editor.setRangeText("  ", start, end, "end");
      editor.dispatchEvent(new Event("input"));
    }
  });

  const leftPane = el("div", { class: "pane left" }, [
    el("div", { class: "panehead" }, [
      el("span", { class: "label", text: "deck.json" }),
      el("div", { class: "spacer" }),
      el("span", { class: "crumb", text: "草稿自动暂存于浏览器,保存后写入磁盘" }),
    ]),
    el("div", { class: "editorwrap" }, [gutter, editor]),
    errStrip,
  ]);

  /* --- right pane: tabs --- */
  const iframe = el("iframe", { sandbox: "allow-same-origin", title: "preview" });
  const selectionInfo = el("div", {
    class: "selectioninfo",
    text: "点击预览元素以查看 page / id / type",
  });
  const inspText = el("textarea", { id: "insp-text", class: "insp-text", rows: "2", spellcheck: "false" });
  const inspFont = el("input", { id: "insp-fontSize", type: "number", min: "1", step: "any", placeholder: "继承" });
  const inspX = el("input", { id: "insp-x", type: "number", step: "any" });
  const inspY = el("input", { id: "insp-y", type: "number", step: "any" });
  const inspW = el("input", { id: "insp-w", type: "number", step: "any" });
  const inspH = el("input", { id: "insp-h", type: "number", step: "any" });
  const inspApply = el("button", { id: "insp-apply", class: "btn", type: "button", text: "应用" });
  const inspAdd = el("button", { id: "insp-add", class: "btn", type: "button", text: "添加文本" });
  const inspRemove = el("button", { id: "insp-remove", class: "btn danger", type: "button", text: "删除" });
  const inspNote = el("div", { class: "inspector-note", id: "insp-note" });
  const inspLock = el("div", { class: "inspector-lock", id: "insp-lock" });
  const inspTextRow = el("div", { class: "inspector-row", id: "insp-text-row" }, [
    el("label", { for: "insp-text", text: "text" }),
    inspText,
  ]);
  const inspFontRow = el("div", { class: "inspector-row", id: "insp-font-row" }, [
    el("label", { for: "insp-fontSize", text: "fontSize" }),
    inspFont,
  ]);
  const inspBoundsRow = el("div", { class: "inspector-row", id: "insp-bounds-row" }, [
    el("label", { text: "bounds" }),
    el("div", { class: "inspector-bounds" }, [inspX, inspY, inspW, inspH]),
  ]);
  const inspector = el("div", { class: "inspector" }, [
    inspTextRow,
    inspFontRow,
    inspBoundsRow,
    el("div", { class: "inspector-actions" }, [inspApply, inspAdd, inspRemove]),
    inspNote,
    inspLock,
  ]);
  const previewPanel = el("div", { class: "tabpanel preview active" }, [iframe, selectionInfo, inspector]);
  const qaPanel = el("div", { class: "tabpanel" });
  const mediaPanel = el("div", { class: "tabpanel" });

  const tabDefs = [
    ["preview", "预览", previewPanel],
    ["qa", "QA", qaPanel],
    ["media", `媒体 (${project.media.length})`, mediaPanel],
  ];
  const tabButtons = new Map();
  const tabs = el("div", { class: "tabs" },
    tabDefs.map(([key, label, panel]) => {
      const btn = el("button", { class: `tab${key === "preview" ? " active" : ""}`, text: label });
      btn.addEventListener("click", () => {
        for (const [, other] of tabButtons) other.btn.classList.remove("active");
        for (const [, other] of tabButtons) other.panel.classList.remove("active");
        btn.classList.add("active");
        panel.classList.add("active");
        if (key === "qa") runQa();
        if (key === "media") renderMedia();
      });
      tabButtons.set(key, { btn, panel });
      return btn;
    }),
  );

  const refreshBtn = el("button", { class: "btn ghost", text: "刷新预览" });
  const rightPane = el("div", { class: "pane" }, [
    el("div", { class: "panehead" }, [tabs, el("div", { class: "spacer" }), refreshBtn]),
    el("div", { class: "tabbody" }, [previewPanel, qaPanel, mediaPanel]),
  ]);

  function leafTypeClass(node) {
    return [...node.classList].find((name) => name !== "el" && name !== "selected") || "";
  }

  function revealEditorRange(start, end) {
    editor.focus();
    editor.setSelectionRange(start, end);
    const line = (editor.value.slice(0, start).match(/\n/g) || []).length;
    const lineHeight = 20;
    editor.scrollTop = Math.max(0, (line - 3) * lineHeight);
  }

  function onPreviewPointer(event) {
    event.preventDefault();
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const leaf = target.closest(".el");
    if (!leaf || leaf.dataset.elId == null) return;
    const pageNode = leaf.closest(".page");
    const pageId = pageNode?.dataset.page;
    const elementId = leaf.dataset.elId;
    const type = leafTypeClass(leaf);
    if (pageId == null) return;

    const doc = iframe.contentDocument;
    if (doc) {
      for (const node of doc.querySelectorAll(".el.selected")) node.classList.remove("selected");
      leaf.classList.add("selected");
    }

    const snapshot = editor.value;
    selectedPageId = pageId;
    selectedElementId = elementId;
    currentInspection = inspectAuthoringSelection(snapshot, pageId, elementId);
    const located = locateAuthoringIdToken(snapshot, pageId, elementId);
    if (located.kind === "external" || currentInspection.kind === "external") {
      selectionInfo.className = "selectioninfo readonly";
      selectionInfo.textContent = `page ${pageId} · ${elementId} · ${type} — ${externalPageLocationMessage(located.paths || currentInspection.paths || [])}`;
    } else {
      selectionInfo.className = "selectioninfo active";
      selectionInfo.textContent = `page ${pageId} · ${elementId} · ${type}`;
    }
    syncInspectorFields();
    if (editor.value !== snapshot) return;
    if (located.kind === "ok") revealEditorRange(located.start, located.end);
  }

  function bindPreviewSelection() {
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.addEventListener("click", onPreviewPointer, true);
    doc.addEventListener("auxclick", onPreviewPointer, true);
  }
  iframe.addEventListener("load", bindPreviewSelection);

  function refreshPreview() {
    iframe.src = `/api/projects/${id}/preview?ts=${Date.now()}`;
  }
  refreshBtn.addEventListener("click", refreshPreview);

  function deckHasExternalPages(source) {
    try {
      const parsed = JSON.parse(source);
      return Boolean(parsed && Array.isArray(parsed.pages) && parsed.pages.some((page) => typeof page === "string"));
    } catch {
      return false;
    }
  }

  function patchActionsAllowed() {
    if (patchGate) return false;
    if (saveGate) return false;
    if (loadGate) return false;
    if (conflictOpen) return false;
    if (project.deckFile !== "deck.json") return false;
    if (!baseEtag) return false;
    if (editor.value !== saved) return false;
    if (deckHasExternalPages(editor.value)) return false;
    try {
      JSON.parse(editor.value);
    } catch {
      return false;
    }
    return true;
  }

  function refreshInspectorEnabled() {
    const allowed = patchActionsAllowed();
    const selectable = currentInspection && currentInspection.kind === "ok";
    inspApply.disabled = !allowed || !selectable;
    inspRemove.disabled = !allowed || !selectable;
    inspAdd.disabled = !allowed || !selectedPageId;
    saveBtn.disabled = Boolean(patchGate || loadGate);
    exportBtn.disabled = Boolean(patchGate || loadGate);
    if (pdfBtn) pdfBtn.disabled = Boolean(patchGate || loadGate);
    if (patchGate) inspLock.textContent = "PATCH 进行中";
    else if (saveGate) inspLock.textContent = "保存进行中";
    else if (loadGate) inspLock.textContent = "加载磁盘版本进行中";
    else if (project.deckFile !== "deck.json") inspLock.textContent = "仅 deck.json 支持检查器 PATCH";
    else if (conflictOpen) inspLock.textContent = "有保存冲突，检查器 PATCH 已禁用";
    else if (!baseEtag) inspLock.textContent = "版本未知，检查器 PATCH 已禁用";
    else if (editor.value !== saved) inspLock.textContent = "有未保存草稿，检查器 PATCH 已禁用";
    else if (deckHasExternalPages(editor.value)) inspLock.textContent = "外部页文件为只读，检查器 PATCH 已禁用";
    else {
      try {
        JSON.parse(editor.value);
        inspLock.textContent = "";
      } catch {
        inspLock.textContent = "JSON 无效，检查器 PATCH 已禁用";
      }
    }
  }

  function syncInspectorFields() {
    const ins = currentInspection;
    if (!ins || ins.kind !== "ok") {
      inspText.value = "";
      inspText.disabled = true;
      inspFont.value = "";
      inspFont.disabled = true;
      inspX.value = "";
      inspY.value = "";
      inspW.value = "";
      inspH.value = "";
      inspX.disabled = inspY.disabled = inspW.disabled = inspH.disabled = true;
      inspBoundsRow.style.display = "none";
      inspFontRow.style.display = "";
      if (ins && ins.kind === "invalid") inspNote.textContent = "JSON 无效，无法读取所选元素";
      else if (ins && ins.kind === "external") inspNote.textContent = "元素在外部页文件中，不能用检查器 PATCH";
      else inspNote.textContent = "";
      refreshInspectorEnabled();
      return;
    }
    if (ins.text.mode === "plain") {
      inspText.value = ins.text.value ?? "";
      inspText.disabled = false;
      inspNote.textContent = "";
    } else if (ins.text.mode === "runs" || ins.text.mode === "paragraphs") {
      inspText.value = "";
      inspText.disabled = true;
      inspNote.textContent = "该元素是结构化文本(runs/paragraphs)，不能压成纯字符串。请在 JSON 中编辑。";
    } else {
      inspText.value = "";
      inspText.disabled = true;
      inspNote.textContent = "";
    }
    if (ins.type === "text") {
      inspFontRow.style.display = "";
      inspFont.disabled = false;
      inspFont.value = ins.hasOwnFontSize ? String(ins.fontSize) : "";
      inspFont.placeholder = "继承";
    } else {
      inspFontRow.style.display = "none";
      inspFont.value = "";
      inspFont.disabled = true;
    }
    if (ins.geometry === "absolute") {
      inspBoundsRow.style.display = "";
      inspX.value = String(ins.bounds[0]);
      inspY.value = String(ins.bounds[1]);
      inspW.value = String(ins.bounds[2]);
      inspH.value = String(ins.bounds[3]);
      inspX.disabled = inspY.disabled = inspW.disabled = inspH.disabled = false;
    } else {
      inspBoundsRow.style.display = "none";
      inspX.disabled = inspY.disabled = inspW.disabled = inspH.disabled = true;
      if (ins.geometry === "group-child") {
        const geo = "组内子元素使用布局尺寸，不能写成画布绝对 bounds。";
        inspNote.textContent = inspNote.textContent ? `${inspNote.textContent} ${geo}` : geo;
      }
    }
    refreshInspectorEnabled();
  }

  function collectInspectorEdits(ins) {
    const edits = {};
    if (ins.text.mode === "plain" && !inspText.disabled) edits.text = inspText.value;
    if (ins.type === "text" && !inspFont.disabled && inspFont.value !== "") {
      const size = Number(inspFont.value);
      if (Number.isFinite(size)) edits.fontSize = size;
    }
    if (ins.geometry === "absolute") {
      const bounds = [Number(inspX.value), Number(inspY.value), Number(inspW.value), Number(inspH.value)];
      if (bounds.every((n) => Number.isFinite(n))) edits.bounds = bounds;
    }
    return edits;
  }

  async function runPatch(operations) {
    if (patchGate || !patchActionsAllowed()) return false;
    const submitted = editor.value;
    const submittedEtag = baseEtag;
    patchGate = runPatchInner(operations, submitted, submittedEtag).finally(() => {
      patchGate = null;
      if (stillHere()) refreshInspectorEnabled();
      flushPendingReconcile();
    });
    refreshInspectorEnabled();
    return patchGate;
  }

  async function runPatchInner(operations, submitted, submittedEtag) {
    try {
      const result = await apiRaw(`/api/projects/${id}/deck`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "If-Match": submittedEtag,
        },
        body: JSON.stringify({ operations }),
      });
      if (!stillHere()) return false;
      const newSource = result.body.source;
      saved = newSource;
      if (editor.value === submitted) {
        baseEtag = result.etag || submittedEtag;
        editor.value = newSource;
        persistEditorDraft();
        hideConflictActions();
        errStrip.classList.remove("show");
        setStatus("ok", "已保存");
        refreshGutter();
        checkSyntax();
        if (selectedPageId && selectedElementId) {
          currentInspection = inspectAuthoringSelection(editor.value, selectedPageId, selectedElementId);
          syncInspectorFields();
        }
      } else {
        persistEditorDraft();
        showConflict(
          "检查器已写入磁盘,但编辑器在请求期间有新输入。草稿仍基于原版本,未改用新 ETag。请复制草稿,或加载磁盘版本。",
        );
        setStatus("bad", "保存冲突");
      }
      refreshPreview();
      toast("检查器已更新");
      return true;
    } catch (err) {
      if (!stillHere()) return false;
      persistEditorDraft();
      const detail = `[${err.code || "ERR"}] ${err.message}`;
      if (err.status === 412 || err.status === 428) {
        showConflict(`保存冲突:${detail} 编辑器与磁盘均未覆盖。请复制草稿,或加载磁盘版本。`);
        setStatus("bad", "保存冲突");
        toast(`检查器冲突:${detail}`, "err", 8000);
      } else {
        errMsg.textContent = detail;
        errIndex = null;
        if (!conflictOpen) errStrip.classList.add("show");
        setStatus("bad", "PATCH 失败");
        toast(`检查器失败:${detail}`, "err", 8000);
      }
      return false;
    }
  }

  inspApply.addEventListener("click", async () => {
    if (!currentInspection || currentInspection.kind !== "ok") return;
    const built = inspectorPatchOperations(currentInspection, collectInspectorEdits(currentInspection));
    if (!built.ok) {
      if (built.reason === "noop") toast("没有需要提交的更改");
      else if (built.reason === "structured-text") toast("不能把结构化文本压成纯字符串", "err");
      else if (built.reason === "group-geometry") toast("组内子元素不能写成绝对 bounds", "err");
      return;
    }
    await runPatch(built.operations);
  });
  inspAdd.addEventListener("click", async () => {
    if (!selectedPageId || !patchActionsAllowed()) return;
    let deck;
    try {
      deck = JSON.parse(editor.value);
    } catch {
      return;
    }
    const newId = nextRootTextId(deck);
    await runPatch(
      inspectorAddRootText(selectedPageId, {
        id: newId,
        type: "text",
        bounds: [40, 40, 800, 80],
        text: "New text",
        fontSize: 18,
      }),
    );
  });
  inspRemove.addEventListener("click", async () => {
    if (!selectedPageId || !selectedElementId) return;
    await runPatch(inspectorRemove(selectedPageId, selectedElementId));
  });
  refreshInspectorEnabled();

  async function runQa() {
    qaPanel.replaceChildren(el("div", { class: "boot", text: "运行结构 QA…" }));
    try {
      const result = await api(`/api/projects/${id}/qa`);
      const items = [];
      items.push(
        result.ok
          ? el("div", { class: "qaok" }, [`通过(fail-on: ${result.failOn})— ${result.issues.length} 条提示`])
          : el("div", { class: "qaissue high", style: "margin:16px 16px 0;" }, [
              el("div", { class: "head" }, [el("span", { class: "badge high", text: "FAIL" }), el("span", { class: "msg", text: `未达标(fail-on: ${result.failOn})` })]),
            ]),
      );
      const list = el("div", { class: "qalist" });
      for (const issue of result.issues) {
        list.append(
          el("div", { class: `qaissue ${issue.severity}` }, [
            el("div", { class: "head" }, [
              el("span", { class: `badge ${issue.severity}`, text: issue.severity }),
              el("span", { class: "code", text: `${issue.code} · ${issue.pageId || ""}` }),
            ]),
            el("div", { class: "msg", text: issue.message }),
          ]),
        );
      }
      if (!result.issues.length) list.append(el("div", { class: "boot", text: "没有发现布局问题。" }));
      qaPanel.replaceChildren(...items, list);
    } catch (err) {
      qaPanel.replaceChildren(
        el("div", { class: "qaissue high", style: "margin:16px;" }, [
          el("div", { class: "head" }, [el("span", { class: "badge high", text: err.code || "ERR" })]),
          el("div", { class: "msg", text: err.message }),
        ]),
      );
    }
  }

  async function renderMedia() {
    mediaPanel.replaceChildren(el("div", { class: "boot", text: "读取媒体…" }));
    let current;
    try {
      current = await api(`/api/projects/${id}`);
    } catch (err) {
      mediaPanel.replaceChildren(el("div", { class: "boot", text: err.message }));
      return;
    }
    tabButtons.get("media").btn.textContent = `媒体 (${current.media.length})`;

    const uploadInput = el("input", { type: "file", accept: ".png,.jpg,.jpeg,.gif,.webp,.svg", multiple: "", style: "display:none" });
    uploadInput.addEventListener("change", async () => {
      for (const file of uploadInput.files) {
        try {
          const form = new FormData();
          form.append("file", file);
          const info = await api(`/api/projects/${id}/media`, { method: "POST", body: form });
          toast(`已上传 ${info.name} — 在 deck 中引用 "${info.src}"`);
        } catch (err) {
          toast(`上传 ${file.name} 失败:${err.message}`, "err", 6000);
        }
      }
      renderMedia();
    });

    const bar = el("div", { class: "mediabar" }, [
      el("button", { class: "btn", text: "上传图片", onclick: () => uploadInput.click() }),
      el("span", { text: `允许 png/jpg/gif/webp/svg,单文件 ≤ ${fmtBytes(meta.limits.mediaBytesPerFile || 33554432)};在 deck 中用 "media/<文件名>" 引用` }),
      uploadInput,
    ]);

    const grid = el("div", { class: "mediagrid" });
    for (const item of current.media) {
      const src = `/api/projects/${id}/media/${item.name}`;
      grid.append(
        el("div", { class: "mediaitem" }, [
          el("div", { class: "thumb" }, [el("img", { src, alt: item.name, loading: "lazy" })]),
          el("div", { class: "info" }, [
            el("div", { class: "name", text: item.name }),
            el("div", { class: "sub" }, [
              el("span", { text: fmtBytes(item.size) }),
              el("div", { class: "ops" }, [
                el("button", {
                  class: "iconbtn", text: "复制引用", title: "复制 media/ 路径",
                  onclick: async () => {
                    try { await navigator.clipboard.writeText(`media/${item.name}`); toast("已复制引用路径"); }
                    catch { toast(`引用路径:media/${item.name}`, "ok", 6000); }
                  },
                }),
                el("button", {
                  class: "iconbtn danger", text: "删除",
                  onclick: async () => {
                    if (!confirm(`删除媒体 ${item.name}?`)) return;
                    try { await api(`/api/projects/${id}/media/${item.name}`, { method: "DELETE" }); renderMedia(); }
                    catch (err) { toast(`删除失败:${err.message}`, "err"); }
                  },
                }),
              ]),
            ]),
          ]),
        ]),
      );
    }
    if (!current.media.length) grid.append(el("div", { class: "empty", style: "grid-column:1/-1", text: "media/ 目前为空 — 上传后即可在 deck 中引用。" }));
    mediaPanel.replaceChildren(bar, grid);
  }

  /* --- actions --- */

  function isEditorPending() {
    return conflictOpen || editor.value !== saved;
  }

  function markPendingStatus() {
    persistEditorDraft();
    if (conflictOpen) {
      if (statusState.kind === "ok" || /校验通过/.test(statusState.text || "")) {
        setStatus("bad", "保存冲突");
      }
      return;
    }
    if (editor.value !== saved) setStatus("dirty", "未保存");
  }

  async function doValidate({ silent = false } = {}) {
    try {
      const result = await api(`/api/projects/${id}/validate`, { method: "POST" });
      if (!stillHere()) return false;
      persistEditorDraft();
      if (result.ok) {
        if (isEditorPending()) {
          markPendingStatus();
          if (!silent) toast("磁盘校验通过(未校验编辑器内容)");
        } else {
          setStatus("ok", `校验通过 · ${result.pages} 页`);
          if (!silent) toast("校验通过");
        }
      } else {
        setStatus("bad", `[${result.error.code}]`);
        if (!silent) toast(`[${result.error.code}] ${result.error.message}`, "err", 8000);
        errMsg.textContent = `[${result.error.code}] ${result.error.message}`;
        errIndex = null;
        errStrip.classList.add("show");
        if (isEditorPending()) persistEditorDraft();
      }
      return result.ok;
    } catch (err) {
      if (!stillHere()) return false;
      persistEditorDraft();
      if (isEditorPending()) markPendingStatus();
      else setStatus("bad", "校验异常");
      if (!silent) toast(`校验异常:${err.message}`, "err", 8000);
      return false;
    }
  }

  async function doSave() {
    if (patchGate || loadGate) return false;
    if (saveGate) return saveGate;
    saveGate = doSaveInner().finally(() => {
      saveGate = null;
      if (stillHere()) refreshInspectorEnabled();
      flushPendingReconcile();
    });
    refreshInspectorEnabled();
    return saveGate;
  }

  async function doSaveInner() {
    if (!checkSyntax()) {
      setStatus("bad", "JSON 语法错误");
      toast("JSON 语法错误,未保存", "err");
      return false;
    }
    const submitted = editor.value;
    const submittedEtag = baseEtag;
    if (!submittedEtag) {
      persistEditorDraft();
      showConflict("无法保存:草稿没有关联的磁盘版本。编辑器与磁盘均未覆盖。请复制草稿后加载磁盘版本,再粘贴保存。");
      setStatus("bad", "版本未知");
      toast("无法保存:草稿没有关联的磁盘版本", "err", 8000);
      return false;
    }
    try {
      const result = await apiRaw(`/api/projects/${id}/deck`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": submittedEtag,
        },
        body: submitted,
      });
      if (!stillHere()) return false;
      const applied = applyPutSuccess({
        submitted,
        current: editor.value,
        persistedSource: putPersistedSource(submitted),
        persistedEtag: result.etag || submittedEtag,
      });
      saved = applied.saved;
      baseEtag = applied.baseEtag;
      if (!applied.dirty) editor.value = applied.editor;
      persistEditorDraft();
      hideConflictActions();
      if (applied.dirty) {
        setStatus("dirty", "未保存");
      } else {
        errStrip.classList.remove("show");
        setStatus("ok", "已保存");
        refreshGutter();
      }
      const ok = await doValidate({ silent: true });
      if (!stillHere()) return true;
      if (ok) refreshPreview();
      if (tabButtons.get("qa").panel.classList.contains("active")) runQa();
      const stillDirty = editor.value !== saved;
      if (stillDirty) {
        persistEditorDraft();
        setStatus("dirty", "未保存");
      }
      toast(
        stillDirty
          ? (ok ? "已保存,仍有未提交修改" : "已保存(校验未通过);仍有未提交修改")
          : (ok ? "已保存并通过校验" : "已保存(校验未通过,见提示)"),
        ok ? "ok" : "err",
      );
      return true;
    } catch (err) {
      if (!stillHere()) return false;
      persistEditorDraft();
      if (err.status === 412 || err.status === 428) {
        showConflict("保存冲突:磁盘已被其他程序更新。编辑器与磁盘均未覆盖。请复制草稿,或加载磁盘版本后再粘贴保存。");
        setStatus("bad", "保存冲突");
        toast(`保存冲突:[${err.code}] ${err.message}`, "err", 8000);
        return false;
      }
      setStatus("bad", "保存失败");
      toast(`保存失败:[${err.code}] ${err.message}`, "err", 8000);
      return false;
    }
  }

  saveBtn.addEventListener("click", doSave);
  validateBtn.addEventListener("click", () => doValidate());
  const exportFlow = (format) => async () => {
    if (patchGate || saveGate || loadGate) return;
    if (editor.value !== saved) {
      const ok = await doSave();
      if (!ok) return;
    }
    if (!stillHere()) return;
    if (editor.value !== saved) {
      persistEditorDraft();
      setStatus("dirty", "未保存");
      return;
    }
    downloadExport(id, format, stillHere);
  };
  exportBtn.addEventListener("click", exportFlow("pptx"));
  if (pdfBtn) pdfBtn.addEventListener("click", exportFlow("pdf"));

  const keyHandler = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      doSave();
    }
  };
  window.addEventListener("keydown", keyHandler);

  function closeEvents() {
    if (!eventSource) return;
    eventSource.close();
    eventSource = null;
  }

  function showTerminal(message) {
    errIndex = null;
    errMsg.textContent = message;
    errStrip.classList.add("show");
    setStatus("bad", "同步中断");
  }

  function liveDispatchState() {
    return {
      generation: gen,
      currentGeneration: routeGeneration,
      disposed,
      terminal,
    };
  }

  function requestReconcile(eventName, data = {}) {
    const dispatch = decideSseDispatch({
      ...liveDispatchState(),
      eventName,
      busy: mutationBusy(),
      fetching: Boolean(reconcileGate),
      errorCode: data.code,
    });
    if (dispatch.action === "ignore") return;
    if (dispatch.action === "deleted") {
      markTerminal();
      showTerminal("项目已从磁盘删除。");
      closeEvents();
      return;
    }
    if (dispatch.action === "error") {
      markTerminal();
      showTerminal(`${data.code}: ${data.message || "文件系统监视失败"}`);
      closeEvents();
      return;
    }
    if (dispatch.action === "queue") {
      pendingReconcile = true;
      return;
    }
    startAuthoritativeGet();
  }

  function flushPendingReconcile() {
    if (!stillHere() || !pendingReconcile || mutationBusy() || reconcileGate) return;
    pendingReconcile = false;
    startAuthoritativeGet();
  }

  function startAuthoritativeGet() {
    if (!stillHere()) return;
    if (mutationBusy() || reconcileGate) {
      pendingReconcile = true;
      return;
    }
    reconcileGate = runAuthoritativeGet().finally(() => {
      reconcileGate = null;
      if (pendingReconcile && stillHere() && !mutationBusy()) {
        pendingReconcile = false;
        startAuthoritativeGet();
      }
    });
  }

  function applyReconcileDecision(decision, fresh) {
    if (decision.action === "ignore" || decision.action === "keep") {
      persistEditorDraft();
      return;
    }
    if (decision.action === "queue") {
      pendingReconcile = true;
      return;
    }
    if (decision.action === "preview-only") {
      refreshPreview();
      persistEditorDraft();
      return;
    }
    if (decision.action === "reload") {
      saved = decision.source;
      baseEtag = decision.etag;
      editor.value = saved;
      persistEditorDraft();
      hideConflictActions();
      errStrip.classList.remove("show");
      setStatus("ok", "已加载");
      refreshGutter();
      checkSyntax();
      refreshInspectorEnabled();
      if (selectedPageId && selectedElementId) {
        currentInspection = inspectAuthoringSelection(editor.value, selectedPageId, selectedElementId);
        syncInspectorFields();
      }
      refreshPreview();
      doValidate({ silent: true });
      return;
    }
    if (decision.action === "keep-conflict") {
      persistEditorDraft();
      showConflict("磁盘已被其他程序更新。编辑器与磁盘均未覆盖。请复制草稿,或加载磁盘版本后再粘贴保存。");
      setStatus("bad", "保存冲突");
      refreshPreview();
    }
  }

  async function runAuthoritativeGet() {
    const snapshot = editor.value;
    try {
      const fresh = await apiRaw(`/api/projects/${id}`);
      if (!stillHere()) return;
      if (mutationBusy()) {
        pendingReconcile = true;
        return;
      }
      if (pendingReconcile) return;
      let invalid = false;
      try {
        JSON.parse(editor.value);
      } catch {
        invalid = true;
      }
      const decision = decideReconcile({
        ...liveDispatchState(),
        busy: false,
        editorChangedDuringFetch: editor.value !== snapshot,
        editorValue: editor.value,
        saved,
        conflicted: conflictOpen,
        invalid,
        fetchedSource: fresh.body.source,
        fetchedEtag: fresh.etag,
        currentEtag: baseEtag,
      });
      applyReconcileDecision(decision, fresh);
    } catch (err) {
      if (!stillHere()) return;
      if (err.status === 404) {
        markTerminal();
        showTerminal("项目已从磁盘删除。");
        closeEvents();
      }
    }
  }

  function onSseMessage(ev) {
    requestReconcile(ev.type, parseSsePayload(ev.data));
  }

  function connectEvents() {
    closeEvents();
    if (!stillHere()) return;
    const es = new EventSource(`/api/projects/${id}/events`);
    eventSource = es;
    es.addEventListener("ready", onSseMessage);
    es.addEventListener("changed", onSseMessage);
    es.addEventListener("deleted", onSseMessage);
    es.addEventListener("error", onSseMessage);
  }

  function disposeWorkbench() {
    disposed = true;
    pendingReconcile = false;
    closeEvents();
    clearTimeout(syntaxTimer);
    window.removeEventListener("keydown", keyHandler);
    window.removeEventListener("pagehide", disposeWorkbench);
    window.removeEventListener("hashchange", disposeWorkbench);
  }

  window.addEventListener("pagehide", disposeWorkbench);
  window.addEventListener("hashchange", disposeWorkbench);

  /* --- mount --- */
  appEl.replaceChildren(topbar, el("div", { class: "bench" }, [leftPane, rightPane]));
  refreshGutter();
  checkSyntax();
  refreshInspectorEnabled();
  refreshPreview();
  doValidate({ silent: true });
  connectEvents();
}

/* ---------------- boot ---------------- */

(async function boot() {
  try {
    meta = await api("/api/meta");
  } catch {
    // keep defaults; home view will surface connection errors
  }
  route();
})();
