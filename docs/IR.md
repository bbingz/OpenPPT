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
- Units: CSS pixels; export maps `px / 96` → inches for pptxgenjs.
- `fontSize` is passed through as points (1px ≈ 1pt in IR docs).

## Element types (v1)

| type | Required fields | Notes |
|---|---|---|
| `text` | id, bounds, text | optional fontSize, color, bold, align, valign |
| `shape` | id, bounds, shape | shape ∈ rect, roundRect, ellipse |
| `image` | id, bounds, src | local relative path only |

## Compatibility note

OpenPPT IR is **inspired by** the industry need for a presentation DSL but is **not** a clone of any proprietary PPTD format and does not claim bidirectional compatibility with Kimi Slides.
