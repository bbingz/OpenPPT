# OpenPPT IR v1 overview

Status: **stable for v1.0** (`version: "openppt-1"`).

Machine-readable schema: [`../schema/openppt-ir.schema.json`](../schema/openppt-ir.schema.json).

## Design principles

1. **Agent-first:** declarative JSON/YAML, not imperative pptxgenjs scripts.
2. **Absolute layout:** each element has pixel bounds; no hidden masters.
3. **Theme tokens:** `$name` colors resolved from `theme.colors`.
4. **Fail closed:** invalid schema, OOB bounds, missing media → no PPTX.
5. **Open compile:** IR maps to OOXML via open libraries only.

## Coordinate system

- Origin top-left of the page.
- **Bounds** units: CSS pixels; export maps `px / 96` → inches for pptxgenjs.
- **`fontSize` is points** (pptxgenjs / PowerPoint typography), **not** CSS px.
  Do not assume 1px = 1pt for layout math; a box of height 24px with
  `fontSize: 24` is intentionally larger type than the box in pure CSS terms.
- Color `#RRGGBBAA`: alpha maps to pptxgenjs `transparency` (0–100) on text/shape fills.

## Identifiers

- `page.id` must be unique across the deck.
- `element.id` must be unique across the **entire deck**, not merely within its
  page. Reusing `title` on every slide is rejected with `SCHEMA_INVALID`.
- Rationale: ids are the IR's only stable handles for future diff/patch and
  round-trip tooling, so they address one element unambiguously.
- Neither rule lives in the JSON Schema (which cannot express cross-document
  uniqueness); both are enforced by `validateDeck`.

## Resource ceilings

OpenPPT enforces fixed safety ceilings before layout expansion and again before
export, QA, or preview. They are runtime policy, not OOXML format limits.

| Resource | Maximum |
|---|---:|
| Pages per deck | 256 |
| Expanded leaf elements per page / deck | 512 / 8,192 |
| Authoring nodes per page / deck | 1,024 / 16,384 |
| Group nesting depth / direct children | 16 / 256 |
| UTF-8 bytes per user-authored string / deck total | 64 KiB / 8 MiB |
| Rich-text runs per text element | 1,024 |
| Chart series per chart | 32 |
| Chart points per series / chart / deck | 2,048 / 8,192 / 32,768 |
| Table rows / columns per row or `colW` entries | 256 / 64 |
| Table cells per table / deck | 8,192 / 32,768 |
| Referenced local media per file / deck total | 32 MiB / 128 MiB |

Authoring nodes include groups and leaves and are counted before groups are
flattened. String accounting covers supported free-form IR values such as IDs,
content, labels, paths, font families, hyperlinks, colors, and theme names.
Structural and string limits apply even when media checks are disabled. Media
byte limits apply when `checkMedia` is enabled and count each canonical resolved
local path once, regardless of repeated references. Exceeding a ceiling throws
`RESOURCE_LIMIT_EXCEEDED`.

These ceilings do not limit source JSON/YAML bytes, imported PPTX archive
expansion, generated output bytes, execution time, or process memory.

## Element types (v1.1+)

| type | Required fields | Notes |
|---|---|---|
| `text` | id, bounds, text | optional fontSize (**points**), fontFamily, color, bold, align, valign |
| `shape` | id, bounds, shape | shape ∈ rect, roundRect, ellipse; optional fill, lineColor, lineWidth |
| `image` | id, bounds, src | **`media/...` only**; magic-byte check; optional `fit` (default **cover**, no stretch) |
| `chart` | id, bounds, chartType, series | chartType ∈ bar, line, pie, doughnut, area; series[{name, values, labels?}] |
| `table` | id, bounds, rows | rows of string/number or `{text, bold?, fill?, color?, align?, fontSize?}`; optional `header`, `colW`, `borderColor` |
| `group` | id, bounds, layout, children | **Authoring only** — expanded at load to leaves (see below) |

Text boxes may include optional `href` using `http://`, `https://`, or `mailto:` for a hyperlink on the whole box.

## Layout primitives (v1.4)

Agents may nest `type: "group"` instead of hand-computing every `[x,y,w,h]`.

```json
{
  "id": "col",
  "type": "group",
  "layout": "stack",
  "bounds": [48, 40, 864, 460],
  "gap": 16,
  "padding": 0,
  "align": "stretch",
  "justify": "start",
  "children": [
    { "id": "title", "type": "text", "height": 48, "text": "Hello", "fontSize": 28 },
    { "id": "body", "type": "text", "flex": 1, "text": "Fills remaining height" }
  ]
}
```

| layout | Main axis | Child sizing |
|---|---|---|
| `stack` | vertical | each child needs `height` **or** `flex`; optional `width` + `align` |
| `row` | horizontal | each child needs `width` **or** `flex`; optional `height` + `align` |
| `grid` | 2D cells | `columns` (default 2); equal cell size; `gap` applies both axes |
| `layer` | z-order | **every child fills the group** (later children paint on top); ideal for card = shape bg + nested stack |

- `padding`: number, `[v,h]`, or `[t,r,b,l]`
- `align`: `start` \| `center` \| `end` \| `stretch` (cross axis)
- `justify`: `start` \| `center` \| `end` \| `space-between` (main axis leftover when no flex)
- Nested groups allowed; group nodes are **removed** after expansion (not drawn)
- Overflow of fixed sizes → `LAYOUT_INVALID` (fail-closed)
- `from-outline` currently targets the standard `960×540` canvas only
- Leaf JSON Schema still describes post-expansion IR; `loadDeck` / `validateDeck` expand groups first
- Demo: `fixtures/layout-demo/deck.json`

## Media policy

- All `image.src` values must use canonical `media/...` paths (forward slashes; no empty, `.` or `..` segments).
- File must exist, be a regular file, and pass path jail (no symlink escape).
- Extension must match sniffed content (e.g. `.png` must be a real PNG).
- Remote URLs are not accepted on the default export path.

## Chart series

```json
{
  "id": "c1",
  "type": "chart",
  "bounds": [48, 80, 864, 400],
  "chartType": "bar",
  "title": "Sales",
  "series": [
    { "name": "Revenue", "labels": ["Q1", "Q2"], "values": [10, 20] }
  ]
}
```

If `labels` is omitted, categories default to `"1"`, `"2"`, …

## Compatibility note

OpenPPT IR is **inspired by** the industry need for a presentation DSL but is **not** a clone of any proprietary PPTD format and does not claim bidirectional compatibility with Kimi Slides.

Agents: start with [`docs/AGENT.md`](AGENT.md).
