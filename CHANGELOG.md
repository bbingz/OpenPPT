# Changelog

## 1.1.0 — 2026-08-09

- **Charts:** IR `chart` elements (`bar` / `line` / `pie` / `doughnut` / `area`) exported via pptxgenjs
- **Media hardening:** images must live under `media/`; magic-byte sniff + extension match (`MEDIA_TYPE_INVALID`)
- **Docs:** progressive `docs/AGENT.md` for agents; chart demo fixture
- Tests for charts, media subtree, and fake image bytes

## 1.0.2 — 2026-08-09

- Published repo: https://github.com/bbingz/OpenPPT
- Agent skill: `skills/openppt/SKILL.md` + `bun run install:skill`
- Templates: pitch skeleton (cover/TOC/body/final) and page fragments under `templates/`
- Tests cover pitch-skeleton validate + export

## 1.0.1 — 2026-08-08

- Bun is the supported runtime (`bun install`, `bun test ./test/`, `bun bin/openppt.js`).
- Security: finite bounds, symlink path jail, media extension allowlist, atomic export, refuse overwrite of source deck.
- CLI: realpath entrypoint for linked bins; reject unknown options.
- Reviews: Herdr Claude+Codex two rounds under `docs/reviews/`.

## 1.0.0 — 2026-08-08

- Initial open IR + pptxgenjs compiler.
