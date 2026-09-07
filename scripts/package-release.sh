#!/bin/bash
set -euo pipefail

[ "$#" = 2 ] || { echo 'usage: package-release.sh VERIFIED_ASSETS DESTINATION' >&2; exit 1; }
assets=$(cd "$1" && pwd)
destination=$2
version=$(bun -e 'const p = await Bun.file(process.argv[1]).json(); console.log(p.version)' "$assets/release.json")
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
(cd "$assets" && shasum -a 256 -c checksums.txt)
mkdir "$destination"
destination=$(cd "$destination" && pwd)
cp "$assets/aipass-browser-provider-darwin-arm64" "$destination/"
COPYFILE_DISABLE=1 tar -czf "$destination/aipass-browser-provider-$version-complete-source.tar.gz" -C "$assets" \
  "aipass-browser-provider-$version-source.tar.gz" \
  bun-1.4.0-source.tar.gz playwright-1.62.1-source.tar.gz \
  tinycc-05f0fafa-source.tar.gz webkit-0f966e81-source.tar.gz \
  LICENSE THIRD_PARTY_NOTICES SOURCE.md install.sh release.json checksums.txt
(cd "$destination" && shasum -a 256 aipass-* > checksums.txt && shasum -a 256 -c checksums.txt)
