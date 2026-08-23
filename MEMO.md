# OpenPPT Memo

## Changelog Memo

### 2026-08-23

- [新增] Added a source-grounded SVG/PNG architecture diagram for the OpenPPT workflow; see `README.md` and `CHANGELOG.md`.
- [修复] The package-install integration smoke now allows 30 seconds for cold Windows dependency resolution instead of inheriting Bun's 5-second unit-test timeout.
- [安全] Added a fail-closed production audit gate for the exact two reviewed `image-size@1.2.1` advisories; see `CHANGELOG.md` and `docs/BACKLOG.md`.
- [验证] The gate pins advisory metadata and the dependency path, scans executable entrypoints, and proves in a fresh export process that `image-size` is not loaded; 99/99 tests and the live gate pass on Bun 1.4.0 and the current canary.
- [风险] The vulnerable transitive package remains installed and downstream audits remain red until PptxGenJS removes it or a trusted patched release exists.
- [完成] The committed active maintenance backlog is now zero; explicitly deferred product scope remains unchanged.
- [修复] PPTX export and HTML preview now consume the same bounded local-media snapshot used for type, size, and dimension validation; see `CHANGELOG.md` and `docs/IR.md`.
- [验证] Five snapshot regressions and the full 92-test suite pass on Bun 1.4.0 and the current canary, covering replacement boundaries, deduplication, and non-blocking non-file rejection.
- [新增] Added fixed resource ceilings for deck structure, authored strings, chart/table collections, and referenced local media; see `CHANGELOG.md` and `docs/IR.md`.
- [验证] Resource-ceiling boundaries and the full 87-test suite pass on Bun 1.4.0 and the current canary; hosted CI remains the merge gate.
- [变更] Expanded CI coverage to Bun 1.4 minimum, stable, canary, Linux, macOS, and Windows, including an installed-package bin smoke; see `CHANGELOG.md`.
- [验证] Bun 1.4.0 and the current canary each passed 72 tests locally; hosted-runner evidence remains the merge check.

### 2026-08-22

- [修复] Completed post-v1.5 validation, layout, generator, preview, import, and package hardening; see the Unreleased entry in `CHANGELOG.md`.
- [验证] Added regression coverage for theme paths, nested non-finite values, TOC pagination, table widths, hyperlink schemes, CLI options, write guards, and import commit boundaries.
- [风险] Transitive `image-size@1.2.1` still has two high advisories with no patched upstream release; the audit gate was not disabled or bypassed with a breaking upgrade.
- [历史] The 2026-08-22 maintenance resume point was completed on 2026-08-23; see the current entry above.
