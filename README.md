# OpenPPT

**Open intermediate representation (IR) → open-source compiler → editable PowerPoint (`.pptx`).**

OpenPPT fills the open-source gap left by proprietary “YAML deck + closed WASM exporter” stacks: agents write a **declarative, schema-checked deck**, and a **deterministic OSS path** (pptxgenjs) produces a real, text-editable PPTX. **No Kimi / neo-ppt frontend mirror and no official WASM** are required for the default export path.

| | |
|---|---|
| **Version** | **1.4.0** |
| **License** | Apache-2.0 (see `LICENSE` + `NOTICE`) |
| **Runtime** | **Bun** ≥ 1.1 (preferred; scripts and shebang use Bun) |
| **Default exporter** | [pptxgenjs](https://github.com/gitbrent/PptxGenJS) (MIT) |
| **Repo** | https://github.com/bbingz/OpenPPT |

## Install (local)

```bash
git clone https://github.com/bbingz/OpenPPT.git
cd OpenPPT
bun install
```

```bash
# validate IR
bun bin/openppt.js validate fixtures/golden/deck.json

# export editable PPTX
bun bin/openppt.js export fixtures/golden/deck.json -o out/deck.pptx --force

# lossy import PPTX → IR project
bun bin/openppt.js import out/deck.pptx -o recovered/ --force

# structural layout QA (JSON report; --fail-on low|med|high|critical)
bun bin/openppt.js qa fixtures/golden/deck.json
bun bin/openppt.js qa fixtures/golden/deck.json --fail-on med

# offline HTML preview
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
- **Elements (v1.2):** `text` (string or **rich runs**) · `shape` · `image` · `chart`
- **Layout groups (v1.4):** `type: "group"` with `layout: stack|row|grid` → absolute bounds at load
- **Multi-file:** `pages` may list relative page files (e.g. `"pages/cover.json"`)
- **Bounds:** absolute `[x, y, width, height]` — must fit inside the canvas
- **IDs:** page ids and element ids must each be unique **across the whole deck**
  (element ids are not scoped per page — don't reuse `title` on every slide)
- **Media:** **`media/` only**; extension + magic-byte check; no remote URLs; no symlink escape

Golden fixture: [`fixtures/golden/deck.json`](fixtures/golden/deck.json) (2 pages: cover + body, text/shape/image).

**Templates:** [`templates/pitch-skeleton/deck.json`](templates/pitch-skeleton/deck.json) (cover · TOC · body · final) and page fragments under [`templates/pages/`](templates/pages/). See [`templates/README.md`](templates/README.md).

**Charts demo:** [`fixtures/chart-demo/deck.json`](fixtures/chart-demo/deck.json).

**Layout demo:** [`fixtures/layout-demo/deck.json`](fixtures/layout-demo/deck.json) (stack · nested row · grid).

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

The last two are enforced by `validateDeck`, not by the JSON Schema — schema
alone cannot express cross-document uniqueness.

## Agent usage (thin skill)

1. Read `schema/openppt-ir.schema.json`. Optionally copy colors from `themes/default.json` into your deck's `theme.colors` (it is a **template only** — not auto-loaded at runtime).
2. Write a self-contained project: `deck.json` + `media/*` next to it.
3. Run `bun bin/openppt.js validate <deck.json>` and fix errors.
4. Run `bun bin/openppt.js export <deck.json> -o <deck.pptx> --force`.
5. Deliver both the IR project folder and the `.pptx`.

Do **not** call any Kimi WASM, neo-ppt mirror, or `www.kimi.com` export path.
Use **Bun**, not Node, for install/test/export in this project.

## What v1.0 is / is not

**In scope**

- Versioned open IR + machine-checkable schema  
- Open compiler to real OOXML PPTX (editable text)  
- Structural validation (bounds + media)  
- CLI + library entry points + tests  

**Not in v1.0 (backlog)**

- Charts, animations, font embedding parity  
- Browser WYSIWYG editor  
- Lossless PPTX → IR round-trip  
- Full consulting design-system packs  
- npm registry publish  

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
