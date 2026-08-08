# OpenPPT Round 2 Verification — Codex

Date: 2026-08-08  
Reviewer: Codex  
Scope: OpenPPT product tree only; `upstream/` excluded.

## 1. Result

Claude's three stated Round 2 fixes are verified in the current product source
and tests. The gate result is:

| Gate | Verdict | Evidence |
|---|---|---|
| Real-path CLI entrypoint | **PASS** | `bin/openppt.js:149-169`; direct and symlinked-bin tests pass |
| Duplicate IDs | **PASS** | `src/validate.js:141-173`; duplicate page and deck-wide element tests pass |
| Documentation consistency | **PASS** | schema and `docs/IR.md` now distinguish pixel bounds from point font sizes and document alpha loss |
| Product suite | **PASS** | `bun test ./test/`: **24 pass, 0 fail, 3 files** |

No new critical regression was found in these fixes, so no additional critical
product change was applied in Round 2. Release readiness is still blocked by
the carried Round 1 residuals summarized below.

## 2. Verification details

### G1 — PASS — real-path entrypoint

`isEntrypoint()` canonicalizes both `process.argv[1]` and `import.meta.url` with
`realpathSync` before comparison. This handles a linked package bin and a repo
under a symlinked parent without restoring the unsafe basename fallback removed
in Round 1. Failure to canonicalize returns false rather than accidentally
executing an imported module.

The CLI suite verifies both:

- direct execution through the shipped Bun shebang;
- invocation through a temporary symlink, matching npm/Bun link behavior.

Both pass under the reviewed Bun runtime. The executable-bit omission found by
Codex Round 1 was separately fixed (`bin/openppt.js` is now Git mode `100755`).

### G2 — PASS — duplicate page and element IDs

`validateDeck` maintains separate page and element sets. Page IDs are unique
deck-wide, and element IDs are also unique deck-wide rather than merely within
a page. Both failure paths use the stable `SCHEMA_INVALID` code and structured
page/element details.

The tests cover:

- duplicate page IDs;
- the same element ID on two different pages.

The check occurs after JSON Schema validation and before rendering, so both file
and buffer compilation inherit it through their mandatory `validateDeck` call.

### G3 — PASS — documentation alignment

The machine-readable schema now says canvas/bounds are pixels mapped at 96 dpi
while `fontSize` is points. `docs/IR.md` states the same distinction and records
that v1 drops `#RRGGBBAA` alpha during export. This resolves the earlier
contradiction without silently changing golden rendering.

README/package commands consistently use Bun and the product-only test filter
`bun test ./test/`.

## 3. New residual issues from Round 2 review

### N1 — LOW — the exported JSON Schema cannot express runtime ID uniqueness

The public `./schema` export accepts decks with duplicate page or element IDs;
only `validateDeck` performs those semantic checks. A consumer that treats the
JSON Schema as the complete acceptance contract can therefore approve a deck
that OpenPPT later rejects.

This is not a regression in `validateDeck`, and standard JSON Schema cannot
conveniently enforce uniqueness by one object property. Document duplicate-ID
uniqueness as a semantic validation rule and advise tool authors to call
`validateDeck`, not only the exported Ajv schema.

### N2 — LOW — entrypoint coverage is Unix-centric

The real-path fix and executable mode are verified on macOS. The package-manager
shim path on Windows remains unverified, and the test suite also depends on the
system `unzip` command. This is a portability gap, not evidence that the Round 2
entrypoint fix is wrong.

No other new residual issue was identified in the bounded Round 2 fix set.

## 4. Carried residuals (not new Round 2 regressions)

These remain authoritative from `docs/reviews/round1-codex.md`:

1. **HIGH:** `--force` unlinks an existing output before a successful
   replacement and can delete the input deck when input/output paths collide.
2. **HIGH:** any regular file under the deck directory can be embedded through
   image `src`; the path jail blocks outside-root escape but not sensitive
   in-root siblings.
3. **MED:** `bun audit --production` reports two high advisories on transitive
   `image-size`; runtime reachability is unverified, but the release audit is red.
4. **MED:** source, structure, text, media, and output sizes have no explicit
   resource ceilings.
5. **MED:** the declared Bun `>=1.1.0` floor is not exercised; only the installed
   Bun 1.4 canary was verified.

## 5. Validation record

### CHECKS_RUN

- `bun test ./test/`: **24 pass, 0 fail, 3 files**.
- CLI direct execution test: pass.
- CLI symlinked-bin entrypoint test: pass.
- Duplicate page-ID test: pass.
- Deck-wide duplicate element-ID test: pass.
- The docs/schema consistency check was performed against current product files.

### CHECKS_NOT_RUN

- Bun 1.1/stable-Bun matrix.
- Windows package-manager bin shim.
- PowerPoint or LibreOffice render/open check.
- Docker/container checks.

### WHY_NOT

- Only the installed Bun runtime was available, and Round 2 was explicitly
  bounded to the applied fixes.
- Office and Windows environments were outside this local product review.
- Docker is prohibited on this Mac and was unnecessary.

### EVIDENCE_PATH

- `bin/openppt.js`
- `src/validate.js`
- `src/compile.js`
- `schema/openppt-ir.schema.json`
- `docs/IR.md`
- `README.md`
- `test/cli.test.js`
- `test/validate.test.js`
- `docs/reviews/round1-codex.md`

## 6. Remaining risk / unverified items

The Round 2 changes themselves pass their bounded verification. They do not
close the Round 1 export-collision, in-root file disclosure, dependency-audit,
or resource-exhaustion risks. The working tree is also not yet a committed
release artifact.
