#!/usr/bin/env bash
# Builds the distributable archives into dist/.
#
#   dist/hs-browser-extension-<version>-chrome.zip   -> load unpacked / Chrome Web Store
#   dist/hs-browser-extension-<version>-firefox.zip  -> input for `npm run sign`
#
# The version always comes from manifest.json; nothing else may declare it.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./manifest.json').version")"
NAME="hs-browser-extension"

rm -rf dist
mkdir -p dist

npx --no-install web-ext build --source-dir . --artifacts-dir dist --filename "${NAME}-${VERSION}-firefox.zip"
cp "dist/${NAME}-${VERSION}-firefox.zip" "dist/${NAME}-${VERSION}-chrome.zip"

echo "Built version ${VERSION}:"
ls -1 dist
