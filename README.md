# OpenPPT

**Open intermediate representation (IR) → open-source compiler → editable PowerPoint (`.pptx`).**

OpenPPT fills the open-source gap left by proprietary “YAML deck + closed WASM exporter” stacks: agents write a **declarative, schema-checked deck**, and a **deterministic OSS path** (pptxgenjs) produces a real, text-editable PPTX. **No Kimi / neo-ppt frontend mirror and no official WASM** are required for the default export path.

| | |
|---|---|
| **Version** | **1.0.0** |
| **License** | Apache-2.0 (see `LICENSE` + `NOTICE`) |
| **Runtime** | Node.js 18+ |
| **Default exporter** | [pptxgenjs](https://github.com/gitbrent/PptxGenJS) (MIT) |

## Install (local)

```bash
cd /path/to/OpenPPT
npm install
```

```bash
# validate IR
node bin/openppt.js validate fixtures/golden/deck.json

# export editable PPTX
node bin/openppt.js export fixtures/golden/deck.json -o out/deck.pptx --force
```

After `npm link` / global install, the binary name is `openppt`.

## Open IR (v1)

- **Schema:** [`schema/openppt-ir.schema.json`](schema/openppt-ir.schema.json)
- **Version marker:** `"version": "openppt-1"`
- **Canvas:** `size: [width, height]` in CSS pixels (default fixture uses 960×540)
- **Theme tokens:** `"$primary"` style references under `theme.colors`
- **Elements (v1.0):** `text` · `shape` (`rect` | `roundRect` | `ellipse`) · `image` (local path only)
- **Bounds:** absolute `[x, y, width, height]` — must fit inside the canvas
- **Media:** project-relative paths only; absolute paths and `..` escapes are rejected

Golden fixture: [`fixtures/golden/deck.json`](fixtures/golden/deck.json) (2 pages: cover + body, text/shape/image).

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

## Agent usage (thin skill)

1. Read `schema/openppt-ir.schema.json` and `themes/default.json`.
2. Write a self-contained project: `deck.json` + `media/*` next to it.
3. Run `node bin/openppt.js validate <deck.json>` and fix errors.
4. Run `node bin/openppt.js export <deck.json> -o <deck.pptx> --force`.
5. Deliver both the IR project folder and the `.pptx`.

Do **not** call any Kimi WASM, neo-ppt mirror, or `www.kimi.com` export path.

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
npm test
```

## License

Apache-2.0 — Copyright 2026 OpenPPT contributors. Third-party notices in `NOTICE`.
