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

    echo "Downloading ${URL}"
    curl -fL -o "$DMG_PATH" "$URL"

    echo "Installing to /Applications..."
    hdiutil attach "$DMG_PATH" -nobrowse -quiet
    cp -R "/Volumes/Brows3/Brows3.app" /Applications/
    hdiutil detach "/Volumes/Brows3" -quiet
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
      curl -fL -o "$DEST" "$URL"
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
