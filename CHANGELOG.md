# Changelog

## Unreleased — 2026-09-05 (private-network Docker deployment verified)

- [PR #8](https://github.com/bbingz/OpenPPT/pull/8) is open. Revision `376b631a04390707e6369bf546259cd25b95cf77` passed all eight [hosted CI checks](https://github.com/bbingz/OpenPPT/actions/runs/33967801320), including Linux/macOS/Windows minimum and stable Bun, canary, and the unchanged production audit. That exact revision was then built and deployed on the authorized remote Linux arm64 Docker engine; no Docker ran on the development Mac. Subsequent closeout documentation does not change the deployed runtime.
- The non-root container is healthy, restarts automatically, publishes only on the selected private network interface, and stores projects in a persistent volume. All 53 shipped runtime/configuration files were compared byte-for-byte with the CI-verified Git tree. Image identity, exact private endpoint, release path, rollback command and evidence are retained in the host-local deployment marker rather than public documentation. This was the first deployment; rollback stops the new service while retaining data.
- `CHECKS_RUN`: 386 local tests; all eight PR CI checks; remote Compose build and health; actual browser source loading, clean SSE reconciliation, inspector PATCH, editor save and PPTX/PDF downloads; foreign Host/Origin rejection; two downloaded PDF pages rasterized and viewed with visible Chinese/Latin text and chart/table data. The container was replaced and the saved project source remained byte-exact. Only the two task-created acceptance projects were subsequently removed. Tracked-file credential-pattern scanning and review found only the intentional fake credential URL in the rejection test. `git diff --check` passes.
- `CHECKS_NOT_RUN`: native PowerPoint repair-dialog checks remain outside this verification. The PR has not been merged. The service is a trusted private-network application without an application login; it is not exposed as an unauthenticated public website. The two reviewed image-size advisories remain unchanged. The earlier host-CLI registry TLS failures did not reproduce in the actual Docker engine build; no proxy or system configuration was changed.
- An initial online smoke expectation omitted PUT's documented trailing-newline normalization; the probe fixture was corrected without changing the product or image. Local evidence retains that failure and the passing rerun. Deployment status supersedes the preparation-only states below.

## Unreleased — 2026-09-05 (PR and remote Docker deployment preparation)

- Public-content review found no real credentials in tracked files; the only credential-URL pattern is an intentional fake test input. Deployment host names and local evidence paths are omitted from the published documentation. Environment files, runtime project data, private keys, backups and upstream mirrors are not included in this change or the container build context.

- The user authorized committing the accepted work, opening a PR, and deploying the CI-green revision in Docker on the private deployment host. This supersedes the earlier no-commit/no-deploy boundary for this task only; Docker is still forbidden on the development Mac. The user confirmed retaining the public repository and hosted CI. The feature branch is pushed; PR checks and deployment remain pending. No repository visibility change was made.
- Add a remote-only Docker/Compose setup with Bun 1.4.0, LibreOffice, Poppler, CJK fonts, a persistent project volume, health check and revision-labeled image. Publish only on an explicitly supplied private host IP. An optional exact `publicOrigin` lets the container validate the browser's hostname while listening on its internal interface; default CLI loopback behavior and exact Host, mutation-Origin and SSE audience guards remain intact. Deployment and rollback instructions are in `deploy/README.md`.
- `CHECKS_RUN`: new remote-origin tests first failed (configured endpoint returned 403 and invalid configuration was accepted), then passed with the minimal server change; focused PATCH/SSE/origin checks pass 23/23 and the complete Bun suite passes 386/386 across 32 files. Remote `docker compose config --quiet` passes on the private deployment host, which has Linux arm64 Docker and an unused 7357 port. Existing C acceptance remains recorded below.
- `CHECKS_NOT_RUN`: hosted PR CI, remote image build, browser and container deployment checks remain pending. The remote host's direct Docker Hub TLS connection timed out during read-only registry inspection; no daemon/network settings were changed. Full command logs are retained in the local deployment evidence directory; host-specific paths are omitted from public documentation.

## Unreleased — 2026-09-05 (C complete locally)

- C1–C5 and the prerequisite failure remediation are independently accepted. The current approved A+B, prerequisite and C queues each have zero remaining local tasks; the stage records below retain their historical test counts and superseded pending states. Grok was the sole implementation worker; Codex reviewed the actual changes and ran independent acceptance probes. Work remains uncommitted on `6b4772f883812694d78895ddc0052a1c0ad6278d`, preserving the preexisting dirty work. No staging, push, publication, deployment, Docker, or machine/font installation was performed.
- C5 closes the mixed Latin/CJK authoring → preview → exact PPTX → PDF/render workflow, original compact/long outline layouts, and actual CLI-generated project → Studio PATCH → external clean/dirty edit → accepted-version download. Final rendered review caught numbered preview markers wrapping onto two lines; the narrow gutter/nowrap correction keeps markers on one line without overlapping the body and preserves body long-token wrapping. A persistent regression and independent Chromium geometry check cover the correction. HTML preview remains an approximation of native PPTX layout.
- Authoring docs now separate font-family, paragraph-spacing and character-spacing precedence, include the complete named-style fields, preserve false/zero overrides, and describe bounded SSE and guarded inline JSON editing. The copyable theme/paragraph examples validate; both documented PATCH bodies return HTTP 200 with a changed ETag and retain the structured paragraph contents. The coordinator's initial example probe incorrectly read `validateDeck(...).pages` instead of `.deck.pages`; only the probe was corrected and its failed result is retained.
- `CHECKS_RUN`: final `bun test ./test/` passes 384/384 across 31 files; 14 final actual Chromium groups pass. Fixed dogfood passes 12/12, seeded random coverage passes 120/120 positive and 10/10 negative cases, and the unchanged production-audit policy accepts only its two reviewed image-size residuals. Required render-check passes compact eight-page, long 23-page and mixed two-page PPTX outputs, plus the final mixed output and actual accepted eight-page Studio download. Representative PDFs/browser pages were viewed separately from the conversion/page-count gate. The packed consumer includes all five original page fragments and four new authoring/event helpers; installed from-outline, QA, export, preview and byte-exact Studio helper serving pass. Pack/install checks use the local cache/network and are not hermetic. Final scope/hash evidence and `git diff --check` complete the local closeout.
- `CHECKS_NOT_RUN`: native PowerPoint opening/repair-dialog checks and hosted cross-platform CI were not run in this local task. No release-readiness claim is made; noncooperating CLI writes are not locked, inline PATCH excludes YAML/external page lists, SSE is not a gap-free audit log, and the two reviewed transitive image-size advisories remain installed.
- Independent evidence: `evidence/gate-c5-leader.md` in the local C evidence directory, `leader-c5-final-suite.json`, `leader-c4-final-browser-gate-final-v2.json`, `leader-c5-doc-examples-second.json`, `leader-c5-package-final/result.json`, and `leader-c5-final-scope.json`. The exact final mixed project/PPTX/PDF and viewed images are under `evidence/leader-c5-integration-final/`; the generated-project browser/download evidence is under `evidence/leader-c5-studio-second/`. Temporary evidence is not a permanent archive.

## Unreleased — 2026-09-05 (C stage records; superseded by local closeout above)

- The user authorized C implementation and required prior failures to be resolved first. Grok remains the sole implementation worker under Codex coordination. A+B and earlier dirty-tree changes are preserved as the new baseline on `6b4772f883812694d78895ddc0052a1c0ad6278d`; no staging, commit, push, release, Docker, or system/font installation is authorized. C1–C4 are complete; C5 integration and documentation remain active in `docs/BACKLOG.md`.
- The dependency failure recorded below is superseded: only the existing fast-uri lock resolution changed from 3.1.5 to 3.1.7, with installed bytes and registry tarball integrity independently verified. The initial 3.1.6 target was corrected after vendor advisories [GHSA-qw65-cvwx-89v3](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3) and [GHSA-58mr-gqgx-xq4g](https://github.com/fastify/fast-uri/security/advisories/GHSA-58mr-gqgx-xq4g) showed that 3.1.7 was required; the global advisory feed lagged those vendor publications. Existing production-audit policy and the two reviewed image-size exceptions are unchanged. Raw `bun audit` still reports those two residuals; OpenPPT-specific fast-uri exploitability was not established.
- The prior local CJK visual failure was isolated using the same PPTX and fresh LibreOffice profiles. Default headless conversion lost visible Chinese despite a valid text layer; process-local `SAL_USE_VCLPLUGIN=osx` restored Chinese/Latin glyphs, and an A/B/A repeat reproduced the dependency on that setting. Sync, async, and render-check conversion now default this child environment on macOS only, preserving explicit caller values and leaving parent environment and other platforms unchanged. Codex independently converted and viewed both public API outputs with visible Chinese; this is local renderer evidence, not an upstream-confirmed bug diagnosis or native Office validation.
- A full-suite PDF request returned 429 after Bun's 10-second idle timeout. Codex independently reproduced it with a 22-second fake converter; the accepted-job HTTP timeout is now a finite 180 seconds per request, preserving the existing 120-second converter bound and default timeouts elsewhere. The unchanged probe now returns 200 at 22 seconds; persistent tests retain responsive health and genuine second-job 429. This supersedes the initial worker explanation of test interference. A viewed chart control also exposed a nearly invisible second series because the export palette included the page surface color; a shared palette now excludes background/surface/text colors and uses the same ordered defaults for PPTX and preview. Exact file/buffer XML, 43 focused regressions and a viewed PDF confirm the corrected visible second series.
- C1 is independently accepted: optional `theme.textStyles` and `$name` text references resolve once on the existing detached validation path, with explicit element/run values including false taking precedence. Raw unused definitions are validated and named styles are capped at 128 with string accounting before and after resolution. Optional `theme.fonts.latin` sets text/table/chart and authored theme defaults; `theme.fonts.ea` sets the independent DrawingML East Asian face. Legacy theme major/minor defaults remain untouched when no Latin font is authored. Browser preview uses the selected Latin/EA fallback stack. Element italic, a reusable original fixture, and IR documentation are included. Root caught and returned missing theme Latin defaults for repair before accepting actual theme/chart/table XML, inverse run overrides, browser computed styles and viewed Chinese/Latin PDF. The full suite is now 281/281 across 22 files; C2–C5 remain active.
- C2 is independently accepted: explicit paragraphs and ordinary/numbered lists preserve one native paragraph per entry, soft CRLF/CR/LF breaks, restart/level semantics and false/zero overrides. New point spacing and character spacing apply to authored paragraphs and opt-in legacy text; legacy inputs without new fields keep their former defaults. QA now accounts for wrapped content, run metrics, blank lines and horizontal overflow. Review caught false-negative QA, box-level instead of paragraph-level preview spacing, marker inheritance and an unintended legacy trigger before acceptance. Coordinator corrected the initial native format constraints to 1584pt paragraph spacing and 51206400EMU derived list margins, with boundary regressions. Independent full suite: 302/302 across 23 files; actual Chromium, parsed file/buffer structure and final Chinese/Latin PDF pass. Evidence: `evidence/gate-c2-leader.md` under the current root below. C3–C5 remain active.
- C3 is independently accepted: five original reusable page fragments now drive content-based outline layouts, with readable pagination, lexical ordered markers, prose/mixed-block preservation, long-heading handling, literal text safety, and preflight page/string limits. Review returned intermediate splitter, title/sequence, browser token wrapping, source-number and resource-boundary failures before acceptance. The final full suite passes 322/322 across 24 files. Compact 8-page, long 23-page and long-heading 7-page PDFs were inspected; final input/pixel comparisons retain the prior viewed evidence where unchanged. Long English/Chinese PDF bodies each reconstruct exactly once after whitespace normalization. The installed tarball consumer includes and loads all five fragments and passes from-outline/QA/export/preview. Evidence: `evidence/gate-c3-leader.md` under the current evidence root. C4–C5 remain pending.
- `CHECKS_RUN`: unchanged production-audit gate passed at fast-uri 3.1.7; independent focused renderer/server tests passed 33/33 and final full suite passed 262/262 after the HTTP timeout correction. Actual sync/async CJK PPTX-to-PDF conversions, font/text inspection, viewed rasters and worker render-check passed their stated checks. The independent 22-second HTTP probe failed with 429 before the correction and passed with 200 afterwards; both results are retained.
- `CHECKS_NOT_RUN`: C feature acceptance is pending implementation; native PowerPoint and hosted cross-platform CI remain outside this local verification. Full C integration and dogfood will run after the feature batches.
- Current local evidence and batch authority: `execution-contract.md` in the local C evidence directory, `gate-0b-spec.md`, `gate-0c-spec.md`, and queued `c1-spec.md` through `c4-spec.md`. Independent dependency gate is `evidence/gate-0a-leader.md`; viewed public CJK outputs are under `evidence/leader-cjk/`; original HTTP repro is `evidence/leader-slow-pdf/red-22s.json`. Historical A+B evidence below remains unchanged.
- C4 is independently accepted: bounded raw-authoring PATCH, shared filesystem notifications, safe leaf/source selection, and a guarded inspector now connect through a mounted Studio EventSource. Serialized authoritative GET reconciliation preserves exact drafts and original ETags, handles PUT newline normalization, and invalidates terminal/cross-route completions; source-load and mutation operations exclude one another. Review reproduced and repaired draft-loss, own-save false-conflict, late terminal-state overwrite, unbounded concurrent GET, selection-stacking and workbench-height failures. Independent full suite: 383/383 across 31 files. Fourteen final Chromium groups pass, plus an actual CLI-generated eight-page project → Studio PATCH → external edit/conflict → accepted-version PPTX download. Scope proof preserves 127 pre-C4 files. C5 retains one genuine preview marker-wrap finding and final package/documentation closeout. Evidence: `evidence/gate-c4-leader.md` under the current C evidence root.


## Unreleased — 2026-09-05 (approved A+B)

- Grok implemented six bounded batches under Codex coordination; Codex independently reviewed the baseline-relative diff and reproduced the critical behavior before accepting each batch. Work remains uncommitted on `6b4772f883812694d78895ddc0052a1c0ad6278d`. The preexisting utility extraction, JPEG correction, and duplicate-project feature were preserved; duplicate implementation is not part of this task. No version bump, dependency upgrade, push, or release was performed.
- Import now preserves supported direct shape fills despite an unfilled outline, emits filled-text backgrounds before their text, recognizes full paragraph alignment tokens, reads transform attributes without order assumptions, and resolves slide/picture relationships by their actual IDs and types. AlternateContent replacement uses literal semantics; touched unsupported/drop cases produce warnings. Layout/master inheritance, gradients, and connectors remain outside this bounded repair.
- Export validates font-family attribute safety, uses project-relative image descriptions, and normalizes drawing IDs and paragraph properties in both file and buffer artifacts. Unique IDs and semantic references are preserved; ambiguous referenced duplicates and conflicting paragraph properties fail explicitly. Rich-text LF/CRLF/CR handling preserves concatenated flow and run styles, including blank and trailing lines.
- Native charts use the existing theme palette and text colors. All series must share their effective category vector: omitted labels default to `"1"`, `"2"`, etc., and may coexist with matching explicit labels. Pie/doughnut require one series instead of silently dropping data. Artifact probes compare chart caches with referenced embedded-workbook cells.
- Studio validates the actual loopback Host/port and mutation Origin, with frame-ancestor restrictions compatible with its preview iframe. Exact source bytes determine a strong SHA-256 ETag; saves require `If-Match` (missing 428, stale/weak/wildcard 412). Drafts retain their base version and survive conflicts. Save/export coordination preserves edits made during an in-flight save. This is stale-snapshot detection, not a lock on external CLI writers; unchanged bytes need not mint a new ETag.
- Real JPEG regression tests accept both `.jpg` and `.jpeg` and reject a wrong extension. An isolated HEAD-server replay returns 422 before the existing two-token correction and 201 after it. The separately applicable patch is `evidence/jpeg-only-against-head.patch` under the evidence root below; it contains no duplicate-project feature. A published-version production incident was not established.
- Preview and QA retain the openppt-1 contract: 96dpi CSS bounds and point fonts. Preview converts points by 4/3 and preserves supported text/run font, bold, italic, alignment, shape-line, and table styling. QA estimates inner text capacity in CSS pixels, including default insets, and reports nonempty zero-capacity boxes. HTML remains an approximation.
- Studio PDF conversion and discovery are asynchronous, share concurrent discovery, and allow one conversion at a time with predictable 429 rejection. Subprocesses have bounded output and hard timeouts; isolated work/profile directories are cleaned on success and failure. Existing synchronous public conversion APIs remain compatible. Independent probes measured a responsive health endpoint during a 1.4-second conversion, one discovery process for four simultaneous requests, and cleanup after a stubborn child timeout and excessive output.
- `render-check` now requires a positive `pdfinfo` page count matching the PPTX slide count and rejects missing, zero, unknown, or mismatched counts. Nightly adds only `poppler-utils` to its existing LibreOffice prerequisite. This gate verifies conversion and page counts, not glyphs, native Office behavior, or editorial quality.
- B adds original intake, slide-structure, hierarchy, content, and image-provenance guidance. It requires exporting, converting that exact PPTX to PDF, rasterizing, viewing, correcting IR, and rerendering before a visual-success claim. The IR-to-PDF convenience command is documented separately. Original KPI/chart/table samples were viewed; blank and overflow samples were rejected, and a shortened/wider overflow correction was rerendered and inspected. C remains separately scoped in `docs/BACKLOG.md`; neither a mandatory implementation order nor a half-day completion promise applies.
- `CHECKS_RUN`: `bun test ./test/` passed 254 tests across 21 files on local macOS Bun 1.4.1-canary.1+d296efbb4; the suite includes the existing package pack/install/bin integration smoke, which is not hermetic. `bun scripts/dogfood.js --out <evidence>/final-dogfood` passed 12/12 scenarios; `bun scripts/dogfood-random.js --count 120 --seed 20260905 --out <evidence>/final-random` passed 120/120 positive and 10/10 negative cases. Actual Chromium Studio/style probes, file/buffer OOXML/workbook assertions, documented PDF commands, and `render-check --require` on eight representative PPTX files passed their stated checks. Strict QA rejected the blank and overflow samples while accepting the ordinary and corrected samples. `git diff --check` passed.
- `CHECKS_RUN` (failed gate): `bun scripts/verify-production-audit.js` exited 1 with `Unexpected production audit findings`. Raw production audit identifies four high `fast-uri@3.1.5` advisories: [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8), [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc), [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf), and [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp). Their patched 3.x version is 3.1.6. `bun.lock`, `package.json`, and the audit script are byte-identical to HEAD. The two existing reviewed `image-size` findings are not new findings. No exception was widened, and OpenPPT-specific exploitability was not established. **The release gate remains failed.**
- `CHECKS_NOT_RUN`: native PowerPoint GUI/repair-dialog validation and hosted Linux/Windows/CI runs were not performed in this local task. CJK visual acceptance is not achieved: the explicit Noto Sans CJK SC sample renders English but no Chinese in this LibreOffice environment despite a matching installed face. The cause remains unverified; font lookup and successful conversion are not glyph proof. No font/system installation or renderer reconfiguration was attempted.
- Evidence root (local temporary storage): the local A+B evidence directory. `execution-contract.md` and `baseline.patch` define scope; `evidence/batch1-leader-gate.md` through `batch6-leader-gate.md` record independent gates. Final command logs/exit metadata use `evidence/leader-final-*`; source preservation and dependency-baseline proofs, browser probes, original evaluation decks/rasters, and the JPEG-only patch remain there. Resume from the separate dependency follow-up or a newly approved C scope, not from the completed A+B checklist.

## Unreleased — 2026-08-30 (round seven)

- **Import contract change:** off-canvas imported elements no longer fail the
  whole package — partially outside bounds are clamped into the canvas and
  fully outside (or sub-1px after clamping) elements are dropped, each with a
  warning. `validateDeck` itself is unchanged; the pre-commit fail-closed
  guarantee is re-anchored on IR resource ceilings and media validation
  regressions.
- Import preserves spTree document order (z-order): group children expand in
  place instead of after sibling leaves.
- Groups whose `a:xfrm` carries rotation or flips fall back to skip-with-warning
  instead of importing silently wrong child positions (the IR has no
  rotation/mirror semantics).
- Import maps `a:schemeClr` through the package theme (`a:clrScheme`,
  including `sysClr` and tx/bg aliases) for run colors and solid fills;
  unknown scheme values fall back with a one-time warning. Luminance modifiers
  are ignored (base color).
- Verified previously-untested paths: grouped `p:pic` scaling and the depth-8
  expand / depth-9 fallback boundary.
- HTML preview renders charts as inline SVG mini-charts (grouped bars,
  line/area, pie/doughnut with hole and full-circle handling, sampled points,
  escaped labels/titles, NaN-proof zero/negative handling) instead of dashed
  placeholders.
- Tests: 200 total across 17 files, including a new preview mini-chart suite.

- Optional PDF export via headless LibreOffice: new `pdf` CLI command,
  `exportDeckPdf` / `convertPptxToPdf` / `findSoffice` public API
  (`src/render-pdf.js`), and a Studio "导出 PDF" button plus
  `GET /api/projects/:id/export.pdf` (501 with `PDF_UNAVAILABLE` when
  LibreOffice is absent; `meta.pdfAvailable` feature flag). PPTX export still
  needs no external tools; conversions run in isolated LibreOffice profiles
  with typed fail-closed errors.
- PPTX import now expands `p:grpSp` groups per OOXML semantics — child
  coordinates composed through `off`/`ext` over `chOff`/`chExt` scaling in EMU
  space, nested groups up to depth 8, with fail-safe skip + warning for
  malformed or over-deep groups — instead of skipping all grouped shapes.
- PPTX import preserves run-level styling (`b`/`sz`/`srgbClr`) as rich-text
  runs per paragraph, keeping fifth-round newline semantics, degrading to a
  plain string when all runs share one style, and truncating at the
  1024-runs-per-element ceiling with a warning.
- Nightly workflow files a GitHub issue on failure (seeded repro command in
  the body; `issues: write`).
- Tests: 188 total — group-scale/nesting/malformed-group fixtures, rich-run
  extraction and degradation, CLI `pdf` argument matrix, and a Studio PDF
  endpoint test that follows advertised availability on each platform.

- New seeded random battery (`bun run dogfood:random`): generates
  random-but-valid decks across the whole IR surface (rich text runs, shapes,
  media, charts, tables, nested stack/row/grid/layer groups with feasible
  sizing by construction), exports each one, and asserts artifact hygiene and
  rels integrity; failures keep the deck folder and print a seeded repro
  command. A negative catalog asserts ten fail-closed mutations reject with
  exact error codes and write nothing. Locally verified with 5 seeds × 120
  decks (600/600) plus 50/50 negative rejections.
- New render check (`bun run render:check`): converts exported PPTX to PDF via
  headless LibreOffice (isolated user profile), asserting conversion succeeds
  and PDF page count matches slide count; skips politely without LibreOffice,
  `--require` for CI. Locally verified 27/27 artifacts.
- New `nightly` workflow: date-seeded 300-deck fuzz plus a LibreOffice render
  check over the full battery output (same pinned action SHAs,
  `contents: read`).

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
