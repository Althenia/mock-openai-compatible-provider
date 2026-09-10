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
mkdir -p "$work/bin" "$work/releases" "$work/install dir" "$work/native home"
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
make_release v0.5.0 0.5.0
make_release v0.6.0 0.6.0
make_release v0.7.0 0.7.0
make_release v0.8.0 0.8.0
make_release v0.9.0 0.9.0
printf '%064d  %s\n' 0 "$asset" > "$work/releases/v0.3.0/checksums.txt"
mkdir -p "$work/releases/v0.4.0"
printf '#!/bin/sh\nexit 1\n' > "$work/releases/v0.4.0/$asset"
printf '%s  %s\n' "$(checksum "$work/releases/v0.4.0/$asset")" "$asset" > "$work/releases/v0.4.0/checksums.txt"

for directory in "$work/releases/"*; do
  version=${directory##*/}
  digest=$(awk '{print $1}' "$directory/checksums.txt")
  printf '{"tag_name":"%s","assets":[{"name":"unrelated","state":"uploaded","digest":null},{"name":"%s","state":"uploaded","digest":"sha256:%s"}]}\n' \
    "$version" "$asset" "$digest" > "$directory/metadata.json"
done
printf '{"tag_name":"v0.5.0","assets":[{"name":"%s","state":"uploaded","digest":null}]}\n' "$asset" > "$work/releases/v0.5.0/metadata.json"
printf 'invalid JSON\n' > "$work/releases/v0.6.0/metadata.json"
printf '{"tag_name":"v0.7.0","assets":[]}\n' > "$work/releases/v0.7.0/metadata.json"
printf '{"tag_name":"v9.9.9","assets":[]}\n' > "$work/releases/v0.8.0/metadata.json"
rm "$work/releases/v0.9.0/$asset"

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
[ -z "${FAKE_CURL_LOG:-}" ] || printf '%s\n' "$url" >> "$FAKE_CURL_LOG"
case "$url" in
  https://api.github.com/repos/*/releases/tags/*)
    version=${url##*/}
    cp "$FAKE_RELEASES_ROOT/$version/metadata.json" "$output"
    ;;
  */releases/latest)
    [ -n "$write_out" ] || exit 2
    printf 'https://github.com/Althenia/mock-openai-compatible-provider/releases/tag/%s' "$FAKE_LATEST_VERSION"
    ;;
  */releases/download/*)
    relative=${url#*/releases/download/}
    version=${relative%%/*}
    file=${relative#*/}
    [ -n "$output" ] || exit 2
    [ "$file" != checksums.txt ] || exit 22
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

cat > "$work/bin/id" <<'EOF'
#!/bin/sh
[ "${1:-}" = -u ] || exit 2
printf '%s\n' "${FAKE_UID:-501}"
EOF
chmod +x "$work/bin/id"

cat > "$work/bin/dscacheutil" <<'EOF'
#!/bin/sh
set -eu
[ "$#" = 5 ] || exit 2
[ "$1" = -q ] && [ "$2" = user ] && [ "$3" = -a ] && [ "$4" = uid ] || exit 2
if [ "${FAKE_DSCACHEUTIL_FAIL:-0}" = 1 ]; then
  printf 'dir: %s\n' "${FAKE_NATIVE_HOME:?}"
  exit 1
fi
printf 'name: fixture\ndir: %s\n' "${FAKE_NATIVE_HOME:?}"
EOF
chmod +x "$work/bin/dscacheutil"

write_config() {
  path=$1
  install_dir=$2
  mkdir -p "$(dirname "$path")"
  printf '{"installDir":"%s"}\n' "$install_dir" > "$path"
}

run_installer_with_native_home() {
  native_home=$1
  latest=$2
  shift 2
  env \
    PATH="$work/bin:$PATH" \
    HOME="$work/spoofed home" \
    XDG_CONFIG_HOME="$work/spoofed config" \
    XDG_STATE_HOME="$work/spoofed state" \
    AIPASS_INSTALL_DIR="$work/ignored environment install" \
    AIPASS_REPOSITORY_URL="https://github.com/attacker/repository" \
    FAKE_NATIVE_HOME="$native_home" \
    FAKE_DSCACHEUTIL_FAIL="${FAKE_DSCACHEUTIL_FAIL:-0}" \
    FAKE_LATEST_VERSION="$latest" \
    FAKE_RELEASES_ROOT="$work/releases" \
    sh -s -- "$@" < "$installer"
}

run_installer_at() {
  destination=$1
  latest=$2
  shift 2
  run_installer_with_native_home "$work/native home" "$latest" --install-dir "$destination" "$@"
}

run_installer() {
  latest=$1
  shift
  run_installer_at "$work/install dir" "$latest" "$@"
}

config_install="$work/config install"
default_config="$work/native home/.config/aipass-browser-provider/config.json"
write_config "$default_config" "$config_install"
default_config_before=$(cat "$default_config")
curl_log="$work/curl.log"
FAKE_CURL_LOG="$curl_log" run_installer_with_native_home "$work/native home" v0.2.0 --version 0.1.0 >/dev/null
[ "$("$config_install/aipass-browser-provider")" = "0.1.0" ] || fail "default native configuration installDir was not used"
[ "$(cat "$default_config")" = "$default_config_before" ] || fail "installer modified the selected runtime configuration"
[ ! -e "$work/ignored environment install/aipass-browser-provider" ] || fail "environment install directory override was used"
[ ! -e "$work/spoofed home/.local/bin/aipass-browser-provider" ] || fail "HOME selected the default install directory"
[ ! -e "$work/spoofed config/aipass-browser-provider/config.json" ] || fail "XDG_CONFIG_HOME selected the configuration file"
grep -Fqx 'https://api.github.com/repos/Althenia/mock-openai-compatible-provider/releases/tags/v0.1.0' "$curl_log" \
  || fail "embedded canonical repository was not used"
if grep -Fq 'https://github.com/attacker/repository' "$curl_log"; then
  fail "environment repository override was used"
fi

custom_config="$work/custom-config.json"
custom_config_install="$work/custom config install"
write_config "$custom_config" "$custom_config_install"
run_installer_with_native_home "$work/native home" v0.2.0 --version 0.2.0 --config "$custom_config" >/dev/null
[ "$("$custom_config_install/aipass-browser-provider")" = "0.2.0" ] || fail "--config installDir was not used"

source_config="$work/source-config.json"
source_config_install="$work/source config install"
write_config "$source_config" "$source_config_install"
(FAKE_CURL_FAIL=1 run_installer_with_native_home "$work/native home" v0.1.0 --version 0.1.0 --config "$source_config" --from-dir "$work/releases/v0.1.0" >/dev/null)
[ "$("$source_config_install/aipass-browser-provider")" = "0.1.0" ] || fail "offline source mode did not use --config installDir"

cli_install="$work/cli install"
run_installer_with_native_home "$work/native home" v0.2.0 --version 0.2.0 --config "$custom_config" --install-dir "$cli_install" >/dev/null
[ "$("$cli_install/aipass-browser-provider")" = "0.2.0" ] || fail "--install-dir did not override configuration installDir"

missing_config="$work/missing-config.json"
if run_installer_with_native_home "$work/native home" v0.2.0 --version 0.2.0 --config "$missing_config" >/dev/null 2>&1; then
  fail "explicitly missing --config was accepted"
fi

for invalid_config in malformed nonstring empty whitespace; do
  path="$work/$invalid_config-config.json"
  case "$invalid_config" in
    malformed) printf '{\n' > "$path" ;;
    nonstring) printf '{"installDir":42}\n' > "$path" ;;
    empty) printf '{"installDir":""}\n' > "$path" ;;
    whitespace) printf '{"installDir":"   "}\n' > "$path" ;;
  esac
  if run_installer_with_native_home "$work/native home" v0.2.0 --version 0.2.0 --config "$path" >/dev/null 2>&1; then
    fail "invalid configuration installDir was accepted for $invalid_config"
  fi
done

nul_config="$work/nul-config.json"
printf '{"installDir":"%s/nul\\u0000suffix"}\n' "$work" > "$nul_config"
if output=$(run_installer_with_native_home "$work/native home" v0.2.0 --config "$nul_config" --version not-a-version 2>&1); then
  fail "NUL installDir was accepted"
fi
printf '%s\n' "$output" | grep -Fq 'config installDir must be a non-empty string' \
  || fail "NUL installDir reached release-version validation"

openstep_config="$work/openstep-config.json"
printf '%s\n' '{ "installDir" = "/tmp/never-installed"; }' > "$openstep_config"
if output=$(run_installer_with_native_home "$work/native home" v0.2.0 --config "$openstep_config" --version not-a-version 2>&1); then
  fail "OpenStep selected configuration was accepted"
fi
printf '%s\n' "$output" | grep -Fq 'invalid runtime configuration JSON' \
  || fail "OpenStep selected configuration reached release-version validation"

trailing_comma_config="$work/trailing-comma-config.json"
printf '%s\n' '{"installDir":"/tmp/never-installed",}' > "$trailing_comma_config"
if output=$(run_installer_with_native_home "$work/native home" v0.2.0 --config "$trailing_comma_config" --version not-a-version 2>&1); then
  fail "trailing-comma selected configuration was accepted"
fi
printf '%s\n' "$output" | grep -Fq 'invalid runtime configuration JSON' \
  || fail "trailing-comma selected configuration reached release-version validation"

escaped_config="$work/escaped-config.json"
escaped_config_install="$work/escaped config install"
cat > "$escaped_config" <<EOF
{"installDir":"$escaped_config_install","nested":{"message":"quote: \" and newline \n","values":[true,null,{"ok":false}]}}
EOF
run_installer_with_native_home "$work/native home" v0.2.0 --version 0.2.0 --config "$escaped_config" >/dev/null
[ "$("$escaped_config_install/aipass-browser-provider")" = "0.2.0" ] || fail "valid nested escaped JSON configuration was not used"

newline_config="$work/newline-config.json"
newline_config_prefix="$work/trailing newline install"
newline_suffix=$(printf '\nX')
newline_suffix=${newline_suffix%X}
newline_config_install=$newline_config_prefix$newline_suffix
printf '{"installDir":"%s\\n"}\n' "$newline_config_prefix" > "$newline_config"
run_installer_with_native_home "$work/native home" v0.2.0 --version 0.2.0 --config "$newline_config" >/dev/null
[ "$("$newline_config_install/aipass-browser-provider")" = "0.2.0" ] || fail "trailing newline installDir was not preserved"

quote_config="$work/quote-config.json"
quote_config_prefix="$work/escaped quote"
quote_config_install="$quote_config_prefix\" install"
cat > "$quote_config" <<EOF
{"installDir":"$quote_config_prefix\" install"}
EOF
run_installer_with_native_home "$work/native home" v0.2.0 --version 0.2.0 --config "$quote_config" >/dev/null
[ "$("$quote_config_install/aipass-browser-provider")" = "0.2.0" ] || fail "escaped quote installDir was not preserved"

root_array_config="$work/root-array-config.json"
printf '[]\n' > "$root_array_config"
if output=$(run_installer_with_native_home "$work/native home" v0.2.0 --config "$root_array_config" --version not-a-version 2>&1); then
  fail "array-root configuration was accepted"
fi
printf '%s\n' "$output" | grep -Fq 'runtime configuration JSON must be an object' \
  || fail "array-root configuration reached release-version validation"

malformed_override_config="$work/malformed-override-config.json"
printf '{\n' > "$malformed_override_config"
override_isolation="$work/malformed override install"
if output=$(run_installer_with_native_home "$work/native home" v0.2.0 --config "$malformed_override_config" --install-dir "$override_isolation" --version not-a-version 2>&1); then
  fail "malformed selected configuration was accepted with --install-dir"
fi
printf '%s\n' "$output" | grep -Fq 'invalid runtime configuration JSON' \
  || fail "malformed selected configuration with --install-dir reached release-version validation"
[ ! -e "$override_isolation/aipass-browser-provider" ] || fail "malformed selected configuration wrote to the override destination"

plist_config="$work/plist-config.plist"
printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>' > "$plist_config"
if output=$(run_installer_with_native_home "$work/native home" v0.2.0 --config "$plist_config" --install-dir "$work/plist override install" --version not-a-version 2>&1); then
  fail "plist selected configuration was accepted"
fi
printf '%s\n' "$output" | grep -Fq 'runtime configuration JSON must be an object' \
  || printf '%s\n' "$output" | grep -Fq 'invalid runtime configuration JSON' \
  || fail "plist selected configuration reached release-version validation"

default_home_without_config="$work/native home without config"
run_installer_with_native_home "$default_home_without_config" v0.2.0 --version 0.2.0 >/dev/null
[ "$("$default_home_without_config/.local/bin/aipass-browser-provider")" = "0.2.0" ] || fail "native default install directory was not used when config was absent"

if output=$(FAKE_DSCACHEUTIL_FAIL=1 run_installer_with_native_home "$work/native lookup failure home" v0.2.0 --version not-a-version 2>&1); then
  fail "failed native account lookup was accepted"
fi
printf '%s\n' "$output" | grep -Fq 'could not determine the native account home' \
  || fail "failed native account lookup reached release-version validation"

if run_installer_with_native_home relative-home v0.2.0 --version 0.2.0 >/dev/null 2>&1; then
  fail "relative native account home was accepted"
fi

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

for version in 0.5.0 0.6.0 0.7.0 0.8.0 0.9.0; do
  if run_installer "v$version" --version "$version" >/dev/null 2>&1; then
    fail "invalid metadata or missing executable was accepted for $version"
  fi
  [ "$("$work/install dir/aipass-browser-provider")" = "0.2.0" ] || fail "failed metadata/download replaced the installed binary"
done
if (FAKE_CURL_FAIL=1 run_installer v0.2.0 --version 0.2.0 >/dev/null 2>&1); then
  fail "failed metadata retrieval was accepted"
fi
[ "$("$work/install dir/aipass-browser-provider")" = "0.2.0" ] || fail "network failure replaced the installed binary"

if run_installer v0.2.0 --version ../unsafe >/dev/null 2>&1; then
  fail "unsafe version was accepted"
fi
if run_installer v0.2.0 --version 0.2.0-beta >/dev/null 2>&1; then
  fail "unsupported prerelease version was accepted"
fi

rm -f "$work/curl-called"
if env \
  PATH="$work/bin:$PATH" \
  HOME="$work/spoofed home" \
  XDG_CONFIG_HOME="$work/spoofed config" \
  XDG_STATE_HOME="$work/spoofed state" \
  AIPASS_INSTALL_DIR="$work/ignored environment install" \
  AIPASS_REPOSITORY_URL="https://github.com/attacker/repository" \
  FAKE_NATIVE_HOME="$work/native home" \
  FAKE_UNAME_S=Linux \
  FAKE_UNAME_M=x86_64 \
  FAKE_LATEST_VERSION=v0.2.0 \
  FAKE_RELEASES_ROOT="$work/releases" \
  sh -s -- < "$installer" >/dev/null 2>&1; then
  fail "unsupported platform was accepted"
fi

printf 'installer tests passed\n'
