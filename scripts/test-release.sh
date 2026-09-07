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
cp "$root/scripts/package-release.sh" "$fixture/scripts/"
printf '#!/bin/sh\nexit 0\n' > "$fixture/scripts/build.sh"
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

git -C "$fixture" checkout -- src/uncommitted.ts
bash "$fixture/scripts/prepare-release.sh" "$work/candidate" "$work/sources" > "$work/candidate.log" 2>&1
bundle="aipass-browser-provider-$version-complete-source.tar.gz"
test -f "$work/candidate/$bundle" || { echo 'complete source bundle is missing' >&2; exit 1; }
test "$(find "$work/candidate" -type f | wc -l | tr -d ' ')" = 3
(cd "$work/candidate" && shasum -a 256 -c checksums.txt)
mkdir "$work/unpacked"
tar -xzf "$work/candidate/$bundle" -C "$work/unpacked"
cp "$work/candidate/aipass-browser-provider-darwin-arm64" "$work/unpacked/"
(cd "$work/unpacked" && shasum -a 256 -c checksums.txt)
test -s "$work/unpacked/LICENSE"
test -s "$work/unpacked/THIRD_PARTY_NOTICES"
test -s "$work/unpacked/SOURCE.md"
git -C "$fixture" archive --format=tar.gz --prefix="aipass-browser-provider-$version/" \
  --output="$work/expected-source.tar.gz" HEAD
cmp "$work/expected-source.tar.gz" "$work/unpacked/aipass-browser-provider-$version-source.tar.gz"
if bash "$fixture/scripts/prepare-release.sh" "$work/candidate" "$work/sources" > "$work/existing.log" 2>&1; then
  echo 'existing release candidate was overwritten' >&2
  exit 1
fi
(cd "$work/candidate" && shasum -a 256 -c checksums.txt)
printf 'tampered\n' >> "$work/sources/bun-1.3.14-source.tar.gz"
if bash "$fixture/scripts/prepare-release.sh" "$work/tampered-candidate" "$work/sources" > "$work/tampered.log" 2>&1; then
  echo 'tampered bundled source was accepted' >&2
  exit 1
fi
test ! -e "$work/tampered-candidate"
printf 'release preflight and complete-source packaging tests passed\n'
