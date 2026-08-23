# OpenPPT backlog (post v1.5 current-state reconciliation)

As of 2026-08-23, Path 1 through v1.5 is complete. Only unchecked items under **Active maintenance follow-up** count as committed active backlog. Completed release history and explicitly deferred/out-of-scope items do not.

## Active maintenance follow-up (3)

- [ ] Resolve or mitigate the two high `image-size@1.2.1` advisories reported through `pptxgenjs`; runtime reachability is not yet established.
- [ ] Define and enforce resource ceilings for deck/page/element counts, string/series sizes, and local media bytes.
- [ ] Close or explicitly mitigate the media validation TOCTOU window between metadata/content checks and compiler reads.

## Completed maintenance follow-up (2026-08-23)

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
