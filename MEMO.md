# OpenPPT Memo

## Changelog Memo

### 2026-08-23

- [新增] Added fixed resource ceilings for deck structure, authored strings, chart/table collections, and referenced local media; see `CHANGELOG.md` and `docs/IR.md`.
- [验证] Resource-ceiling boundaries and the full 87-test suite pass on Bun 1.4.0 and the current canary; hosted CI remains the merge gate.
- [继续] Active maintenance now focuses on the media validation TOCTOU window and the transitive image-size advisories.
- [变更] Expanded CI coverage to Bun 1.4 minimum, stable, canary, Linux, macOS, and Windows, including an installed-package bin smoke; see `CHANGELOG.md`.
- [验证] Bun 1.4.0 and the current canary each passed 72 tests locally; hosted-runner evidence remains the merge check.

### 2026-08-22

- [修复] Completed post-v1.5 validation, layout, generator, preview, import, and package hardening; see the Unreleased entry in `CHANGELOG.md`.
- [验证] Added regression coverage for theme paths, nested non-finite values, TOC pagination, table widths, hyperlink schemes, CLI options, write guards, and import commit boundaries.
- [风险] Transitive `image-size@1.2.1` still has two high advisories with no patched upstream release; the audit gate was not disabled or bypassed with a breaking upgrade.
- [继续] Resume from Active maintenance follow-up in `docs/BACKLOG.md`; this hardening batch is intended for the next release.
