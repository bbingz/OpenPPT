# OpenPPT Problem Discovery Report

## 执行摘要

上游 `open-kimi-ppt-skill` 以 MIT 名义发布，但默认导出与编辑器核心依赖 **完整官方 neo-ppt 前端镜像** 与 **patched PPTD→PPTX WASM**，外加大量 Kimi/Moonshot 品牌面与 reverse-engineered 设计语料；Binaryify MIT 无法转让这些专有资产的再分发权。运行时还存在 **路径逃逸 / SSRF 媒体拉取**、**本地导出错误一律回退浏览器**、**缺图仍写成功 PPTX** 等高优先级缺陷。二次开发若要去 Kimi 再发布，必须先完成法律/品牌剥离与导出栈解耦，再谈 UX 与性能。

**关键数字**：已确认 **18** 项 · 被证伪 **0** 项 · 未验证尾部 **30** 项（见附录）。

**默认导出链路（事实）**：

```
export_pptx.py (prefer_local=True)
  → export_pptx_local()
  → node local-export/export-pptd.mjs --no-sign --wasm <patched>
  → load PPTD + resolveImages + exportPPTDToPPTXBytes (WASM)
  → write PPTX → Python patch_transitions + verify
真源 WASM: editor/neo-ppt/assets/pptd_wasm_bg-DPPWdROu.wasm
安装拷贝: scripts/local-export/pptd_wasm_bg.wasm
回退: --browser / export_images.py → 同一 editor/ + agent-browser
```

---

## 1. Kimi / 版权与品牌资产清单（必须去除的东西）

> 受众：二次开发与 rebrand **必须** 从分发包中剥离或替换的内容。优先级按 critical → high → med。

### 1.1 阻塞性（critical）— 产品无法合法/可持续公开发布

| ID | 资产 | 位置 | 说明 |
|---|---|---|---|
| `ip-neo-ppt-mirror` | 完整官方 neo-ppt 前端镜像 | `editor/neo-ppt/`（~198 assets：双轨 modern+legacy JS/CSS、2 个 WASM、KaTeX、`fonts/fnt/*.fntdata`、`favicon-kimi.ico`） | `editor/README.md` 明文「夺舍官方 Kimi neo-ppt 前端镜像」；`package.json` `files: ["editor/", …]` + install `cpSync` 整树；测试断言 `editor/index.html` + WASM 存在 |
| `ip-wasm-export-core` | 官方/patched PPTD→PPTX WASM + kimiDesign 胶水 | `editor/neo-ppt/assets/pptd_wasm_bg-DPPWdROu.wasm`；`export-pptd.mjs` / `kimiDesign-*.js`；`export_pptx.py` 默认路径 | **唯一**离线 PPTX 真源；无替代 open writer；装/导均依赖该二进制 |

### 1.2 高优先级品牌 / 许可 / 语料（high）

| ID | 必须处理项 | 证据要点 |
|---|---|---|
| `ip-mit-claim-mismatch` | **整包 MIT 过度声明** | `LICENSE` 仅 Binaryify 2026；无 THIRD_PARTY/NOTICE；却随 npm 发镜像前端/WASM/品牌/字体 |
| `ip-product-naming` | 产品命名去 Kimi | `package.json` name/bin/keyword：`open-kimi-ppt-skill`、`kimi`；CLI/skill 目录 `open-kimi-ppt`；README 承认第三方商标 |
| `ip-brand-surface-assets` | UI 品牌面 | `favicon-kimi.ico`；meta「Kimi生成PPT」；`kimi-*` JS/CSS chunks；`a_Kimi` SVG；`.kimi-*` CSS |
| `ip-hardcoded-moonshot-hosts` | 硬编码主机/UA（残留 IP 字符串） | `const-BjfH-jZe.js`：`statics.moonshot.cn/kimi-ppt`、`www.kimi.com`、`www.kimi.ai`、`slides.kimi.link|page`、kimi-desktop/ios/…；`Share-*.js` 按 origin 分支。本地 shell 仅 blocklist fetch/XHR，**未剥离 bundle 内品牌**（severity 已降为 med，但仍需 rebrand） |
| `ip-skill-pptd-docs` | reverse-engineered skill 语料 | `reference/pptd.md`、`fonts.md`（MiSans/Alimama）、shapes/categories/design_system；SKILL 写「Moonshot AI's PPTD」；`files` 含整个 `reference/` |
| `ip-design-system-dual-tree` | 双树 design_system | 命名树 `consulting|finance|…/*/design.md` × 编号树 `01_strategy–05_academic/**/en/*.md`；重叠 theme ID（如 `pine-green-strategy`）；文中大量 reverse-engineered / Source-deck / McKinsey-BCG 基线表述 |
| `opt-dekimi-rebrand-plan` | 分阶段 de-Kimi 计划（执行层） | 重命名包/CLI/skill；替换 favicon 与 kimi-* chunks；去掉 Share/slides.kimi 面；清理 `KIMI_COOKIE`/`KIMI_ORIGIN` 默认；SKILL/README 从产品身份改为技术溯源。Local shell 已写 NeoDeck，却仍带 Kimi chrome |

### 1.3 品牌面 MAP（完整清单，去重合并）

| 表面 | 路径 / 标识 |
|---|---|
| Favicon | `editor/neo-ppt/favicon-kimi.ico`（`editor/index.html` + `neo-ppt/index.html` 引用） |
| Meta / SEO | `neo-ppt/index.html`：`Kimi生成PPT`；keywords 含 kimi |
| 脚本 chunk | `kimi-DRwOD7EI.js`、`kimi-legacy-*`、`kimi.button-*`、`kimiDesign-*`、`Share-*` / `ShareDialog-*` |
| CSS | `kimi-DH0O-3yG.css`；`local-shell.css` 的 `.kimi-message`；bundled `.kimi-icon-svg` / `.kimi-tooltip` |
| 主机常量 | `const-BjfH-jZe.js` Moonshot/Kimi hosts + UA brands |
| 文档/包元数据 | `package.json` name/keyword/description；`bin/open-kimi-ppt-skill.js`；`skills/open-kimi-ppt/`；`SKILL.md` Moonshot AI PPTD；README 逆向免责 + 商标声明；`editor/README.md`「夺舍…」 |
| 导出 env | `export-pptd.mjs`：`KIMI_COOKIE` / `KIMI_ORIGIN` 默认 `https://www.kimi.com` |
| 字体（UNVERIFIED 中度） | `fonts/fnt/MiSans.fntdata` + 目录中商业/系统 CJK 字体包 — 见附录尾部 |

### 1.4 许可结论（确认）

- **MIT 只覆盖 Binaryify 自有包装/胶水代码**，不能覆盖 admitted official mirror + patched WASM + Kimi brand assets +（可能的）字体二进制。
- 下游 OpenPPT 若原样 `files` 再发，继承 **许可过度声明 + 专有 blob 再分发** 风险。
- 再发布最低合规形态：自有代码 MIT（或所选协议）+ 明确 **排除/替换** 专有栈，或单独 NOTICE 且不随 MIT 授予再分发权——但后者对「可商用二次开发」几乎不可接受。

---

## 2. 实现缺陷与脆弱点

### 2.1 已确认缺陷（高）

#### `def-local-error-browser-fallback` — 本地导出错误一律吞掉并开浏览器
- **文件**：`skills/open-kimi-ppt/scripts/export_pptx.py`
- **行为**：`export_pptx()` 对 `export_pptx_local` 抛出的 **任意** `ExportError`（WASM 崩溃、verify/patch 失败、坏 deck、缺工具、输出已存在等）统一 log「local WASM export unavailable」后走 `ensure_agent_browser` / browser UI。
- **默认**：`prefer_local=True`，即正常路径就会踩到。
- **后果**：真实错误被掩盖；与 docstring「离线默认、无需浏览器」矛盾；verify 失败后磁盘可能已有坏 PPTX，浏览器路径再报「output already exists」。

#### `def-silent-missing-media` — 缺图仍写成功 PPTX
- **文件**：`skills/open-kimi-ppt/scripts/local-export/export-pptd.mjs`
- **行为**：`resolveImages` 对远程 fetch 失败 / 本地文件缺失仅 `console.warn` 并跳过 remap；`main()` 仍 `exportPPTDToPPTXBytes` + `writeFileSync`，exit 0。
- **Python 侧**：仅 `returncode != 0` 才 `ExportError` → agent 报告「export OK」的残缺 deck。

#### `def-win-images-no-cdp` — Windows 图片 QA 未接 CDP
- **文件**：`export_images.py` vs `export_pptx.py`
- **行为**：PPTX browser 路径调用 `ensure_debug_chrome()` 并传 `cdp_port`；`export_images` 构造 `BrowserSession` **从不**设 CDP。Windows 上 agent-browser 无法自启 Chrome 的已知问题已为 PPTX 修过，图片 QA 未同步 → 多模态必做的 image review 在 Windows 上失败。

### 2.2 架构脆弱点（确认，非“跑挂”而是战略锁死）

| ID | 问题 | 影响 |
|---|---|---|
| `opt-wasm-replace` / `ip-wasm-export-core` | 默认导出锁死单一 patched WASM + `offline-bypass-*` 合成签名 | 上游轮换二进制则全产品断供；公开再发布不可持续 |
| `opt-pure-ooxml` | 无纯 OOXML writer；Python 仅 ZIP 内 patch fade transition | 无法摆脱二进制 IP；难做确定性 CI / 完整字体控制 |
| `opt-qa-without-browser` | 视觉 QA = agent-browser 刮 neo-ppt UI（「导出」「图片」中文按钮 + ZIP + Pillow stitch） | 脆弱、慢、难进 CI；SKILL 对多模态强制此路径 |
| `opt-smaller-skill-surface` | install 总是整 skill + 整 editor/（含 legacy Share/Mobile） | 磁盘/token/延迟成本高；headless 导出实际只需 WASM |

### 2.3 与缺陷相关的 pipeline 事实

- **Local 默认**：Node WASM 路径；**不**使用 Python `safe_project_path`（该 jail 只在 browser payload 构建）。
- **Browser 回退 / 手动 serve**：同一 `editor/` + 同一 WASM；fetch/XHR 对 Kimi 域 blocklist 假响应。
- **无** pptxgenjs / python-pptx / 自研 OOXML builder（skills/ + lib/ 检索确认）。

---

## 3. 安全边界

### 3.1 已确认高危

#### `sec-path-escape-export-pptd` — 默认导出路径无 project-root jail
- **文件**：`export-pptd.mjs`（`loadProject` page 路径、`resolveImages` 本地 src）
- **机制**：`path.join(root, userPath)` + `readFileSync`，无 `resolve` + `relative_to`。
  - 绝对路径：Node `path.join('/proj', '/etc/passwd')` → `/etc/passwd`
  - `../` 可逃出工程目录
- **数据流**：读到的 page YAML / 图片字节进入 PPTX。
- **对比**：`export_pptx.py` 的 `safe_project_path` 有 jail，但 **默认 WASM 路径不走它**。

#### `sec-ssrf-image-fetch` — 无限制远程图片 fetch
- **文件**：`export-pptd.mjs` `resolveImages`
- **机制**：`^(https?:|data:)` → `fetch(src)` → 全量 `arrayBuffer()`；无私网 IP 黑名单、无 redirect 策略、无 content-type、无字节上限。
- **对比**：Python `MAX_IMAGE_BYTES` 只限制 browser 路径本地文件；Node 远程拉取不受限。
- **次表面**：`editor/local-bridge.js` `resolveImage` 对 https/blob 直通。
- **场景**：不可信 PPTD → LAN/metadata SSRF + 响应嵌入/DoS（本地 CLI/skill，非多租户，故 high 而非 critical）。

### 3.2 安全相关未验证 / 中低项（见附录；不抬高为 CONFIRMED 主体）

包括：CLI 默认可能走 `KIMI_COOKIE` 签名 API、offline blocklist 非 fail-closed、未 pin 的 auto-install、WASM 无校验和、Windows CDP 常开、js-yaml `load()`、CORS `*` 等。二次开发应按「威胁模型 = agent 跑用户 deck」一并收紧。

### 3.3 安全边界建议原则（仅建议）

1. **导出 TCB 最小化**：Node 路径与 Python 路径统一 `safe_project_path` 语义。  
2. **媒体解析默认 deny-remote** 或 allowlist + 大小上限 + 禁私网。  
3. **去掉或硬关** 官方签名 API 与 cookie 路径（与 offline 叙事一致）。  
4. WASM / 自动安装物：**内容哈希 + 固定版本**，禁止 `@latest` 全局装。

---

## 4. Skill / Agent UX 问题

> 本节主体多为 **UNVERIFIED_TAIL** 中的 skill/ux 项（证据在 JSON 中，但未进 CONFIRMED 主集）。与 CONFIRMED 重叠处已标注。

### 4.1 与品牌/安装强相关（CONFIRMED 支撑）

- **命名锁死**（`ip-product-naming` + 尾部 `skill_ux-kimi-naming-lockin`）：skill id / install 目录 / CLI 均为 `open-kimi-ppt*`，agent 发现靠字符串匹配；rebrand 需全链路改名或保留别名兼容。
- **安装面过大**（`opt-smaller-skill-surface`）：每次 install 拷贝完整 editor 镜像，抬高 agent 环境成本。
- **QA 与导出策略分裂**（`opt-qa-without-browser`）：多模态必须浏览器 UI QA；默认 PPTX 却走无浏览器 WASM——工作流轻重不一致。

### 4.2 未验证但高影响的 Agent UX（尾部，标 UNVERIFIED）

| ID | 问题 | 为何重要 |
|---|---|---|
| `skill_ux-dual-theme-card-conflict` | 同名 theme 在 design.md vs 编号 en/*.md 卡片规则矛盾 | agent 混风 / 反复改版 |
| `skill_ux-ghost-pptx-import` | SKILL/pptd 要求 PPTX→PPTD convert/check，**scripts/ 无实现** | 模板编辑路径空转 |
| `skill_ux-hardcoded-agents-path` | 示例命令写死 `~/.agents/skills/open-kimi-ppt`，install 却支持多 target | 装到 `.claude`/`.cursor` 后命令失效 |
| `skill_ux-overlong-mandatory-context` | 强制通读 `pptd.md` ~2k 行 + categories + design | 上下文爆炸、跳读幻觉 |
| `skill_ux-canvas-size-mismatch` | PPTD 默认 960×540 vs design 源画布 ~1467×825 | 坐标/布局系统性偏差 |
| `skill_ux-font-embed-promise-gap` / `def-fonts-claim-vs-default` | 交付物承诺嵌字体；默认 WASM `fonts:[]`、`--embed-fonts` reserved | 质量承诺与实现不符 |
| `skill_ux-confirm-and-expand-defaults` | 默认要确认页数 / 外扩搜索 | 与「一行命令出片」预期冲突 |
| `skill_ux-multimodal-qa-brittle` | 必做 image QA 依赖 Chrome+agent-browser+视觉模型 | 无头/非多模态环境被卡 |
| `skill_ux-scenario-theme-no-bridge` | slides_categories 与 design_system 分类体系不通 | 二次产品难做「场景→主题」引导 |

### 4.3 UX 与缺陷交叉（确认缺陷的 agent 表现）

- 本地导出失败 → 静默/半静默进浏览器（agent 难归因）。  
- 缺媒体仍 OK → agent checklist 假通过。  
- Windows 上 export_images 挂 → 多模态流程在 Win 上不可用。

---

## 5. 可优化方向（按 ROI）

> ROI ≈ 影响 / 工作量。CONFIRMED 优化项优先；尾部 med 项附后。

### P0 — 法律与产品生死（不做则不宜公开发布）

| 方向 | ID | 影响 | 工作量 | 说明 |
|---|---|---|---|---|
| 剥离/替换 neo-ppt 镜像 + 品牌面 | `ip-neo-ppt-mirror`, `ip-brand-surface-assets`, `opt-dekimi-rebrand-plan` | 解除再分发与商标风险 | L | 短期可：不打包 editor 到 npm；长期：自有轻量预览或仅 headless |
| 导出栈解耦 / 替换 WASM | `ip-wasm-export-core`, `opt-wasm-replace`, `opt-pure-ooxml` | 战略独立、可 CI | L（全替换）/ M（契约隔离） | 先版本化契约+黄金夹具，再渐进纯 OOXML |
| 许可诚实化 | `ip-mit-claim-mismatch` | 下游合规 | S–M | NOTICE、files 白名单、停止对专有 blob 声明 MIT |
| 命名与文档 rebrand | `ip-product-naming`, `ip-skill-pptd-docs` | 去 Kimi 产品身份 | M | 包/CLI/skill/README/SKILL 统一新品牌；PPTD 仅作技术溯源 |

### P1 — 正确性与安全（可立即立项）

| 方向 | ID | 影响 | 工作量 |
|---|---|---|---|
| 分类 ExportError：本地失败可失败，勿默认浏览器 | `def-local-error-browser-fallback` | 可诊断、真·离线 | S |
| 缺图 fail-closed 或显式 `--allow-missing-media` | `def-silent-missing-media` | 交付物完整 | S |
| Node 路径 jail + 远程媒体策略 | `sec-path-escape-export-pptd`, `sec-ssrf-image-fetch` | 不可信 deck 安全 | S–M |
| Windows export_images 接 `ensure_debug_chrome` | `def-win-images-no-cdp` | Win QA 可用 | S |

### P2 — Agent 体验与体积（中高 ROI）

| 方向 | ID | 影响 | 工作量 |
|---|---|---|---|
| 模块化包装：core-export / editor-ui / theme-packs | `opt-smaller-skill-surface` | 安装体积与延迟 | M–L |
| 无浏览器结构化 QA | `opt-qa-without-browser` | 稳定门禁、可 CI | M（结构）/ L（像素） |
| 合并 design_system 单 ID 映射 | `ip-design-system-dual-tree` + 尾部 dual/theme | 减 thrash | M |
| Skill 瘦身 + 渐进披露 + JSON Schema | 尾部 `opt-skill-token-budget` 等 | 降 token、提遵从 | M |
| 一等模板包（可填 PPTD 骨架） | 尾部 `opt-template-system` | 质量杠杆最大之一 | M |

### P3 — 工程卫生（中低）

- CI：install → 导出 `fixtures/minimal` → ZIP 完整性（尾部 `opt-ci-pack-e2e` / `def-untested-wasm-export`）  
- 性能：去 legacy bundle（若仅 Chromium local）、pin yaml、避免重复 transition patch（`opt-export-perf-mirror`）  
- 清理 dead `load_pptd.py`、统一 manifest 发现（尾部 low）

---

## 6. 建议的二次开发优先级路线图（仅建议，不改代码）

### Phase 0 — 决策门（1 周内）
1. **法律红线**：公开二次开发是否允许继续分发 neo-ppt 镜像与 WASM？若否 → Phase 1A；若仅内部研究 → 明确 license 与 `files` 裁剪。  
2. **产品身份**：确定新品牌名（替代 open-kimi-ppt / NeoDeck 混用），列出必须改的包名、CLI、skill id、install 路径兼容策略。  
3. **导出战略**：选 (a) 短期隔离 WASM 契约 + 黄金测试，或 (b) 立项纯 OOXML 替代（可并行）。

### Phase 1 — 可对外的最小合规切片（2–4 周）
1. **npm/分发面**：从默认包移除或可选安装 `editor/neo-ppt`；头less 导出仅带自有脚本 +（若仍暂用）WASM 并 NOTICE。  
2. **de-Kimi 表面**：favicon、meta、package 元数据、SKILL 文案、env 名（`KIMI_*`→中性）、Share 域字符串清理计划。  
3. **诚实许可证**：MIT 仅覆盖自有代码；专有组件列表 + 明确「不授予再分发」或完全删除。  
4. **P1 正确性补丁清单**（可并行小 PR）：本地错误不默认浏览器、缺图策略、路径 jail、SSRF 限制、Win CDP。

### Phase 2 — 导出独立与质量门（4–10 周）
1. WASM：**版本 pin + sha256** 加载前校验；`exportPPTDToPPTXBytes` 输入输出契约文档化；`fixtures/minimal` 进 CI。  
2. 启动 **纯 OOXML 渐进 writer**（text/shape/image/line → 后续 chart/icon），与 WASM 双轨，feature flag 切换。  
3. **无浏览器 QA v1**：bounds/缺媒体/主题 token/密度启发式；SKILL 将「强制 UI 截图」降为可选增强。  
4. design_system：**单 ID→单文件**；去掉重复编号树或生成 JSON tokens。

### Phase 3 — Agent 产品化（持续）
1. 薄 SKILL 入口 + `pptd` JSON Schema + 场景→主题映射。  
2. 一等模板骨架（cover/TOC/chapter/body/final）绑定 theme tokens。  
3. 模块包：`@org/ppt-export-core` / `ppt-editor-ui` / `ppt-themes-*`。  
4. 字体策略：默认开源可嵌入字体；剔除 MiSans 等无授权二进制（尾部 `ip-fonts-misans-fntdata`）。  
5. 实现或删除「PPTX→PPTD convert」文档承诺（尾部 ghost import）。

### 明确不做（本报告范围）
- 不在本阶段改上游代码、不提交 exploit、不绕过任何官方鉴权做「更好用的签名」。  
- 不建议继续强化 `KIMI_COOKIE` 云签名路径。

---

## 附录：已确认 finding 表 / 被证伪 / 未验证尾部

### A. 已确认 finding 表（18）

| ID | 类别 | 严重度 | 摘要 |
|---|---|---|---|
| `ip-neo-ppt-mirror` | legal_risk | **critical** | 完整官方 neo-ppt 镜像入库+npm+install；MIT 无法覆盖 |
| `ip-wasm-export-core` | ip_brand | **critical** | 离线 PPTX 唯一真源 = patched 官方 WASM + kimiDesign 胶水 |
| `ip-mit-claim-mismatch` | legal_risk | high | 整包 MIT + 无 NOTICE，对下游过度授权声明 |
| `ip-product-naming` | ip_brand | high | 包/CLI/skill/关键词以 Kimi/Moonshot 为产品身份 |
| `ip-brand-surface-assets` | ip_brand | high | favicon-kimi、meta、kimi-* chunks、a_Kimi、.kimi-* CSS |
| `ip-hardcoded-moonshot-hosts` | ip_brand | med | const/Share 硬编码 Moonshot/Kimi 主机与 UA（offline 已 stub 网络） |
| `ip-skill-pptd-docs` | ip_brand | high | reverse-engineered PPTD skill 语料与 MiSans 等默认 |
| `ip-design-system-dual-tree` | ip_brand | high | 双 design_system 树 + reverse-engineered 表述 |
| `opt-dekimi-rebrand-plan` | optimization | high | 公开再发需分阶段 de-Kimi（命名/资源/env/文案） |
| `def-local-error-browser-fallback` | defect | high | 任意本地 ExportError → 浏览器回退，掩盖根因 |
| `def-silent-missing-media` | defect | high | 缺图 warn 后仍成功写 PPTX |
| `def-win-images-no-cdp` | defect | high | export_images 无 ensure_debug_chrome，Win QA 断 |
| `sec-path-escape-export-pptd` | security | high | 默认 Node 导出 path.join 无 root jail |
| `sec-ssrf-image-fetch` | security | high | deck 内任意 URL 无限制 fetch 入 PPTX |
| `opt-pure-ooxml` | architecture | high | 无纯 OOXML writer，全程 WASM 耦合 |
| `opt-wasm-replace` | architecture | high | 单二进制锁死 + signature bypass 负载 |
| `opt-qa-without-browser` | optimization | high | 视觉 QA 仅 UI 自动化，难 CI |
| `opt-smaller-skill-surface` | optimization | high | install 永远整包 editor+reference |

### B. 被证伪
无（`REJECTED` 为空数组）。

### C. 未验证尾部（30，勿当已修清单；与 CONFIRMED 重复的路径逃逸以 `sec-path-escape-export-pptd` 为准）

| ID | sev | 一句话 |
|---|---|---|
| `skill_ux-dual-theme-card-conflict` | high | 同 theme 卡片规则冲突 |
| `skill_ux-ghost-pptx-import` | high | 无 PPTX→PPTD 工具却文档要求 |
| `skill_ux-hardcoded-agents-path` | high | 示例路径写死 `~/.agents` |
| `skill_ux-overlong-mandatory-context` | high | 强制通读 ~2k 行 pptd.md |
| `def-fonts-claim-vs-default` | med | 嵌字体承诺 vs 默认空 fonts |
| `def-mjs-path-escape` | med | 与已确认 path escape 重叠（重复项） |
| `def-python3-windows-yaml` | med | YAML fallback 写死 python3 |
| `def-untested-wasm-export` | med | 默认 WASM 路径无集成测试 |
| `def-xhr-offline-stub-incomplete` | med | XHR offline stub 不完整 |
| `ip-fonts-misans-fntdata` | med | MiSans 等字体二进制许可风险 |
| `ip-kimi-cookie-sign-path` | med | 残留官方签名 API 面 |
| `opt-ci-pack-e2e` | med | 无 GH Actions / 真导出 CI |
| `opt-dual-design-system` | med | 双目录结构维护成本 |
| `opt-export-perf-mirror` | med | Node 子进程/legacy/base64 浪费 |
| `opt-skill-token-budget` | med | Skill 面过大 |
| `opt-template-system` | med | 无一等模板包 |
| `sec-kimi-cookie-sign-api` | med | CLI 默认可走 cookie 签名 |
| `sec-offline-blocklist-incomplete` | med | offline 非 fail-closed |
| `sec-unpinned-auto-install` | med | pyyaml/agent-browser 未 pin |
| `sec-wasm-binary-trust` | med | WASM 无哈希校验 |
| `sec-windows-cdp-left-open` | med | Win CDP 故意常开 |
| `skill_ux-canvas-size-mismatch` | med | 画布默认尺寸冲突 |
| `skill_ux-confirm-and-expand-defaults` | med | 强制确认/外扩 |
| `skill_ux-font-embed-promise-gap` | med | 字体承诺落差（文案侧） |
| `skill_ux-kimi-naming-lockin` | med | skill 发现名锁死 |
| `skill_ux-multimodal-qa-brittle` | med | 多模态 QA 脆 |
| `skill_ux-scenario-theme-no-bridge` | med | 场景与主题无映射 |
| `def-dead-load-pptd` | low | 硬编码 debug 脚本残留 |
| `def-manifest-discovery-skew` | low | Py rglob vs Node 顶层扫描 |
| `sec-jsyaml-unsafe-load` | low | js-yaml `load()` 非 safe |
| `sec-payload-cors-star` | low | 本地 payload CORS `*` |

---

*本报告仅基于提供的 CONFIRMED/UNVERIFIED 证据与对 `/Users/bing/-Code-/OpenPPT/upstream` 的路径核对；未引入无证据新主张。不包含代码修改。*
