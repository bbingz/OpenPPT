# Changelog

## 1.4.0 — 2026-08-09

- **layout primitives:** authoring `type: "group"` with `layout: stack|row|grid` expands at load into absolute leaf bounds (nested groups, `gap`, `padding`, `flex`, `height`/`width`, `align`, `justify`, grid `columns`)
- Fail-closed overflow: `LAYOUT_INVALID` when fixed children exceed the group
- **qa:** `--fail-on low|med|high|critical` (default `high`) gates process exit for CI
- Fixture: `fixtures/layout-demo/deck.json`

## 1.3.1 — 2026-08-09

- **fix:** images default to `fit: cover` without stretch. pptxgenjs uses placement w/h as image aspect — compiler now reads natural pixel size and passes correct aspect so OOXML `srcRect` actually crops
- schema: `fit` ∈ cover|contain|crop|fill (`fill` = legacy stretch)
- QA: CJK-aware `TEXT_OVERFLOW_RISK` heuristic
- Preview HTML respects image `fit`

## 1.3.0 — 2026-08-09

- **import:** lossy `openppt import file.pptx -o project/` (text/shapes/images → IR)
- **qa:** structural layout analysis (`openppt qa`) — overlaps, density, empty pages
- **preview:** offline HTML preview (`openppt preview -o out.html`)
- Theme pack: `themes/dark.json`
- Dependency: direct `jszip` for import

## 1.2.1 — 2026-08-09

- GitHub Actions CI (`bun test` + export smoke on Ubuntu)
- Map `#RRGGBBAA` alpha to pptxgenjs transparency for text and shape fills

## 1.2.0 — 2026-08-09

- **Multi-file decks:** `pages` may reference relative page JSON/YAML files under the project
- **Rich text:** `text` may be an array of runs `{text, bold?, italic?, color?, fontSize?, fontFamily?}`
- Fixture `fixtures/multi-file/` + tests

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
