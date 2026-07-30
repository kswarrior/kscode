#!/usr/bin/env bash
#
# rebuild.sh - Build KS Code into ./release/ (clean rebuild every run).
#
# Release layout:
#   release/
#     kscode-server        -> the Go binary
#     web/                 -> the built React app (index.html + assets/)
#     workspace/           -> empty on-disk workspace the server edits
#
# Then run it with:
#   ./release/kscode-server
#   # open http://localhost:8080
#
set -euo pipefail

# Resolve repo root (dir containing this script), even when run via symlink/PATH.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ROOT="$SCRIPT_DIR"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"
RELEASE_DIR="$ROOT/release"

GO_BUILD_FLAGS=(-buildvcs=false)

echo "=============================================="
echo " KS Code rebuild"
echo "   root: $ROOT"
echo "   release: $RELEASE_DIR"
echo "=============================================="

# ---------------------------------------------------------------
# 1. Fresh release folder.
# ---------------------------------------------------------------
# If release/ already exists (with an old kscode build / library),
# delete it entirely so we always start from a clean slate.
if [[ -d "$RELEASE_DIR" ]]; then
  echo "[1/6] Removing existing release folder..."
  rm -rf "$RELEASE_DIR"
fi
echo "[1/6] Creating release folder: $RELEASE_DIR"
mkdir -p "$RELEASE_DIR/web" "$RELEASE_DIR/workspace"

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
# 3. Build the Go backend binary into release/.
# ---------------------------------------------------------------
echo "[3/6] Building Go backend..."
(
  cd "$BACKEND_DIR"
  # Keep module deps tidy (no-op if go.sum is already accurate).
  go mod tidy
  # Compile the server straight into the release folder.
  go build "${GO_BUILD_FLAGS[@]}" -o "$RELEASE_DIR/kscode-server" ./cmd/server
)
echo "        -> $RELEASE_DIR/kscode-server"

# ---------------------------------------------------------------
# 4. Install frontend deps if needed, then build the web bundle.
# ---------------------------------------------------------------
echo "[4/6] Building frontend..."
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

  # Build to a temp dir then move, so a failed build never leaves a half-written web/.
  rm -rf dist
  node node_modules/vite/bin/vite.js build
)
echo "        -> $RELEASE_DIR/web"

# ---------------------------------------------------------------
# 5. Move the freshly built web bundle into release/web.
# ---------------------------------------------------------------
echo "[5/6] Copying web bundle into release/web..."
# Vite wrote to frontend/dist; relocate it into the release folder.
rm -rf "$RELEASE_DIR/web"
mv "$FRONTEND_DIR/dist" "$RELEASE_DIR/web"

# ---------------------------------------------------------------
# 6. Sanity-check the release tree.
# ---------------------------------------------------------------
echo "[6/6] Release tree:"
(
  cd "$RELEASE_DIR"
  find . -maxdepth 3 \( -path './web/assets' -prune -o -print \) \
    | sed 's/^/        /'
  echo "        web/assets/ ($(ls web/assets 2>/dev/null | wc -l) files)"
)

echo "=============================================="
echo " KS Code build complete"
echo ""
echo " Run it:"
echo "   cd \"$RELEASE_DIR\""
echo "   KS_STATIC=\"$RELEASE_DIR/web\" \\"
echo "   KS_WORKSPACE=\"$RELEASE_DIR/workspace\" \\"
echo "   KS_API_DIR=\"$RELEASE_DIR/data\" \\"
echo "   ./kscode-server"
echo " Then open http://localhost:8080"
echo "=============================================="
