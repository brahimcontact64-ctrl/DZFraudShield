#!/usr/bin/env bash
# Build the WordPress plugin as an installable zip archive.
# Usage: bash scripts/package-plugin.sh [version]
#
# Output: wordpress-plugin/releases/dz-fraud-shield-<version>.zip

set -euo pipefail

PLUGIN_SRC="wordpress-plugin/dz-fraud-shield"
RELEASES_DIR="wordpress-plugin/releases"
VERSION="${1:-$(date +%Y%m%d)}"
OUT="$RELEASES_DIR/dz-fraud-shield-$VERSION.zip"

if [ ! -d "$PLUGIN_SRC" ]; then
  echo "ERROR: Plugin source not found at $PLUGIN_SRC" >&2
  exit 1
fi

mkdir -p "$RELEASES_DIR"

echo "Packaging plugin version $VERSION..."
zip -r "$OUT" "$PLUGIN_SRC" \
  --exclude "*.DS_Store" \
  --exclude "*__MACOSX*" \
  --exclude "*.git*" \
  --exclude "*.log"

echo "Plugin packaged: $OUT"
echo "Size: $(du -sh "$OUT" | cut -f1)"
