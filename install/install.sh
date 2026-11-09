#!/bin/sh
# Brows3 installer (macOS / Linux).
# Usage: curl -fsSL https://raw.githubusercontent.com/sindus/brows3/main/install/install.sh | sh
set -eu

REPO="sindus/brows3"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

echo "Fetching the latest Brows3 release..."
RELEASE_JSON=$(curl -fsSL "$API_URL")

get_asset_url() {
  pattern="$1"
  printf '%s\n' "$RELEASE_JSON" \
    | grep -oE "\"browser_download_url\": \"[^\"]*${pattern}\"" \
    | head -1 \
    | sed -E 's/.*"(https:[^"]+)"$/\1/'
}

fail() {
  echo "Error: $1" >&2
  echo "You can always download manually from https://github.com/${REPO}/releases/latest" >&2
  exit 1
}

# SHA-256 that GitHub publishes for an asset ("digest" precedes its download URL).
get_asset_sha256() {
  printf '%s\n' "$RELEASE_JSON" | awk -v url="$1" '
    /"digest":/ { digest = $0; sub(/.*"digest": *"?/, "", digest); sub(/[",].*/, "", digest) }
    index($0, "\"browser_download_url\": \"" url "\"") { print digest; exit }' \
    | sed -n 's/^sha256://p'
}

verify_download() {
  expected=$(get_asset_sha256 "$2")
  if [ -z "$expected" ]; then
    echo "Warning: no checksum published for this file; skipping verification." >&2
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$1" | cut -d ' ' -f 1)
  else
    actual=$(shasum -a 256 "$1" | cut -d ' ' -f 1)
  fi
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $(basename "$2")."
  echo "Checksum verified."
}

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    if [ "$ARCH" = "arm64" ]; then
      URL=$(get_asset_url '_aarch64\.dmg')
    else
      URL=$(get_asset_url '_x64\.dmg')
    fi
    [ -n "$URL" ] || fail "could not find a macOS .dmg asset for arch ${ARCH}."

    TMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TMP_DIR"' EXIT
    DMG_PATH="${TMP_DIR}/Brows3.dmg"

    MOUNT_POINT="${TMP_DIR}/mnt"

    echo "Downloading ${URL}"
    curl -fL -o "$DMG_PATH" "$URL"
    verify_download "$DMG_PATH" "$URL"

    echo "Installing to /Applications..."
    # A private mount point avoids clashing with an already mounted "Brows3" volume.
    mkdir -p "$MOUNT_POINT"
    hdiutil attach "$DMG_PATH" -nobrowse -quiet -mountpoint "$MOUNT_POINT"
    cp -R "${MOUNT_POINT}/Brows3.app" /Applications/
    hdiutil detach "$MOUNT_POINT" -quiet
    # The app is not notarized: clear the quarantine flag so Gatekeeper lets it start.
    xattr -cr /Applications/Brows3.app || true

    echo "Brows3 installed to /Applications/Brows3.app"
    ;;

  Linux)
    if command -v dpkg >/dev/null 2>&1 && command -v apt >/dev/null 2>&1; then
      if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        URL=$(get_asset_url '_arm64\.deb')
      else
        URL=$(get_asset_url '_amd64\.deb')
      fi
      [ -n "$URL" ] || fail "could not find a .deb asset for arch ${ARCH}."

      TMP_DIR=$(mktemp -d)
      trap 'rm -rf "$TMP_DIR"' EXIT
      DEB_PATH="${TMP_DIR}/brows3.deb"

      echo "Downloading ${URL}"
      curl -fL -o "$DEB_PATH" "$URL"
      verify_download "$DEB_PATH" "$URL"

      echo "Installing via apt (you may be asked for your password)..."
      sudo apt install -y "$DEB_PATH"

      echo "Brows3 installed. Launch it from your application menu or run 'brows3'."
    else
      if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        URL=$(get_asset_url '_aarch64\.AppImage')
      else
        URL=$(get_asset_url '_amd64\.AppImage')
      fi
      [ -n "$URL" ] || fail "could not find an AppImage asset for arch ${ARCH}."

      mkdir -p "$HOME/.local/bin"
      DEST="$HOME/.local/bin/Brows3.AppImage"

      echo "Downloading ${URL}"
      curl -fL -o "${DEST}.download" "$URL"
      verify_download "${DEST}.download" "$URL"
      mv "${DEST}.download" "$DEST"
      chmod +x "$DEST"

      echo "Brows3 installed to ${DEST}"
      case ":${PATH}:" in
        *":${HOME}/.local/bin:"*) echo "Run it with: Brows3.AppImage" ;;
        *) echo "Add \$HOME/.local/bin to your PATH, then run: Brows3.AppImage" ;;
      esac
    fi
    ;;

  *)
    fail "unsupported OS '${OS}'. Windows users should use install.ps1 instead."
    ;;
esac
