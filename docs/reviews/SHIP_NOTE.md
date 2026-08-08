# OpenPPT SHIP_NOTE — v1.0.1

**Date:** 2026-08-08  
**Version:** `1.0.1`  
**Runtime:** **Bun only** (`engines.bun >= 1.1.0`) — not Node  
**Commands:** `bun install` · `bun test ./test/` · `bun bin/openppt.js`

## Gate

```text
bun test ./test/
# 25 pass, 0 fail, 3 files
```

## Key fixes — Round 1

- Non-finite YAML bounds/size (`.nan` / `.inf`) **fail closed**
- Symlink-aware project-root jail + media must be a **regular file**
- Media extension allowlist: `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg`
- `compileToPptx` / `compileToBuffer` share **`buildPresentation`**
- Bun shebang; test scope `bun test ./test/`; lockfile → `bun.lock`
- CLI rejects unknown options / bad `-o`

## Key fixes — Round 2

- Realpath-based CLI entrypoint (symlinked `bin` works)
- Atomic export: write temp `.tmp.pptx` then rename (no pre-unlink of destination)
- Refuse overwriting source deck path even with `--force`
- Deck-wide unique page/element IDs (documented)
- Canvas size max **5376px**; finite checks for `fontSize` / `lineWidth`
- Docs: `fontSize` is **points**; `#RRGGBBAA` alpha drop documented

## Residual backlog (post v1.0.1)

- Magic-byte media sniff / require `media/` subtree only
- Full alpha → pptxgenjs transparency mapping
- Schema-level uniqueness (or documented semantic-only)
- Dependency audit for pptxgenjs advisories
- Windows CI for shebang/symlink tests

## Review artifacts

- `docs/reviews/SUMMARY.md`
- `docs/reviews/round1-claude.md` / `round1-codex.md`
- `docs/reviews/round2-claude.md` / `round2-codex.md`
