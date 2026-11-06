#!/bin/bash
# Клодбище: installs the latest release into /Applications (or ~/Applications) and starts it.
# Downloading with curl instead of a browser means macOS doesn't mark the app as
# "downloaded from the internet", so it opens without the unverified-developer block.
set -euo pipefail

REPO="kovalenkonstan-cmd/klodbishche"
URL="https://github.com/${REPO}/releases/latest/download/Klodbishche-mac.zip"
APP_NAME="Клодбище.app"

if [ "$(uname)" != "Darwin" ]; then
  echo "Клодбище работает только на Mac." >&2
  exit 1
fi

DEST="/Applications"
if [ ! -w "${DEST}" ]; then
  DEST="${HOME}/Applications"
  mkdir -p "${DEST}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "🪦 Скачиваю Клодбище (около 170 МБ)…"
curl -fL --progress-bar "${URL}" -o "${TMP}/klodbishche.zip"

# Close a running copy before replacing it
if pgrep -xq "Клодбище"; then
  osascript -e 'tell application "Клодбище" to quit' >/dev/null 2>&1 || true
  sleep 1
fi

echo "🪦 Кладу в ${DEST}…"
rm -rf "${DEST}/${APP_NAME}"
ditto -x -k "${TMP}/klodbishche.zip" "${DEST}"
xattr -dr com.apple.quarantine "${DEST}/${APP_NAME}" 2>/dev/null || true

open "${DEST}/${APP_NAME}"
echo "🪦 Готово! Кладбище появится в правом верхнем углу экрана."
