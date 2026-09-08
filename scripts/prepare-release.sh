#!/bin/bash
set -euo pipefail

# Assemble an immutable candidate; never overwrite an earlier candidate directory.
[ "$#" -le 2 ] || { echo 'usage: prepare-release.sh [DESTINATION [SOURCE_ARCHIVES]]' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
destination=${1:-release}
sources=${2:-}
[ ! -e "$destination" ] || { echo 'release destination already exists' >&2; exit 1; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]
[ "$(bun --version)" = 1.4.2 ]
version=$(bun -p 'require("./package.json").version')
[ "$(bun -p 'require("./package.json").license')" = AGPL-3.0-only ]
if ! git diff --quiet HEAD -- .; then
  echo 'release input changes must be committed' >&2
  exit 1
fi
untracked=$(git ls-files --others --exclude-standard -- src scripts site .github package.json bun.lock bunfig.toml tsconfig.json README.md LICENSE THIRD_PARTY_NOTICES SOURCE.md third-party docs/releases)
if [ -n "$untracked" ]; then
  echo 'untracked release inputs must be committed' >&2
  exit 1
fi
bun run build
[ "$(dist/aipass-browser-provider --version)" = "$version" ]
dist/aipass-browser-provider help >/dev/null
file dist/aipass-browser-provider | grep -q 'Mach-O 64-bit executable arm64'
for file in LICENSE THIRD_PARTY_NOTICES SOURCE.md "docs/releases/v$version.md"; do test -s "$file"; done
assets=$(mktemp -d "${TMPDIR:-/tmp}/aipass-release-assets.XXXXXX")
trap 'rm -rf "$assets"' EXIT
cp dist/aipass-browser-provider "$assets/aipass-browser-provider-darwin-arm64"
cp LICENSE THIRD_PARTY_NOTICES SOURCE.md "$assets/"
cp site/install.sh "$assets/install.sh"
git archive --format=tar.gz --prefix="aipass-browser-provider-$version/" \
  --output="$assets/aipass-browser-provider-$version-source.tar.gz" HEAD
if [ -n "$sources" ]; then
  for name in bun-1.4.2-source playwright-1.62.1-source tinycc-05f0fafa-source webkit-2e2aa229-source; do
    cp "$sources/$name.tar.gz" "$assets/"
  done
else
  curl -fL --connect-timeout 15 --max-time 180 --retry 2 -o "$assets/bun-1.4.2-source.tar.gz" \
    https://codeload.github.com/oven-sh/bun/tar.gz/refs/tags/bun-v1.4.2
  curl -fL --connect-timeout 15 --max-time 180 --retry 2 -o "$assets/playwright-1.62.1-source.tar.gz" \
    https://codeload.github.com/microsoft/playwright/tar.gz/refs/tags/v1.62.1
  curl -fL --connect-timeout 15 --max-time 180 --retry 2 -o "$assets/tinycc-05f0fafa-source.tar.gz" \
    https://codeload.github.com/oven-sh/tinycc/tar.gz/05f0fafaa3be31e31d7b4b5c17dc60f62c991171
  bash scripts/archive-webkit.sh "$assets/webkit-2e2aa229-source.tar.gz"
fi
(cd "$assets" && shasum -a 256 -c "$root/third-party/sources.sha256")
export AIPASS_RELEASE_COMMIT=$(git rev-parse HEAD)
bun -e 'const p = await Bun.file("package.json").json(); console.log(JSON.stringify({version:p.version,license:p.license,bun:Bun.version,target:"darwin-arm64",commit:process.env.AIPASS_RELEASE_COMMIT},null,2))' > "$assets/release.json"
(cd "$assets" && shasum -a 256 * > checksums.txt && shasum -a 256 -c checksums.txt)
bash scripts/package-release.sh "$assets" "$destination"
printf 'Prepared release %s\n' "$version"
