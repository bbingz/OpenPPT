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

install_one() {
  local dest="$1"
  mkdir -p "$dest"
  # Copy skill tree; include a pointer to the repo for OPENPPT_ROOT discovery.
  rm -rf "$dest/$NAME"
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

echo "Done. Agents should see skill 'openppt'. Set OPENPPT_ROOT=$ROOT if needed."
