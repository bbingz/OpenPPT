---
name: openppt
description: Create editable PowerPoint decks via OpenPPT open IR (JSON/YAML) and Bun CLI. Use for presentations, PPTX, slides, pitch decks when the user wants an open-source IR→PPTX path without proprietary Kimi/WASM. Default deliverables are a self-contained deck project (deck.json + media/) and a compiled .pptx.
---

# OpenPPT skill

OpenPPT turns a **declarative deck IR** into a real, **text-editable `.pptx`** using **pptxgenjs**. Runtime is **Bun** only. Do **not** call Kimi, neo-ppt, or any official WASM exporter.

## Prerequisites

```bash
bun --version   # need Bun >= 1.1
```

If the OpenPPT repo is not on disk, clone it (or use a path the user provides):

```bash
git clone https://github.com/bbingz/OpenPPT.git
cd OpenPPT && bun install
```

Set `OPENPPT_ROOT` to the repo root when invoking the CLI from elsewhere.

## Default deliverables

Unless the user opts out of PPTX:

1. A project folder: `deck.json` (or `.yaml`) + optional `media/*`
2. A compiled `deck.pptx` next to it

Prefer absolute paths in the final reply.

## Workflow

### 1. Choose layout strategy

- **From scratch:** copy a skeleton under `templates/` (see below) or write IR by hand.
- **From outline:** one page per major section; cover + TOC + body + final for formal decks.
- **Style:** copy colors from `themes/default.json` into `theme.colors` (template only — not auto-loaded).

### 2. Write IR

- Read **`schema/openppt-ir.schema.json`** (source of truth).
- Optional short guide: `docs/IR.md`.
- Rules agents forget most often:
  - `"version": "openppt-1"`
  - Bounds `[x,y,w,h]` in **CSS pixels**, must fit `size`
  - **`fontSize` is points**, not CSS px
  - Page ids and **element ids are unique deck-wide** (do not reuse `title` on every slide)
  - Images: **only** `media/...`; real image bytes; extensions `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg`
  - Charts: `type: "chart"`, `chartType` ∈ bar|line|pie|doughnut|area, `series[{name,values,labels?}]`
  - Tables: `type: "table"`, `rows: [["H1","H2"],["a","b"]]`, optional `header: true`, `colW`
  - Text links: `"href": "https://..."` on text elements
  - **Layout groups (prefer for multi-block pages):** `type: "group"`, `layout: "stack"|"row"|"grid"|"layer"`, `bounds`, `gap?`, `children` with `height`/`width`/`flex` — `layer` = card overlay (bg + content). See `fixtures/layout-demo/`, `demos/sspai-113139/`, `docs/IR.md`
  - Themes to copy: `themes/default.json`, `dark.json`, `magazine.json`, `report.json`
  - Theme colors: `"$primary"` style tokens under `theme.colors`
  - First read: `docs/AGENT.md` (then schema if needed)
  - Multi-file: `pages: ["pages/cover.json", ...]` expanded at load
  - Rich text: `text: [{ "text": "Hi", "bold": true, "color": "$primary" }]`

### 3. Scaffold / outline (optional)

```bash
bun "$OPENPPT_ROOT/bin/openppt.js" init /abs/path/project --theme magazine --title "Deck"
bun "$OPENPPT_ROOT/bin/openppt.js" from-outline /abs/path/outline.md -o /abs/path/project --force
```

Outline format: `# Title`, `## Section`, `- bullet` lines.

### 4. Validate, QA, export, preview

```bash
bun "$OPENPPT_ROOT/bin/openppt.js" validate /abs/path/deck.json
bun "$OPENPPT_ROOT/bin/openppt.js" qa       /abs/path/deck.json
bun "$OPENPPT_ROOT/bin/openppt.js" qa       /abs/path/deck.json --fail-on med
bun "$OPENPPT_ROOT/bin/openppt.js" export  /abs/path/deck.json -o /abs/path/deck.pptx --force
bun "$OPENPPT_ROOT/bin/openppt.js" preview /abs/path/deck.json -o /abs/path/preview.html --force
```

Import existing PPTX (lossy):

```bash
bun "$OPENPPT_ROOT/bin/openppt.js" import /abs/path/in.pptx -o /abs/path/project/ --force
```

If `OPENPPT_ROOT` is the current directory, use `bun bin/openppt.js ...`.

Fix `SCHEMA_INVALID` / `BOUNDS_OUT_OF_RANGE` / `LAYOUT_INVALID` / `MEDIA_MISSING` / `MEDIA_TYPE_INVALID` / `THEME_COLOR_UNRESOLVED` before re-exporting. Fail-closed: do not hand-edit the PPTX to “paper over” IR errors.

### 5. Templates (skeletons)

Copy from the repo (paths relative to OpenPPT root):

| Skeleton | Path | Use |
|---|---|---|
| Full deck | `templates/pitch-skeleton/deck.json` | Cover + TOC + body + final (4 pages) |
| Cover only | `templates/pages/cover.json` | Single-page fragment to merge |
| TOC | `templates/pages/toc.json` | |
| Body | `templates/pages/body.json` | |
| Final | `templates/pages/final.json` | |

Replace placeholder strings (`{{TITLE}}`, etc.) with real copy; keep bounds and `$` theme tokens unless redesigning.

### 6. Delivery

Link:

- project directory
- `deck.json`
- `media/` if any
- `deck.pptx`

Optional: remind the user they can re-export after IR edits with the same Bun commands.

## Out of scope for this skill

- Kimi / open-kimi-ppt / neo-ppt / PPTD WASM paths
- Animations and font embedding parity (chart authoring is supported; chart import is best-effort)
- HTML-only slide decks (use another skill)

## Quick reference — minimal deck

```json
{
  "version": "openppt-1",
  "title": "Hello",
  "size": [960, 540],
  "theme": {
    "colors": {
      "primary": "#2563EB",
      "text": "#111827",
      "background": "#FFFFFF"
    }
  },
  "pages": [
    {
      "id": "cover",
      "background": { "type": "solid", "color": "$background" },
      "elements": [
        {
          "id": "cover-title",
          "type": "text",
          "bounds": [60, 200, 840, 60],
          "text": "Hello OpenPPT",
          "fontSize": 32,
          "color": "$primary",
          "align": "center"
        }
      ]
    }
  ]
}
```
