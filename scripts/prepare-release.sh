#!/bin/bash
set -euo pipefail

# Assemble a binary-only immutable candidate; never overwrite an earlier candidate directory.
[ "$#" -le 1 ] || { echo 'usage: prepare-release.sh [DESTINATION]' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
destination=${1:-release}
[ ! -e "$destination" ] || { echo 'release destination already exists' >&2; exit 1; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]
expected_bun=$(bun -p 'require("./package.json").packageManager ?? ""')
expected_bun=${expected_bun#bun@}
[ -n "$expected_bun" ] || { echo 'packageManager (bun@x.y.z) is not set in package.json' >&2; exit 1; }
[ "$(bun --version)" = "$expected_bun" ]
version=$(bun -p 'require("./package.json").version')
[ "$(bun -p 'require("./package.json").license')" = AGPL-3.0-only ]
if ! git diff --quiet HEAD -- .; then
  echo 'release input changes must be committed' >&2
  exit 1
fi
untracked=$(git ls-files --others --exclude-standard -- src scripts site .github package.json bun.lock bunfig.toml tsconfig.json README.md LICENSE docs/releases)
if [ -n "$untracked" ]; then
  echo 'untracked release inputs must be committed' >&2
  exit 1
fi
bun run build
[ "$(dist/aipass-browser-provider --version)" = "$version" ]
dist/aipass-browser-provider help >/dev/null
file dist/aipass-browser-provider | grep -q 'Mach-O 64-bit executable arm64'
for file in LICENSE "docs/releases/v$version.md"; do test -s "$file"; done
assets=$(mktemp -d "${TMPDIR:-/tmp}/aipass-release-assets.XXXXXX")
trap 'rm -rf "$assets"' EXIT
cp dist/aipass-browser-provider "$assets/aipass-browser-provider-darwin-arm64"
cp LICENSE "$assets/"
cp site/install.sh "$assets/install.sh"
export AIPASS_RELEASE_COMMIT=$(git rev-parse HEAD)
bun -e 'const p = await Bun.file("package.json").json(); console.log(JSON.stringify({version:p.version,license:p.license,bun:Bun.version,target:"darwin-arm64",commit:process.env.AIPASS_RELEASE_COMMIT},null,2))' > "$assets/release.json"
(cd "$assets" && shasum -a 256 * > checksums.txt && shasum -a 256 -c checksums.txt)
bash scripts/package-release.sh "$assets" "$destination"
printf 'Prepared release %s\n' "$version"
