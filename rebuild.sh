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
# ---------------------------------------------------------------
echo "[3/6] Building frontend..."
(
  cd "$FRONTEND_DIR"

  # Install deps on first build or if node_modules is missing.
  if [[ ! -d node_modules ]]; then
    echo "        installing npm dependencies (first build)..."
    npm install
  else
    echo "        node_modules present, skipping npm install"
  fi

  # esbuild ships a native binary that npm sometimes installs without the
  # executable bit; make sure it is runnable so Vite does not choke.
  if [[ -f node_modules/@esbuild/linux-x64/bin/esbuild ]]; then
    chmod +x node_modules/@esbuild/linux-x64/bin/esbuild 2>/dev/null || true
  fi

  # Type-check, then bundle. Invoke the bins directly via node so this works
  # even in environments where npm does not create node_modules/.bin symlinks.
  node node_modules/typescript/bin/tsc --noEmit
  rm -rf dist
  node node_modules/vite/bin/vite.js build
)
echo "        -> $FRONTEND_DIR/dist"

# ---------------------------------------------------------------
# 4. Place the built bundle where go:embed expects it.
# ---------------------------------------------------------------
echo "[4/6] Staging frontend for embed..."
rm -rf "$EMBED_DIR"
mkdir -p "$(dirname "$EMBED_DIR")"
mv "$FRONTEND_DIR/dist" "$EMBED_DIR"

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
echo "   ./kscode                 # http://localhost:6060"
echo "   ./kscode --port 3837     # http://localhost:3837"
echo "=============================================="
