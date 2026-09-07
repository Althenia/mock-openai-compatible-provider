#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
installer="$root/site/install.sh"

fail() {
  printf 'installer test failed: %s\n' "$*" >&2
  exit 1
}

[ -f "$installer" ] || fail "site/install.sh does not exist"

work=$(mktemp -d "${TMPDIR:-/tmp}/aipass-installer-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p "$work/bin" "$work/releases" "$work/install dir"
asset=aipass-browser-provider-darwin-arm64

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

make_release() {
  version=$1
  reported=$2
  directory="$work/releases/$version"
  mkdir -p "$directory"
  cat > "$directory/$asset" <<EOF
#!/bin/sh
printf '%s\\n' '$reported'
EOF
  digest=$(checksum "$directory/$asset")
  printf '%s  %s\n' "$digest" "$asset" > "$directory/checksums.txt"
}

make_release v0.1.0 0.1.0
make_release v0.2.0 0.2.0
make_release v0.3.0 0.3.0
printf '%064d  %s\n' 0 "$asset" > "$work/releases/v0.3.0/checksums.txt"
mkdir -p "$work/releases/v0.4.0"
printf '#!/bin/sh\nexit 1\n' > "$work/releases/v0.4.0/$asset"
printf '%s  %s\n' "$(checksum "$work/releases/v0.4.0/$asset")" "$asset" > "$work/releases/v0.4.0/checksums.txt"

cat > "$work/bin/curl" <<'EOF'
#!/bin/sh
set -eu
[ "${FAKE_CURL_FAIL:-0}" != 1 ] || exit 22
output=
write_out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output)
      output=$2
      shift 2
      ;;
    -w|--write-out)
      write_out=$2
      shift 2
      ;;
    -*) shift ;;
    *)
      url=$1
      shift
      ;;
  esac
done
case "$url" in
  */releases/latest)
    [ -n "$write_out" ] || exit 2
    printf '%s/releases/tag/%s' "$FAKE_REPOSITORY_URL" "$FAKE_LATEST_VERSION"
    ;;
  */releases/download/*)
    relative=${url#*/releases/download/}
    version=${relative%%/*}
    file=${relative#*/}
    [ -n "$output" ] || exit 2
    cp "$FAKE_RELEASES_ROOT/$version/$file" "$output"
    ;;
  *) exit 22 ;;
esac
EOF
chmod +x "$work/bin/curl"

cat > "$work/bin/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in
  -s) printf '%s\n' "${FAKE_UNAME_S:-Darwin}" ;;
  -m) printf '%s\n' "${FAKE_UNAME_M:-arm64}" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$work/bin/uname"

run_installer_at() {
  destination=$1
  latest=$2
  shift 2
  env \
    PATH="$work/bin:$PATH" \
    AIPASS_INSTALL_DIR="$destination" \
    FAKE_LATEST_VERSION="$latest" \
    FAKE_RELEASES_ROOT="$work/releases" \
    FAKE_REPOSITORY_URL="https://github.test/owner/repository" \
    AIPASS_REPOSITORY_URL="https://github.test/owner/repository" \
    sh -s -- "$@" < "$installer"
}

run_installer() {
  latest=$1
  shift
  run_installer_at "$work/install dir" "$latest" "$@"
}

run_installer v0.2.0 --version 0.1.0 >/dev/null
[ "$("$work/install dir/aipass-browser-provider")" = "0.1.0" ] || fail "selected version was not installed"

(FAKE_CURL_FAIL=1 run_installer v0.2.0 --version 0.1.0 --from-dir "$work/releases/v0.1.0" >/dev/null)
[ "$("$work/install dir/aipass-browser-provider")" = "0.1.0" ] || fail "authenticated download directory was not installed"
if run_installer v0.2.0 --from-dir "$work/releases/v0.1.0" >/dev/null 2>&1; then
  fail "local assets without an explicit version were accepted"
fi

run_installer v0.2.0 >/dev/null
[ "$("$work/install dir/aipass-browser-provider")" = "0.2.0" ] || fail "latest version did not update the binary"
run_installer v0.2.0 --version v0.2.0 >/dev/null
[ "$("$work/install dir/aipass-browser-provider")" = "0.2.0" ] || fail "leading-v reinstall was not idempotent"

(FAKE_CURL_FAIL=1 run_installer v0.2.0 --version 0.1.0 --from-dir "$work/releases/v0.1.0" >/dev/null)
[ "$("$work/install dir/aipass-browser-provider")" = "0.1.0" ] || fail "selected-version restore failed"
(FAKE_CURL_FAIL=1 run_installer v0.2.0 --version 0.2.0 --from-dir "$work/releases/v0.2.0" >/dev/null)
if run_installer v0.2.0 --version 0.3.0 --from-dir "$work/releases/v0.3.0" >/dev/null 2>&1; then
  fail "local asset with invalid checksum was accepted"
fi
[ "$("$work/install dir/aipass-browser-provider")" = "0.2.0" ] || fail "local checksum failure replaced the installed binary"
chmod 644 "$work/install dir/aipass-browser-provider"
run_installer v0.2.0 --version v0.2.0 >/dev/null
case "$(uname -s)" in
  Darwin) mode=$(stat -f '%Lp' "$work/install dir/aipass-browser-provider") ;;
  *) mode=$(stat -c '%a' "$work/install dir/aipass-browser-provider") ;;
esac
[ "$mode" = 700 ] || fail "identical reinstall left mode $mode instead of 700"

mkdir -p "$work/non-regular/aipass-browser-provider"
if run_installer_at "$work/non-regular" v0.2.0 --version v0.2.0 >/dev/null 2>&1; then
  fail "existing destination directory was accepted"
fi
[ -d "$work/non-regular/aipass-browser-provider" ] || fail "existing destination directory was replaced"

if run_installer v0.3.0 --version v0.3.0 >/dev/null 2>&1; then
  fail "invalid checksum was accepted"
fi
[ "$("$work/install dir/aipass-browser-provider")" = "0.2.0" ] || fail "checksum failure replaced the installed binary"

if run_installer v0.4.0 --version v0.4.0 >/dev/null 2>&1; then
  fail "executable failing its help check was accepted"
fi
[ "$("$work/install dir/aipass-browser-provider")" = "0.2.0" ] || fail "help-check failure replaced the installed binary"

if run_installer v0.2.0 --version ../unsafe >/dev/null 2>&1; then
  fail "unsafe version was accepted"
fi
if run_installer v0.2.0 --version 0.2.0-beta >/dev/null 2>&1; then
  fail "unsupported prerelease version was accepted"
fi

rm -f "$work/curl-called"
if env \
  PATH="$work/bin:$PATH" \
  AIPASS_INSTALL_DIR="$work/install dir" \
  FAKE_UNAME_S=Linux \
  FAKE_UNAME_M=x86_64 \
  FAKE_LATEST_VERSION=v0.2.0 \
  FAKE_RELEASES_ROOT="$work/releases" \
  FAKE_REPOSITORY_URL="https://github.test/owner/repository" \
  AIPASS_REPOSITORY_URL="https://github.test/owner/repository" \
  sh -s -- < "$installer" >/dev/null 2>&1; then
  fail "unsupported platform was accepted"
fi

printf 'installer tests passed\n'
