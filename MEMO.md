# OpenPPT Memo

## Changelog Memo

### 2026-09-05(Docker 部署完成)

- [完成] 公开仓库 PR #8 已创建，8 项托管 CI 全绿后将对应版本部署到指定私网 Docker 主机；实际访问地址和部署标记只保存在私有运行记录中，详见 `CHANGELOG.md`。
- [验证] 容器健康、53 个运行文件与已验证提交一致；Web 编辑/PATCH/SSE、PPTX/PDF 下载及中文渲染通过，重建容器后数据保留，测试项目已清理。
- [边界] PR 尚未合并，本机未运行 Docker；原生 PowerPoint 未验证，两个既有依赖例外未扩大。

### 2026-09-05(PR / Docker 部署准备)

- [授权] 用户批准提交、PR，并在 CI 全绿后部署到指定私网主机 Docker；本机禁用 Docker。用户已确认保留公开仓库、托管 CI；已提交推送，PR 与部署待完成。
- [新增] 增加私网容器配置、项目持久卷和严格访问地址校验；部署/回滚说明见 `deploy/README.md`，详情见 `CHANGELOG.md`。
- [验证] 新用例先失败后修复，专项 23/23、全套 386/386、远端 Compose 配置检查通过；镜像构建和部署验收待 CI 通过后进行。

### 2026-09-05(C 本地完成)

- [完成] 前置失败与 C1–C5 均已由 Codex 独立验收；A+B、前置修复、C 三个当前队列剩余均为 0。下方推进记录保留阶段历史，现状以本条为准。详见 `CHANGELOG.md`、`docs/BACKLOG.md`。
- [修复] 最终实物检查发现的预览编号换行已修复；文档分别说明字体、段落间距和字距继承，主题/段落/PATCH 示例已实际运行。
- [验证] 全套 384/384、14 组浏览器、固定 12/12、随机 120/120 + 负向 10/10、审计策略、PPTX 转换页数和独立安装消费均通过；代表性 PDF/浏览器页面已查看，Studio 接受版本下载已核对。
- [边界] 未提交、推送或发布；原生 PowerPoint、托管跨平台 CI 未验证。两条既有 image-size 例外仍在；预览非像素一致，外部写入不加锁。证据目录在临时盘，详情见 `CHANGELOG.md`。

### 2026-09-05(C 推进中)

- [授权] C 已获批准，Grok 实施、Codex 编排并独立验收；旧失败已处理，C1–C4 已验收，C5 尚未完成。详见 `CHANGELOG.md`、`docs/BACKLOG.md`。
- [修复] fast-uri 最小锁文件升级至 3.1.7，完整性与原审计闸通过；原两条 image-size 例外未扩大。中文缺字已定位至本机无头转换字体发现，子进程环境修复后同步/异步实物栅格可见中文。
- [修复] PDF HTTP 空闲超时已修复：同一 22 秒探针由 429 变为 200，真并发仍受限；独立全套 262/262。图表第二系列误用背景色亦已修复，文件/内存导出和实物栅格通过验收。
- [新增] C1 可执行文字样式、中西文字体默认值和斜体覆盖已验收；独立全套 281/281，浏览器计算样式与中文 PDF 实物通过。
- [新增] C2 段落、编号、软换行、间距与字距已验收；修正 QA 漏判、预览间距/符号继承及格式边界，独立全套 302/302，最终浏览器与中文 PDF 通过。
- [新增] C3 五种原创页面原型与可读大纲分页已验收；修正标题/序号/续页/长词换行和资源边界，独立全套 322/322，原文、实物 PDF 与打包消费通过。C4 Studio 已完成。
- [新增] C4 PATCH/SSE、预览选取与检查器已验收；修复草稿/请求竞态与布局问题，独立全套 383/383、14 组浏览器专项及实际生成→编辑→下载通过。下一步 C5 编号视觉修正及最终文档/打包。
- [边界] 未提交、发布或修改机器配置；原生 PowerPoint、跨平台 CI 和 C 集成验收仍未完成。

### 2026-09-05

- [完成] Grok 分六批实施 A+B，Codex 独立复现并逐批验收；C 单独立项，撤回固定顺序及“半天收完”承诺。详见 `CHANGELOG.md`。
- [修复] 导入丢失、OOXML/图表/富文本、Studio 来源与陈旧保存、preview/QA 单位、PDF 阻塞和页数误判；原有复制项目及工具抽取保留，JPEG 独立补丁已留证。
- [文档] 增加原创设计/内容/素材指导，交付要求查看最终 PPTX 渲染图片并修正重渲染；CLI 成功不等于视觉通过。
- [验证] 本地全套 254/254、固定场景 12/12、随机 120/120 + 负向 10/10、8 份 PPTX 转换页数核对及浏览器专项通过；未 commit/push/release。
- [风险] 依赖审计失败：原锁文件 fast-uri 3.1.5 命中四条 high，独立维护项未实施；本机 CJK 字形验收失败且原因未确认，原生 PowerPoint/跨平台 CI 未验证。证据和后续边界见 `CHANGELOG.md`、`docs/BACKLOG.md`。

### 2026-08-30(第七轮)

- [变更] 导入契约:越界元素 clamp 进画布/亚像素丢弃+警告,不再整包失败;文档序(z-order)保真;rot/flip 组回退跳过;schemeClr 经 theme1.xml 映射(忽略亮度修饰);补组内 pic 缩放与深度 8/9 边界造样。
- [新增] 预览图表内联 SVG 迷你图(分组柱/线/面积/饼/环,采样封顶、全转义、零/负值防 NaN),替代虚线占位。
- [变更] hardening 的"提交前校验"回归从旧越界契约改为字符串上限场景(坏媒体场景原有独立回归)。
- [验证] 全套 200/200;dogfood 12/12;随机种子 707070 120/120+负向 10/10;LibreOffice 渲染 6/6。
- [DEFERRED] lumMod/shade 真正调色、叶子 rot/flip 几何、schemeClr phClr。

### 2026-08-30(第六轮)

- [新增] 可选 PDF 导出:CLI `pdf` 命令、`exportDeckPdf` 公共 API、Studio「导出 PDF」按钮与 `/export.pdf` 端点(无 LibreOffice 时 501+`PDF_UNAVAILABLE`,`meta.pdfAvailable` 探测);隔离 profile、类型化错误,PPTX 导出依旧零外部依赖。
- [修复] 导入按 OOXML off/ext/chOff/chExt 缩放语义递归展开 `p:grpSp`(嵌套上限 8,畸形回退跳过+警告),取代整组跳过;run 级 b/sz/srgbClr 保留为富文本 runs,同质降级 string,1024 上限截断+警告。
- [新增] nightly 失败自动开 GitHub issue(附种子复现命令)。
- [验证] 全套 188/188;dogfood 12/12;随机种子 606060 120/120+负向 10/10;LibreOffice 渲染核对 8/8(含经新导入路径的 re-export)。
- [风险/DEFERRED] 组内 flipH/flipV/rot、schemeClr 主题色、run italic/fontFamily 未做;组变换后越界元素会整包校验失败(未 clamp);组内文档序 leaf 先于组。→ 第七轮工单。

### 2026-08-30

- [新增] `dogfood:random` 种子化随机批次:全 IR 面随机成稿(构造性可行布局),产物卫生+rels 完整性断言,失败保留现场并打印种子复现命令;负向目录 10 类变异断言精确错误码且零写盘。本地 5 种子 × 120 = 600/600,负向 50/50。
- [新增] `render:check` LibreOffice 无头渲染核对(转 PDF+页数比对),本地 27/27 通过;无 LibreOffice 时礼貌跳过,CI 用 --require。
- [新增] nightly workflow:每晚日期种子 300 deck fuzz + 全批次渲染核对(同 SHA 钉扎,contents:read)。
- [验证] 随机批次首轮暴露的两类失败均为生成器造出不可行布局被产品正确 LAYOUT_INVALID 拒绝(fail-closed 按设计工作),生成器已改为构造性可行。
- [新增] `bun run dogfood` 真实生成陪跑批次(12 场景/115 断言):中文骨架成稿、五图表+类目标签、富单元格长表、富文本+链接关系完整性、嵌套布局、30 节大纲、多文件、五媒体格式、导入回环、Studio HTTP 全链路、YAML、64 页压力;产物级卫生断言(无 Infinity/NaN/rIdundefined、r:id 全解析、预览转义、耗时预算);已接入 CI 全矩阵。
- [验证] 首轮 4 个失败均为陪跑脚本自身的 IR 用法错误(schema 与文档经受住真实作者路径检验);修正后 12/12,全套 180/180。
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
