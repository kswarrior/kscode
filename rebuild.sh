#!/usr/bin/env bash
#
# rebuild.sh - Build KS Code into a single self-contained binary: ./release/kscode.
#
# The frontend is built and embedded into the Go binary via go:embed, so the
# release folder contains exactly one file:
#
#   release/
#     kscode   -> the Go binary (frontend baked in)
#
# Run it:
#   ./release/kscode                  # listens on :6060
#   ./release/kscode --port 3837      # listens on :3837
#
set -euo pipefail

# Resolve repo root (dir containing this script), even when run via symlink/PATH.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ROOT="$SCRIPT_DIR"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"
RELEASE_DIR="$ROOT/release"
EMBED_DIR="$ROOT/backend/internal/web/dist"
FE_TMP="/tmp/ks_fe_build"

GO_BUILD_FLAGS=(-buildvcs=false)

echo "=============================================="
echo " KS Code rebuild (single binary)"
echo "   root:   $ROOT"
echo "   release: $RELEASE_DIR/kscode"
echo "=============================================="

# ---------------------------------------------------------------
# 1. Fresh release folder.
# ---------------------------------------------------------------
if [[ -d "$RELEASE_DIR" ]]; then
  echo "[1/6] Removing existing release folder..."
  rm -rf "$RELEASE_DIR"
fi
echo "[1/6] Creating release folder: $RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# ---------------------------------------------------------------
# 2. Verify the toolchain is present.
# ---------------------------------------------------------------
echo "[2/6] Verifying toolchain..."
command -v go   >/dev/null 2>&1 || { echo "error: go not found in PATH"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node not found in PATH"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "error: npm not found in PATH"; exit 1; }
echo "        go $(go version | awk '{print $3}')"
echo "        node $(node --version)"
echo "        npm $(npm --version)"

# ---------------------------------------------------------------
# 3. Build the frontend bundle into the embed directory.
#    Uses a writable tmp location so that npm install and native
#    binary execution work even on read-only fuse mounts.
# ---------------------------------------------------------------
echo "[3/6] Building frontend..."
rm -rf "$FE_TMP"
mkdir -p "$FE_TMP"

cp "$FRONTEND_DIR"/package.json "$FE_TMP/"
cp "$FRONTEND_DIR"/package-lock.json "$FE_TMP/" 2>/dev/null || true
cp "$FRONTEND_DIR"/tsconfig.json "$FE_TMP/"
cp "$FRONTEND_DIR"/tsconfig.node.json "$FE_TMP/" 2>/dev/null || true
cp "$FRONTEND_DIR"/vite.config.ts "$FE_TMP/"
cp "$FRONTEND_DIR"/index.html "$FE_TMP/"

echo "        installing dependencies in $FE_TMP ..."
(cd "$FE_TMP" && npm install --no-audit --no-fund 2>&1 | tail -1)

cp -r "$FRONTEND_DIR"/src "$FE_TMP/src"

echo "        type-checking..."
(cd "$FE_TMP" && node node_modules/typescript/bin/tsc --noEmit --project . )
echo "        bundling..."
(cd "$FE_TMP" && node node_modules/vite/bin/vite.js build)
echo "        -> $FE_TMP/dist"

# ---------------------------------------------------------------
# 4. Place the built bundle where go:embed expects it.
# ---------------------------------------------------------------
echo "[4/6] Staging frontend for embed..."
rm -rf "$EMBED_DIR"
mkdir -p "$(dirname "$EMBED_DIR")"
mv "$FE_TMP/dist" "$EMBED_DIR"

# Cleanup temp build dir.
rm -rf "$FE_TMP"

# embed.FS requires at least one file; sanity-check it landed.
if ! ls "$EMBED_DIR"/index.html >/dev/null 2>&1; then
  echo "error: embed dir missing index.html"; exit 1
fi
echo "        -> $EMBED_DIR"

# ---------------------------------------------------------------
# 5. Build the Go backend binary with the frontend embedded.
# ---------------------------------------------------------------
echo "[5/6] Building Go backend..."
(
  cd "$BACKEND_DIR"
  go mod tidy
  go build "${GO_BUILD_FLAGS[@]}" -o "$RELEASE_DIR/kscode" ./cmd/server
)
chmod +x "$RELEASE_DIR/kscode"
echo "        -> $RELEASE_DIR/kscode"

# ---------------------------------------------------------------
# 6. Sanity-check the release tree (one file expected).
# ---------------------------------------------------------------
echo "[6/6] Release tree:"
(
  cd "$RELEASE_DIR"
  find . -maxdepth 2 | sed 's/^/        /'
)

echo "=============================================="
echo " KS Code build complete"
echo ""
echo " Run it:"
echo "   cd \"$RELEASE_DIR\""
