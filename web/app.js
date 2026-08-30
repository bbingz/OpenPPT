/* OpenPPT Studio — vanilla ES module, no build step, offline only. */

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

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const type = res.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.code = body?.error?.code || String(res.status);
    err.status = res.status;
    err.details = body?.error?.details;
    throw err;
  }
  return body;
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

/* ---------------- routing ---------------- */

function route() {
  const hash = location.hash || "#/";
  const match = hash.match(/^#\/p\/([a-z0-9-]+)$/);
  if (match) renderWorkbench(match[1]);
  else renderHome();
}

window.addEventListener("hashchange", route);

/* ---------------- home ---------------- */

async function renderHome() {
  appEl.replaceChildren(el("div", { class: "boot", text: "加载项目列表…" }));
  let projects = [];
  try {
    const data = await api("/api/projects");
    projects = data.projects;
  } catch (err) {
    appEl.replaceChildren(el("div", { class: "boot", text: `无法连接服务:${err.message}` }));
    return;
  }

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

async function downloadExport(id, format = "pptx") {
  try {
    const path = format === "pdf" ? `/api/projects/${id}/export.pdf` : `/api/projects/${id}/export`;
    const res = await fetch(path);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ? `[${body.error.code}] ${body.error.message}` : `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = el("a", { href: url, download: `${id}.${format}` });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast(`${format.toUpperCase()} 已导出下载`);
  } catch (err) {
    toast(`导出失败:${err.message}`, "err", 7000);
  }
}

/* ---------------- workbench ---------------- */

async function renderWorkbench(id) {
  appEl.replaceChildren(el("div", { class: "boot", text: `打开项目 ${id}…` }));
  let project;
  try {
    project = await api(`/api/projects/${id}`);
  } catch (err) {
    toast(`打开失败:${err.message}`, "err");
    location.hash = "#/";
    return;
  }

  const draftKey = `openppt-draft-${id}`;
  let saved = project.source;
  let statusState = { kind: "ok", text: "已加载" };

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
  const draft = localStorage.getItem(draftKey);
  if (draft && draft !== saved) {
    editor.value = draft;
    setStatus("dirty", "有未保存草稿");
  }

  const errMsg = el("span", { class: "msg" });
  const errJump = el("button", { class: "btn ghost", text: "定位", style: "padding:3px 10px;font-size:12px;" });
  const errStrip = el("div", { class: "errstrip" }, [errMsg, errJump]);
  let errIndex = null;
  errJump.addEventListener("click", () => {
    if (errIndex == null) return;
    editor.focus();
    editor.setSelectionRange(errIndex, errIndex + 1);
  });

  function refreshGutter() {
    const lines = editor.value.split("\n").length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
    gutter.scrollTop = editor.scrollTop;
  }

  function checkSyntax() {
    try {
      JSON.parse(editor.value);
      errStrip.classList.remove("show");
      errIndex = null;
      return true;
    } catch (err) {
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
    localStorage.setItem(draftKey, editor.value);
    if (editor.value !== saved) setStatus("dirty", "未保存");
    refreshGutter();
    clearTimeout(syntaxTimer);
    syntaxTimer = setTimeout(checkSyntax, 350);
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
  const iframe = el("iframe", { sandbox: "", title: "preview" });
  const previewPanel = el("div", { class: "tabpanel preview active" }, [iframe]);
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

  function refreshPreview() {
    iframe.src = `/api/projects/${id}/preview?ts=${Date.now()}`;
  }
  refreshBtn.addEventListener("click", refreshPreview);

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

  async function doValidate({ silent = false } = {}) {
    try {
      const result = await api(`/api/projects/${id}/validate`, { method: "POST" });
      if (result.ok) {
        setStatus("ok", `校验通过 · ${result.pages} 页`);
        if (!silent) toast("校验通过");
      } else {
        setStatus("bad", `[${result.error.code}]`);
        if (!silent) toast(`[${result.error.code}] ${result.error.message}`, "err", 8000);
        errMsg.textContent = `[${result.error.code}] ${result.error.message}`;
        errIndex = null;
        errStrip.classList.add("show");
      }
      return result.ok;
    } catch (err) {
      setStatus("bad", "校验异常");
      if (!silent) toast(`校验异常:${err.message}`, "err", 8000);
      return false;
    }
  }

  async function doSave() {
    if (!checkSyntax()) {
      setStatus("bad", "JSON 语法错误");
      toast("JSON 语法错误,未保存", "err");
      return false;
    }
    try {
      await api(`/api/projects/${id}/deck`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: editor.value,
      });
      saved = editor.value;
      localStorage.removeItem(draftKey);
      errStrip.classList.remove("show");
      const ok = await doValidate({ silent: true });
      if (ok) refreshPreview();
      if (tabButtons.get("qa").panel.classList.contains("active")) runQa();
      toast(ok ? "已保存并通过校验" : "已保存(校验未通过,见提示)", ok ? "ok" : "err");
      return true;
    } catch (err) {
      setStatus("bad", "保存失败");
      toast(`保存失败:[${err.code}] ${err.message}`, "err", 8000);
      return false;
    }
  }

  saveBtn.addEventListener("click", doSave);
  validateBtn.addEventListener("click", () => doValidate());
  const exportFlow = (format) => async () => {
    if (editor.value !== saved) {
      const ok = await doSave();
      if (!ok) return;
    }
    downloadExport(id, format);
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
  window.addEventListener("hashchange", () => window.removeEventListener("keydown", keyHandler), { once: true });

  /* --- mount --- */
  appEl.replaceChildren(topbar, el("div", { class: "bench" }, [leftPane, rightPane]));
  refreshGutter();
  checkSyntax();
  refreshPreview();
  doValidate({ silent: true });
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
