# OpenPPT — agent quickstart (read this first)

Progressive disclosure: start here → IR authoring guide → normalized leaf schema.

## 30-second path

```bash
# repo root
bun install
# choose one creation route for a new project
bun bin/openppt.js init path/to/project --skeleton --theme magazine --title "My deck"
# OR
bun bin/openppt.js from-outline outline.md -o path/to/project --theme report
bun bin/openppt.js validate path/to/project/deck.json
bun bin/openppt.js export  path/to/project/deck.json -o path/to/project/deck.pptx --force
bun bin/openppt.js qa      path/to/project/deck.json
bun bin/openppt.js qa      path/to/project/deck.json --fail-on med   # CI-stricter
# preview: --force is optional on first write, required to replace an existing file
bun bin/openppt.js preview path/to/project/deck.json -o path/to/project/preview.html --force
bun bin/openppt.js import  path/to/file.pptx -o path/to/project/ --force
```

Runtime is **Bun**. Do not use Node as the default path.
`init --skeleton` creates the four-page pitch skeleton; without it, `init`
creates the two-page starter. `--force` replaces an existing `deck.json`, so do
not chain `init` and `from-outline --force` against the same directory.

## Intake and slides (not a form)

Infer or confirm purpose, audience, input facts, page budget, and visual
direction only when those would change the deck. Do not invent a mandatory
questionnaire, required TOC, or house-style bullet ban.
`from-outline` output is a **starter** — it chooses narrative / two-column / three-card / KPI / sequence from the outline (ordered lists and `label: value` metrics only when explicit) and paginates long English/CJK. Edit it before claiming delivery.

Each slide has one job: a claim and the evidence that supports it. Choose
comparison, sequence, KPI, chart, table, or image from the content. Keep
hierarchy, aligned edges, consistent type/color roles, and intentional
whitespace. Cut or restructure copy instead of shrinking everything. Bullets
are for parallel items, not a default on every page. Replace filler,
unsupported claims, and leftover tokens with sourced content. Images must
serve the message (own / user-provided / permissioned, with provenance), not
generic decoration.

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
| fontSize | **points**, not CSS px (finite, exclusive 0 through 4000). 96 dpi bounds: 1pt = 4/3 CSS px |
| fontFamily | XML-safe Latin/CJK, digits, space, apostrophe, hyphen, `_.()`; run → paragraph → element → `$style` → `theme.fonts.latin` → Arial |
| IDs | page ids and element ids unique **deck-wide** |
| Images | `src` must match `media/...`; extension must match file magic |
| No remote images | no `http(s):` in default path |
| Theme | `$name` tokens from `theme.colors`; copy only a theme file's top-level `colors` value, never its `id` or `name` |

## Element types

- `text` — string **or** run array `[{text, bold?, color?, fontSize?, italic?}]`; optional `href` using `http://`, `https://`, or `mailto:` only
- `shape` — `rect` \| `roundRect` \| `ellipse`
- `image` — local `media/*`
- `chart` — `bar` \| `line` \| `pie` \| `doughnut` \| `area` + `series[{name,labels?,values}]`. Omitted labels → `"1"`,`"2"`,…. Explicit + omitted labels are valid when those vectors agree (e.g. `["1","2"]` with a 2-value unlabeled series). Mismatches reject. Pie/doughnut: one series.
- `table` — `rows` (cells as strings or `{text, fill?, bold?}`); optional `header`, `colW`
- `group` — **authoring-only layout helper** (not in the normalized leaf schema and not drawn): `layout: stack|row|grid|layer`, `bounds`, `children` with `height`/`width`/`flex`; `loadDeck` and `validateDeck` expand it before leaf-schema validation (see `docs/IR.md`, `fixtures/layout-demo/`)

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
rendering. Charts in preview are **SVG mini-charts** (structure only). `--force`
is optional on the first preview write and required to replace an existing file.

**Visual success (delivery gate):** convert the **already exported PPTX** with
the existing sync API, raster, **view**, then fix IR and re-export if needed:

```bash
bun -e 'import {convertPptxToPdf} from "./src/index.js"; console.log(convertPptxToPdf(process.argv[1], process.argv[2], {force:true}));' path/to/project/deck.pptx path/to/project/from-pptx.pdf
pdftoppm -png path/to/project/from-pptx.pdf path/to/project/page
```

Convenience IR→PDF is **separate** and recompiles IR; it is not the exact-PPTX
gate:

```bash
bun bin/openppt.js pdf path/to/project/deck.json -o path/to/project/from-ir.pdf --force
```

QA heuristics and PDF page counts are not glyph or editorial approval. Font
listings (`fc-list` / `fc-match`) are not glyph proof. If CJK is named and a
matching face exists but the raster shows English only, the cause is unverified
— not a confirmed font-selection diagnosis, and not proof fonts are absent.

Studio: `GET /api/projects/:id` ETag is SHA-256 of exact source bytes; `PUT .../deck`
needs `If-Match` (missing 428, stale/weak/`*` 412). `PATCH .../deck` requires
`Content-Type: application/json` (charset parameters allowed; missing/`text/plain`
are rejected and leave exact source bytes). It accepts `{operations}` (1–64
`add` / `update` / `remove`) with the same strong If-Match, mutates a detached
authoring JSON tree, validates schema/media/resources, then one atomic write. The response is `{ok:true,source}`
plus the new ETag of those exact bytes. Groups and `$style` references stay
authored, never flattened. YAML projects and decks whose `pages` list external
page files return `UNSUPPORTED_EDIT` — convert to inline `deck.json` page objects;
CLI/PUT/multifile viewing still work. Drafts keep that base ETag.
`GET /api/projects/:id/events` is SSE (`text/event-stream`) with project-scoped
`fs.watch` shared across subscribers (caps 4/project, 32/server, 128 dirs). The
project's parent directory is watched only for that project name so deletion is
visible; there is no global scanner. New/replaced directory trees are walked
and reattached under the dir cap (realpath-visited, stop on budget). It emits
`ready` only after a successful watch setup, debounced `changed` (relative
paths + current source ETag when readable within the source cap), `deleted`,
and `error` (symlink escape / watcher budget) without absolute paths. Slow
clients are closed from unread stream backlog (frames/bytes, including
heartbeats), not from a lifetime event count. Originless CLI and same-origin
EventSource are allowed; foreign/null Origin and `Sec-Fetch-Site: cross-site`
are 403. Missing project 404; subscriber cap 429. Reconnect rereads current
state; it is not a replay log. `stop()`, last disconnect, `deleted`, and
`error` release watchers, timers, and subscriber counts.
Hash detects byte changes; identical bytes need not change the tag. External CLI
writers are not locked. The workbench subscribes to events only while mounted and
reconciles with an authoritative GET (dirty drafts keep exact text and the
original base ETag). YAML and decks that list external page files are read-only
for PATCH and inspector selection. The inspector may PATCH plain text / own
fontSize / root bounds on a clean inline `deck.json`. HTML preview is not
pixel-perfect PowerPoint.

Import is lossy. Grouped shapes (`p:grpSp`) are expanded with OOXML group-space
transforms (`off`/`ext`/`chOff`/`chExt`) in XML document order; malformed, zero
`chExt`, over-deep (>8), or `rot`/`flipH`/`flipV` groups skip with a warning.
Off-canvas bounds are clamped (or dropped if <1px remains). Mixed run `b`/`sz`/
`srgbClr` (and `schemeClr` via `theme1.xml` `clrScheme`, ignoring lumMod) becomes
IR rich text; homogeneous runs collapse to a plain string. Slide order follows
`p:sldIdLst` plus `presentation.xml.rels`, not `slideN.xml` filenames.

## Anti-patterns

- Kimi / open-kimi-ppt / neo-ppt / WASM exporters  
- Writing pptxgenjs by hand when IR would do  
- Reusing element id `title` on every page  
- Putting secrets next to images outside `media/` and hoping export ignores them  

## Install skill for hosts

```bash
bun run install:skill
# existing installs are left in place unless you pass --force (a .bak is kept)
```
