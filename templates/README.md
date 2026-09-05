# OpenPPT templates

Skeletons bound to the default theme tokens (`primary`, `accent`, `text`, `muted`, `background`, `surface`).

## Full deck

| Path | Pages |
|---|---|
| [`pitch-skeleton/deck.json`](pitch-skeleton/deck.json) | cover · toc · body · final |

Replace the actual tokens — `{{DECK_TITLE}}`, `{{TITLE}}`, `{{SUBTITLE}}`,
`{{FOOTER}}`, `{{TOC_1}}`–`{{TOC_4}}`, `{{SECTION_TITLE}}`, `{{BODY}}`,
`{{CALLOUT}}`, `{{CLOSING}}`, `{{CTA}}`, and `{{CONTACT}}` — then:

```bash
bun bin/openppt.js validate templates/pitch-skeleton/deck.json
bun bin/openppt.js export templates/pitch-skeleton/deck.json -o out/pitch.pptx --force
```

Note: placeholders are plain text until you replace them — validation still succeeds because they are valid strings.

## Page fragments

Under [`pages/`](pages/) — single page objects for agents that assemble multi-page decks programmatically:

- `cover.json`
- `toc.json`
- `body.json`
- `final.json`
- `narrative.json` — one heading + body
- `two-column.json` — two peer columns
- `three-card.json` — three short peer cards
- `kpi-row.json` — explicit label/value metrics
- `sequence.json` — explicit ordered steps

These are **not** full IR documents (no `version` / `size` / `theme`). Merge into a root deck before export. Existing cover/toc/body/final stay absolute-layout fragments. The five C3 prototypes are group-based and share `from-outline` composition via `src/internal/page-prototypes.js`. Fill `{{PLACEHOLDERS}}` structurally or with a replacement **callback**; do not use JavaScript `$&` / `$$` replacement strings on author text.

Required `theme.textStyles` for the C3 fragments (all body roles ≥18pt):

| Style | Role |
|---|---|
| `$title` | section heading, 26pt, `$primary` |
| `$body` | readable body, 20pt, `$text` |
| `$muted` | supporting/continuation, 18pt, `$muted` |
| `$kpiValue` | metric value, 32pt, `$primary` |
| `$kpiLabel` | metric label, 18pt, `$muted` |
| `$stepIndex` | visible sequence index, 24pt, `$primary` |

`from-outline` injects these styles. Agents reusing the JSON fragments must define the same names. Sequence is only for explicit ordered input; KPI-row is only for explicit `label: value` metrics that already contain a number. Unordered bullets never become a timeline or fabricated statistics.

## Layout demo (groups)

Prefer `type: "group"` with `stack` / `row` / `grid` instead of hand-placing every box:

```bash
bun bin/openppt.js export fixtures/layout-demo/deck.json -o out/layout.pptx --force
```

See `docs/IR.md` § Layout primitives.
