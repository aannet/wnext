#!/usr/bin/env sh
# Initialise un worktree git (ex. .claude/worktrees/<nom>) pour que `make check` y teste SON code.
# Sans cela, `@wnext/*` se résout vers les paquets du dépôt principal (node_modules du dossier parent) et les tests voient
# l'ancien contrat. Les autres dépendances restent celles du dépôt principal. À lancer depuis la racine du worktree.
set -eu
root="$(git rev-parse --show-toplevel)"
cd "$root"
mkdir -p node_modules/@wnext
for pair in api:apps/api contracts:packages/contracts contracts-tools:packages/contracts-tools engine:packages/engine web:apps/web; do
  name="${pair%%:*}"; target="${pair#*:}"
  rm -f "node_modules/@wnext/$name"
  ln -s "$root/$target" "node_modules/@wnext/$name"
done
echo "worktree initialisé : @wnext/* -> $root"
