# OpenPPT Round 1 Adversarial Review — Codex

Date: 2026-08-08  
Reviewer: Codex  
Baseline: `2676bc35dcce` plus the current shared working-tree fixes  
Scope: product only (`bin/`, `src/`, `schema/`, `test/`, product fixtures,
package metadata, and product docs). `upstream/` was excluded.

## 1. Result

The repaired product path is materially stronger and the stated fixes are
present in current source. The final product suite passes **24/24 tests across
3 files** under Bun. In particular:

- canvas size and element bounds are finite-checked;
- media paths are checked lexically and after symlink resolution, and targets
  must be regular files;
- file and buffer exporters share `buildPresentation`;
- unknown CLI options and missing `-o` values are rejected;
- the shipped CLI has a Bun shebang, a real-path entrypoint check, and is now
  executable (`100755`);
- `bun test ./test/` is correctly scoped to the product suite.

This is not yet release-clean. Two confirmed high-impact residuals remain:
`--force` can delete the input deck when output and input collide, and an
attacker-authored deck can embed any regular file under the deck directory into
the PPTX because media is not restricted by subtree, extension, or content.
The production dependency audit also fails on two high-severity advisories,
although current runtime reachability through PptxGenJS is not established.

## 2. Remaining findings

### R1 — HIGH — `--force` can destroy the source deck

Evidence: `src/compile.js:136-151` resolves the output, unlinks it immediately
when `force` is true, and only then builds/writes the presentation. Neither the
CLI (`bin/openppt.js:126-134`) nor `exportDeckFile` rejects an output path equal
to the input path. The write is not transactional.

Confirmed repro in a temporary directory:

```text
exportDeckFile(deck.json, deck.json, { force: true })
=> EXPORT_FAILED; source exists=false
=> Export produced no file at .../deck.json
```

The `.json` source is unlinked before PptxGenJS declines to produce that output.
A source named with a `.pptx` suffix is silently replaced instead. More
generally, any pre-existing output is lost if a later build/write step fails.

Recommended fix: reject canonical input/output equality in both high-level
entrypoints, write to a sibling temporary `.pptx`, validate the ZIP, then
atomically rename over the destination. Add rollback-preservation tests.

### R2 — HIGH — project-root file disclosure through the image surface

Evidence: the schema accepts any non-empty project-relative `src`
(`schema/openppt-ir.schema.json:125-137`); validation requires only containment
and `statSync(...).isFile()` (`src/validate.js:217-238`); compilation passes the
path to PptxGenJS unchanged (`src/compile.js:113-117`).

Confirmed end-to-end with a temporary project containing a sentinel `.env`:

```text
src: ".env"
compileToBuffer(...) => success
ppt/media/image-1-1.env contains OPENPPT_REVIEW_SENTINEL
```

The symlink jail is working: this finding is inside its declared boundary, not
a claim that arbitrary host paths remain reachable. Exploitability requires an
untrusted or compromised deck plus a sensitive sibling file under the deck
directory, and disclosure occurs when the resulting PPTX is handed onward.
That is plausible for agent-generated projects, where `.env` and config files
often coexist with the deck.

Recommended fix: constrain media to a dedicated `media/` subtree and accept a
small documented format allowlist backed by magic-byte/content validation.
Fail with `MEDIA_MISSING` (or a new stable media-type code) before export. Add
tests for `.env`, JSON, mislabeled bytes, valid supported images, and SVG policy.

### R3 — MED — the production dependency audit is red

`bun audit --production` exits 1 with two high advisories on transitive
`image-size@1.2.1` through `pptxgenjs@3.12.0`:

- `GHSA-w3rx-r6r6-pgpr` — ICNS parser infinite-loop denial of service;
- `GHSA-5p2g-fcmc-qvqq` — JXL/HEIF parser infinite-loop denial of service.

Reachability is **UNVERIFIED** and appears limited: the shipped
`pptxgenjs/dist/pptxgen.cjs.js` bundle imports `jszip`, and a bounded search
found no `image-size` import/call in its distributed runtime. Nevertheless, a
release audit gate remains red and the lockfile contains the vulnerable package.

Recommended fix: remediate through a compatible PptxGenJS/dependency update or
an independently tested override, then keep `bun audit --production` enabled.
Do not suppress the audit based only on the current reachability inference.

### R4 — MED — no resource ceilings for untrusted decks

`src/load.js:11-23` synchronously reads the entire input before parsing. The
schema has no maximum for pages, elements, text length, theme size, or media
file size (`schema/openppt-ir.schema.json:38-41,73-81,93,133-136`). Export builds
the complete PPTX in memory, and `compileToBuffer` necessarily duplicates a
large result buffer.

Current exposure is local CLI/library denial of service, not remote service
exposure. This becomes high priority if OpenPPT is placed behind a server or
automated ingestion queue.

Recommended fix: define explicit product ceilings for source bytes, page and
element counts, text length, individual media bytes, aggregate media bytes,
and output size. Test rejection just above every limit.

### R5 — MED — Bun minimum-version claim is not exercised

`package.json:34-35` declares Bun `>=1.1.0`, but this review ran only on
`1.4.0-canary.1+f972c287f`. The tests use Bun's `node:test` compatibility layer,
and compile tests shell out to system `unzip` (`test/compile.test.js:29-43`).
The current Mac path is green; Bun 1.1, stable Bun, Windows shims, and hosts
without `unzip` are not covered.

Recommended fix: CI on the minimum supported Bun and current stable Bun. Use a
Bun/JS ZIP reader in tests or explicitly scope support to Unix hosts with
`unzip`. Add a packed-tarball install/bin smoke test.

### R6 — LOW — known options are accepted for the wrong subcommand

`parseArgs` recognizes `--force` and `-o/--output` globally
(`bin/openppt.js:49-69`). Both of these commands exit 0 and ignore the options:

```text
bun bin/openppt.js validate fixtures/golden/deck.json --force
bun bin/openppt.js validate fixtures/golden/deck.json -o ignored.pptx
```

Unknown-option handling itself is fixed and tested. The residual is misleading
automation behavior, not option injection. Validate option legality after the
command is known and test every command/option combination.

### R7 — LOW — path validation still has a TOCTOU window

The real-path containment check is performed during validation and again while
building slides, which substantially narrows the original symlink escape.
PptxGenJS still opens the path after the second check; no already-validated file
descriptor or immutable copy is handed forward. A cooperating local process can
race a symlink or file replacement between check and read.

This is low severity for the current single-user CLI. If used as a service,
copy approved media from open file descriptors into a private staging directory
before invoking PptxGenJS.

### R8 — LOW — intentional lossy and rendering semantics lack output assertions

Eight-digit color alpha is intentionally dropped, and font sizes are documented
as points while bounds are pixels. These are now documented decisions, not
reopened defects. The golden export test asserts ZIP structure and one editable
text string, but does not assert page dimensions, background/fill/line colors,
line width, font size, image relationships, or alpha-loss behavior. A renderer
regression can therefore pass while preserving only the title text.

Add focused OOXML assertions for those contracts; keep visual Office/LibreOffice
opening as a separate compatibility check.

## 3. Safe fixes applied during this review

1. **Completed the Bun shebang fix.** The shebang text existed but
   `bin/openppt.js` was `0644` / Git mode `100644`; direct execution failed with
   `EACCES` (exit 126). The file is now `100755`, with direct-execution coverage.
2. **Closed remaining non-finite numeric output.** YAML-compatible
   `fontSize: Infinity` and `lineWidth: Infinity` previously exported
   `sz="Infinity"` and `w="Infinity"` into slide XML. `validateDeck` now rejects
   both with `SCHEMA_INVALID`, with a regression test.
3. **Made package contents deterministic.** `files: ["fixtures/golden/"]`
   caused `bun pm pack` to include gitignored test-generated PPTX/XML outputs.
   The manifest now lists only the golden deck and its source image.

No previously fixed issue was changed without a failing current-state repro.

## 4. Test gaps, ordered by value

1. Source/output collision and transactional preservation on exporter failure.
2. Non-image and sensitive sibling-file rejection, plus content-type policy.
3. End-to-end compile rejection for escaping symlinks; the current post-fix test
   exercises `safeProjectPath` directly, not the final PPTX.
4. Resource-limit tests for source, structure, media, and output.
5. Golden OOXML assertions for all three element types and styling fields.
6. Positive YAML export (the current YAML fixture covers only rejection).
7. `compileToBuffer` error-code parity with `compileToPptx`.
8. Minimum/stable Bun matrix, Windows/bin shim, and no-system-`unzip` path.
9. Packed tarball install/import/CLI smoke test.
10. Fuzz/property tests for schema-valid numeric and path edge cases.

## 5. Bun correctness assessment

- **PASS:** `bun test ./test/` selects only `test/`; final result is 24 pass,
  0 fail, 3 files.
- **PASS:** direct `./bin/openppt.js --version` and symlinked-bin execution are
  covered and pass after the mode correction.
- **PASS:** `bun install --frozen-lockfile --ignore-scripts` reports 25 installs
  checked across 26 packages with no changes.
- **PASS:** `bun pm pack --dry-run --ignore-scripts` now reports 18 files,
  50.31 KB unpacked, with no generated `fixtures/golden/out/` content.
- **PARTIAL:** runtime behavior is proven only on Bun
  `1.4.0-canary.1+f972c287f`, not the declared minimum or stable channel.
- **PARTIAL:** the lock transition is present in the working tree, but
  `bun.lock` is still untracked while `package-lock.json` is staged for deletion;
  the Bun-only state is not durable until the complete change set is committed.
- **FAIL (release gate):** `bun audit --production` exits 1 with two high
  advisories; see R3.

## 6. Security residual summary

| Surface | Current judgment | Evidence |
|---|---|---|
| Absolute / lexical traversal | Closed | `safeProjectPath` rejects absolute and outside-relative paths |
| Symlink escape | Closed for ordinary checks | root and candidate real paths are re-confined |
| Directory/dangling media | Closed | `statSync(...).isFile()` |
| In-root arbitrary file embedding | **Open, confirmed** | `.env` sentinel was embedded in `ppt/media/` |
| Path TOCTOU | Open, low for CLI | path is reopened after checks |
| Remote URL fetch | Closed by current default | URL-like paths fail local-file validation; no fetch path exists |
| Input/media memory pressure | Open | no explicit byte/count ceilings |
| Dependency advisories | Open | `bun audit --production`: 2 high; runtime reachability unverified |

## 7. Validation record

### CHECKS_RUN

- `bun test ./test/` before Codex fixes: **18 pass, 0 fail, 3 files**.
- Failing repro suite after adding tests: **14 pass, 2 fail** — direct CLI
  execution failed `EACCES`; non-finite font/line size validation failed open.
- Targeted post-fix suite: **16 pass, 0 fail, 2 files**.
- Final `bun test ./test/`: **24 pass, 0 fail, 3 files**.
- `./bin/openppt.js --version`: failed with exit 126 before the mode fix; passes
  after the fix.
- Non-finite output repro: before fix, exported `sz="Infinity"` and
  `w="Infinity"`; now covered by a rejecting validation test.
- Same-path forced-export repro: `EXPORT_FAILED`, input source removed.
- In-root file embedding repro: `.env` sentinel recovered from generated PPTX.
- `bun install --frozen-lockfile --ignore-scripts`: pass, no changes.
- `bun pm pack --dry-run --ignore-scripts`: before manifest fix, 22 files /
  218.47 KB including generated outputs; after fix, 18 files / 50.31 KB.
- `bun audit --production`: exit 1, 2 high advisories.
- `bun pm ls`: direct dependencies resolved as `ajv@8.20.0`,
  `pptxgenjs@3.12.0`, and `yaml@2.9.0`.
- `git diff --check`: pass before writing this report; rerun in final closeout.

### CHECKS_NOT_RUN

- Bun 1.1 and stable-Bun CI matrix.
- Windows/bin-shim compatibility.
- PowerPoint or LibreOffice open/render validation.
- A live TOCTOU race exploit.
- Docker/container checks.

### WHY_NOT

- Only the installed Bun canary was available; no remote matrix was authorized.
- Office compatibility and Windows runtime testing require environments outside
  this product-only local review.
- The TOCTOU condition is source-confirmed, but a timing exploit is not needed
  to justify the low-severity residual.
- Docker is prohibited on this Mac and was not needed.

### EVIDENCE_PATH

- `src/validate.js`, `src/compile.js`, `src/load.js`, `src/index.js`
- `bin/openppt.js`, `schema/openppt-ir.schema.json`, `package.json`, `bun.lock`
- `test/cli.test.js`, `test/compile.test.js`, `test/validate.test.js`
- `fixtures/golden/deck.json`, `fixtures/negative-nonfinite/deck.yaml`
- Commands and temporary-directory repros recorded in this review's
  `CHECKS_RUN` section

## 8. Remaining risk / unverified items

The current working tree is not a committed release artifact. The dependency
audit is red, minimum-Bun and cross-platform claims are unverified, and no
PowerPoint/LibreOffice consumer opened the generated file. R1 and R2 should be
treated as pre-release blockers if OpenPPT will compile untrusted or agent-
authored decks in directories that may contain valuable files.
