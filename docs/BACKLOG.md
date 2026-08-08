# OpenPPT backlog (post v1.0)

v1.0 ships the **core open IR → open PPTX compiler** gap. Remaining items from discovery and product ambition:

## P1 — correctness & product surface
- [ ] Chart elements in IR + OOXML chart mapping
- [ ] Multi-file decks (`deck.json` + `pages/*.page.json`)
- [ ] Remote image policy (default deny; optional allowlist)
- [ ] Partial PPTX → IR import (lossy OK if documented)
- [ ] Rich text spans (bold/color runs inside one box)

## P2 — agent UX
- [ ] Thin `SKILL.md` package for Claude/Codex/Cursor
- [ ] Template skeletons (cover / TOC / body / final) bound to theme tokens
- [ ] Progressive disclosure docs (schema-first, not 2k-line prose)

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
