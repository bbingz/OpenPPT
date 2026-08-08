# OpenPPT — 上游备份说明

备份时间：2026-08-08

## 上游状态

| 源 | 状态 | 说明 |
|---|---|---|
| [Binaryify/open-kimi-ppt-skill](https://github.com/Binaryify/open-kimi-ppt-skill) | **已清空**（版权原因） | 仅剩 1 个 commit：`Clear repository due to copyright reasons.`，archived，1588 stars |
| [WangEn/open-kimi-ppt-skill](https://github.com/WangEn/open-kimi-ppt-skill) | **仍可访问**（fork） | 完整 21 commits，HEAD `07eeaad`，version **1.3.0**，66 stars / 230 forks |
| npm `open-kimi-ppt-skill` | **已下架** | 曾发布 1.2.0 / 1.3.0 / 1.3.1 / 1.3.2；2026-08-07T09:49:43Z unpublished。`npx` 已不可用 |

## 本地备份布局

```text
OpenPPT/
  upstream/                          # 可写工作树（WangEn fork clone）— 二次开发从此开始
  open-kimi-ppt-skill.git/           # bare mirror（完整 refs 备份，129M）
  Binaryify-open-kimi-ppt-skill.git/ # bare mirror（仅清库后的 1 commit）
  backups/
    open-kimi-ppt-skill-1.3.0.tgz    # npm pack 产物（11M，可离线 install）
  BACKUP.md                          # 本文件
```

### 从备份恢复 / 重装 skill

```bash
# 从 tarball 安装（不依赖 npm registry）
npx /Users/bing/-Code-/OpenPPT/backups/open-kimi-ppt-skill-1.3.0.tgz install -y

# 或从源码
node /Users/bing/-Code-/OpenPPT/upstream/bin/open-kimi-ppt-skill.js install -y
# 多 Agent：
node .../bin/open-kimi-ppt-skill.js install --all
```

### 已安装到本机的 skill 路径

- `~/.agents/skills/open-kimi-ppt`（共享默认）
- `~/.claude/skills/open-kimi-ppt`
- `~/.codex/skills/open-kimi-ppt`
- `~/.cursor/skills/open-kimi-ppt`
- `~/.grok/skills/open-kimi-ppt`
- `~/.workbuddy/skills/open-kimi-ppt`

## 版权 / 二次开发注意

上游作者因版权原因清空主仓库并 unpublished npm。本项目包含：

1. **逆向 Kimi Slides / PPTD 格式** 与官方 design system 文档
2. **镜像的 neo-ppt 前端资产**（`editor/neo-ppt/`，含 WASM、字体等）

二次开发与重新发布前建议：剥离或替换官方镜像资产、重写 branding、评估 PPTD 兼容层是否可独立实现，并明确「非官方 / 研究用」声明。

## 版本快照

- 工作树版本：`1.3.0`（package.json）
- 最后有意义的 CHANGELOG：1.3.0 完成 **完全本地化**（离线 neo-ppt + patched WASM，不再走 kimi.com）
- npm 曾到 1.3.2，但 WangEn fork 工作树仍停在 1.3.0 源码；1.3.1/1.3.2 若需可另找其他 fork 对比
