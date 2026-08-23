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

These are **not** full IR documents (no `version` / `size` / `theme`). Merge into a root deck before export.

## Layout demo (groups)

Prefer `type: "group"` with `stack` / `row` / `grid` instead of hand-placing every box:

```bash
bun bin/openppt.js export fixtures/layout-demo/deck.json -o out/layout.pptx --force
```

See `docs/IR.md` § Layout primitives.
