#!/bin/sh
# Brows3 uninstaller (macOS / Linux).
# Usage: curl -fsSL https://raw.githubusercontent.com/sindus/brows3/main/install/uninstall.sh | sh
set -eu

fail() {
  echo "Error: $1" >&2
  exit 1
}

OS="$(uname -s)"

case "$OS" in
  Darwin)
    [ -d "/Applications/Brows3.app" ] || fail "Brows3.app not found in /Applications."
    rm -rf "/Applications/Brows3.app"
    rm -rf "$HOME/Library/Application Support/com.brows3"
    rm -rf "$HOME/Library/Caches/com.brows3"
    echo "Brows3 removed."
    ;;

  Linux)
    if command -v dpkg >/dev/null 2>&1 && dpkg -s brows3 >/dev/null 2>&1; then
      sudo apt remove -y brows3
      echo "Brows3 removed via apt."
    elif [ -f "$HOME/.local/bin/Brows3.AppImage" ]; then
      rm -f "$HOME/.local/bin/Brows3.AppImage"
      echo "Brows3 AppImage removed from ${HOME}/.local/bin."
    else
      fail "no Brows3 installation found via apt or ~/.local/bin/Brows3.AppImage."
    fi
    ;;

  *)
    fail "unsupported OS '${OS}'. Windows users should use uninstall.ps1 instead."
    ;;
esac
