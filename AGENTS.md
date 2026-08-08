# OpenPPT — agent notes

## 夜班约束（代管 · 2026-08-08）

- **范围**：本地 IR 编译器 / skill 再开发 / 测试与文档；保持可离线可复现。
- **禁止**：
  - 向任何远端 force-push 或覆盖用户未授权的发布动作；
  - 把已清空/版权敏感的上游 Binaryify 镜像当可再分发源；
  - 未授权的 `npm publish` / 对外公开发布；
  - 关掉或删除 `upstream/`、`*.git` bare mirror、`backups/*.tgz` 等备份资产。
- **无 remote 时**：不强建 GitHub remote、不强 init 新托管仓；用户回来再定公开策略。
- **验证**：改动后优先 `bun test` / 项目内已有测试脚本；失败先本地修，不伪造绿。
- **Herdr**：协调员默认 nudge **main**；用户明确要求多 agent review 时，可直接 prompt 本 tab 内的 `openppt-claude` / `openppt-codex`。
- **Runtime**：一律 **Bun**（`bun install` / `bun test ./test/` / `bun bin/openppt.js`），不要用 node/npm 作为默认路径。
