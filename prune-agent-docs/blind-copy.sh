#!/usr/bin/env bash
set -euo pipefail

repo=$(realpath "$1")
dest=$2
shift 2
docs=()
ignored=()
while (($#)); do
  if [[ $1 == -- ]]; then
    shift
    ignored=("$@")
    break
  fi
  docs+=("$1")
  shift
done

for doc in "${docs[@]}"; do
  [[ -e $repo/$doc ]] || { echo "no doc $doc in $repo" >&2; exit 1; }
done

rm -rf "$dest"
mkdir -p "$dest"
git -C "$repo" ls-files -z --cached --others --exclude-standard |
  sed -z '/\/$/d' |
  tar -C "$repo" --null --ignore-failed-read -T - -cf - 2>/dev/null |
  tar -xf - -C "$dest"

for path in "${ignored[@]}"; do
  mkdir -p "$dest/$(dirname -- "$path")"
  cp -a "$repo/$path" "$dest/$(dirname -- "$path")/"
done

for doc in "${docs[@]}"; do rm -rf "${dest:?}/$doc"; done

while IFS= read -r -d '' dep; do
  rel=${dep#"$repo"/}
  [[ -e $dest/$rel ]] && continue
  mkdir -p "$dest/$(dirname -- "$rel")"
  cp -a --reflink=auto "$dep" "$dest/$rel"
done < <(find "$repo" -name .git -prune -o \( -name node_modules -o -name .venv \) -type d -prune -print0)

doc_commits=$( ((${#docs[@]})) && git -C "$repo" log --format=%H -- "${docs[@]}" || true)
mapfile -t kept < <(git -C "$repo" rev-list HEAD | grep -vxF -e "${doc_commits:-none}" | head -150)
: >"$dest/.gitlog.txt"
((${#kept[@]} == 0)) || git -C "$repo" log --no-walk=unsorted --format='%s%n%b---' "${kept[@]}" >"$dest/.gitlog.txt"
echo "$dest"
