#!/bin/sh
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/aipass-build-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
cp "$root/dist/aipass-browser-provider" "$work/provider"
if [ "$(uname -s)" = Darwin ]; then codesign --verify --strict "$work/provider"; fi
version=$(cd "$root" && bun -p 'require("./package.json").version')
set --
if [ "$(uname -s)" = Darwin ]; then
  set -- sandbox-exec -D "REPO=$root" -p '(version 1)(allow default)(deny file-read* (subpath (param "REPO")))'
fi
cd "$work"
test "$("$@" ./provider --version)" = "$version"
"$@" ./provider help >/dev/null
printf 'Copied executable signature, isolated version and help checks passed\n'
