# OpenPPT backlog (post v1.0)

v1.0 ships the **core open IR → open PPTX compiler** gap. Remaining items from discovery and product ambition:

## P1 — correctness & product surface
- [x] Chart elements in IR + OOXML chart mapping (bar/line/pie/doughnut/area via pptxgenjs)
- [x] Media policy: `media/` subtree + magic-byte sniff
- [x] Multi-file decks (`pages: ["pages/cover.json", ...]`)
- [x] Rich text runs on `text` elements
- [ ] Remote image policy (default deny; optional allowlist) — remote already denied
- [ ] Partial PPTX → IR import (lossy OK if documented)

## P2 — agent UX
- [x] Thin `SKILL.md` package for Claude/Codex/Cursor (`skills/openppt/`, `bun run install:skill`)
- [x] Template skeletons (cover / TOC / body / final) bound to theme tokens (`templates/`)
- [x] Progressive disclosure docs (`docs/AGENT.md` → schema → IR.md)

## P3 — quality & layout
- [ ] Structured layout QA (overlap, density heuristics) without browser
- [ ] Optional preview HTML renderer for the same IR
- [ ] Additional original theme packs (Apache-2.0 only)

## Explicitly out of product runtime
- Kimi / Moonshot branding
- neo-ppt frontend mirror
- Official or patched PPTD WASM
- Reverse-engineered proprietary design-system prose

Research copies of third-party trees (if present) stay gitignored under `upstream/`, `backups/`, `*.git`.
