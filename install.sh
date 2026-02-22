#!/bin/bash

set -e

TARGET="$1"

if [[ -n "$TARGET" ]] && [[ ! "$TARGET" =~ ^(stable|latest|v?[0-9]+\.[0-9]+\.[0-9]+(-[^[:space:]]+)?)$ ]]; then
  echo "Usage: $0 [stable|latest|VERSION]" >&2
  exit 1
fi

REPO="axeldelafosse/loop"
RELEASES_BASE="https://github.com/${REPO}/releases"
INSTALL_DIR="${LOOP_INSTALL_DIR:-$HOME/.local/bin}"
DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loop-install.XXXXXX")"
TARGET_PATH="${INSTALL_DIR}/loop"

trap 'rm -rf "$DOWNLOAD_DIR"' EXIT

DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then
  DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER="wget"
else
  echo "Either curl or wget is required but neither is installed" >&2
  exit 1
fi

download_file() {
  local url="$1"
  local output="$2"

  if [ "$DOWNLOADER" = "curl" ]; then
    if [ -n "$output" ]; then
      curl -fsSL -o "$output" "$url"
    else
      curl -fsSL "$url"
    fi
    return
  fi

  if [ -n "$output" ]; then
    wget -q -O "$output" "$url"
  else
    wget -q -O - "$url"
  fi
}

case "$(uname -s)" in
  Darwin) os="macos" ;;
  Linux) os="linux" ;;
  *) echo "Windows is not supported" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ "$os" = "macos" ] && [ "$arch" = "x64" ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    arch="arm64"
  fi
fi

platform="${os}-${arch}"

if [ -z "$TARGET" ] || [ "$TARGET" = "latest" ] || [ "$TARGET" = "stable" ]; then
  release_path="latest/download"
  release_name="latest"
else
  tag="$TARGET"
  if [[ "$tag" != v* ]]; then
    tag="v$tag"
  fi
  release_path="download/$tag"
  release_name="$tag"
fi

asset="loop-${platform}"
binary_path="$DOWNLOAD_DIR/$asset"
asset_url="${RELEASES_BASE}/${release_path}/${asset}"

echo "Installing loop ${release_name} (${platform})..."
if ! download_file "$asset_url" "$binary_path"; then
  echo "Download failed: $asset_url" >&2
  exit 1
fi

checksum_url="${asset_url}.sha256"
checksum_path="$DOWNLOAD_DIR/${asset}.sha256"
HASH_TOOL=""

if command -v shasum >/dev/null 2>&1; then
  HASH_TOOL="shasum"
elif command -v sha256sum >/dev/null 2>&1; then
  HASH_TOOL="sha256sum"
else
  echo "Error: unable to verify SHA256 checksum (shasum or sha256sum is required)" >&2
  exit 1
fi

if download_file "$checksum_url" "$checksum_path"; then
  expected=$(cut -d ' ' -f 1 < "$checksum_path")
  if [ "$HASH_TOOL" = "shasum" ]; then
    actual=$(shasum -a 256 "$binary_path" | cut -d ' ' -f 1)
  elif [ "$HASH_TOOL" = "sha256sum" ]; then
    actual=$(sha256sum "$binary_path" | cut -d ' ' -f 1)
  else
    echo "Error: unknown checksum tool selected: $HASH_TOOL" >&2
    exit 1
  fi

  if [ "$expected" != "$actual" ]; then
    echo "Checksum verification failed!" >&2
    echo "  expected: $expected" >&2
    echo "  got:      $actual" >&2
    exit 1
  fi
  echo "Checksum verified."
else
  echo "Error: could not download checksum file" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
chmod +x "$binary_path"
cp "$binary_path" "$TARGET_PATH"

echo "Installed loop -> $TARGET_PATH"

if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo ""
  echo "Add this to your shell profile:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
fi

echo ""
echo "Installation complete. Run: loop --help"
