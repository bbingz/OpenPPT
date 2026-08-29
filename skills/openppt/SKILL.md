---
name: openppt
description: Create editable PowerPoint decks via OpenPPT open IR (JSON/YAML) and Bun CLI. Use for presentations, PPTX, slides, pitch decks when the user wants an open-source IR→PPTX path without proprietary Kimi/WASM. Default deliverables are a self-contained deck project (deck.json + media/) and a compiled .pptx.
---

# OpenPPT skill

OpenPPT turns a **declarative deck IR** into a real, **text-editable `.pptx`** using **pptxgenjs**. Runtime is **Bun** only. Do **not** call Kimi, neo-ppt, or any official WASM exporter.

## Prerequisites

```bash
bun --version   # need Bun >= 1.4
```

If the OpenPPT repo is not on disk, clone it (or use a path the user provides):

```bash
git clone https://github.com/bbingz/OpenPPT.git
cd OpenPPT && bun install
```

After `bash scripts/install-skill.sh`, the repo root is stored in
`OPENPPT_ROOT=$(cat "$HOME/.agents/skills/openppt/OPENPPT_ROOT")`.
If the current working directory is already the OpenPPT repo, use
`bun bin/openppt.js ...` instead of `$OPENPPT_ROOT`.

## Default deliverables

Unless the user opts out of PPTX:

1. A project folder: `deck.json` (or `.yaml`) + optional `media/*`
2. A compiled `deck.pptx` next to it

Prefer absolute paths in the final reply.

## Workflow

### 1. Choose layout strategy

- **From scratch:** copy a skeleton under `templates/` (see below) or write IR by hand.
- **From outline:** one page per major section; cover + TOC + body + final for formal decks.
- **Style:** copy only the top-level `colors` value from `themes/default.json` into `deck.theme.colors`; do not copy the theme file's `id` or `name` (template only — not auto-loaded).

### 2. Write IR

- Read **`schema/openppt-ir.schema.json`** as the source of truth for normalized leaf IR.
- Read `docs/IR.md` when authoring groups: `group` is authoring-only and must pass through `loadDeck` / `validateDeck`, which expand it before leaf-schema validation.
- Rules agents forget most often:
  - `"version": "openppt-1"`
  - Bounds `[x,y,w,h]` in **CSS pixels**, must fit `size`
  - **`fontSize` is points**, not CSS px
  - Page ids and **element ids are unique deck-wide** (do not reuse `title` on every slide)
  - Images: **only** `media/...`; real image bytes; extensions `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg`
  - Charts: `type: "chart"`, `chartType` ∈ bar|line|pie|doughnut|area, `series[{name,values,labels?}]`
  - Tables: `type: "table"`, `rows: [["H1","H2"],["a","b"]]`, optional `header: true`, `colW`
  - Text links: `"href": "https://..."` on text elements
  - **Layout groups (prefer for multi-block pages):** authoring-only `type: "group"`, `layout: "stack"|"row"|"grid"|"layer"`, `bounds`, `gap?`, `children` with `height`/`width`/`flex` — `layer` = card overlay (bg + content). See packed `fixtures/layout-demo/` (or `demos/sspai-113139/` if you have a git checkout), `docs/IR.md`
  - Theme color sources: the top-level `colors` value in `themes/default.json`, `dark.json`, `magazine.json`, or `report.json`
  - Theme colors: `"$primary"` style tokens under `theme.colors`
  - First read: `docs/AGENT.md` (then schema if needed)
  - Multi-file: `pages: ["pages/cover.json", ...]` expanded at load
  - Rich text: `text: [{ "text": "Hi", "bold": true, "color": "$primary" }]`

### 3. Scaffold / outline (optional)

```bash
OPENPPT_ROOT=$(cat "$HOME/.agents/skills/openppt/OPENPPT_ROOT")
# choose one creation route for a new project
bun "$OPENPPT_ROOT/bin/openppt.js" init /abs/path/project --skeleton --theme magazine --title "Deck"
# OR
bun "$OPENPPT_ROOT/bin/openppt.js" from-outline /abs/path/outline.md -o /abs/path/project
```

Outline format: `# Title`, `## Section`, `- bullet` lines.
`init --skeleton` creates four pages; without it, `init` creates a two-page
starter. `--force` replaces an existing `deck.json`, so never run the two
creation commands against the same directory unless replacement is intended.

### 4. Validate, QA, export, preview

```bash
bun "$OPENPPT_ROOT/bin/openppt.js" validate /abs/path/project/deck.json
bun "$OPENPPT_ROOT/bin/openppt.js" qa       /abs/path/project/deck.json
bun "$OPENPPT_ROOT/bin/openppt.js" qa       /abs/path/project/deck.json --fail-on med
bun "$OPENPPT_ROOT/bin/openppt.js" export  /abs/path/project/deck.json -o /abs/path/project/deck.pptx --force
bun "$OPENPPT_ROOT/bin/openppt.js" preview /abs/path/project/deck.json -o /abs/path/project/preview.html --force
```

Preview is an offline structural approximation, not pixel-faithful PowerPoint
rendering; charts are placeholders. Inspect the exported PPTX for final visual
QA.

Import existing PPTX (lossy):

```bash
bun "$OPENPPT_ROOT/bin/openppt.js" import /abs/path/in.pptx -o /abs/path/project/ --force
```

If the current working directory is the OpenPPT repo, use `bun bin/openppt.js ...`.

Fix `SCHEMA_INVALID` / `BOUNDS_OUT_OF_RANGE` / `LAYOUT_INVALID` / `MEDIA_MISSING` / `MEDIA_TYPE_INVALID` / `THEME_COLOR_UNRESOLVED` / `RESOURCE_LIMIT_EXCEEDED` before re-exporting. Fail-closed: do not hand-edit the PPTX to “paper over” IR errors.

### 5. Templates (skeletons)

Copy from the repo (paths relative to OpenPPT root):

| Skeleton | Path | Use |
|---|---|---|
| Full deck | `templates/pitch-skeleton/deck.json` | Cover + TOC + body + final (4 pages) |
| Cover only | `templates/pages/cover.json` | Single-page fragment to merge |
| TOC | `templates/pages/toc.json` | |
| Body | `templates/pages/body.json` | |
| Final | `templates/pages/final.json` | |

Replace the actual placeholder strings with real copy: `{{DECK_TITLE}}`,
`{{TITLE}}`, `{{SUBTITLE}}`, `{{FOOTER}}`, `{{TOC_1}}`–`{{TOC_4}}`,
`{{SECTION_TITLE}}`, `{{BODY}}`, `{{CALLOUT}}`, `{{CLOSING}}`, `{{CTA}}`, and
`{{CONTACT}}`. `init --skeleton --title` fills the deck title and `{{TITLE}}`;
the remaining tokens still need content. Keep bounds and `$` theme tokens
unless redesigning.

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
