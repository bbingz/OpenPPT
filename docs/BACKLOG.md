# OpenPPT backlog (post v1.0)

v1.0 ships the **core open IR → open PPTX compiler** gap. Remaining items from discovery and product ambition:

## P1 — correctness & product surface
- [x] Chart elements in IR + OOXML chart mapping (bar/line/pie/doughnut/area via pptxgenjs)
- [x] Media policy: `media/` subtree + magic-byte sniff
- [x] Multi-file decks (`pages: ["pages/cover.json", ...]`)
- [x] Rich text runs on `text` elements
- [x] Remote image policy (default **deny**; no remote fetch on export path)
- [x] Partial PPTX → IR import (lossy) — `openppt import`
- [x] Table elements in IR + export + import — v1.5
- [x] `openppt init` project scaffold — v1.5
- [x] Markdown outline → deck (`from-outline`) — v1.5
- [x] Text hyperlinks (`href`) — v1.5

## P2 — agent UX
- [x] Thin `SKILL.md` package for Claude/Codex/Cursor (`skills/openppt/`, `bun run install:skill`)
- [x] Template skeletons (cover / TOC / body / final) bound to theme tokens (`templates/`)
- [x] Progressive disclosure docs (`docs/AGENT.md` → schema → IR.md)

## P3 — quality & layout
- [x] GitHub Actions CI (Bun test + export smoke)
- [x] `#RRGGBBAA` alpha → pptxgenjs transparency (text/shape fill)
- [x] Structured layout QA (`openppt qa`) — overlap / density / empty page / contrast / margin
- [x] Offline HTML preview (`openppt preview`)
- [x] Additional theme pack (`themes/dark.json`)
- [x] Layout primitives (`group` stack/row/grid/layer) — v1.4 / v1.4.1
- [x] QA `--fail-on` severity gate — v1.4
- [x] Extra themes (magazine, report) + sspai group dogfood — v1.4.1
- [x] Import tables from PPTX (plain cells) — v1.5
- [x] Import charts from PPTX (best-effort series/values) — v1.5
- [x] Pixel-faithful preview / browser editor — **wontfix / deferred** (not Path 1; structural HTML preview ships)

## Explicitly deferred / out of product scope
- Full WYSIWYG browser editor
- Animations / transitions / embedded video
- npm registry publish automation (repo is installable from git)
- Optional remote image allowlist fetch

## Explicitly out of product runtime
- Kimi / Moonshot branding
- neo-ppt frontend mirror
- Official or patched PPTD WASM
- Reverse-engineered proprietary design-system prose

Research copies of third-party trees (if present) stay gitignored under `upstream/`, `backups/`, `*.git`.
