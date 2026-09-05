# OpenPPT backlog (post v1.5 current-state reconciliation)

As of 2026-09-05, A+B, prerequisite failure remediation and C1–C5 are independently complete locally. The dependency gate is repaired at fast-uri 3.1.7; the macOS CJK renderer, long PDF HTTP timeout, chart palette and final preview marker corrections are independently accepted. All three approved local queues below have zero remaining tasks. These counts exclude explicitly deferred product scope and do not imply release readiness.

## Approved A+B follow-up (0 remaining)

- [x] A1: Preserve supported imported fills, alignment, geometry, relationship targets, and literal AlternateContent text.
- [x] A2: Correct exported OOXML structure, rich-text line breaks, chart data consistency, and font/path attribute handling.
- [x] A3: Verify the isolated JPEG correction and protect Studio request origins and stale source saves.
- [x] A4: Correct preview/QA units and fidelity for already-supported text, shape, and table properties.
- [x] A5: Keep Studio responsive during bounded PDF conversion and reject indeterminate render-smoke page counts.
- [x] B: Add original intake/design guidance and verify the actual export-render-inspect delivery loop, including rejected blank/overflow samples and an explicitly unresolved CJK renderer result.

These are local implementation and verification tasks. Preserve the preexisting duplicate-project feature and utility-extraction diff; they are not part of the JPEG correction. No commit, deployment, or publication is authorized by this work item.

## Failure remediation before C (0 remaining)

- [x] Resolve the production-audit failure with a lock-only fast-uri 3.1.7 update. The initial 3.1.6 target was superseded after two newer vendor advisories were verified. Independent registry/tarball integrity, module negative/positive probes, and unchanged production audit pass; existing suite is 254/254. OpenPPT-specific exploitability has not been established.
- [x] Correct macOS headless renderer font discovery without installing fonts or changing machine configuration; both public conversion paths show visible CJK glyphs. The additionally reproduced HTTP idle timeout is fixed per PDF request; a 22-second original job returns 200 while true concurrent jobs remain 429. Independent suite: 262/262.
- [x] Correct chart series accidentally using the page surface color and align preview/PPTX palettes; independent file/buffer XML, 43 focused regressions and viewed PDF confirm both series are visible.

The two previously reviewed `image-size` findings are separate, unchanged residuals. Raw `bun audit` still reports them; the existing production gate accepts only its unchanged reviewed exceptions. C-preparation changes only the fast-uri lock entry; package.json and audit policy remain unchanged.

## Approved project C (0 remaining)

- [x] C1: Executable text styles and Latin/East Asian font defaults across validation, preview, QA, and PPTX; independently verified with 281/281 tests, actual browser styles and mixed CJK PDF.
- [x] C2: Explicit paragraphs/bullets, soft breaks and typography with legacy compatibility; independent 302/302, native boundary assertions, real browser and viewed PDF pass.
- [x] C3: Original page prototypes and content-driven outline generation with content-preserving overflow handling.
- [x] C4: Version-guarded Studio element operations, filesystem change notifications, and preview selection; independent 383/383 tests and 14 final browser groups pass.
- [x] C5: Integrated regression, browser and rendered-artifact verification; authoring documentation and durable closeout. Independent final suite 384/384, fixed 12/12, random 120/120 + negative 10/10, unchanged production audit, actual HTTP doc examples, exact-PPTX rendered review, required conversion/page-count checks and installed-package CLI/Studio smoke pass.

C completed under the separate coordinator contract, including old-deck compatibility and representative visual outcomes. It retains openppt-1's 96dpi bounds / point-font contract. B guidance remains independently useful; no mandatory ordering or fixed short-duration estimate is implied. Native PowerPoint and hosted cross-platform CI remain unverified; two reviewed image-size residuals remain installed. Current contract and independent evidence: `/private/tmp/openppt-c-20260905-3ikfaee_/`, especially `evidence/gate-c5-leader.md`. No commit or publication is authorized by this completion.

## Completed maintenance follow-up (2026-08-23)

- [x] Mitigate the two high `image-size@1.2.1` advisories with a fail-closed production-audit gate that accepts them only while they remain unreachable from OpenPPT and the PptxGenJS runtime entrypoint.
- [x] Validate and render each referenced local image from one per-operation immutable byte snapshot across PPTX export and HTML preview.
- [x] Enforce documented ceilings for expanded-deck page/element counts, authoring groups, user-authored strings, chart/table collections, and per-file/aggregate referenced local-media bytes.
- [x] Exercise Bun 1.4.0, stable, and canary plus stable Linux/macOS/Windows in CI, including installed-package bin shims.

## Completed post-v1.5 hardening (2026-08-22)

- [x] Enforce nested rich-text/table finite values and theme tokens during validation.
- [x] Normalize partial table `colW` values without exceeding the table frame.
- [x] Restrict hyperlink schemes and canonicalize the `media/...` subtree contract.
- [x] Restrict built-in theme selection to the four documented IDs.
- [x] Paginate generated outline TOCs, reject unsupported canvas sizes, and validate before writing.
- [x] Apply skeleton titles to the visible cover element.
- [x] Preserve text alignment and enforce authoring-group IDs before layout flattening.
- [x] Reject options outside each CLI subcommand's contract.
- [x] Protect preview source/existing files and validate the public preview API.
- [x] Stage, validate, and rollback-safe commit lossy import outputs.
- [x] Isolate test outputs in temporary directories and narrow the package file whitelist.
- [x] Reconcile import capability and direct-dependency documentation.

## Completed Path 1 release history (v1.0–v1.5)

### P1 — correctness & product surface
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

### P2 — agent UX
- [x] Thin `SKILL.md` package for Claude/Codex/Cursor (`skills/openppt/`, `bun run install:skill`)
- [x] Template skeletons (cover / TOC / body / final) bound to theme tokens (`templates/`)
- [x] Progressive disclosure docs (`docs/AGENT.md` → schema → IR.md)

### P3 — quality & layout
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

## Explicitly deferred / out of product scope
- Pixel-faithful preview / full WYSIWYG browser editor (Path 1 ships structural HTML preview only)
- Animations / transitions / embedded video
- npm registry publish automation (repo is installable from git)
- Optional remote image allowlist fetch

## Explicitly out of product runtime
- Kimi / Moonshot branding
- neo-ppt frontend mirror
- Official or patched PPTD WASM
- Reverse-engineered proprietary design-system prose

Research copies of third-party trees (if present) stay gitignored under `upstream/`, `backups/`, `*.git`.
