#!/bin/bash
set -euo pipefail

# Binary-only release preflight; verifies packaging without network access.
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/aipass-release-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
fixture="$work/repo"
mkdir -p "$fixture/scripts" "$fixture/src" "$fixture/dist" "$fixture/site" \
  "$fixture/docs/releases"
cp "$root/scripts/prepare-release.sh" "$fixture/scripts/"
cp "$root/scripts/package-release.sh" "$fixture/scripts/"
printf '#!/bin/sh\nexit 0\n' > "$fixture/scripts/build.sh"
cp "$root/dist/aipass-browser-provider" "$fixture/dist/"
cp "$root/package.json" "$root/LICENSE" "$fixture/"
cp "$root/site/install.sh" "$fixture/site/"
version=$(cd "$root" && bun -p 'require("./package.json").version')
cp "$root/docs/releases/v$version.md" "$fixture/docs/releases/"
git -C "$fixture" init -q
git -C "$fixture" add package.json LICENSE scripts site docs
git -C "$fixture" -c user.name=ReleaseFixture -c user.email=release-fixture@example.invalid commit -qm fixture
cp "$root/bunfig.toml" "$fixture/"
if bash "$fixture/scripts/prepare-release.sh" "$work/untracked-config-candidate" > "$work/untracked-config.log" 2>&1; then
  echo 'release preflight accepted untracked test configuration' >&2
  exit 1
fi
grep -q 'untracked release inputs' "$work/untracked-config.log"
test ! -e "$work/untracked-config-candidate"
git -C "$fixture" add bunfig.toml
git -C "$fixture" -c user.name=ReleaseFixture -c user.email=release-fixture@example.invalid commit -qm fixture-test-config
printf 'export const fixture = true\n' > "$fixture/src/uncommitted.ts"
if bash "$fixture/scripts/prepare-release.sh" "$work/untracked-candidate" > "$work/untracked.log" 2>&1; then
  echo 'release preflight accepted an untracked source file' >&2
  exit 1
fi
grep -q 'untracked release inputs' "$work/untracked.log"
test ! -e "$work/untracked-candidate"
git -C "$fixture" add src/uncommitted.ts
git -C "$fixture" -c user.name=ReleaseFixture -c user.email=release-fixture@example.invalid commit -qm fixture-source
printf 'export const another = true\n' >> "$fixture/src/uncommitted.ts"
if bash "$fixture/scripts/prepare-release.sh" "$work/dirty-candidate" > "$work/dirty.log" 2>&1; then
  echo 'release preflight accepted modified source' >&2
  exit 1
fi
grep -q 'release input changes must be committed' "$work/dirty.log"
test ! -e "$work/dirty-candidate"

git -C "$fixture" checkout -- src/uncommitted.ts
bash "$fixture/scripts/prepare-release.sh" "$work/candidate" > "$work/candidate.log" 2>&1
test -f "$work/candidate/aipass-browser-provider-darwin-arm64" || { echo 'release binary is missing' >&2; exit 1; }
test -f "$work/candidate/install.sh" || { echo 'release installer is missing' >&2; exit 1; }
test -f "$work/candidate/LICENSE" || { echo 'release license is missing' >&2; exit 1; }
test -f "$work/candidate/release.json" || { echo 'release metadata is missing' >&2; exit 1; }
test "$(find "$work/candidate" -type f | wc -l | tr -d ' ')" = 5
(cd "$work/candidate" && shasum -a 256 -c checksums.txt)
test -s "$work/candidate/LICENSE"
sh "$work/candidate/install.sh" --version "$version" --from-dir "$work/candidate" --install-dir "$work/offline install"
test "$("$work/offline install/aipass-browser-provider" --version)" = "$version"
test "$(stat -f '%Lp' "$work/offline install/aipass-browser-provider")" = 700
cmp "$work/candidate/aipass-browser-provider-darwin-arm64" "$work/offline install/aipass-browser-provider"
if bash "$fixture/scripts/prepare-release.sh" "$work/candidate" > "$work/existing.log" 2>&1; then
  echo 'existing release candidate was overwritten' >&2
  exit 1
fi
(cd "$work/candidate" && shasum -a 256 -c checksums.txt)
printf 'release preflight and binary-only packaging tests passed\n'
