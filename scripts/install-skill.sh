#!/usr/bin/env bash
# Install OpenPPT agent skill into shared + common agent skill directories.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/skills/openppt"
NAME="openppt"

if [[ ! -f "$SRC/SKILL.md" ]]; then
  echo "missing $SRC/SKILL.md" >&2
  exit 1
fi

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

install_one() {
  local dest="$1"
  mkdir -p "$dest"
  if [[ -e "$dest/$NAME" ]]; then
    if [[ "$FORCE" -ne 1 ]]; then
      echo "exists: $dest/$NAME (pass --force to replace; a timestamped .bak is kept)" >&2
      return 0
    fi
    local bak="$dest/${NAME}.bak.$(date +%Y%m%d%H%M%S)"
    mv "$dest/$NAME" "$bak"
    echo "Backed up existing skill → $bak"
  fi
  mkdir -p "$dest/$NAME"
  cp "$SRC/SKILL.md" "$dest/$NAME/SKILL.md"
  printf '%s\n' "$ROOT" >"$dest/$NAME/OPENPPT_ROOT"
  echo "Installed $NAME → $dest/$NAME (OPENPPT_ROOT=$ROOT)"
}

# Shared default + common agents (skip missing parents gracefully for --all style)
install_one "${HOME}/.agents/skills"
for d in .claude .codex .cursor .grok; do
  base="${HOME}/${d}/skills"
  if [[ -d "${HOME}/${d}" ]] || [[ -d "$base" ]]; then
    install_one "$base"
  fi
done

echo "Done. Agents should see skill 'openppt'."
echo "OPENPPT_ROOT file: \$HOME/.agents/skills/openppt/OPENPPT_ROOT (after install)."
echo "Re-run with --force to replace an existing install (previous copy is renamed .bak)."
