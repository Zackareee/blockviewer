#!/bin/bash
# Build WASM with parallel support (Rayon)
# This script ensures the correct Rust toolchain is installed and configured

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_DIR="$PROJECT_ROOT/src/wasm-mesher"

echo "=== Building WASM with parallel support ==="

# Check if rustup is installed
if ! command -v rustup &> /dev/null; then
    echo "Error: rustup is not installed. Please install from https://rustup.rs"
    exit 1
fi

# Check if nightly toolchain is installed
if ! rustup toolchain list | grep -q "nightly"; then
    echo "Installing nightly Rust toolchain..."
    rustup toolchain install nightly
fi

# Add wasm32 target to nightly if not present
if ! rustup +nightly target list --installed | grep -q "wasm32-unknown-unknown"; then
    echo "Adding wasm32-unknown-unknown target to nightly..."
    rustup +nightly target add wasm32-unknown-unknown
fi

# Add rust-src component for build-std
if ! rustup +nightly component list --installed | grep -q "rust-src"; then
    echo "Adding rust-src component to nightly..."
    rustup +nightly component add rust-src
fi

# Check if wasm-pack is installed
if ! command -v wasm-pack &> /dev/null; then
    echo "Installing wasm-pack..."
    cargo install wasm-pack
fi

# Check if wasm-bindgen-cli is installed
if ! command -v wasm-bindgen &> /dev/null; then
    echo "Installing wasm-bindgen-cli..."
    cargo install wasm-bindgen-cli
fi

# Build with parallel feature
echo "Building WASM with parallel feature..."
cd "$WASM_DIR"

# Clean previous build
rm -rf pkg target/wasm32-unknown-unknown

# Use nightly toolchain for build-std support
# Build with cargo directly, then use wasm-bindgen to generate bindings
echo "Building with cargo nightly..."
RUSTUP_TOOLCHAIN=nightly cargo build \
    --lib \
    --release \
    --target wasm32-unknown-unknown \
    --features parallel

# Use wasm-bindgen to generate JS bindings
echo "Generating JS bindings with wasm-bindgen..."
mkdir -p pkg
wasm-bindgen target/wasm32-unknown-unknown/release/wasm_mesher.wasm \
    --out-dir pkg \
    --target web \
    --typescript

# Optimize with wasm-opt if available
if command -v wasm-opt &> /dev/null; then
    echo "Optimizing WASM with wasm-opt..."
    wasm-opt -O3 pkg/wasm_mesher_bg.wasm -o pkg/wasm_mesher_bg.wasm
fi

# Copy to public directory and to wasm module directories
echo "Copying to public/wasm and src/wasm/pkg..."
cp -r "$WASM_DIR/pkg/"* "$PROJECT_ROOT/public/wasm/"
mkdir -p "$PROJECT_ROOT/src/wasm/pkg"
cp -r "$WASM_DIR/pkg/"* "$PROJECT_ROOT/src/wasm/pkg/"
# Also copy to worker-accessible location
mkdir -p "$PROJECT_ROOT/src/mesh/wasm/pkg"
cp -r "$WASM_DIR/pkg/"* "$PROJECT_ROOT/src/mesh/wasm/pkg/"

echo "=== Build complete ==="
echo "WASM with Rayon parallel support built successfully!"
