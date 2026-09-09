#!/usr/bin/env bash
# Fails unless manifest.json, package.json and the git tag agree on the version.
# Usage: scripts/check-version.sh [expected-version]
set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST_VERSION="$(node -p "require('./manifest.json').version")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"

if [[ "$MANIFEST_VERSION" != "$PACKAGE_VERSION" ]]; then
  echo "::error::manifest.json ($MANIFEST_VERSION) and package.json ($PACKAGE_VERSION) disagree on the version." >&2
  exit 1
fi

if [[ $# -ge 1 ]]; then
  EXPECTED="${1#v}"
  if [[ "$MANIFEST_VERSION" != "$EXPECTED" ]]; then
    echo "::error::tag v$EXPECTED does not match manifest.json version $MANIFEST_VERSION." >&2
    exit 1
  fi
fi

echo "$MANIFEST_VERSION"
