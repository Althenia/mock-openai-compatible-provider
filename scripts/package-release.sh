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
cp "$assets/install.sh" "$assets/LICENSE" "$assets/release.json" "$destination/"
(cd "$destination" && shasum -a 256 aipass-* install.sh LICENSE release.json > checksums.txt && shasum -a 256 -c checksums.txt)
