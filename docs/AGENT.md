# OpenPPT — agent quickstart (read this first)

Progressive disclosure: start here → schema → IR.md only when stuck.

## 30-second path

```bash
# repo root
bun install
bun bin/openppt.js init path/to/project --theme magazine --title "My deck"
bun bin/openppt.js from-outline outline.md -o path/to/project --theme report --force
bun bin/openppt.js validate path/to/deck.json
bun bin/openppt.js export  path/to/deck.json -o path/to/deck.pptx --force
bun bin/openppt.js qa      path/to/deck.json
bun bin/openppt.js qa      path/to/deck.json --fail-on med   # CI-stricter
bun bin/openppt.js preview path/to/deck.json -o path/to/preview.html
bun bin/openppt.js import  path/to/file.pptx -o path/to/project/ --force
```

Runtime is **Bun**. Do not use Node as the default path.

## What to generate

1. `deck.json` (`version: "openppt-1"`)
2. images only under `media/` (real PNG/JPEG/GIF/WEBP/SVG bytes)
3. `deck.pptx` via export

Optional start: copy `templates/pitch-skeleton/deck.json` and replace `{{PLACEHOLDERS}}`.

## Hard rules (fail-closed)

| Rule | Detail |
|---|---|
| Version | `"openppt-1"` only |
| Bounds | `[x,y,w,h]` CSS px, finite, inside `size` (max 5376 per side) |
| fontSize | **points**, not CSS px |
| IDs | page ids and element ids unique **deck-wide** |
| Images | `src` must match `media/...`; extension must match file magic |
| No remote images | no `http(s):` in default path |
| Theme | `$name` tokens from `theme.colors` (copy from `themes/default.json`) |

## Element types

- `text` — string **or** run array `[{text, bold?, color?, fontSize?, italic?}]`; optional `href`
- `shape` — `rect` \| `roundRect` \| `ellipse`
- `image` — local `media/*`
- `chart` — `bar` \| `line` \| `pie` \| `doughnut` \| `area` + `series[{name,labels?,values}]`
- `table` — `rows` (cells as strings or `{text, fill?, bold?}`); optional `header`, `colW`
- `group` — **layout helper** (not drawn): `layout: stack|row|grid|layer`, `bounds`, `children` with `height`/`width`/`flex` — expanded at load (see `docs/IR.md`, `fixtures/layout-demo/`, `demos/sspai-113139/`)

## Multi-file decks

```json
{
  "version": "openppt-1",
  "size": [960, 540],
  "pages": ["pages/cover.json", "pages/body.json"]
}
```

Page files are full page objects (`id` + `elements`). Paths must stay inside the project (path jail).

## Sources of truth (in order)

1. This file  
2. [`schema/openppt-ir.schema.json`](../schema/openppt-ir.schema.json)  
3. [`docs/IR.md`](IR.md) — units, identifiers, alpha note  
4. [`skills/openppt/SKILL.md`](../skills/openppt/SKILL.md) — installable agent skill  

## Anti-patterns

- Kimi / open-kimi-ppt / neo-ppt / WASM exporters  
- Writing pptxgenjs by hand when IR would do  
- Reusing element id `title` on every page  
- Putting secrets next to images outside `media/` and hoping export ignores them  

## Install skill for hosts

```bash
bun run install:skill
```
