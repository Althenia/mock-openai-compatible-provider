#!/bin/bash
set -euo pipefail

# GitHub blocks archive generation for this repository; use its published Git tag.
# Exclude browser test corpora, not library source or build/relinking inputs.
[ "$#" -eq 1 ] || { echo 'usage: archive-webkit.sh OUTPUT.tar.gz' >&2; exit 1; }
output=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
[ ! -e "$output" ] || { echo 'source archive already exists' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/aipass-webkit-source.XXXXXX")
trap 'rm -rf "$work"' EXIT
revision=5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b
git -c advice.detachedHead=false clone --quiet --filter=blob:none --depth 1 --sparse \
  --branch "autobuild-$revision" https://github.com/oven-sh/WebKit.git "$work/repo"
[ "$(git -C "$work/repo" rev-parse HEAD)" = "$revision" ]
git -C "$work/repo" ls-tree --format='%(objecttype) %(path)' HEAD > "$work/entries"
paths=()
directories=()
while read -r type path; do
  case "$path" in
    JSTests|LayoutTests|ManualTests|PerformanceTests|WebDriverTests|Websites) continue ;;
  esac
  paths+=("$path")
  if [ "$type" = tree ]; then directories+=("$path"); fi
done < "$work/entries"
git -C "$work/repo" sparse-checkout set --cone "${directories[@]}"
git -C "$work/repo" archive --format=tar.gz --prefix="webkit-$revision/" \
  --output="$output" HEAD "${paths[@]}"
printf 'Archived WebKit library source and build inputs at %s\n' "$revision"
