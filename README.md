# OpenPPT

**Open intermediate representation (IR) → open-source compiler → editable PowerPoint (`.pptx`).**

OpenPPT fills the open-source gap left by proprietary “YAML deck + closed WASM exporter” stacks: agents write a **declarative, schema-checked deck**, and a **fully open OSS path** (pptxgenjs) produces a real, text-editable PPTX. **No Kimi / neo-ppt frontend mirror and no official WASM** are required for the default export path.

| | |
|---|---|
| **Version** | **1.5.0** |
| **License** | Apache-2.0 (see `LICENSE` + `NOTICE`) |
| **Runtime** | **Bun** ≥ 1.4 (scripts, lockfile, and shebang use Bun) |
| **Default exporter** | [pptxgenjs](https://github.com/gitbrent/PptxGenJS) (MIT) |
| **Repo** | https://github.com/bbingz/OpenPPT |

## Architecture

OpenPPT turns authored or imported inputs into normalized Open IR, applies a
shared fail-closed validation boundary, and then produces structural QA, an
offline HTML preview, or an editable OOXML PowerPoint file.

[![How OpenPPT works](https://raw.githubusercontent.com/bbingz/OpenPPT/main/docs/architecture/openppt-workflow.svg)](https://github.com/bbingz/OpenPPT/blob/main/docs/architecture/openppt-workflow.svg)

The same diagram is also available as a
[1920px PNG](https://github.com/bbingz/OpenPPT/blob/main/docs/architecture/openppt-workflow.png).

## Install (local)

```bash
git clone https://github.com/bbingz/OpenPPT.git
cd OpenPPT
bun install
```

```bash
# scaffold a four-page pitch skeleton (omit --skeleton for the two-page starter)
bun bin/openppt.js init my-deck --skeleton --theme magazine --title "Hello"

# OR create a different project from markdown (# title, ## section, - bullets)
bun bin/openppt.js from-outline fixtures/outline-sample.md -o out/from-md

# validate IR
bun bin/openppt.js validate fixtures/golden/deck.json

# export editable PPTX
bun bin/openppt.js export fixtures/golden/deck.json -o out/deck.pptx --force

# lossy import PPTX → IR project (text/shapes/images/tables + best-effort charts)
bun bin/openppt.js import out/deck.pptx -o recovered/ --force

# structural layout QA (JSON report; --fail-on low|med|high|critical)
bun bin/openppt.js qa fixtures/golden/deck.json
bun bin/openppt.js qa fixtures/golden/deck.json --fail-on med

# offline HTML preview (--force is required to replace an existing file)
bun bin/openppt.js preview fixtures/golden/deck.json -o out/preview.html

# pitch skeleton (cover + TOC + body + final)
bun bin/openppt.js export templates/pitch-skeleton/deck.json -o out/pitch.pptx --force
```

After linking, the binary name is `openppt` (shebang: `#!/usr/bin/env bun`).

### Agent skill

Thin skill for Claude Code / Codex / Cursor (and any SKILL.md host):

```bash
bun run install:skill
# or: bash scripts/install-skill.sh
```

Installs `openppt` under `~/.agents/skills` (and `~/.claude` / `~/.codex` / `~/.cursor` / `~/.grok` when those trees exist). Source of truth: [`skills/openppt/SKILL.md`](skills/openppt/SKILL.md).

## Open IR (v1)

- **Schema:** [`schema/openppt-ir.schema.json`](schema/openppt-ir.schema.json)
- **Version marker:** `"version": "openppt-1"`
- **Canvas:** `size: [width, height]` in CSS pixels (default fixture uses 960×540)
- **Theme tokens:** `"$primary"` style references under `theme.colors`
- **Elements:** `text` (+ optional `href`) · `shape` · `image` · `chart` · **`table`**
- **Layout groups (v1.4):** `type: "group"` with `layout: stack|row|grid|layer` → absolute bounds at load
- **Multi-file:** `pages` may list relative page files (e.g. `"pages/cover.json"`)
- **Bounds:** absolute `[x, y, width, height]` — must fit inside the canvas
- **IDs:** page ids and element ids must each be unique **across the whole deck**
  (element ids are not scoped per page — don't reuse `title` on every slide)
- **Media:** **`media/` only**; extension + magic-byte check; no remote URLs or symlink escape; export/preview reuse the exact validated byte snapshot
- **Resource ceilings:** fixed page/element, string, chart/table, and referenced-media limits; see [`docs/IR.md`](docs/IR.md#resource-ceilings)

Golden fixture: [`fixtures/golden/deck.json`](fixtures/golden/deck.json) (2 pages: cover + body, text/shape/image).

**Templates:** [`templates/pitch-skeleton/deck.json`](templates/pitch-skeleton/deck.json) (cover · TOC · body · final) and page fragments under [`templates/pages/`](templates/pages/). See [`templates/README.md`](templates/README.md).

**Charts demo:** [`fixtures/chart-demo/deck.json`](fixtures/chart-demo/deck.json).

**Layout demo:** [`fixtures/layout-demo/deck.json`](fixtures/layout-demo/deck.json) (stack · nested row · grid · layer).

**Table demo:** [`fixtures/table-demo/deck.json`](fixtures/table-demo/deck.json).

**Agents:** start with [`docs/AGENT.md`](docs/AGENT.md).

### Minimal example

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
      "id": "p1",
      "background": { "type": "solid", "color": "$background" },
      "elements": [
        {
          "id": "t1",
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

## Library API

```js
import { loadDeck, validateDeck, compileToPptx, exportDeckFile } from "openppt";

const { deck, projectRoot } = loadDeck("./deck.json");
validateDeck(deck, { projectRoot, checkMedia: true });
await compileToPptx(deck, "./out.pptx", { projectRoot, force: true });

// or one-shot:
await exportDeckFile("./deck.json", "./out.pptx", { force: true });
```

## Fail-closed validation

Default export **refuses** to write a PPTX when:

| Condition | Error code |
|---|---|
| JSON Schema mismatch | `SCHEMA_INVALID` |
| Element outside canvas | `BOUNDS_OUT_OF_RANGE` |
| Missing local image | `MEDIA_MISSING` |
| Unresolved `$token` | `THEME_COLOR_UNRESOLVED` |
| Duplicate page `id` | `SCHEMA_INVALID` |
| Duplicate element `id` (deck-wide) | `SCHEMA_INVALID` |
| Documented resource ceiling exceeded | `RESOURCE_LIMIT_EXCEEDED` |

Duplicate-ID rules and resource ceilings are enforced by `validateDeck`, not by
the JSON Schema; schema alone cannot express cross-document uniqueness or the
full runtime resource policy.

## Agent usage (thin skill)

1. Start with `docs/AGENT.md`. Use `schema/openppt-ir.schema.json` as the contract for normalized leaf IR; read `docs/IR.md` when authoring `group` nodes.
2. Write a self-contained project: `deck.json` + `media/*` next to it. Optionally copy only the top-level `colors` value from `themes/default.json` into `deck.theme.colors` (the theme file is a **template only** — not auto-loaded at runtime).
3. Run `bun bin/openppt.js validate <deck.json>` and fix errors. This uses `loadDeck` / `validateDeck` to expand authoring groups before leaf-schema validation; do not run raw Ajv against group-bearing authoring IR.
4. Run `bun bin/openppt.js export <deck.json> -o <deck.pptx> --force`.
5. Deliver both the IR project folder and the `.pptx`.

Do **not** call any Kimi WASM, neo-ppt mirror, or `www.kimi.com` export path.
Use **Bun**, not Node, for install/test/export in this project.

The HTML preview is an offline structural approximation, not a pixel-faithful
PowerPoint renderer; charts appear as placeholders. Inspect the exported PPTX
for final visual QA.

## Current capabilities (v1.5.0 plus Unreleased hardening)

- Versioned open IR, machine-checkable normalized-leaf schema, and authoring layout groups
- Editable OOXML PPTX export for text, shapes, images, charts, tables, and hyperlinks
- Multi-file decks, rich text, themes, templates, `init`, and `from-outline`
- Lossy PPTX import for text, shapes, images, tables, and best-effort charts
- Fail-closed validation/resource ceilings, structural QA, and offline structural preview

## Explicitly deferred or out of product scope

- Pixel-faithful preview or a full browser WYSIWYG editor
- Animations, transitions, embedded video, and font-embedding parity
- Lossless PPTX → IR round-trip
- Optional remote-image fetching
- npm registry publish automation

See [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Explicit non-dependence on proprietary Kimi runtime

- Default export uses **only** `pptxgenjs` + our validate/load code.  
- Package `files` / dependencies do **not** include `editor/neo-ppt/**` or `pptd_wasm*.wasm`.  
- Developer checkouts may keep `upstream/` or `backups/` as **gitignored research references**; they are not required to export.

## Tests

```bash
bun test ./test/
```

The `./` prefix matters: `bun test` positional args are path filters, so a bare
`test/` (or no argument) also collects any gitignored `upstream/test/**`.

## License

Apache-2.0 — Copyright 2026 OpenPPT contributors. Third-party notices in `NOTICE`.
