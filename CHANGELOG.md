# Changelog

## Unreleased — 2026-08-30

- New `bun run dogfood` battery (`scripts/dogfood.js`): 12 real end-to-end
  generation scenarios (Chinese pitch from the skeleton, all five chart types
  with authored category labels, a 52-row rich-cell table, rich text with
  hyperlink rels integrity, nested stack/row/grid/layer layouts, a 30-section
  outline, multi-file decks, all five media formats with fit modes, PPTX
  import round-trip, the Studio HTTP API end to end, YAML authoring, and a
  64-page stress deck). Every scenario unzips the produced PPTX and asserts
  artifact hygiene: no `Infinity`/`NaN` attributes, no `rIdundefined`, every
  slide `r:id` resolves in its rels part, preview escaping, and size/time
  budgets. CI runs the battery on every matrix cell; `report.json` is written
  next to the kept artifacts. First run validated the pipeline (all four
  failures were harness authoring mistakes — schema and docs held up).

- New `serve` command starts **OpenPPT Studio**, a local offline web workbench
  (`Bun.serve`, no new dependencies, binds 127.0.0.1 only): project list plus
  create flows (blank / skeleton / markdown outline / lossy PPTX import),
  `deck.json` editing with draft autosave and JSON error location, fail-closed
  validate, structural preview in a sandboxed iframe (strict CSP), QA report,
  media upload/serve/delete, and PPTX download.
- Studio projects are plain CLI-compatible folders (`deck.json` + `media/`)
  under `--data-dir` (default `~/.openppt/projects`); deck saves go through the
  existing atomic writer and must parse as JSON before touching disk.
- Server hardening: allowlisted project ids (`[a-z0-9-]`) and media names with
  containment checks on every path, upload ceilings from `RESOURCE_LIMITS`,
  extension + magic-byte enforcement on media uploads, `nosniff`/`no-store`
  everywhere, and a static-file manifest (no directory serving).
- Public API adds `startWebServer`; package ships `web/`; production audit
  surface manifest re-pinned for the new `files`/`scripts` entries.
- New `test/server.test.js` covers create/list/save/validate/preview escaping,
  QA, export unpack, media magic-byte and traversal rejection, import
  round-trip, and delete (180 tests total).

## Unreleased — 2026-08-29

- Fail-closed numeric ceilings: `fontSize` 1–4000pt and `lineWidth`/`borderWidth` 0–1584pt in schema plus runtime; `fontSize: 1e308` no longer writes `sz="Infinity"`. Table `colW` stays weight-based (existing overflow-sum rejection), not capped at 1584.
- Theme tokens no longer resolve through `Object.prototype`; `resolveColor` requires `#RRGGBB` / `#RRGGBBAA` or throws `THEME_COLOR_UNRESOLVED` (`$constructor` / `$toString` / `$hasOwnProperty`).
- PNG natural size is capped (edge ≤65535px, aspect ≤10000:1) before EMU placement; oversized IHDR headers are `MEDIA_TYPE_INVALID`.
- PPTX import uses linear tag scanning instead of non-greedy `[\s\S]*?`; malformed unclosed tags fail closed in bounded time.
- Import page order follows `p:sldIdLst` + `ppt/_rels/presentation.xml.rels`; ghost `slideN.xml` files outside the list are ignored.
- Public load/validate/compile wrap untyped I/O and clone failures as `IO_ERROR` / `SCHEMA_INVALID` (EISDIR, deep clone, function values).
- Non-force PPTX export installs with exclusive `link`/`wx` (same no-clobber contract as `project-write.js`).
- Text `href` is written on each run so pptxgenjs 3.12.0 emits `hlinkClick` without `rIdundefined`.
- SVG `cover`/`contain`/`crop` parse `width`/`height`/`viewBox`; missing size is `MEDIA_TYPE_INVALID` unless `fit=fill`.
- Zero-width shape/table borders emit `{type:"none"}`; run `bold:false` is materialized; RGBA alpha is passed as transparency on background, lines, and table fills.
- Flex weights are normalized before multiply with a finite check (`LAYOUT_INVALID`); layer leaves copy bounds instead of sharing one array.
- Single-series pie/doughnut charts show legend and data labels; padded header cells reuse full header style.
- Import keeps only `mc:Fallback` (else Choice), preserves `a:p`/`a:br` newlines, parses relationships in any attribute order with single quotes and OPC target resolve, skips `p:grpSp` with a warning, and removes empty `outDir`/`media` created by a failed commit.
- QA composites text alpha over the page background, scores contrast per run, estimates overflow from the largest run fontSize, and reports mixed-type overlap except the text-on-shape whitelist.
- CLI supports `--` as an options terminator, warns on duplicate flags, prints missing-command errors on stderr, and uses `ALREADY_EXISTS` for occupied `init` / `from-outline` targets.
- Preview HTML escapes single quotes (`&#39;`). Skill install no longer silently `rm -rf`s an existing skill (backup + `--force`).
- CI: `permissions: contents: read`, canary `continue-on-error`, Bun 1.4.0 on macOS/Windows, actions pinned to SHAs. Production audit `clean` path still runs lock/entry/runtime probes (golden + chart export).
- Unreleased items above require `main@HEAD`; they are not in the 1.5.0 tarball. Version is not bumped.

## Unreleased — 2026-08-25

- CLI help and authoring docs now state that the JSON Schema describes normalized leaf IR, while `group` is authoring-only and must pass through `loadDeck` / `validateDeck`; the IR status now reflects v1.5 and agent guidance lists the allowed hyperlink schemes.
- Layout expansion and leaf-only validation now return deeply detached IR, so validated, compiled, previewed, or QA-consumed objects cannot alias caller-owned pages, elements, or nested fields.
- Public `expandPageLayouts` now applies the same deep-detach rule to leaf-only pages, including nested page metadata and element fields.
- No-clobber project creation and PPTX import now fall back from unsupported hard links (`EXDEV`, `ENOTSUP`, `ENOSYS`) to exclusive `wx` writes; `EEXIST`, `EPERM`, and other link errors still fail without overwriting the target.
- Snapshot regressions now replace media immediately after snapshot encoding, preserving the original post-validation TOCTOU coverage under the detached-deck contract.
- Local verification passed all 124 tests and the production dependency-audit gate on the current Bun 1.4.1 canary.
- Known residuals remain unchanged: ZIP64 stays fail-closed, an already-running `pako.push()` cannot be preempted, and the reviewed runtime-unreachable `image-size` advisories remain installed behind the audit gate.
- No-clobber import now commits every hard link before best-effort sibling-temp cleanup, preserving successful outputs and returning cleanup warnings when a temp remains locked.
- Atomic non-force deck creation now treats a successful hard link as the commit point; a later sibling-temp cleanup failure cannot delete the installed `deck.json`.
- PPTX import now gives JSZip a comment-free view pinned to the exact EOCD and central directory accepted by preflight, and resource-limit aborts pause JSZip's inflate helper directly.
- README agent guidance now starts from the authoring docs and identifies the JSON Schema as the normalized leaf-IR contract rather than the sole write-time source of truth.
- PPTX import now fail-closes on bounded regular-file input, raw ZIP entry count, declared per-entry/aggregate sizes, and actual streamed inflate bytes before committing output; repeated relationships reuse one cached media output and imported media is budgeted before staging.
- `validateDeck` now returns a typed load-first error for external page paths, enforces canonical `media/` paths even without media byte checks, rejects unsafe `colW` normalization, and expands authoring groups without mutating the caller.
- Compile, preview, and QA now consume the normalized deck returned by validation; large finite table weights avoid intermediate multiplication overflow.
- Public image sniffing now uses the bounded no-follow/nonblocking snapshot reader, byte-only sniff/size helpers are exported, and the unused path-based `readImageSize` helper was removed.
- `init` and `from-outline` now stage `deck.json` in a sibling temp file, atomically avoid non-force races, and replace existing decks only with force.
- Agent-facing documentation now distinguishes normalized leaf schema from authoring groups, uses non-destructive creation examples, documents `--skeleton`, colors-only theme copying, real template tokens, current chart support, and structural-preview limitations.
- Local verification passed all 119 tests and the production dependency-audit gate on the current Bun 1.4.1 canary.
- Added a source-grounded SVG/PNG architecture diagram covering project creation, IR normalization, fail-closed validation, immutable media snapshots, QA, preview, and editable PPTX export.
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
