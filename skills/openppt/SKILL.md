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

## Intake, design, content, material

Do not run a canned questionnaire, required table of contents, or a blanket
bullet/whitespace ban. Infer or confirm purpose, audience, input facts, page
budget, and visual direction **only when those would change the deck**. If one
of those is still ambiguous, ask that one thing; otherwise proceed with a
stated assumption.

- **One job per slide.** State a claim and the evidence that supports it.
  Do not stack unrelated points because the skeleton has empty boxes.
- **Structure follows content.** Comparison, sequence, KPI row, chart, table,
  or image — pick the form the facts need, not a default layout.
- **Hierarchy and craft.** Visible heading vs body, aligned edges, consistent
  type and color roles, intentional whitespace. Cut or restructure copy
  instead of shrinking everything to fit.
- **Bullets are for parallel items**, not the default on every page.
- **Replace filler.** Unsupported claims, leftover `{{TOKENS}}`, and generic
  lorem do not ship. Use concrete sourced content.
- **Images serve the message.** Own, user-provided, or permissioned files,
  with provenance. Not stock decoration. Bytes live under `media/` and must
  match the extension.

Units and IR syntax (96 dpi bounds, point `fontSize`, XML-safe `fontFamily`)
are in **Write IR** below and `docs/IR.md`, not a substitute for the slide
judgment above. Font and spacing are **separate** chains: `fontFamily` is run →
paragraph → element → `$style` → `theme.fonts.latin` → Arial;
`lineHeight`/`spaceBefore`/`spaceAfter` are paragraph → element → `$style` →
defaults (runs cannot set them); `charSpacing` is run → paragraph → element →
`$style` → 0. Paragraph `false`/`0` overrides are kept.

## Workflow

### 1. Choose a starting shape

- **From scratch:** write IR, or copy a skeleton under `templates/` and
  replace its tokens with real copy.
- **From outline:** `from-outline` (`#` title, `##` section, `-` bullets)
  emits a **starter** project using original page prototypes (narrative,
  two-column, three-card, KPI-row, sequence) chosen from the content.
  It is not a finished deck. Edit titles, bounds, charts, tables, and
  wording before any delivery claim.
- **Style:** copy only the top-level `colors` value from
  `themes/default.json` (or dark/magazine/report) into `deck.theme.colors`.
  Do not copy the theme file's `id` or `name`.

`init --skeleton` creates four pages; without `--skeleton`, two. `--force`
replaces an existing `deck.json`, so do not chain `init` and `from-outline`
against the same directory unless replacement is intended.

### 2. Write IR

- Normalized leaf schema: `schema/openppt-ir.schema.json`.
- Groups (`stack|row|grid|layer`) are authoring-only; `loadDeck` /
  `validateDeck` expand them first. See `docs/IR.md` and
  `fixtures/layout-demo/`.
- Multi-file decks: `pages: ["pages/cover.json", ...]` — each file is a full
  page object; paths stay inside the project.
- Rules agents forget most often:
  - `"version": "openppt-1"`
  - Bounds `[x,y,w,h]` in CSS pixels at 96 dpi, inside `size`
  - **`fontSize` is points**, not CSS px (1pt = 4/3 CSS px at 96 dpi)
  - `fontFamily` is XML-safe (Latin/CJK letters and digits, space,
    apostrophe, hyphen, `_.()`). Chain: run → paragraph → element →
    `$style` → `theme.fonts.latin` → Arial
  - Page ids and **element ids unique deck-wide**
  - Images: only `media/...`; real bytes; `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg`
  - Text `href` only `http://`, `https://`, or `mailto:`
  - Charts: `chartType` ∈ bar|line|pie|doughnut|area. Omitted series `labels`
    become `"1"`, `"2"`, …. Series may mix explicit labels with omitted
    labels **when those vectors agree** (example: explicit `["1","2"]` with a
    second series that omits labels and has two values). Mismatched category
    vectors are rejected. Pie and doughnut take **one** series.
  - Tables: `rows`, optional `header`, `colW`
  - Rich text: `text: [{ "text": "Hi", "bold": true, "italic": true }]`
  - Theme tokens: `"$primary"` under `theme.colors`
  - `theme.fonts`: `{ latin?, ea? }`; `theme.textStyles` via `style: "$body"`
    may set `fontSize`, `fontFamily`, `color`, `bold`, `italic`, `align`,
    `valign`, `lineHeight`, `spaceBefore`, `spaceAfter`, `charSpacing`
  - Explicit `paragraphs` (instead of `text`; exactly one): bullets
    `{type:"bullet"|"number", level?, start?, indent?}` (default indent 18pt).
    `lineHeight` 0.5–9.99 (new paragraphs default 1.2);
    `spaceBefore`/`spaceAfter` 0–1584pt (default 0); `charSpacing` −100..100pt
    (default 0)

### 3. Scaffold (optional)

```bash
OPENPPT_ROOT=$(cat "$HOME/.agents/skills/openppt/OPENPPT_ROOT")
bun "$OPENPPT_ROOT/bin/openppt.js" init /abs/path/project --skeleton --theme magazine --title "Deck"
# OR a starter only — edit before delivery:
bun "$OPENPPT_ROOT/bin/openppt.js" from-outline /abs/path/outline.md -o /abs/path/project
```

### 4. Validate, QA, export, preview

These are **different** checks. None of them is glyph or editorial approval.

```bash
bun "$OPENPPT_ROOT/bin/openppt.js" validate /abs/path/project/deck.json
bun "$OPENPPT_ROOT/bin/openppt.js" qa       /abs/path/project/deck.json
bun "$OPENPPT_ROOT/bin/openppt.js" qa       /abs/path/project/deck.json --fail-on med
bun "$OPENPPT_ROOT/bin/openppt.js" export  /abs/path/project/deck.json -o /abs/path/project/deck.pptx --force
bun "$OPENPPT_ROOT/bin/openppt.js" preview /abs/path/project/deck.json -o /abs/path/project/preview.html --force
```

- **validate** — schema, bounds, media, chart category contract.
- **qa** — heuristic layout (overflow capacity uses CSS px + default text
  insets). A pass is not visual quality.
- **preview** — offline HTML approximation. Charts render as **structural
  SVG mini-charts**, not PowerPoint chart objects. Not pixel-faithful.
- **export** — the PPTX to review.

Import existing PPTX (lossy):

```bash
bun "$OPENPPT_ROOT/bin/openppt.js" import /abs/path/in.pptx -o /abs/path/project/ --force
```

If the current working directory is the OpenPPT repo, use `bun bin/openppt.js ...`.

Fix `SCHEMA_INVALID` / `BOUNDS_OUT_OF_RANGE` / `LAYOUT_INVALID` / `MEDIA_MISSING` /
`MEDIA_TYPE_INVALID` / `THEME_COLOR_UNRESOLVED` / `RESOURCE_LIMIT_EXCEEDED`
before re-exporting. Do not hand-edit the PPTX to paper over IR errors.

### 5. Visual delivery (required before claiming the slides look right)

CLI exit 0, PDF page count, and QA green are **not** visual success. The
**delivery gate** is the **already exported PPTX**, not a second compile from
IR.

1. Export the final PPTX (`export` above).
2. Convert **that PPTX file** to PDF with the existing synchronous public API
   (needs LibreOffice / `SOFFICE`; PPTX export itself never does).
   `./src/index.js` is relative to the **OpenPPT repository root**, not the
   deck folder. From any working directory (including outside the repo):

    ```bash
    OPENPPT_ROOT=$(cat "$HOME/.agents/skills/openppt/OPENPPT_ROOT")
    ( cd "$OPENPPT_ROOT" && bun -e 'import {convertPptxToPdf} from "./src/index.js"; console.log(convertPptxToPdf(process.argv[1], process.argv[2], {force:true}));' /abs/input.pptx /abs/output.pdf )
    ```

   If you are already in the OpenPPT repo, `cd` is unnecessary; run the `bun -e`
   line from that root. Absolute PPTX and PDF paths still work from there.

3. Raster that PDF (for example `pdftoppm -png /abs/output.pdf /abs/page`).
4. **View** the images.
5. If type, overflow, color, or missing glyphs are wrong, **edit the IR**,
   re-export the PPTX, and rerender from that new PPTX. Do not declare visual
   success from structure alone.

A listing of installed fonts (`fc-list` / `fc-match`) is **not** glyph proof.
If CJK is named in the PPTX and a matching face exists on the machine but the
PDF/raster shows English only, the cause is **unverified** — do not call it a
confirmed font-selection diagnosis, and do not claim fonts are absent.

#### Convenience IR→PDF (not the delivery gate)

`bun bin/openppt.js pdf deck.json -o deck.pdf --force` recompiles IR, then
renders. It is a convenience path. It is **not** interchangeable with the
exact-PPTX gate above and does not verify the PPTX you already exported.

### 6. Templates (skeletons)

Copy from the repo (paths relative to OpenPPT root):

| Skeleton | Path | Use |
|---|---|---|
| Full deck | `templates/pitch-skeleton/deck.json` | Cover + TOC + body + final (4 pages) |
| Cover only | `templates/pages/cover.json` | Single-page fragment to merge |
| TOC | `templates/pages/toc.json` | |
| Body | `templates/pages/body.json` | |
| Final | `templates/pages/final.json` | |
| Narrative | `templates/pages/narrative.json` | Heading + body |
| Two-column | `templates/pages/two-column.json` | Two peer columns |
| Three-card | `templates/pages/three-card.json` | Three short peers |
| KPI-row | `templates/pages/kpi-row.json` | Explicit label/value metrics |
| Sequence | `templates/pages/sequence.json` | Explicit ordered steps |

Replace placeholder strings with real copy: `{{DECK_TITLE}}`, `{{TITLE}}`,
`{{SUBTITLE}}`, `{{FOOTER}}`, `{{TOC_1}}`–`{{TOC_4}}`, `{{SECTION_TITLE}}`,
`{{BODY}}`, `{{CALLOUT}}`, `{{CLOSING}}`, `{{CTA}}`, `{{CONTACT}}`.
`init --skeleton --title` fills the deck title and `{{TITLE}}`; remaining
tokens still need content. Keep bounds and `$` theme tokens unless redesigning.

### 7. Studio saves (local workbench)

`bun bin/openppt.js serve` is loopback-only. `GET /api/projects/:id` returns a
strong ETag (SHA-256 of the exact source bytes). `PUT .../deck` requires
`If-Match`: missing → **428**, stale / weak / `*` → **412**. `PATCH .../deck`
accepts `{operations}` (1–64 `add` / `update` / `remove`) with the same strong
If-Match on **inline `deck.json` page objects only**; YAML and decks that list
external page files return `UNSUPPORTED_EDIT`. `GET .../events` is bounded
same-origin SSE (`ready` / `changed` / `deleted` / `error`); the workbench
subscribes only while mounted and reconciles with an authoritative GET. Dirty
drafts keep exact text and the original base ETag. The inspector may edit plain
text, own `fontSize`, and root absolute bounds on a clean saved deck. Structured
run/paragraph **contents** stay in JSON (do not flatten them); `fontSize` on
that element is still inspector-editable. Group-child layout bounds stay in JSON.

The editor stores each draft with that base ETag; a conflict keeps both disk and
the editor and offers copy / reload-from-disk. The hash detects **byte**
changes. A write that does not change bytes need not mint a new tag. External
CLI writers are **not** locked. HTML preview is an approximation, not
pixel-perfect PowerPoint.

Copyable PATCH (clean inline `deck.json`; `notes` already has `paragraphs`, so
only `fontSize` — do not also send `text`):

```http
PATCH /api/projects/demo/deck
If-Match: "<etag>"
Content-Type: application/json

{"operations":[{"op":"update","pageId":"p","elementId":"notes","changes":{"fontSize":28}}]}
```

### 8. Delivery

Link:

- project directory
- `deck.json`
- `media/` if any
- `deck.pptx`

Say what you actually viewed (PPTX→PDF→raster) and which renderer/font limits
remain. Coverage or QA thresholds do not certify quality.

## Out of scope for this skill

- Kimi / open-kimi-ppt / neo-ppt / PPTD WASM paths
- Animations and font embedding are not produced by the current compiler
- Chart **import** is best-effort; chart **authoring** is supported
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
