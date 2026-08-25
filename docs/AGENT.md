# OpenPPT — agent quickstart (read this first)

Progressive disclosure: start here → IR authoring guide → normalized leaf schema.

## 30-second path

```bash
# repo root
bun install
# choose one creation route for a new project
bun bin/openppt.js init path/to/project --skeleton --theme magazine --title "My deck"
# OR
bun bin/openppt.js from-outline outline.md -o path/to/outline-project --theme report
bun bin/openppt.js validate path/to/deck.json
bun bin/openppt.js export  path/to/deck.json -o path/to/deck.pptx --force
bun bin/openppt.js qa      path/to/deck.json
bun bin/openppt.js qa      path/to/deck.json --fail-on med   # CI-stricter
bun bin/openppt.js preview path/to/deck.json -o path/to/preview.html
bun bin/openppt.js import  path/to/file.pptx -o path/to/project/ --force
```

Runtime is **Bun**. Do not use Node as the default path.
`init --skeleton` creates the four-page pitch skeleton; without it, `init`
creates the two-page starter. `--force` replaces an existing `deck.json`, so do
not chain `init` and `from-outline --force` against the same directory.

## What to generate

1. `deck.json` (`version: "openppt-1"`)
2. images only under `media/` (real PNG/JPEG/GIF/WEBP/SVG bytes)
3. `deck.pptx` via export

Optional start: copy `templates/pitch-skeleton/deck.json` and replace its real
tokens: `{{DECK_TITLE}}`, `{{TITLE}}`, `{{SUBTITLE}}`, `{{FOOTER}}`,
`{{TOC_1}}`–`{{TOC_4}}`, `{{SECTION_TITLE}}`, `{{BODY}}`, `{{CALLOUT}}`,
`{{CLOSING}}`, `{{CTA}}`, and `{{CONTACT}}`.

## Hard rules (fail-closed)

| Rule | Detail |
|---|---|
| Version | `"openppt-1"` only |
| Bounds | `[x,y,w,h]` CSS px, finite, inside `size` (max 5376 per side) |
| fontSize | **points**, not CSS px |
| IDs | page ids and element ids unique **deck-wide** |
| Images | `src` must match `media/...`; extension must match file magic |
| No remote images | no `http(s):` in default path |
| Theme | `$name` tokens from `theme.colors`; copy only a theme file's top-level `colors` value, never its `id` or `name` |

## Element types

- `text` — string **or** run array `[{text, bold?, color?, fontSize?, italic?}]`; optional `href` using `http://`, `https://`, or `mailto:` only
- `shape` — `rect` \| `roundRect` \| `ellipse`
- `image` — local `media/*`
- `chart` — `bar` \| `line` \| `pie` \| `doughnut` \| `area` + `series[{name,labels?,values}]`
- `table` — `rows` (cells as strings or `{text, fill?, bold?}`); optional `header`, `colW`
- `group` — **authoring-only layout helper** (not in the normalized leaf schema and not drawn): `layout: stack|row|grid|layer`, `bounds`, `children` with `height`/`width`/`flex`; `loadDeck` and `validateDeck` expand it before leaf-schema validation (see `docs/IR.md`, `fixtures/layout-demo/`, `demos/sspai-113139/`)

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
2. [`docs/IR.md`](IR.md) — authoring groups, units, identifiers, alpha note
3. [`schema/openppt-ir.schema.json`](../schema/openppt-ir.schema.json) — normalized leaf IR after page/group expansion
4. [`skills/openppt/SKILL.md`](../skills/openppt/SKILL.md) — installable agent skill

The HTML preview is a structural approximation, not pixel-faithful PowerPoint
rendering; charts are placeholders. Use the exported PPTX for final visual QA.

## Anti-patterns

- Kimi / open-kimi-ppt / neo-ppt / WASM exporters  
- Writing pptxgenjs by hand when IR would do  
- Reusing element id `title` on every page  
- Putting secrets next to images outside `media/` and hoping export ignores them  

## Install skill for hosts

```bash
bun run install:skill
```
