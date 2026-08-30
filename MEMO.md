# OpenPPT Memo

## Changelog Memo

### 2026-08-30

- [新增] `serve` 子命令 → OpenPPT Studio 本地 Web 工作台(Bun.serve,零新依赖,仅绑 127.0.0.1):项目管理(空白/骨架/大纲/导入 PPTX)、deck.json 编辑+草稿暂存、校验、沙箱预览、QA、媒体上传、PPTX 下载。
- [安全] 项目 id 与媒体名白名单+路径 containment;上传走 RESOURCE_LIMITS 上限与扩展名+magic-byte 双检;预览/媒体响应带严格 CSP 与 nosniff;静态文件走清单不做目录服务。
- [兼容] Studio 项目即普通 CLI 项目文件夹(默认 ~/.openppt/projects);deck 保存复用原子写且必须先通过 JSON 解析。
- [验证] 新增 test/server.test.js(13 项);全套 180/180 通过;浏览器端到端冒烟(创建骨架项目→自动校验 4 页→预览渲染→控制台无错误)通过。
- [登记] production audit 的包表面清单已重签(files+web/、scripts+serve);`startWebServer` 进入公共 API。

### 2026-08-29

- [安全] 数值量级 / 主题原型链 / 超大 PNG / import 正则 DoS / 页序 / 未类型化错误 / 非 force 导出 TOCTOU 已按第五轮工单 P0 fail-closed 修复。
- [修复] href 挂到 run、SVG fit、零宽边框、run 样式、RGBA、flex 溢出、饼图图例、layer bounds 拷贝、表头补齐、import AlternateContent/换行/关系/grpSp/空目录回滚。
- [变更] QA 按 alpha 合成与 run 级样式计对比度；异类重叠仅白名单 text-on-shape 豁免。CLI `--`、重复 flag 警告、缺命令走 stderr、`ALREADY_EXISTS`。
- [测试] 回归补进 validate/layout/compile/import-qa-preview/cli/table-init/charts/resource-limits；禁止再往 hardening 堆。
- [文档] SKILL/AGENT/README 路径与错误码、preview `--force`、Unreleased≠1.5.0 tarball、templates fragments 与 pitch-skeleton 不等价。
- [CI] canary continue-on-error、contents:read、macOS/Windows 1.4.0、actions SHA；audit clean 不再短路探针；pack 后 validate golden + init --skeleton。
- [验证] 见本轮 `bun test ./test/` 数字；工作区未 commit、未 push。
- [风险] `colW` 未按 1584pt 封顶（已有 1e308/1e307 归一回归）；grouped shapes 导入跳过而非累加 xfrm。

### 2026-08-25

- [修复] `validateDeck` 和布局展开现在返回与调用方深度隔离的 IR，leaf-only deck 也不再共享 page、element 或嵌套字段。
- [修复] Public `expandPageLayouts` 也已对 leaf-only page 执行深度隔离，不再共享页面元数据或元素字段。
- [修复] init/from-outline 与 PPTX import 在硬链接不受支持时使用 `wx` 独占写入回退，既支持 FAT/SMB/OneDrive 类文件系统，也保持 no-clobber。
- [文档] CLI、IR 和 AGENT 文档已区分 authoring `group` 与 normalized leaf schema，并补全 `href` 协议限制。
- [验证] Bun 1.4.1 canary 下 124 项测试与 production dependency-audit gate 全部通过；详见 `CHANGELOG.md`。
- [风险] ZIP64 继续 fail-closed；已开始执行的 `pako.push()` 仍无法抢占取消；`image-size` 两条已审查 advisory 仍由 audit gate 约束。

### 2026-08-23

- [修复] No-clobber import now keeps every successful hard-link output when sibling-temp cleanup fails and reports the leftover as a warning; see `CHANGELOG.md`.
- [修复] Atomic deck creation now commits at hard-link success, so temp cleanup cannot delete the installed `deck.json`; see `CHANGELOG.md`.
- [安全] PPTX import now pins JSZip to the EOCD accepted by preflight and directly pauses its inflate helper on resource-limit aborts; see `CHANGELOG.md`.
- [文档] README now identifies the schema as normalized leaf IR and routes group-bearing authoring IR through `loadDeck` / `validateDeck`.
- [安全] PPTX import now applies archive, raw-entry, declared-size, actual-inflate, and pre-staging media ceilings; repeated relationships reuse one imported media output. See `CHANGELOG.md`.
- [修复] Validation now returns typed external-page errors, always enforces canonical media paths, rejects unsafe table-width normalization, and does not mutate authored groups; downstream compile, preview, and QA use the normalized result.
- [修复] Image path inspection shares bounded snapshot I/O, and `init` / `from-outline` use atomic no-clobber deck writes.
- [文档] Agent guidance now uses safe alternative creation paths and documents `--skeleton`, normalized schema versus authored groups, colors-only themes, real template tokens, shipped charts, and preview limits.
- [验证] The full 119-test suite and production dependency-audit gate pass on the current Bun 1.4.1 canary; see `CHANGELOG.md`.
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
