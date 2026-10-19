#!/usr/bin/env bash
set -uo pipefail

copy=$(realpath "$1")
probes=$(realpath "$2")
out=$3
runs=$4
repo=$(realpath "$5")
shift 5
work=$(dirname "$copy")
forbidden=("$repo" "$HOME" "$work" "~/" "$@")
preamble=$(<"$(dirname "$(realpath "$0")")/PREAMBLE.txt")
preamble=${preamble//"{{DIR}}"/"$copy"}

rm -rf -- "$out"
mkdir -p "$out"
out=$(realpath "$out")
shopt -s nullglob
probe_files=("$probes"/*)
((${#probe_files[@]})) || { echo "no probe file in $probes" >&2; exit 1; }
for probe in "${probe_files[@]}"; do
  name=$(basename "$probe")
  for run in $(seq "$runs"); do
    (cd "$copy" && timeout 40m claude -p "$preamble

$(cat "$probe")" --model "${MODEL:-opus}" \
      --output-format stream-json --verbose --permission-mode bypassPermissions --settings '{"disableAllHooks":true}' \
      --disallowedTools "Bash(git:*)" Edit Write NotebookEdit WebFetch WebSearch Agent Task \
      >"$out/$name.$run.jsonl" 2>"$out/$name.$run.err") &
  done
done
wait

for jsonl in "$out"/*.jsonl; do
  stem=${jsonl%.jsonl}
  jq -r 'select(.type=="result" and .subtype=="success" and (.is_error|not)) | .result' "$jsonl" >"$stem.ans.md"
  jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name+" "+(.input|tostring)' \
    "$jsonl" >"$stem.tools.txt"
  status=ok
  [[ -s $stem.ans.md ]] || status="NO RESULT (see $stem.err and the result line of $jsonl)"
  calls=$(<"$stem.tools.txt")
  calls=${calls//"$copy"/.}
  hits=$( {
    grep -nF "${forbidden[@]/#/-e}" <<<"$calls"
    grep -nE '(^|[^[:alnum:]_.-])(git |\.\.(/|$|[^[:alnum:]_.-]))|"path":"/"' <<<"$calls"
  } | sort -un)
  echo "== $(basename "$stem"): $status, $(grep -c . <<<"$hits") audit hits"
  if [[ -n $hits ]]; then cut -c1-300 <<<"$hits"; fi
done
