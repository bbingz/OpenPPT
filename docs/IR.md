# OpenPPT IR overview

Status: **stable for OpenPPT v1.5** (`version: "openppt-1"`), with additional hardening tracked under Unreleased.

The machine-readable [schema](../schema/openppt-ir.schema.json) describes normalized leaf IR after authoring groups are expanded. Group-bearing authoring IR is documented below and must go through `loadDeck` / `validateDeck` before leaf-schema validation.

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
  At the 96 dpi bound mapping, 1pt = 4/3 CSS px. A box of height 24px with
  `fontSize: 24` is larger type than the box in CSS terms.
- Color `#RRGGBBAA`: alpha maps to pptxgenjs `transparency` (0–100) on text, shape fill/line, slide background, and table cell fill/text.

## Identifiers

- `page.id` must be unique across the deck.
- `element.id` must be unique across the **entire deck**, not merely within its
  page. Reusing `title` on every slide is rejected with `SCHEMA_INVALID`.
- Rationale: ids are the IR's only stable handles for future diff/patch and
  round-trip tooling, so they address one element unambiguously.
- Studio `PATCH /api/projects/:id/deck` edits those ids on inline `deck.json`
  authoring nodes (including groups). It does not rewrite external page files.
- Neither rule lives in the JSON Schema (which cannot express cross-document
  uniqueness); both are enforced by `validateDeck`.

## Resource ceilings

OpenPPT enforces fixed safety ceilings before layout expansion and again before
export, QA, or preview. They are runtime policy, not OOXML format limits.

| Resource | Maximum |
|---|---:|
| Named `theme.textStyles` | 128 |
| Explicit paragraphs per text element | 256 |
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
| Imported PPTX archive bytes / entries | 192 MiB / 4,096 |
| Imported PPTX uncompressed bytes per entry / archive | 32 MiB / 256 MiB |
| Referenced local media per file / deck total | 32 MiB / 128 MiB |

Authoring nodes include groups and leaves and are counted before groups are
flattened. String accounting covers supported free-form IR values such as IDs,
content, labels, paths, font families, hyperlinks, colors, and theme names.
Structural and string limits apply even when media checks are disabled. Media
byte limits apply when `checkMedia` is enabled and count each canonical resolved
local path once, regardless of repeated references. Exceeding a ceiling throws
`RESOURCE_LIMIT_EXCEEDED`.

PPTX import checks archive bytes and the raw central-directory entry count
before JSZip parsing, then enforces declared and actual streaming inflate limits.
These ceilings do not limit source JSON/YAML bytes, generated output bytes,
execution time, or total process memory beyond the bounded inputs above.

## Element types (v1.1+)

| type | Required fields | Notes |
|---|---|---|
| `text` | id, bounds, **exactly one of** `text` or `paragraphs` | optional fontSize (**points**), fontFamily, color, bold, italic, align, valign, `style` (`$name`), lineHeight, spaceBefore/After, charSpacing |
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
- `from-outline` currently targets the standard `960×540` canvas only. It picks original `templates/pages` prototypes (narrative, two-column, three-card, KPI-row, sequence) from the supplied outline, paginates overflow at readable ≥18pt, and does not emit generated-by copy.
- Leaf JSON Schema still describes post-expansion IR; `loadDeck` / `validateDeck` expand groups first
- Demo: `fixtures/layout-demo/deck.json`

## Media policy

- All `image.src` values must use canonical `media/...` paths (forward slashes; no empty, `.` or `..` segments).
- File must exist, be a regular file, and pass path jail (no symlink escape).
- Extension must match sniffed content (e.g. `.png` must be a real PNG).
- PPTX export and HTML preview snapshot each referenced local image once per operation. Path policy, byte limits, type sniffing, image sizing, and emitted media all use that same snapshot; project media paths are not reopened after validation.
- Standalone validation and QA report the media state observed during that call. Export and preview always capture and validate their own media snapshots.
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

If `labels` is omitted, categories default to `"1"`, `"2"`, …. Every series
must share the same category vector after that defaulting. Explicit labels
and omitted labels **together are valid when those vectors agree** (example:
one series `labels: ["1","2"]` and another series with two values and no
`labels`). Mismatched vectors are `SCHEMA_INVALID`. `pie` and `doughnut`
accept a single series only. Preview draws structural SVG mini-charts; the
PPTX holds native charts.

`fontFamily` (run, paragraph, or element) allows XML 1.0-safe Latin/CJK letters,
digits, space, apostrophe, hyphen, underscore, period, and parentheses.

Optional `theme.fonts` is `{ latin?: fontFamily, ea?: fontFamily }`. When
`theme.fonts.ea` is set, that name is the East Asian typeface on generated
DrawingML (`a:ea`) for slides, tables, charts, and theme font defaults; Latin
`a:latin` stays independent. Without `ea`, both scripts keep the existing
shared `fontFamily` behavior. There are no per-run EA aliases.

Optional `theme.textStyles` maps up to 128 names to `{ fontSize, fontFamily,
color, bold, italic, align, valign, lineHeight, spaceBefore, spaceAfter,
charSpacing }`. Text elements may set `style: "$body"`. Lookup is own-property
only; unknown names and invalid unused definitions fail closed. Paragraph and
element own-fields including explicit `false`/`0` win over the style; run
own-fields win over the resolved paragraph/element where runs exist. Styles do
not nest, cascade, or attach to groups (text children may still reference
them). `validateDeck` resolves references once on a detached clone so export,
preview, and QA share the effective style.

These are separate chains (do not apply `theme.fonts` → Arial to spacing):

- **`fontFamily`:** run → paragraph → element → `$style` → `theme.fonts.latin` → Arial.
- **`lineHeight` / `spaceBefore` / `spaceAfter`:** paragraph → element → `$style` → documented defaults. Runs cannot set them. New `paragraphs` default `lineHeight` 1.2; `spaceBefore`/`spaceAfter` default 0 (range 0..1584pt). `lineHeight` range is 0.5–9.99.
- **`charSpacing`:** run → paragraph → element → `$style` → default 0 (range −100..100pt).

Legacy `text` without the new typography fields keeps old behavior.

Explicit `paragraphs` is an alternative to `text`. Exactly one is required.
Each entry is one DrawingML paragraph; CRLF inside an entry is a soft `a:br`,
not another bullet. `bullet` may be `false`, `true` (U+2022), or
`{type:"bullet"|"number", level?:0..8, start?:1..32767, indent?:0..1584pt}`.
`start` is numbered-only. Sequences are local to one text element; computed
display numbers are emitted as `startAt` and must stay in 1..32767 (a 32767
item cannot continue implicitly). Default indent is 18pt; `indent: 0` stays
zero. Derived `marL` is `round(indentPt * 12700) * (level + 1)` and must stay
≤ 51206400 EMU (so level 8 + 1584pt is rejected; level 0 + 1584pt and level 8
+ 448pt are valid).

Copyable theme, paragraphs, and Studio PATCH (inline `deck.json` only). Merge
the theme object into the deck root next to `version`/`pages`. Put `notes` on
the page whose `id` is `p`.

```json
{
  "theme": {
    "fonts": { "latin": "Georgia", "ea": "Noto Sans CJK SC" },
    "textStyles": {
      "body": {
        "fontSize": 18,
        "fontFamily": "Georgia",
        "lineHeight": 1.2,
        "spaceBefore": 0,
        "spaceAfter": 6,
        "charSpacing": 0
      }
    }
  }
}
```

```json
{
  "id": "notes",
  "type": "text",
  "bounds": [40, 80, 880, 360],
  "style": "$body",
  "paragraphs": [
    { "text": "First", "bullet": { "type": "number", "start": 1 } },
    { "text": "Second", "bullet": { "type": "number" } },
    { "text": "Callout", "bullet": true, "spaceBefore": 12 }
  ]
}
```

Because `notes` already uses `paragraphs`, PATCH only `fontSize` (do not also
send `text`; exactly one of `text` or `paragraphs` is required):

```http
PATCH /api/projects/:id/deck
If-Match: "<etag>"
Content-Type: application/json

{"operations":[{"op":"update","pageId":"p","elementId":"notes","changes":{"fontSize":28}}]}
```

## Compatibility note

OpenPPT IR is **inspired by** the industry need for a presentation DSL but is **not** a clone of any proprietary PPTD format and does not claim bidirectional compatibility with Kimi Slides.

Agents: start with [`docs/AGENT.md`](AGENT.md).
