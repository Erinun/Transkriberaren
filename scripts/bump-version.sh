#!/bin/bash
# Bumpar versionen i alla tre filer och skapar en git-tagg.
# Användning: ./scripts/bump-version.sh 0.5.2

set -e

if [ -z "$1" ]; then
  echo "Användning: $0 <version>"
  echo "Exempel:    $0 0.5.2"
  exit 1
fi

VERSION="$1"

# Validera versionsformat (X.Y.Z)
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Fel: Version måste vara i formatet X.Y.Z (t.ex. 0.5.2)"
  exit 1
fi

echo "Bumpar till version $VERSION..."

# 1. pyproject.toml
sed -i "s/^version = \".*\"/version = \"$VERSION\"/" pyproject.toml

# 2. src-tauri/tauri.conf.json
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json

# 3. app/package.json
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" app/package.json

echo "Uppdaterade:"
echo "  pyproject.toml        → $VERSION"
echo "  src-tauri/tauri.conf.json → $VERSION"
echo "  app/package.json      → $VERSION"

# Committa och tagga
git add pyproject.toml src-tauri/tauri.conf.json app/package.json
git commit -m "Bumpa version till $VERSION"
git tag "v$VERSION"

echo ""
echo "Klart! Kör nu:"
echo "  git push && git push --tags"
