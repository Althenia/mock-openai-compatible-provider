#!/bin/bash
set -euo pipefail

# Assemble an immutable candidate; never overwrite an earlier candidate directory.
[ "$#" -le 2 ] || { echo 'usage: prepare-release.sh [DESTINATION [SOURCE_ARCHIVES]]' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
destination=${1:-release}
sources=${2:-}
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]
[ "$(bun --version)" = 1.3.14 ]
version=$(bun -p 'require("./package.json").version')
[ "$(bun -p 'require("./package.json").license')" = AGPL-3.0-only ]
if ! git diff --quiet HEAD -- .; then
  echo 'release input changes must be committed' >&2
  exit 1
fi
untracked=$(git ls-files --others --exclude-standard -- src scripts site .github package.json bun.lock tsconfig.json README.md LICENSE THIRD_PARTY_NOTICES SOURCE.md third-party docs/releases)
if [ -n "$untracked" ]; then
  echo 'untracked release inputs must be committed' >&2
  exit 1
fi
bun run build
[ "$(dist/aipass-browser-provider --version)" = "$version" ]
dist/aipass-browser-provider help >/dev/null
file dist/aipass-browser-provider | grep -q 'Mach-O 64-bit executable arm64'
for file in LICENSE THIRD_PARTY_NOTICES SOURCE.md "docs/releases/v$version.md"; do test -s "$file"; done
mkdir "$destination"
destination=$(cd "$destination" && pwd)
cp dist/aipass-browser-provider "$destination/aipass-browser-provider-darwin-arm64"
cp LICENSE THIRD_PARTY_NOTICES SOURCE.md "$destination/"
cp site/install.sh "$destination/install.sh"
git archive --format=tar.gz --prefix="aipass-browser-provider-$version/" \
  --output="$destination/aipass-browser-provider-$version-source.tar.gz" HEAD
if [ -n "$sources" ]; then
  for name in bun-1.3.14-source playwright-1.62.1-source tinycc-12882eee-source webkit-5488984d-source; do
    cp "$sources/$name.tar.gz" "$destination/"
  done
else
  curl -fL --connect-timeout 15 --max-time 180 --retry 2 -o "$destination/bun-1.3.14-source.tar.gz" \
    https://codeload.github.com/oven-sh/bun/tar.gz/refs/tags/bun-v1.3.14
  curl -fL --connect-timeout 15 --max-time 180 --retry 2 -o "$destination/playwright-1.62.1-source.tar.gz" \
    https://codeload.github.com/microsoft/playwright/tar.gz/refs/tags/v1.62.1
  curl -fL --connect-timeout 15 --max-time 180 --retry 2 -o "$destination/tinycc-12882eee-source.tar.gz" \
    https://codeload.github.com/oven-sh/tinycc/tar.gz/12882eee073cfe5c7621bcfadf679e1372d4537b
  bash scripts/archive-webkit.sh "$destination/webkit-5488984d-source.tar.gz"
fi
(cd "$destination" && shasum -a 256 -c "$root/third-party/sources.sha256")
export AIPASS_RELEASE_COMMIT=$(git rev-parse HEAD)
bun -e 'const p = await Bun.file("package.json").json(); console.log(JSON.stringify({version:p.version,license:p.license,bun:Bun.version,target:"darwin-arm64",commit:process.env.AIPASS_RELEASE_COMMIT},null,2))' > "$destination/release.json"
(cd "$destination" && shasum -a 256 * > checksums.txt && shasum -a 256 -c checksums.txt)
printf 'Prepared release %s\n' "$version"
