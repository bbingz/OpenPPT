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
- Color `#RRGGBBAA`: v1.0 drops alpha at export (lossy); prefer `#RRGGBB`.

## Identifiers

- `page.id` must be unique across the deck.
- `element.id` must be unique across the **entire deck**, not merely within its
  page. Reusing `title` on every slide is rejected with `SCHEMA_INVALID`.
- Rationale: ids are the IR's only stable handles for future diff/patch and
  round-trip tooling, so they address one element unambiguously.
- Neither rule lives in the JSON Schema (which cannot express cross-document
  uniqueness); both are enforced by `validateDeck`.

## Element types (v1)

| type | Required fields | Notes |
|---|---|---|
| `text` | id, bounds, text | optional fontSize, color, bold, align, valign |
| `shape` | id, bounds, shape | shape ∈ rect, roundRect, ellipse |
| `image` | id, bounds, src | local relative path only |

## Compatibility note

OpenPPT IR is **inspired by** the industry need for a presentation DSL but is **not** a clone of any proprietary PPTD format and does not claim bidirectional compatibility with Kimi Slides.
