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
if AIPASS_INSTALL_DIR= "$@" ./provider update > renamed.log 2>&1; then
  echo 'renamed executable update unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'renamed executable: use update --install-dir' renamed.log

# Exercise the embedded updater without repository access or network access.
mkdir -p bin installed state
cp provider installed/aipass-browser-provider
printf '#!/bin/sh\nprintf "updated-fixture\\n"\n' > fixture
digest=$(shasum -a 256 fixture | awk '{print $1}')
printf '{"tag_name":"v0.0.1","assets":[{"name":"aipass-browser-provider-darwin-arm64","state":"uploaded","digest":"sha256:%s"}]}\n' "$digest" > metadata
cat > bin/curl <<'EOF'
#!/bin/sh
set -eu
test -s "$AIPASS_STATE_ROOT/profile.lock"
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */releases/tags/v0.0.1) cp "$UPDATE_FIXTURE/metadata" "$output" ;;
  */releases/download/v0.0.1/aipass-browser-provider-darwin-arm64) cp "$UPDATE_FIXTURE/fixture" "$output" ;;
  *) exit 22 ;;
esac
EOF
chmod 700 bin/curl
PATH="$work/bin:/usr/bin:/bin:/usr/sbin:/sbin" UPDATE_FIXTURE="$work" \
  AIPASS_INSTALL_DIR= AIPASS_STATE_ROOT="$work/state" \
  "$@" ./installed/aipass-browser-provider update --version 0.0.1 > update.log
cmp fixture installed/aipass-browser-provider
test "$(./installed/aipass-browser-provider --version)" = updated-fixture
test ! -e state/profile.lock
printf 'Copied executable signature, isolated version/help, and embedded self-update checks passed\n'
