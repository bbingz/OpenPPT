# OpenPPT dual-agent review summary (2 rounds)

Agents: **Claude** (`openppt-claude`) and **Codex** (`openppt-codex`) via Herdr  
Runtime standard: **Bun** (`bun install` / `bun test ./test/` / `bun bin/openppt.js`)  
Date: 2026-08-08

## Round 1

| Source | Artifact |
|---|---|
| Claude | [`round1-claude.md`](round1-claude.md) |
| Codex | [`round1-codex.md`](round1-codex.md) |

**Merged critical/high fixes applied**

- Non-finite YAML bounds/size (`.nan`/`.inf`) fail closed  
- Symlink-aware project-root jail + regular-file media check  
- Media extension allowlist (`.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg`)  
- `compileToPptx` / `compileToBuffer` share `buildPresentation`  
- Bun shebang, `bun test ./test/` scoping, lockfile → `bun.lock`  
- CLI rejects unknown options / bad `-o`  

## Round 2

| Source | Artifact |
|---|---|
| Claude | [`round2-claude.md`](round2-claude.md) |
| Codex | [`round2-codex.md`](round2-codex.md) |

**Merged critical/high fixes applied**

- Realpath-based CLI entrypoint (symlinked `bin` works)  
- Atomic export: write temp `.tmp.pptx` then rename (no pre-unlink of destination)  
- Refuse overwriting source deck path even with `--force`  
- Deck-wide unique page/element IDs (documented)  
- Canvas size max 5376px; fontSize/lineWidth finite checks  
- Docs: `fontSize` is points; alpha drop documented  

## Gate

```text
bun test ./test/
# 25 pass, 0 fail, 3 files
```

## Residual backlog (post v1.0.1)

- Magic-byte media sniff / require `media/` subtree only  
- Full alpha → pptxgenjs transparency mapping  
- Schema-level uniqueness (or documented semantic-only)  
- Dependency audit for pptxgenjs advisories  
- Windows CI for shebang/symlink tests  
