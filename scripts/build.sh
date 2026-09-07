#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
bun scripts/build.ts
if [ "$(uname -s)" = Darwin ]; then
  # Compilation changes the runtime's signed bytes; sign the finished executable.
  codesign --force --sign - dist/aipass-browser-provider
  codesign --verify --strict dist/aipass-browser-provider
fi
