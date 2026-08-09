# OpenPPT templates

Skeletons bound to the default theme tokens (`primary`, `accent`, `text`, `muted`, `background`, `surface`).

## Full deck

| Path | Pages |
|---|---|
| [`pitch-skeleton/deck.json`](pitch-skeleton/deck.json) | cover · toc · body · final |

Replace `{{PLACEHOLDERS}}` then:

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
