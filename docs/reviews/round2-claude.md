# OpenPPT — Round 2 Code Review (Claude)

Date: 2026-08-08 · Reviewer: Claude · Follows [`round1-claude.md`](round1-claude.md)
Scope: `src/`, `bin/`, `test/`, `schema/`, plus `package.json` / `README.md` /
`docs/IR.md` / `bunfig.toml` where round-1 items landed. `upstream/` ignored.

## 1. Summary

Every round-1 fix holds, and the tree has moved further than round 1 asked: the
`compile.js` render-loop duplication I deferred is now properly extracted into
`buildPresentation()`, the alpha and font-unit questions (F7/F8) were resolved
by *deciding and documenting* rather than by drifting, and F11–F14/F17/F18 were
all closed. Non-finite guards were even extended past my report to `fontSize`
and `lineWidth`. The one serious new problem is a regression created by an
otherwise-correct round-1 fix: removing the `endsWith("openppt.js")` is-main
fallback (F13) left a strict `argv[1] === import.meta.url` comparison that fails
whenever the two spell the same file differently — which is exactly what an
installed `bin` symlink does — so the shipped `openppt` binary would parse its
arguments and then exit 0 having done nothing. Beyond that the residue is small:
one undocumented IR contract that silently tightened, an unbounded canvas size,
and doc/packaging trim.

## 2. Prior fixes — verification

Read against current source; all confirmed present.

| Round-1 item | Where it lives now | Holds |
|---|---|---|
| F1 non-finite `size` | `src/validate.js:133-139` | ✅ |
| F1 non-finite `bounds` | `src/validate.js:176-182` | ✅ |
| F3 symlink path jail | `src/validate.js:99-104` (realpath both sides, re-assert) | ✅ |
| F5 media must be a regular file | `src/validate.js:212-224` (`statSync().isFile()`) | ✅ |
| F10 `..` segment boundary | `src/validate.js:60` (`rel === ".."` \|\| `..${sep}`) | ✅ |
| F2 `bun ./test/` scoping | `package.json:29`, `bunfig.toml:2-3`, `README:140-144` | ✅ |
| F4 `lineColor` honored | `src/compile.js:103-113` — **and** the duplication behind it is gone | ✅ |
| F6 doc drift | `README:9` `1.0.1`, `README:105` uses `bun` | ✅ |
| F9 coverage | 5 round-1 tests present; YAML fixture in place | ✅ |

**Resolved since round 1** (not by me): F7 and F8 are now explicit decisions
rather than silent behavior — `docs/IR.md:19-22` states that `fontSize` is
points while bounds are pixels, and that `#RRGGBBAA` alpha is dropped in v1.0;
`src/compile.js:19-21,89` carries matching comments. That is the right
resolution: the schema keeps accepting 8-digit hex for forward compatibility and
the lossiness is now a documented contract. F11/F12/F13 (`parseArgs` rejects
unknown options and empty `-o`), F14 (duplicate ids), F17 (dead code), and F18
(`files` narrowed) are all closed. Non-finite validation was independently
extended to `fontSize` and `lineWidth` (`src/validate.js:199-214`) — a real
hole I had not reported, since `Infinity` clears `exclusiveMinimum: 0`.

**Still open from round 1, unchanged:** F15 (`oneOf` error noise), F16 (tests
shell out to `unzip`), and the validate-time/compile-time `safeProjectPath`
TOCTOU window noted in §4.

## 3. New findings

| # | Sev | File | Issue | Fix | Status |
|---|-----|------|-------|-----|--------|
| R1 | **high** | `bin/openppt.js:149` (pre-fix) | **The installed `bin` never runs.** `entry = pathToFileURL(resolve(process.argv[1])).href` compared strictly against `import.meta.url`. An installed bin *is a symlink* (`node_modules/.bin/openppt` → `../openppt/bin/openppt.js`), so `argv[1]` is the link path while the ESM loader resolves `import.meta.url` to the realpath. They differ → `main()` is never called → `openppt --version` prints nothing and exits **0**. The same divergence occurs if any parent directory of a dev checkout is a symlink. `README:29` advertises exactly this install mode, and no test covered it: `cli.test.js` always invoked the real file path. Round 1's `endsWith("openppt.js")` fallback masked this; removing it (F13, correct on its own) exposed it. | Compare `realpathSync` of both sides. | **fixed** |
| R2 | med | `src/validate.js:144,166-173` | **Element-id uniqueness silently became deck-wide, and is documented nowhere.** `elementIds` is declared outside the page loop, so reusing `title` on slide 2 now throws. That is a defensible contract — ids are the IR's only stable handle for future diff/patch — but it was invisible: absent from the JSON Schema, from `README`'s fail-closed table, and from `docs/IR.md`, while being reported as `SCHEMA_INVALID`, which sends an agent hunting for a schema rule that does not exist. Per-slide `title`/`body` ids are a *very* natural authoring pattern, so this will be hit. It also had no test. | Documented in `README` and `docs/IR.md` (including that it is enforced by `validateDeck`, not the schema); pinned with two tests. **Open design question:** deck-wide or per-page? I preserved current behavior rather than guess. | **fixed** (docs+tests) |
| R3 | med | `schema/…:18-24` | **No upper bound on canvas `size`.** F1 stopped `.inf`, but `size: [1000000, 1000000]` is finite and passes, yielding `defineLayout({width: 10417, height: 10417})` inches. PowerPoint's slide extent tops out near 56 in; past that the file opens corrupt or not at all — the same failure class F1 closed, reachable with ordinary finite numbers. | Add `"maximum": 5376` (56 in × 96 dpi) to `size.items`, or guard in `validateDeck`. **Not applied:** the exact limit is a product decision and I could not test the boundary. | open |
| R4 | med | `test/cli.test.js:26,31` | **Version assertions hardcoded `"1.0.1"`** in two places. A routine version bump reddens two CLI tests, and the failure reads like a CLI defect rather than a stale literal. | Read `version` from `package.json`; the test now asserts the real contract (CLI reports the package version). | **fixed** |
| R5 | low | `src/validate.js:2` | `join` left as an unused import when `void join;` was deleted in the F17 cleanup. Dead import; any linter flags it. | Removed. | **fixed** |
| R6 | low | `src/compile.js:64-67` | `pptx.author = "OpenPPT"` sat *inside* `if (deck.title)`, so a titleless deck exported with no author. Authorship should not depend on the title. | Hoisted out of the conditional. | **fixed** |
| R7 | low | `schema/…:23` | **The schema still carried the claim F8 just retired.** `size.description` read `"(1px ≈ 1pt for fontSize)"` while `docs/IR.md:19-21` now says explicitly *do not* assume that. The schema is the first artifact an agent reads (`README` step 1), so the stale copy is the one that gets believed. | Description rewritten to point at `docs/IR.md`. | **fixed** |
| R8 | low | `package.json:25-26` | **`files` now ships `AGENTS.md` and `bunfig.toml`.** `AGENTS.md` is an internal Chinese night-shift operations note — backup-retention rules, Herdr coordination, publish prohibitions. It has no consumer value and puts internal process detail in a public tarball. `bunfig.toml` ships this repo's test config into `node_modules`. | Drop both from `files`. Not applied — `files` was just deliberately curated, so this is the owner's call. | open |
| R9 | low | `bin/openppt.js:63-70` | `openppt validate deck.json -o out.pptx` parses cleanly and ignores `-o`. Now that unknown *options* are rejected, per-command option validation is the natural next step. | Reject `-o` for `validate`. | open |
| R10 | low | `themes/default.json`, `README:103` | `themes/default.json` is shipped and is step 1 of the agent recipe, but **no code ever loads it**. A deck that uses `$primary` without its own `theme.colors` block fails with `THEME_COLOR_UNRESOLVED` — there is no implicit default theme. Worth one clarifying line, since "read the default theme" reads like "these tokens are available". | Note in `README` that the file is a copy-paste template. | open |
| R11 | low | `docs/IR.md:26-30` | Element table omits `fontFamily` (text) and `lineColor` / `lineWidth` (shape), all of which the schema and compiler support. | Complete the table. | open |
| R12 | low | `test/cli.test.js:29` | The "runs directly through the shipped Bun shebang" test `execFileSync(cli, …)` depends on the executable bit of `bin/openppt.js` being committed. If git has it `644`, this fails with `EACCES` on a fresh clone — a CI-only failure. | Verify `git ls-files -s bin/openppt.js` shows mode `100755`. Not checkable here (§6). | open |

## 4. Security

No new exposure. The round-1 jail hardening is intact and the tightened media
check (`isFile`) is doing real work. Two carry-forward notes:

- The **TOCTOU window** between `validateDeck`'s `safeProjectPath` and
  `buildPresentation`'s second call is unchanged. `buildPresentation` now
  resolves the path itself (`src/compile.js:115`), so the cleanest fix is to
  have `validateDeck` return resolved media paths and let the renderer consume
  them instead of re-deriving. Still low severity in a single-process CLI.
- The **media allowlist** recommendation from round 1 stands: any regular file
  inside the project can still be embedded as an "image".

R3 is the security-adjacent one only in the sense that it is another
attacker-influenced number reaching the OOXML writer unchecked; the impact is a
corrupt file, not a compromise.

## 5. Changes applied this round

```
bin/openppt.js          R1  realpath-based isEntrypoint()
src/validate.js         R5  drop unused `join` import
src/compile.js          R6  author no longer gated on title
schema/…schema.json     R7  size description no longer contradicts docs/IR.md
README.md               R2  ID-uniqueness rule + fail-closed table rows
docs/IR.md              R2  new "Identifiers" section
test/cli.test.js        R1  symlinked-bin regression test
                        R4  version read from package.json (2 assertions)
test/validate.test.js   R2  duplicate page id + deck-wide element id tests
```

Not applied, by design: R3 (limit is a product decision), R8 (`files` was just
curated deliberately), R9–R12 (low value / not verifiable here).

## 6. Validation

**CHECKS_RUN: none.**

**CHECKS_NOT_RUN:** `bun test ./test/`, and every ad-hoc repro I would normally
use to confirm a finding.

**WHY_NOT:** the session's safety classifier that began blocking `Bash` during
round 1 is still blocking it for this entire conversation — it fires on
conversation history, not on the command, so `bun test ./test/`, `git status`,
and even `ls` are all refused. The harness states explicitly that reworking the
call to get around it is not appropriate, so I did not route it through a
subagent or any other channel. **This review's verification is source reading
only.** Round 1's recorded baseline (13 pass / 3 files pre-fix) remains the last
figure I actually observed; I have not seen a green suite since, and I am not
going to imply otherwise.

**Please run:**

```bash
bun test ./test/
```

Expect **24 tests across 3 files** — `cli.test.js` 7, `compile.test.js` 5,
`validate.test.js` 12. Of those, **8 have never been executed**: the 5 added in
round 1, plus 3 added here (symlinked bin, duplicate page id, deck-wide element
id).

**Remaining risk / unverified:**

- **R1's test is the one whose outcome I genuinely cannot predict**, and its
  failure mode is informative either way. It symlinks `bin/openppt.js` into a
  temp dir and runs `bun <link> --version`. If it **passes**, the fix works and
  the linked-bin path is sound. If it fails with *"Cannot find module
  ../package.json"* or similar, that means Bun does **not** realpath
  `import.meta.url`, which would make the installed `bin` broken in a second,
  worse way (relative `../package.json` and `../src/*.js` resolve against the
  link's directory) — a genuine packaging bug, not a bad test. Either result is
  worth having; treat a failure as a finding to act on.
- The R1 source change is safe independent of that: in every case where the old
  comparison succeeded, realpath-ing both sides also succeeds.
- Whether the CLI currently works *at all* on this machine is unverified. If
  `/Users/bing/-Code-` is itself a symlink, the pre-fix strict comparison would
  already have been failing and all `cli.test.js` tests with it. My change fixes
  that case too, but I could not confirm the starting state.
- R2's tests pin **current** behavior (deck-wide element ids). If the intent was
  per-page scoping, both the tests and the docs I wrote need to flip with the
  code — decide before v1.0 ships, because it is a breaking IR change afterward.
- R12 (exec bit on `bin/openppt.js`) is unchecked and could redden `cli.test.js`
  on a fresh clone independently of anything in this round.
