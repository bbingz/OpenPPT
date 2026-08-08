# OpenPPT — Round 1 Code Review (Claude)

Date: 2026-08-08 · Reviewer: Claude · Commit under review: `2676bc3`
Scope: `schema/`, `src/`, `bin/openppt.js`, `test/`, `fixtures/`, `package.json`,
`README.md`. Gitignored `upstream/`, `backups/`, and the `*.git` reference
checkouts were excluded from the product review (but see F2 — the test runner
was *not* excluding them).

## 1. Summary

The product tree is small, coherent, and genuinely delivers what the README
claims: a versioned open IR, an Ajv-checked schema, and a deterministic
pptxgenjs export path with no proprietary WASM anywhere in the runtime graph.
The fail-closed story is real for the three cases it was designed against
(schema, out-of-bounds, missing media), and all 13 product tests passed before
any change. The two material defects are both *fail-open holes in that same
story*: non-finite YAML numbers (`.nan` / `.inf`) walk straight through every
bounds check into the emitted OOXML, and the media path jail resolves `..` and
absolute paths but not symlinks, so a link inside `media/` can pull an arbitrary
file from outside the project into the `.pptx`. Both are confirmed by execution,
not inference, and both are fixed in this round.

## 2. Findings

| # | Sev | File | Issue | Suggested fix | Status |
|---|-----|------|-------|---------------|--------|
| F1 | **critical** | `src/validate.js:130,154` | **Non-finite bounds fail open.** YAML `.nan`/`.inf` satisfy JSON Schema `type: number`, and every guard (`w <= 0`, `x + w > canvasW`) is a comparison that is *false* for `NaN`. A deck with `bounds: [.nan, .nan, .inf, 50]` validates `OK` and exports exit 0, emitting `<a:ext cx="Infinity" .../>` — structurally invalid OOXML that PowerPoint rejects. `size` is partly shielded (`exclusiveMinimum: 0` rejects `NaN`) but `.inf` passes there too. | Reject non-finite `size` and `bounds` in `validateDeck` before any bounds math. | **fixed** |
| F2 | **high** | `package.json:26`, `bunfig.toml`, `README.md` | **Test runner collects gitignored `upstream/`.** `bun test` positionals are *substring path filters*, not directories, so `bun test test/` also matches `upstream/test/…`. Observed: `bun test test/` → **28 tests across 6 files**, pulling in `upstream/test/editor-lib.test.js`, `editor-server.test.js`, `install-skill.test.js`. The `bunfig.toml` comment asserts the opposite of what actually happens. Third-party tests gate the product suite, and CI vs. dev-machine results silently diverge. | Anchor the filter: `bun test ./test/` → 13 tests across 3 files. | **fixed** |
| F3 | **high** | `src/validate.js:88` | **Path jail does not resolve symlinks.** `safeProjectPath` blocks absolute paths and `..` traversal but compares only the *lexical* path. A symlink at `media/leak.png` → any file outside the root passes validation, and `compileToPptx` embeds its bytes as `ppt/media/image-1-1.png`. Confirmed end-to-end. | `realpathSync` both root and candidate, re-assert containment after resolution. | **fixed** |
| F4 | med | `src/compile.js:201` | **`compileToBuffer` ignores `el.lineColor`**, hard-coding the line color to `fill`. `compileToPptx` honors it. Two copies of the same ~60-line render loop have already drifted; this is the drift. | Short term: honor `lineColor`. Round 2: extract one shared `renderSlides()` — the duplication is the root cause. | **fixed** (dedup deferred) |
| F5 | med | `src/validate.js:191` | **Media existence used `existsSync`, which is true for directories.** `src: "media"` or `src: "."` passed validation, then failed deep inside pptxgenjs with an opaque error instead of a clean `MEDIA_MISSING`. Dangling symlinks had the same shape. | Require `statSync(abs).isFile()`. | **fixed** |
| F6 | med | `README.md:9,105,140` | **Doc drift + a Node invocation in the Bun-only agent recipe.** README header said `1.0.0` while `package.json` and the CLI test assert `1.0.1`; agent step 3 said `node bin/openppt.js validate` eleven lines above "Use **Bun**, not Node"; the Tests section said bare `bun test`, which hits F2. | Correct all three. | **fixed** |
| F7 | med | `src/compile.js:23`, `schema/…:33,55` | **`#RRGGBBAA` alpha is silently dropped.** The schema advertises 8-digit hex for every color; `toPptxColor` slices it to 6 and the transparency is lost with no warning. A deck asking for a 20%-opacity overlay exports fully opaque. | Either map alpha to pptxgenjs `transparency` (`0–100`), or drop `[0-9A-Fa-f]{8}` from the schema patterns. Silent lossy acceptance is the worst of the three. | open |
| F8 | med | `src/compile.js:104`, `docs/IR.md:19` | **`fontSize` and geometry use different unit scales.** Bounds convert px→in at 96 dpi; `fontSize` is passed to pptxgenjs verbatim, and pptxgenjs treats it as *points* (72/in). An 18 "px" font therefore renders ~33% larger than the same 18 px measured against its box. Documented as "1px ≈ 1pt in IR docs", but that convention silently breaks the one thing absolute-bounds layout is for. | Decide explicitly: either `fontSize * 0.75` at export, or state in `docs/IR.md` that `fontSize` is points while bounds are pixels. Not auto-fixed — it changes golden output and needs a fixture refresh. | open |
| F9 | med | `src/validate.js`, `test/` | **Two documented behaviors had zero coverage.** `THEME_COLOR_UNRESOLVED` is in the README's fail-closed table with no test and no fixture; `compileToBuffer` is a public export (`src/index.js:14`) with no test at all — its `outputType: "nodebuffer"` path had never been exercised under Bun. No YAML deck was tested either, so `load.js`'s entire YAML branch was dead in CI. | Add tests for all three. | **fixed** |
| F10 | low | `src/validate.js:72` (pre-fix) | **Path-jail false positive.** `rel.startsWith("..")` rejected legitimate in-root files whose *name* begins with `..` (e.g. `..weird.png` at the project root → `Media path escapes project root`). Ironically `sep` was imported for exactly this and then discarded with `void sep`. | Compare on a segment boundary: `rel === ".." \|\| rel.startsWith(".." + sep)`. | **fixed** |
| F11 | low | `bin/openppt.js:54` | `-o` consumes the next token unconditionally, so `export deck.json -o --force` sets `output = "--force"` and silently drops the flag. | Reject a value starting with `-`. | open |
| F12 | low | `bin/openppt.js:58` | Unknown flags fall through to the deck slot: `openppt validate --bogus` reports `Deck file not found: /…/--bogus` rather than "unknown option". | Reject unconsumed `-`-prefixed tokens in `parseArgs`. | open |
| F13 | low | `bin/openppt.js:134` | `process.argv[1]?.endsWith("openppt.js")` is an is-main fallback that fires for *any* entry script with that basename, so importing the module could run `main()`. The `pathToFileURL` check above it is already correct on Bun. | Drop the `endsWith` clause. | open |
| F14 | low | `src/validate.js` | No duplicate-`id` detection across pages or elements. IDs are the IR's only stable handles for future diff/patch tooling; today two elements can share one id silently. | Collect and reject duplicates (cheap, and cheaper now than after the IR ships). | open |
| F15 | low | `schema/…:76` | `oneOf` over three element variants that are already discriminated by `type` const. On any typo Ajv (with `allErrors: true`) emits the union failure plus every branch's failure, so a one-character mistake produces a wall of irrelevant errors. | `if`/`then` on `type`, or `discriminator`. Purely an error-message quality fix. | open |
| F16 | low | `test/compile.test.js:30,41` | Tests shell out to system `unzip`. Fine on macOS/Linux CI, breaks on Windows, and Bun can read the ZIP in-process. | Not urgent; note as a portability constraint. | open |
| F17 | low | `src/compile.js:215`, `src/validate.js:221` | Pre-existing dead code: `export { writeFileSync }` ("for tests" — no test uses it) and `void join`. Flagged, not removed, per the surgical-diff rule. | Delete when next touching those files. | open |
| F18 | low | `package.json:23` | `files` ships all of `docs/`, so `docs/reviews/` and `docs/discovery/` land in the published tarball. | Narrow to `docs/IR.md` (+ any other intended docs). | open |

## 3. Bun migration gaps

The runtime standard is honored where it counts — `#!/usr/bin/env bun` shebang,
`engines: { bun: ">=1.1.0" }`, all three scripts use `bun`, no `node`-only
dependency in the runtime graph (`ajv`, `pptxgenjs`, `yaml`). Gaps:

1. **`bun test test/` was not actually scoping to `test/`** (F2). This is the
   real Bun-semantics gap: Bun's positional args are filters, not paths, and the
   `bunfig.toml` comment encodes the wrong mental model. Fixed via `./test/`.
2. **Lockfile transition is mid-flight.** `package-lock.json` is deleted in the
   working tree but still tracked in git; `bun.lock` exists but is untracked.
   Until both are committed, a fresh clone still gets the npm lockfile.
   `git rm --cached package-lock.json && git add bun.lock`.
3. **`bunfig.toml` `[test]` section is empty** — a header and a comment, nothing
   else. Setting `root = "test"` would make scoping structural rather than
   dependent on every caller remembering `./`. *(The intended comment correction
   here could not be written — see §7.)*
4. **Tests import `node:test` / `node:assert`, not `bun:test`.** This works —
   Bun's compat shim ran all 13 — but it means the suite can't use Bun's own
   matchers, and `before` vs `beforeAll` semantics rest on shim fidelity. A
   deliberate choice worth stating in the README rather than leaving implicit.
5. **`README.md` told agents to run `node bin/openppt.js`** eleven lines above
   "Use Bun, not Node" (F6). Fixed.
6. **No `main` field**, only `exports`. Correct for Bun and modern Node; will
   break older `require()` consumers. Acceptable given the stated standard —
   noting it so it's a decision, not an accident.

## 4. Security

**Path jail** — the interesting surface, and it had a real hole.

- Absolute paths: rejected. ✅
- Lexical `..` traversal: rejected. ✅
- **Symlink escape: was NOT rejected** (F3). Confirmed end-to-end: a symlink at
  `media/leak2.png` pointing outside the project root exported successfully and
  the target's bytes were embedded as `ppt/media/image-1-1.png`. For a tool
  whose whole premise is "an agent writes a deck project and we compile it,"
  this is an arbitrary-file-read primitive reachable from attacker-authored IR.
  Now closed by resolving both root and candidate through `realpathSync` and
  re-asserting containment.
- Directory / dangling-symlink targets passed the `existsSync` check (F5) and
  failed later inside pptxgenjs. Now `statSync(...).isFile()`.
- False positive on `..`-prefixed filenames (F10). Now segment-boundary aware.
- **Still open:** the jail is enforced at validate time and again at compile
  time, but each is a separate `safeProjectPath` call — a TOCTOU window exists
  between them. Low practical severity (single-process, sub-second), but if
  media handling ever moves to a server context, resolve once and pass the
  resolved path forward.

**Media** — `src` accepts any file the jail admits, with no extension or
content-type allowlist. Inside a deck project that is mostly fine, but
`src: "secrets.env"` will happily be embedded into a shareable `.pptx` as an
"image". Recommend an allowlist (`.png .jpg .jpeg .gif .webp .svg`) plus a magic-byte
sniff. **Not applied** — it can break existing decks and is a policy call, not
a bug fix. No remote URL fetching exists in v1.0; that is the right default and
should stay explicit in the schema description.

**Schema** — `additionalProperties: false` throughout and a strict `const`
version marker: good, that's the fail-closed posture done right. Two soft spots:
`type: number` with no finiteness constraint was the root of F1 (the runtime
guard now backstops it, but adding `"minimum": -1e6, "maximum": 1e6` or similar
to `$defs/bounds` would fail it earlier with a better message); and
`Ajv({ strict: false })` disables schema-authoring lint, which is what let the
unconstrained `bounds` definition pass unremarked.

**Parsing** — `yaml` v2 is used with defaults, which caps alias expansion
(`maxAliasCount: 100`), so billion-laughs is mitigated. No `eval`, no custom
tags, no code-execution path. There is no input size limit on `readFileSync`,
so a huge deck is a local memory-pressure issue only.

## 5. What looks solid

- **The anti-proprietary claim is verifiable, not marketing.** `bun pm ls`
  resolves exactly three dependencies (`ajv`, `pptxgenjs`, `yaml`); no
  `neo-ppt`, `pptd_wasm`, or `kimi.com` reference exists anywhere in `src/`,
  `bin/`, or `schema/`. `files` ships only product paths.
- **Fail-closed is structurally enforced, not advisory.** `compileToPptx` calls
  `validateDeck` itself rather than trusting callers, so the library API cannot
  skip validation the CLI performs — and the negative fixtures assert on error
  *codes*, not message text.
- **`OpenPptError` carries a stable `code` plus structured `details`** (page id,
  element id, bounds, resolved path). That is exactly the shape an agent needs
  to self-correct, and the CLI's `[CODE] message` / exit-1 contract is clean and
  tested.
- **Error context strings are excellent** — `pages[0] (id=only).elements[0]
  (id=missing-img)` tells an agent precisely where to edit.
- **Golden fixture is well chosen**: two pages, all three element types, theme
  tokens, background fills, and a real PNG — and the test asserts on extracted
  `slide1.xml` content, proving the text is genuinely editable rather than
  rasterized. That is the assertion that actually defends the product claim.
- Schema and `docs/IR.md` are consistent with each other and with the code, and
  the "not a clone of any proprietary format" note is appropriately scoped.

## 6. Top 5 fixes this round

All five applied.

1. **F1 — reject non-finite `size`/`bounds`** (`src/validate.js`). Closes the
   fail-open that produced `cx="Infinity"` in real output. Highest value: it
   defends the core product promise.
2. **F3 + F5 + F10 — harden the path jail** (`src/validate.js`). Symlinks
   resolved and re-checked, directories rejected, `..`-prefixed filenames no
   longer false-positive. The one genuine security finding.
3. **F2 — stop collecting `upstream/`** (`package.json`, `README.md`). Restores
   a trustworthy suite: 13 tests / 3 files instead of 28 / 6.
4. **F4 — `compileToBuffer` honors `lineColor`** (`src/compile.js`).
5. **F9 — cover the untested contracts** (`test/`, `fixtures/`). Added tests for
   non-finite bounds (via a new YAML fixture, which also gives `load.js`'s YAML
   branch its first coverage), `THEME_COLOR_UNRESOLVED`, symlink rejection,
   in-root acceptance, and `compileToBuffer`. Plus F6 doc drift.

Deferred to round 2: F7 (alpha), F8 (font unit scale), the `compile.js`
render-loop deduplication behind F4, and the media extension allowlist.

### Files changed

```
src/validate.js                        F1, F3, F5, F10
src/compile.js                         F4
package.json                           F2
README.md                              F2, F6
test/validate.test.js                  F9  (+4 tests)
test/compile.test.js                   F9  (+1 test)
fixtures/negative-nonfinite/deck.yaml  F9  (new)
```

## 7. Validation

**CHECKS_RUN (pre-fix baseline, observed):**

- `bun test test/` → `28 pass, 0 fail — Ran 28 tests across 6 files` — and the
  JUnit reporter confirmed 3 of those files were `upstream/test/*` (evidence
  for F2).
- `bun test ./test/` → `13 pass, 0 fail — Ran 13 tests across 3 files`.
- Per-file: `cli.test.js` 4 pass · `compile.test.js` 4 pass ·
  `validate.test.js` 5 pass.
- F1 repro: `bun bin/openppt.js validate <nan.yaml>` → `OK`, exit 0;
  `export` → exit 0, and `unzip -p … slide1.xml` showed `<a:ext cx="Infinity"`.
- F3 repro: symlinked media outside the root exported successfully;
  `unzip -l` listed `ppt/media/image-1-1.png`.
- F10 repro: `src: "..weird.png"` → `[MEDIA_MISSING] Media path escapes project
  root`, for a file that was inside the root.
- F5 repro: directory `src` passed `existsSync`.
- `bun --version` → `1.4.0`; `bun pm ls` → `ajv@8.20.0`, `pptxgenjs@3.12.0`,
  `yaml@2.9.0`.

**CHECKS_NOT_RUN — post-fix `bun test ./test/`.**

**WHY_NOT:** partway through this review the session's safety classifier began
blocking *all* `Bash` invocations (and some edits) for the remainder of the
conversation, for reasons unrelated to the commands themselves. Every code
change above was therefore made with file edits only and **has not been executed**.
I am not going to claim a green suite I did not observe.

**To verify, run:**

```bash
bun test ./test/
```

Expect **18 tests across 3 files** (13 pre-existing + 5 new).

**Remaining risk / unverified:**

- The 5 new tests are unrun. Four of them exercise code written in this round
  and were reasoned through carefully; the fifth — `compileToBuffer returns
  PPTX (ZIP) bytes` — exercises pptxgenjs's `outputType: "nodebuffer"` path,
  which had **never** run under Bun in this repo. If that test fails, it is a
  genuine finding (a public API broken on the declared runtime), not a bad test.
- `safeProjectPath` now returns a `realpathSync`-resolved path. If the project
  directory itself sits behind a symlink, the returned absolute path differs
  from before (same file, different spelling). It is still passed straight to
  `pptxgenjs.addImage({ path })`, so this should be transparent — but it is the
  one behavioral ripple worth watching in the golden export.
- **`bunfig.toml` was not updated.** Its comment still claims `bun test test/`
  excludes `upstream/`, which F2 disproves. The corrective edit was blocked by
  the classifier. Replace lines 3–4 with, in substance: *positional args are path
  filters, not directories — the bare `test/` filter also matches
  `upstream/test/…`, so use `./test/`*; or better, add `root = "test"` under
  `[test]` and make it structural.
- F7, F8, F11–F18 are unaddressed by design and carry forward to round 2.
- The published-tarball contents (F18) were not inspected via `bun pm pack`.
