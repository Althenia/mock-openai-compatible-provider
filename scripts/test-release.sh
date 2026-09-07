#!/bin/bash
set -euo pipefail

# Real Git preflight checks; source-archive bytes are inert local fixtures.
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/aipass-release-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
fixture="$work/repo"
mkdir -p "$fixture/scripts" "$fixture/src" "$fixture/dist" "$fixture/site" \
  "$fixture/docs/releases" "$fixture/third-party" "$work/sources"
cp "$root/scripts/prepare-release.sh" "$fixture/scripts/"
cp "$root/dist/aipass-browser-provider" "$fixture/dist/"
cp "$root/package.json" "$root/LICENSE" "$root/THIRD_PARTY_NOTICES" "$root/SOURCE.md" "$fixture/"
cp "$root/site/install.sh" "$fixture/site/"
version=$(cd "$root" && bun -p 'require("./package.json").version')
cp "$root/docs/releases/v$version.md" "$fixture/docs/releases/"
for name in bun-1.3.14-source playwright-1.62.1-source tinycc-12882eee-source webkit-5488984d-source; do
  printf 'inert preflight fixture\n' > "$work/sources/$name.tar.gz"
done
(cd "$work/sources" && shasum -a 256 *.tar.gz) > "$fixture/third-party/sources.sha256"
git -C "$fixture" init -q
git -C "$fixture" add package.json LICENSE THIRD_PARTY_NOTICES SOURCE.md scripts site docs third-party
git -C "$fixture" -c user.name=ReleaseFixture -c user.email=release-fixture@example.invalid commit -qm fixture
printf 'export const fixture = true\n' > "$fixture/src/uncommitted.ts"
if bash "$fixture/scripts/prepare-release.sh" "$work/untracked-candidate" "$work/sources" > "$work/untracked.log" 2>&1; then
  echo 'release preflight accepted an untracked source file' >&2
  exit 1
fi
grep -q 'untracked release inputs' "$work/untracked.log"
test ! -e "$work/untracked-candidate"
git -C "$fixture" add src/uncommitted.ts
git -C "$fixture" -c user.name=ReleaseFixture -c user.email=release-fixture@example.invalid commit -qm fixture-source
printf 'export const another = true\n' >> "$fixture/src/uncommitted.ts"
if bash "$fixture/scripts/prepare-release.sh" "$work/dirty-candidate" "$work/sources" > "$work/dirty.log" 2>&1; then
  echo 'release preflight accepted modified source' >&2
  exit 1
fi
grep -q 'release input changes must be committed' "$work/dirty.log"
test ! -e "$work/dirty-candidate"
printf 'release preflight tests passed\n'
