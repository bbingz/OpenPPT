# Changelog

## Unreleased — 2026-08-23

- The package-install integration smoke now has a 30-second per-test timeout so cold Windows dependency resolution does not inherit Bun's 5-second unit-test default.
- CI now runs a production dependency audit that accepts only the exact two reviewed `image-size@1.2.1` advisories while their affected parsers remain unreachable from OpenPPT and the PptxGenJS runtime entrypoint.
- The audit exception fails closed on advisory metadata, dependency range/version/integrity, lockfile path, resolved runtime entry, or executable-reference drift; a fresh-process golden export also verifies that `image-size` is not loaded.
- This mitigation does not remove the installed transitive package or suppress downstream package-manager findings; upstream removal or a trusted patched release remains the complete resolution.
- Local verification passed the full 99-test suite and the live production-audit gate on Bun 1.4.0 and the current 1.4.1 canary.
- PPTX export and HTML preview now validate local images and render them from the same per-operation immutable byte snapshot, preventing output drift if project media changes while an operation is running.
- Media file type, byte ceilings, and natural dimensions are now derived from the same bounded file-descriptor read used to create output; renderers no longer reopen project media paths after validation, and repeated same-slide references retain one package payload.
- Local snapshot verification passed all 92 tests on Bun 1.4.0 and the current 1.4.1 canary, including deterministic path-replacement and non-blocking FIFO regressions.
- Validation now fails closed with `RESOURCE_LIMIT_EXCEEDED` on documented deck, authoring-group, string, chart/table collection, and referenced local-media ceilings before layout expansion or output generation.
- Local resource-ceiling verification passed all 87 tests on Bun 1.4.0 and the current 1.4.1 canary.
- CI now exercises Bun 1.4.0, stable, and canary plus stable Linux/macOS/Windows; PPTX assertions no longer depend on the system `unzip` command or POSIX-only smoke checks.
- Package tests now install the generated tarball and invoke its `openppt` bin, including the package-manager shim on Windows.
- The supported runtime floor is now Bun 1.4, matching the checked-in lockfile v2 format and the test runner contract.
- Local verification: `bun install --frozen-lockfile && bun test ./test/` passed 72 tests on Bun 1.4.0 and 1.4.1-canary.1; `actionlint .github/workflows/ci.yml` also passed.
- Validation now rejects unresolved rich-text run colors, non-finite nested renderer values, non-canonical media paths, and hyperlinks outside HTTP(S)/mailto.
- Table compilation now pads/truncates `colW` weights before normalization so the OOXML grid stays inside the declared bounds.
- Built-in theme selection is allowlisted to `default`, `dark`, `magazine`, and `report`; skeleton titles now update the visible cover.
- Outline generation paginates TOCs after seven entries, validates generated IR before writing, and fails closed on unsupported custom canvas sizes.
- Layout expansion preserves leaf text alignment and checks authoring-group IDs before flattening.
- Preview validates its public API inputs, refuses source/existing-file overwrite without explicit force, and writes through a sibling temporary file.
- Import now collects outputs before writing, validates generated IR and referenced extracted media, rejects non-force collisions atomically, and commits replacements with rollback backups.
- CLI options are checked per subcommand; preview now supports explicit `--force`.
- Package contents use an exact fixture/template whitelist, `NOTICE` includes `jszip`, and tests write generated artifacts only under temporary directories.

## 1.5.0 — 2026-08-10

- **table** IR element → pptxgenjs tables (header row, colW, cell styles)
- **import:** recover tables (plain cells) and charts (series/values best-effort)
- **init:** `openppt init <dir> [--theme] [--title] [--skeleton]`
- **from-outline:** markdown `#` / `##` / `-` → multi-page deck with layout groups
- **text.href** hyperlinks on text boxes
- QA: `TIGHT_MARGIN` (low), `LOW_CONTRAST` (med)
- Fixtures: `table-demo/`, `outline-sample.md`

## 1.4.1 — 2026-08-09

- **layout:** `layout: "layer"` — all children fill the group (card = bg shape + nested stack)
- Dogfood: `demos/sspai-113139` rewritten with stack/row/grid/layer (QA clean)
- Themes: `themes/magazine.json`, `themes/report.json`
- Pitch skeleton TOC + body use layout groups

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
