#!/bin/sh
set -eu
umask 077

repository_url=${AIPASS_REPOSITORY_URL:-https://github.com/Althenia/mock-openai-compatible-provider}
repository_url=${repository_url%/}
binary_name=aipass-browser-provider
requested_version=
install_dir=${AIPASS_INSTALL_DIR:-}
source_dir=
stage=

fail() {
  printf 'aipass installer: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage: install.sh [--version VERSION] [--install-dir DIRECTORY] [--from-dir DIRECTORY]

Installs the latest AIPass browser provider release by default.

options:
  --version VERSION       install a release such as 0.1.0 or v0.1.0
  --install-dir DIRECTORY install into DIRECTORY instead of ~/.local/bin
  --from-dir DIRECTORY    use downloaded assets and checksums (requires --version)
  -h, --help              print this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a value"
      requested_version=$2
      shift 2
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || fail "--install-dir requires a value"
      install_dir=$2
      shift 2
      ;;
    --from-dir)
      [ "$#" -ge 2 ] || fail "--from-dir requires a value"
      source_dir=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

if [ -n "$source_dir" ]; then
  [ -d "$source_dir" ] || fail "download directory does not exist"
  [ -n "$requested_version" ] || fail "--from-dir requires --version"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required"
fi

system=$(uname -s)
machine=$(uname -m)
[ "$system" = Darwin ] && [ "$machine" = arm64 ] \
  || fail "unsupported platform: $system $machine (supported: macOS arm64)"
os=darwin
arch=arm64

if [ -z "$source_dir" ]; then
  command -v plutil >/dev/null 2>&1 || fail "macOS plutil is required"
  case "$repository_url" in
    https://github.com/*) repository=${repository_url#https://github.com/} ;;
    *) fail "repository URL must be https://github.com/OWNER/REPOSITORY" ;;
  esac
  printf '%s\n' "$repository" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' \
    || fail "invalid GitHub repository URL"
fi

if [ -z "$requested_version" ]; then
  latest_url=$(curl -fsSL --connect-timeout 15 --max-time 30 -o /dev/null -w '%{url_effective}' "$repository_url/releases/latest") \
    || fail "could not resolve the latest release"
  requested_version=${latest_url##*/}
fi

case "$requested_version" in
  v*) version=$requested_version ;;
  *) version=v$requested_version ;;
esac
version_number=${version#v}
printf '%s\n' "$version_number" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "invalid release version: $requested_version"

if [ -z "$install_dir" ]; then
  [ -n "${HOME:-}" ] || fail "HOME is not set; use --install-dir"
  install_dir=$HOME/.local/bin
fi

asset=$binary_name-$os-$arch
release_url=$repository_url/releases/download/$version
work=$(mktemp -d "${TMPDIR:-/tmp}/aipass-install.XXXXXX") || fail "could not create a temporary directory"
trap 'rm -rf "$work"; [ -z "$stage" ] || rm -f "$stage"' EXIT HUP INT TERM

if [ -n "$source_dir" ]; then
  cp "$source_dir/$asset" "$work/$asset" || fail "downloaded release asset is missing"
  cp "$source_dir/checksums.txt" "$work/checksums.txt" || fail "downloaded checksums are missing"
  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$work/checksums.txt")
else
  curl -fsSL --connect-timeout 15 --max-time 30 -o "$work/release.json" \
    "https://api.github.com/repos/$repository/releases/tags/$version" \
    || fail "could not retrieve release verification metadata (GitHub may be rate-limiting; retry later)"
  tag=$(plutil -extract tag_name raw -expect string -o - "$work/release.json") \
    || fail "invalid release metadata"
  [ "$tag" = "$version" ] || fail "release metadata does not match $version"
  count=$(plutil -extract assets raw -expect array -o - "$work/release.json") \
    || fail "release assets are missing"
  expected=
  index=0
  while [ "$index" -lt "$count" ]; do
    name=$(plutil -extract "assets.$index.name" raw -expect string -o - "$work/release.json") \
      || fail "invalid release asset metadata"
    if [ "$name" = "$asset" ]; then
      state=$(plutil -extract "assets.$index.state" raw -expect string -o - "$work/release.json") \
        || fail "invalid release asset state"
      [ "$state" = uploaded ] || fail "release asset is not ready"
      digest=$(plutil -extract "assets.$index.digest" raw -expect string -o - "$work/release.json") \
        || fail "GitHub SHA-256 digest is missing"
      case "$digest" in
        sha256:*) expected=${digest#sha256:} ;;
        *) fail "GitHub SHA-256 digest is missing" ;;
      esac
      break
    fi
    index=$((index + 1))
  done
  [ -n "$expected" ] || fail "release asset $asset was not found for $version"
  curl -fsSL --connect-timeout 15 --max-time 180 -o "$work/$asset" "$release_url/$asset" \
    || fail "release asset $asset was not found for $version"
fi

printf '%s\n' "$expected" | grep -Eq '^[a-f0-9]{64}$' || fail "valid SHA-256 checksum for $asset is missing"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$work/$asset" | awk '{print $1}')
else
  fail "sha256sum or shasum is required"
fi
[ "$actual" = "$expected" ] || fail "checksum verification failed for $asset"
chmod 700 "$work/$asset" || fail "could not set executable permissions"
"$work/$asset" help >/dev/null 2>&1 || fail "downloaded executable failed its help check"

mkdir -p "$install_dir" || fail "could not create install directory: $install_dir"
[ -d "$install_dir" ] || fail "install path is not a directory: $install_dir"
[ -w "$install_dir" ] || fail "install directory is not writable: $install_dir"

destination=$install_dir/$binary_name
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -f "$destination" ] && [ ! -L "$destination" ] \
    || fail "install destination is not a regular file: $destination"
  if command -v sha256sum >/dev/null 2>&1; then
    installed=$(sha256sum "$destination" | awk '{print $1}')
  else
    installed=$(shasum -a 256 "$destination" | awk '{print $1}')
  fi
  if [ "$installed" = "$expected" ]; then
    chmod 700 "$destination" || fail "could not set executable permissions"
    printf 'AIPass browser provider %s is already installed at %s\n' "$version" "$destination"
    exit 0
  fi
fi
stage=$(mktemp "$install_dir/.$binary_name.tmp.XXXXXX") || fail "could not create a staging file"
cp "$work/$asset" "$stage" || fail "could not stage the executable"
chmod 700 "$stage" || fail "could not set executable permissions"
mv -f "$stage" "$destination" || fail "could not replace $destination"
stage=

printf 'Installed AIPass browser provider %s to %s\n' "$version" "$destination"
case ":${PATH:-}:" in
  *:"$install_dir":*) ;;
  *) printf 'Add %s to PATH before running %s.\n' "$install_dir" "$binary_name" ;;
esac
printf 'Run `%s login` before first use. Restart a running provider to use this version.\n' "$binary_name"
